import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EmbedderModelSpec } from './model-catalog.ts'
import { vectorModelTag } from './model-catalog.ts'

export const ML_RUNTIME_PACKAGE = '@huggingface/transformers'

/** Written next to the weights after a successful load; a partial download never has it. */
export const MODEL_READY_MARKER = '.memoseb-ready'

/** Asynchronous embedder backed by a neural model (semantic similarity). */
export interface SemanticEmbedder {
  readonly spec: EmbedderModelSpec
  /** Tag stored in memory_vectors.model. */
  readonly model: string
  readonly dimensions: number
  embedQuery(text: string): Promise<Float32Array>
  embedPassages(texts: readonly string[]): Promise<Float32Array[]>
  dispose(): Promise<void>
}

export interface MlPaths {
  /** Root of the on-demand ML install (next to vault.sqlite unless MEMOSEB_ML_DIR is set). */
  root: string
  /** npm prefix holding node_modules/@huggingface/transformers. */
  runtimeDir: string
  /** Hugging Face cache with the downloaded ONNX weights. */
  modelsDir: string
}

export function resolveMlPaths(dbPath: string, env: NodeJS.ProcessEnv = process.env): MlPaths {
  const custom = env.MEMOSEB_ML_DIR?.trim()
  const root = custom ? path.resolve(custom) : path.join(path.dirname(path.resolve(dbPath)), 'ml')
  return {
    root,
    runtimeDir: path.join(root, 'runtime'),
    modelsDir: path.join(root, 'models')
  }
}

export function runtimePackageDir(paths: MlPaths): string {
  return path.join(paths.runtimeDir, 'node_modules', ...ML_RUNTIME_PACKAGE.split('/'))
}

export function isMlRuntimeInstalled(paths: MlPaths): boolean {
  return fs.existsSync(path.join(runtimePackageDir(paths), 'package.json'))
}

export function modelCacheDir(paths: MlPaths, spec: EmbedderModelSpec): string | null {
  return spec.hfModel ? path.join(paths.modelsDir, ...spec.hfModel.split('/')) : null
}

export function isModelDownloaded(paths: MlPaths, spec: EmbedderModelSpec): boolean {
  const dir = modelCacheDir(paths, spec)
  return dir !== null && fs.existsSync(path.join(dir, MODEL_READY_MARKER))
}

export function directorySizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directorySizeBytes(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

export interface DownloadProgress {
  file: string
  loaded: number
  total: number
}

interface TransformersModule {
  env: {
    cacheDir: string
    localModelPath: string
    allowRemoteModels: boolean
    allowLocalModels: boolean
  }
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options: {
      dtype: string
      revision?: string
      progress_callback?: (event: Record<string, unknown>) => void
    }
  ) => Promise<FeatureExtractor>
}

type FeatureExtractor = ((
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>) & { dispose?: () => Promise<void> }

async function importRuntime(paths: MlPaths): Promise<TransformersModule> {
  const pkgDir = runtimePackageDir(paths)
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(
      `ML runtime not installed in ${paths.runtimeDir}. Run "memoseb model enable" first.`
    )
  }
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as {
    exports?: { node?: { import?: { default?: string } } }
  }
  const esmEntry = pkg.exports?.node?.import?.default
  const entry = esmEntry
    ? path.join(pkgDir, esmEntry)
    : createRequire(pkgJsonPath).resolve(ML_RUNTIME_PACKAGE)
  return (await import(pathToFileURL(entry).href)) as TransformersModule
}

export class TransformersEmbedder implements SemanticEmbedder {
  readonly spec: EmbedderModelSpec
  readonly model: string
  readonly dimensions: number
  private readonly paths: MlPaths
  private readonly allowRemote: boolean
  private readonly onProgress?: (progress: DownloadProgress) => void
  private extractor: Promise<FeatureExtractor> | null = null

  constructor(
    spec: EmbedderModelSpec,
    paths: MlPaths,
    options?: { allowRemote?: boolean; onProgress?: (progress: DownloadProgress) => void }
  ) {
    if (!spec.hfModel) {
      throw new Error(`Model "${spec.id}" is not a neural model.`)
    }
    this.spec = spec
    this.model = vectorModelTag(spec)
    this.dimensions = spec.dimensions
    this.paths = paths
    // Normal use never touches the network: only "memoseb model enable" downloads.
    this.allowRemote = options?.allowRemote ?? false
    this.onProgress = options?.onProgress
  }

  /** Loads the model on first use; later calls reuse the same pipeline. */
  load(): Promise<FeatureExtractor> {
    if (!this.extractor) {
      this.extractor = (async () => {
        const runtime = await importRuntime(this.paths)
        // The download cache uses the same <org>/<model>/ layout as local models,
        // so offline runs read the weights straight from modelsDir.
        runtime.env.cacheDir = this.paths.modelsDir
        runtime.env.localModelPath = this.paths.modelsDir
        runtime.env.allowLocalModels = true
        runtime.env.allowRemoteModels = this.allowRemote
        const onProgress = this.onProgress
        const extractor = await runtime.pipeline('feature-extraction', this.spec.hfModel!, {
          dtype: 'q8',
          // Pinned commit: a later push to the model repo cannot change what we download.
          revision: this.spec.revision ?? 'main',
          progress_callback: onProgress
            ? (event) => {
                if (event.status === 'progress' && typeof event.file === 'string') {
                  onProgress({
                    file: event.file,
                    loaded: Number(event.loaded ?? 0),
                    total: Number(event.total ?? 0)
                  })
                }
              }
            : undefined
        })
        const dir = modelCacheDir(this.paths, this.spec)
        if (dir && fs.existsSync(dir)) {
          fs.writeFileSync(path.join(dir, MODEL_READY_MARKER), `${this.spec.revision ?? 'main'}\n`)
        }
        return extractor
      })()
      this.extractor.catch(() => {
        this.extractor = null
      })
    }
    return this.extractor
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.run([`${this.spec.queryPrefix}${text}`])
    return vector!
  }

  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    return this.run(texts.map((text) => `${this.spec.passagePrefix}${text}`))
  }

  async dispose(): Promise<void> {
    const pending = this.extractor
    this.extractor = null
    if (pending) {
      const extractor = await pending.catch(() => null)
      await extractor?.dispose?.()
    }
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.load()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const dims = output.dims[output.dims.length - 1] ?? this.dimensions
    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      vectors.push(Float32Array.from(output.data.subarray(i * dims, (i + 1) * dims)))
    }
    return vectors
  }
}
