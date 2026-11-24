import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { EmbedderModelSpec, RerankerModelSpec } from './model-catalog.ts'
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

/** Any downloadable model: embedders and rerankers share the cache layout. */
type DownloadableSpec = Pick<EmbedderModelSpec, 'hfModel'>

export function modelCacheDir(paths: MlPaths, spec: DownloadableSpec): string | null {
  return spec.hfModel ? path.join(paths.modelsDir, ...spec.hfModel.split('/')) : null
}

export function isModelDownloaded(paths: MlPaths, spec: DownloadableSpec): boolean {
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

interface PretrainedOptions {
  dtype?: string
  revision?: string
  progress_callback?: (event: Record<string, unknown>) => void
}

interface TensorLike {
  data: Float32Array | number[]
  dims: number[]
}

type Tokenizer = (
  text: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean; max_length: number }
) => Record<string, unknown>

interface SequenceClassifier {
  (inputs: Record<string, unknown>): Promise<{ logits: TensorLike }>
  dispose?: () => Promise<unknown>
}

interface TransformersModule {
  env: {
    cacheDir: string
    localModelPath: string
    allowRemoteModels: boolean
    allowLocalModels: boolean
  }
  AutoTokenizer: { from_pretrained(model: string, options?: PretrainedOptions): Promise<Tokenizer> }
  AutoModelForSequenceClassification: {
    from_pretrained(model: string, options?: PretrainedOptions): Promise<SequenceClassifier>
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
  options: { pooling: 'mean' | 'cls'; normalize: boolean }
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

/**
 * Points transformers.js at modelsDir. The download cache uses the same
 * <org>/<model>/ layout as local models, so offline runs read the weights
 * straight from there.
 */
function configureRuntime(runtime: TransformersModule, paths: MlPaths, allowRemote: boolean): void {
  runtime.env.cacheDir = paths.modelsDir
  runtime.env.localModelPath = paths.modelsDir
  runtime.env.allowLocalModels = true
  runtime.env.allowRemoteModels = allowRemote
}

function progressCallback(
  onProgress: ((progress: DownloadProgress) => void) | undefined
): ((event: Record<string, unknown>) => void) | undefined {
  if (!onProgress) return undefined
  return (event) => {
    if (event.status === 'progress' && typeof event.file === 'string') {
      onProgress({ file: event.file, loaded: Number(event.loaded ?? 0), total: Number(event.total ?? 0) })
    }
  }
}

/**
 * What to hand transformers.js as the model id. Downloads use the repo id and
 * pinned revision. Offline loads use the local directory instead, because
 * transformers.js 4.3.2 caches a pinned download inconsistently: tokenizer and
 * ONNX files go under <repo>/<revision>/ but pipeline() may store config.json
 * in <repo>/, and get_tokenizer_files ignores the revision. A repo id therefore
 * fails offline ("this.tokenizer is not a function" / "tokenizer_class").
 * Installs made before revisions were pinned keep every file in <repo>/.
 */
export function modelSource(
  paths: MlPaths,
  spec: { hfModel: string | null; revision?: string },
  allowRemote: boolean
): { model: string; revision: string | undefined } {
  const revision = spec.revision ?? 'main'
  if (allowRemote || !spec.hfModel) return { model: spec.hfModel ?? '', revision }
  const root = modelCacheDir(paths, spec)!
  const revisionDir = path.join(root, revision)
  const has = (dir: string, file: string): boolean => fs.existsSync(path.join(dir, file))
  if (has(revisionDir, 'tokenizer_config.json') && !has(revisionDir, 'config.json') && has(root, 'config.json')) {
    try {
      // config.json was fetched at the pinned revision too; only its cache key lacks it.
      fs.copyFileSync(path.join(root, 'config.json'), path.join(revisionDir, 'config.json'))
    } catch {
      // Read-only cache: fall through to the repo id and let transformers.js report it.
    }
  }
  for (const dir of [revisionDir, root]) {
    if (has(dir, 'config.json') && has(dir, 'tokenizer_config.json')) {
      return { model: dir, revision: undefined }
    }
  }
  return { model: spec.hfModel, revision }
}

function writeReadyMarker(paths: MlPaths, spec: DownloadableSpec, revision: string): void {
  const dir = modelCacheDir(paths, spec)
  if (dir && fs.existsSync(dir)) {
    fs.writeFileSync(path.join(dir, MODEL_READY_MARKER), `${revision}\n`)
  }
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
        configureRuntime(runtime, this.paths, this.allowRemote)
        // Pinned commit: a later push to the model repo cannot change what we download.
        const source = modelSource(this.paths, this.spec, this.allowRemote)
        const extractor = await runtime.pipeline('feature-extraction', source.model, {
          dtype: 'q8',
          ...(source.revision ? { revision: source.revision } : {}),
          progress_callback: progressCallback(this.onProgress)
        })
        writeReadyMarker(this.paths, this.spec, this.spec.revision ?? 'main')
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
    const output = await extractor(texts, { pooling: this.spec.pooling ?? 'mean', normalize: true })
    const dims = output.dims[output.dims.length - 1] ?? this.dimensions
    const vectors: Float32Array[] = []
    for (let i = 0; i < texts.length; i++) {
      vectors.push(Float32Array.from(output.data.subarray(i * dims, (i + 1) * dims)))
    }
    return vectors
  }
}

/** Cross-encoder that scores how well each passage answers the query (0..1). */
export interface SemanticReranker {
  readonly spec: RerankerModelSpec
  score(query: string, passages: readonly string[]): Promise<number[]>
  dispose(): Promise<void>
}

/** Pairs scored per forward pass: bounds peak memory on long candidate lists. */
const RERANK_BATCH_SIZE = 8
/** Memories are short; 512 tokens covers query + passage with room to spare. */
const RERANK_MAX_TOKENS = 512

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x))
}

export class TransformersReranker implements SemanticReranker {
  readonly spec: RerankerModelSpec
  private readonly paths: MlPaths
  private readonly allowRemote: boolean
  private readonly onProgress?: (progress: DownloadProgress) => void
  private loaded: Promise<{ tokenizer: Tokenizer; model: SequenceClassifier }> | null = null

  constructor(
    spec: RerankerModelSpec,
    paths: MlPaths,
    options?: { allowRemote?: boolean; onProgress?: (progress: DownloadProgress) => void }
  ) {
    this.spec = spec
    this.paths = paths
    // Same guarantee as the embedder: only "memoseb model reranker enable" downloads.
    this.allowRemote = options?.allowRemote ?? false
    this.onProgress = options?.onProgress
  }

  load(): Promise<{ tokenizer: Tokenizer; model: SequenceClassifier }> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const runtime = await importRuntime(this.paths)
        configureRuntime(runtime, this.paths, this.allowRemote)
        const source = modelSource(this.paths, this.spec, this.allowRemote)
        const options: PretrainedOptions = {
          ...(source.revision ? { revision: source.revision } : {}),
          progress_callback: progressCallback(this.onProgress)
        }
        const tokenizer = await runtime.AutoTokenizer.from_pretrained(source.model, options)
        const model = await runtime.AutoModelForSequenceClassification.from_pretrained(source.model, {
          ...options,
          dtype: 'q8'
        })
        writeReadyMarker(this.paths, this.spec, this.spec.revision)
        return { tokenizer, model }
      })()
      this.loaded.catch(() => {
        this.loaded = null
      })
    }
    return this.loaded
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    if (passages.length === 0) return []
    const { tokenizer, model } = await this.load()
    const scores: number[] = []
    for (let start = 0; start < passages.length; start += RERANK_BATCH_SIZE) {
      const batch = passages.slice(start, start + RERANK_BATCH_SIZE)
      const inputs = tokenizer(
        batch.map(() => query),
        { text_pair: [...batch], padding: true, truncation: true, max_length: RERANK_MAX_TOKENS }
      )
      const { logits } = await model(inputs)
      // One relevance logit per pair (num_labels = 1).
      const perRow = logits.dims[logits.dims.length - 1] ?? 1
      for (let i = 0; i < batch.length; i++) {
        scores.push(sigmoid(Number(logits.data[i * perRow])))
      }
    }
    return scores
  }

  async dispose(): Promise<void> {
    const pending = this.loaded
    this.loaded = null
    if (pending) {
      const loaded = await pending.catch(() => null)
      await loaded?.model.dispose?.()
    }
  }
}
