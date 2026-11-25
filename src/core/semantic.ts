import { contentTokens } from './text.ts'
import { installMlRuntime, type MlRuntimeInstallResult } from './ml-runtime.ts'
import { isSemanticModel, type EmbedderModelSpec, type RerankerModelSpec } from './model-catalog.ts'
import {
  isMlRuntimeInstalled,
  isModelDownloaded,
  TransformersEmbedder,
  TransformersReranker,
  type DownloadProgress,
  type MlPaths,
  type SemanticEmbedder,
  type SemanticReranker
} from './transformers-embedder.ts'
import {
  embeddingTextFor,
  type ActiveEmbedderInfo,
  type ActiveRerankerInfo,
  type MemoryVault,
  type RecallOptions,
  type RecallResult,
  type ScoredMemory,
  type StoreMemoryInput,
  type StoreMemoryResult
} from './vault.ts'

/** Pending vectors embedded on each recall, so imports and syncs self-heal gradually. */
const HEAL_BATCH_SIZE = 32

/** Everything that touches npm, the network or ONNX; injectable for tests. */
export interface MlBackend {
  isRuntimeInstalled(paths: MlPaths): boolean
  isModelDownloaded(paths: MlPaths, spec: Pick<EmbedderModelSpec, 'hfModel'>): boolean
  installRuntime(paths: MlPaths, onOutput?: (chunk: string) => void): Promise<MlRuntimeInstallResult>
  createEmbedder(
    spec: EmbedderModelSpec,
    paths: MlPaths,
    options?: { allowRemote?: boolean; onProgress?: (progress: DownloadProgress) => void }
  ): SemanticEmbedder
  createReranker(
    spec: RerankerModelSpec,
    paths: MlPaths,
    options?: { allowRemote?: boolean; onProgress?: (progress: DownloadProgress) => void }
  ): SemanticReranker
}

export const defaultMlBackend: MlBackend = {
  isRuntimeInstalled: isMlRuntimeInstalled,
  isModelDownloaded,
  installRuntime: (paths, onOutput) => installMlRuntime(paths, { onOutput }),
  createEmbedder: (spec, paths, options) => new TransformersEmbedder(spec, paths, options),
  createReranker: (spec, paths, options) => new TransformersReranker(spec, paths, options)
}

/** Rerankers see this many retrieved candidates (at least 4x the requested limit). */
export const MIN_RERANK_CANDIDATES = 20

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
  embedder: SemanticEmbedder | null,
  reranker: SemanticReranker | null = null
): Promise<RecallResult> {
  if (query.trim().length === 0) {
    return vault.recallMemories(query, options)
  }
  let rankOptions: RecallOptions = options
  let warning: string | undefined
  if (embedder) {
    try {
      await healVectors(vault, embedder)
      const queryVector = await embedder.embedQuery(query)
      rankOptions = {
        ...options,
        queryVector,
        vectorModel: embedder.model,
        minSimilarity: embedder.spec.minSimilarity
      }
    } catch (err) {
      warning = `Semantic search failed (${describeError(err)}); used lexical search.`
    }
  }
  if (!reranker) {
    const result = vault.recallMemories(query, rankOptions)
    return warning ? { ...result, warning } : result
  }

  const ranked = vault.rankMemories(query, rankOptions)
  const limit = Math.max(1, options.limit ?? 5)
  const pool = ranked.candidates.slice(0, Math.max(MIN_RERANK_CANDIDATES, limit * 4))
  let ordered = ranked.candidates
  try {
    const scores = await reranker.score(
      query,
      pool.map((m) => embeddingTextFor(m.title, m.content, m.tags, m.aliases ?? []))
    )
    const queryTokens = new Set(contentTokens(query))
    // Cross-encoders can score a bare keyword query ("FTS5", an id) very low; a
    // memory containing every query term is kept regardless of the floor.
    const coversQuery = (memory: ScoredMemory): boolean => {
      if (memory.ftsScore <= 0) return false
      const own = new Set(contentTokens(embeddingTextFor(memory.title, memory.content, memory.tags, memory.aliases ?? [])))
      for (const token of queryTokens) if (!own.has(token)) return false
      return true
    }
    ordered = pool
      .map((memory, i) => ({ ...memory, rerankScore: Number(scores[i]!.toFixed(6)) }))
      .filter((memory) => memory.rerankScore >= reranker.spec.minScore || coversQuery(memory))
      .sort((a, b) => b.rerankScore - a.rerankScore)
  } catch (err) {
    const rerankWarning = `Reranking failed (${describeError(err)}); kept the retrieval order.`
    warning = warning ? `${warning} ${rerankWarning}` : rerankWarning
  }
  const result = vault.selectRecalled(ranked.projectId, ordered, options)
  return warning ? { ...result, warning } : result
}

export interface ActiveRerankerResolution {
  info: ActiveRerankerInfo
  /** null when no reranker is configured or it cannot be loaded. */
  reranker: SemanticReranker | null
  warning?: string
}

/** Like resolveActiveEmbedder: never loads the model, only checks it is installed. */
export function resolveActiveReranker(
  vault: MemoryVault,
  backend: MlBackend = defaultMlBackend
): ActiveRerankerResolution {
  const info = vault.getActiveReranker()
  if (info.invalidValue) {
    return { info, reranker: null, warning: `Unknown reranker "${info.invalidValue}" (${info.source}); results are not reranked.` }
  }
  if (!info.spec) return { info, reranker: null }
  const paths = vault.mlPaths
  if (!backend.isRuntimeInstalled(paths) || !backend.isModelDownloaded(paths, info.spec)) {
    return {
      info,
      reranker: null,
      warning: `Reranker "${info.spec.id}" is not installed: results are not reranked. Run "memoseb model reranker enable ${info.spec.id}".`
    }
  }
  return { info, reranker: backend.createReranker(info.spec, paths) }
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
  const rerankHit = rerankerCache.get(vault)
  rerankerCache.delete(vault)
  await Promise.allSettled([hit?.resolution.embedder?.dispose(), rerankHit?.resolution.reranker?.dispose()])
}

const rerankerCache = new WeakMap<
  MemoryVault,
  { key: string; resolution: ActiveRerankerResolution }
>()

/** Reranker counterpart of cachedActiveEmbedder (the MCP server keeps it loaded). */
export function cachedActiveReranker(
  vault: MemoryVault,
  backend: MlBackend = defaultMlBackend
): ActiveRerankerResolution {
  const info = vault.getActiveReranker()
  const paths = vault.mlPaths
  const installed =
    info.spec !== null && backend.isRuntimeInstalled(paths) && backend.isModelDownloaded(paths, info.spec)
  const key = `${info.spec?.id ?? info.invalidValue ?? 'none'}|${installed}`
  const hit = rerankerCache.get(vault)
  if (hit && hit.key === key) return hit.resolution
  hit?.resolution.reranker?.dispose().catch(() => {})
  const resolution = resolveActiveReranker(vault, backend)
  rerankerCache.set(vault, { key, resolution })
  return resolution
}

/** Default idle time before the MCP server unloads its semantic models. */
export const DEFAULT_MODEL_IDLE_MINUTES = 5

/** setTimeout overflows above 2^31-1 ms (~24.8 days) and would fire after 1 ms. */
export const MAX_MODEL_IDLE_MS = 2_147_483_647

/**
 * Reads MEMOSEB_MODEL_IDLE_MINUTES. 0 keeps models loaded for the whole
 * session; missing, negative or non-numeric values fall back to the default.
 * Positive values are clamped to [1 ms, MAX_MODEL_IDLE_MS].
 */
export function resolveModelIdleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMOSEB_MODEL_IDLE_MINUTES?.trim()
  const minutes = raw ? Number(raw) : Number.NaN
  const effective = Number.isFinite(minutes) && minutes >= 0 ? minutes : DEFAULT_MODEL_IDLE_MINUTES
  if (effective === 0) return 0
  return Math.min(Math.max(1, Math.round(effective * 60_000)), MAX_MODEL_IDLE_MS)
}

export interface ModelIdleReleaser {
  /** Runs a model-using call; the idle countdown restarts once no call is in flight. */
  run<T>(fn: () => Promise<T>): Promise<T>
  /** Cancels the pending countdown without releasing anything. */
  stop(): void
}

export interface ModelIdleReleaserOptions {
  idleMs?: number
  release?: (vault: MemoryVault) => Promise<void>
  onRelease?: () => void
}

/**
 * Each MCP client spawns its own server, so with many open sessions the
 * loaded models (~1.1 GB with e5-small + reranker) add up. Releasing them
 * after a quiet period keeps only recently used sessions resident; the next
 * call reloads lazily through cachedActiveEmbedder/cachedActiveReranker.
 */
export function createModelIdleReleaser(
  vault: MemoryVault,
  options: ModelIdleReleaserOptions = {}
): ModelIdleReleaser {
  const idleMs = Math.min(options.idleMs ?? resolveModelIdleMs(), MAX_MODEL_IDLE_MS)
  const release = options.release ?? releaseCachedEmbedder
  let inFlight = 0
  let stopped = false
  let timer: NodeJS.Timeout | undefined

  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
  }

  const arm = () => {
    cancel()
    if (stopped || idleMs <= 0) return
    timer = setTimeout(() => {
      timer = undefined
      if (inFlight > 0) return
      release(vault)
        .then(() => options.onRelease?.())
        .catch(() => {})
    }, idleMs)
    // Never keep the process alive just to unload models.
    timer.unref()
  }

  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      inFlight += 1
      cancel()
      try {
        return await fn()
      } finally {
        inFlight -= 1
        if (inFlight === 0) arm()
      }
    },
    stop() {
      stopped = true
      cancel()
    }
  }
}
