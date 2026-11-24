import { installMlRuntime, type MlRuntimeInstallResult } from './ml-runtime.ts'
import { isSemanticModel, type EmbedderModelSpec } from './model-catalog.ts'
import {
  isMlRuntimeInstalled,
  isModelDownloaded,
  TransformersEmbedder,
  type DownloadProgress,
  type MlPaths,
  type SemanticEmbedder
} from './transformers-embedder.ts'
import {
  embeddingTextFor,
  type ActiveEmbedderInfo,
  type MemoryVault,
  type RecallOptions,
  type RecallResult,
  type StoreMemoryInput,
  type StoreMemoryResult
} from './vault.ts'

/** Pending vectors embedded on each recall, so imports and syncs self-heal gradually. */
const HEAL_BATCH_SIZE = 32

/** Everything that touches npm, the network or ONNX; injectable for tests. */
export interface MlBackend {
  isRuntimeInstalled(paths: MlPaths): boolean
  isModelDownloaded(paths: MlPaths, spec: EmbedderModelSpec): boolean
  installRuntime(paths: MlPaths, onOutput?: (chunk: string) => void): Promise<MlRuntimeInstallResult>
  createEmbedder(
    spec: EmbedderModelSpec,
    paths: MlPaths,
    options?: { allowRemote?: boolean; onProgress?: (progress: DownloadProgress) => void }
  ): SemanticEmbedder
}

export const defaultMlBackend: MlBackend = {
  isRuntimeInstalled: isMlRuntimeInstalled,
  isModelDownloaded,
  installRuntime: (paths, onOutput) => installMlRuntime(paths, { onOutput }),
  createEmbedder: (spec, paths, options) => new TransformersEmbedder(spec, paths, options)
}

export interface ActiveEmbedderResolution {
  info: ActiveEmbedderInfo
  /** null when the lexical hash is active or the semantic model cannot be loaded. */
  embedder: SemanticEmbedder | null
  /** Why a configured semantic model is not in use (missing runtime, missing weights...). */
  warning?: string
}

/**
 * Resolves the configured embedder without loading the model: loading happens
 * lazily on the first embed call, so commands that never embed pay nothing.
 */
export function resolveActiveEmbedder(
  vault: MemoryVault,
  backend: MlBackend = defaultMlBackend
): ActiveEmbedderResolution {
  const info = vault.getActiveEmbedder()
  const invalid = info.invalidValue
    ? `Unknown embedder "${info.invalidValue}" (${info.source}); using the lexical hash.`
    : undefined
  if (!isSemanticModel(info.spec)) {
    return { info, embedder: null, ...(invalid ? { warning: invalid } : {}) }
  }
  const paths = vault.mlPaths
  if (!backend.isRuntimeInstalled(paths) || !backend.isModelDownloaded(paths, info.spec)) {
    return {
      info,
      embedder: null,
      warning: `Model "${info.spec.id}" is not installed: search uses FTS5 keywords plus lexical vectors where available. Run "memoseb model enable ${info.spec.id}".`
    }
  }
  return { info, embedder: backend.createEmbedder(info.spec, paths) }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export async function storeMemoryWithEmbedder(
  vault: MemoryVault,
  input: StoreMemoryInput,
  embedder: SemanticEmbedder | null
): Promise<StoreMemoryResult> {
  const result = vault.storeMemory(input)
  if (!embedder) return result
  const { memory } = result
  let vector: Float32Array
  try {
    ;[vector] = (await embedder.embedPassages([
      embeddingTextFor(memory.title, memory.content, memory.tags, memory.aliases ?? [])
    ])) as [Float32Array]
  } catch (err) {
    // The memory is already stored with a lexical vector; a later recall re-embeds it.
    return { ...result, warning: `Semantic embedding failed (${describeError(err)}); stored with the lexical vector.` }
  }
  vault.writeVectors(embedder.model, [{ id: memory.id, vector }])
  // Lexical near-duplicates are replaced by the semantic ones computed below.
  const withoutLexicalSimilar: StoreMemoryResult = { memory: result.memory, created: result.created }
  if (!result.created) return withoutLexicalSimilar
  const similar = vault.findSimilarMemories({
    projectId: memory.projectId,
    category: memory.category,
    vector,
    model: embedder.model,
    threshold: embedder.spec.duplicateSimilarity,
    excludeId: memory.id
  })
  return similar.length > 0 ? { ...withoutLexicalSimilar, similar } : withoutLexicalSimilar
}

/** Embeds up to `limit` memories whose vector belongs to another model. */
export async function healVectors(
  vault: MemoryVault,
  embedder: SemanticEmbedder,
  limit: number = HEAL_BATCH_SIZE
): Promise<number> {
  const pending = vault.listMemoriesNeedingVectors(embedder.model, limit)
  if (pending.length === 0) return 0
  const vectors = await embedder.embedPassages(pending.map((item) => item.text))
  return vault.writeVectors(
    embedder.model,
    pending.map((item, i) => ({ id: item.id, vector: vectors[i]! }))
  )
}

export async function recallWithEmbedder(
  vault: MemoryVault,
  query: string,
  options: RecallOptions,
  embedder: SemanticEmbedder | null
): Promise<RecallResult> {
  if (!embedder || query.trim().length === 0) {
    return vault.recallMemories(query, options)
  }
  let queryVector: Float32Array
  try {
    await healVectors(vault, embedder)
    queryVector = await embedder.embedQuery(query)
  } catch (err) {
    return {
      ...vault.recallMemories(query, options),
      warning: `Semantic search failed (${describeError(err)}); used lexical search.`
    }
  }
  return vault.recallMemories(query, {
    ...options,
    queryVector,
    vectorModel: embedder.model,
    minSimilarity: embedder.spec.minSimilarity
  })
}

export interface ReindexProgress {
  done: number
  total: number
}

/** Re-embeds every memory whose vector was not produced by the active model. */
export async function reindexVault(
  vault: MemoryVault,
  embedder: SemanticEmbedder | null,
  options?: { batchSize?: number; onProgress?: (progress: ReindexProgress) => void }
): Promise<{ model: string; reindexed: number; total: number }> {
  if (!embedder) {
    const total = vault.countMemoriesNeedingVectors(vault.lexicalVectorModel)
    const reindexed = vault.reindexLexicalVectors({ includeSemantic: true })
    options?.onProgress?.({ done: reindexed, total })
    return { model: vault.lexicalVectorModel, reindexed, total }
  }
  const total = vault.countMemoriesNeedingVectors(embedder.model)
  const batchSize = Math.max(1, options?.batchSize ?? 16)
  let reindexed = 0
  while (reindexed < total) {
    const written = await healVectors(vault, embedder, batchSize)
    if (written === 0) break
    reindexed += written
    options?.onProgress?.({ done: reindexed, total })
  }
  return { model: embedder.model, reindexed, total }
}

const resolutionCache = new WeakMap<
  MemoryVault,
  { key: string; resolution: ActiveEmbedderResolution }
>()

/**
 * Long-lived processes (the MCP server) keep the loaded model between calls.
 * The cache key follows the stored config and install state, so running
 * "memoseb model enable/disable" elsewhere takes effect on the next call.
 */
export function cachedActiveEmbedder(
  vault: MemoryVault,
  backend: MlBackend = defaultMlBackend
): ActiveEmbedderResolution {
  const info = vault.getActiveEmbedder()
  const paths = vault.mlPaths
  const installed =
    isSemanticModel(info.spec) &&
    backend.isRuntimeInstalled(paths) &&
    backend.isModelDownloaded(paths, info.spec)
  const key = `${info.spec.id}|${installed}`
  const hit = resolutionCache.get(vault)
  if (hit && hit.key === key) return hit.resolution
  // Never let a failed dispose become an unhandled rejection in the MCP process.
  hit?.resolution.embedder?.dispose().catch(() => {})
  const resolution = resolveActiveEmbedder(vault, backend)
  resolutionCache.set(vault, { key, resolution })
  return resolution
}

export async function releaseCachedEmbedder(vault: MemoryVault): Promise<void> {
  const hit = resolutionCache.get(vault)
  resolutionCache.delete(vault)
  await hit?.resolution.embedder?.dispose()
}
