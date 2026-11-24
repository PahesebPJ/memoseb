import { LEXICAL_EMBEDDER_MODEL } from './embedder.ts'

export const LEXICAL_MODEL_ID = 'hash'
export const RECOMMENDED_MODEL_ID = 'e5-small'

export interface EmbedderModelSpec {
  id: string
  label: string
  /** Hugging Face repository with ONNX weights; null for the built-in lexical embedder. */
  hfModel: string | null
  /** Pinned commit of hfModel, so the downloaded weights are reproducible. */
  revision?: string
  dimensions: number
  /** Approximate download size of the q8 ONNX weights. */
  diskMb: number
  /** Approximate resident memory while the model is loaded. */
  ramMb: number
  languages: string
  note: string
  queryPrefix: string
  passagePrefix: string
  /**
   * Cosine floor below which a vector-only match is treated as noise. Each model
   * has its own similarity scale (E5 rarely scores unrelated text below 0.7).
   */
  minSimilarity: number
  /** Cosine at which a new memory is reported as a likely duplicate. */
  duplicateSimilarity: number
}

// diskMb/ramMb/minSimilarity measured with scripts/bench-embedder.ts (q8 weights, CPU,
// Node 26, x86-64). minSimilarity sits just above the best match of unrelated queries.
export const MODEL_CATALOG: readonly EmbedderModelSpec[] = [
  {
    id: LEXICAL_MODEL_ID,
    label: 'Built-in lexical hash (no ML)',
    hfModel: null,
    dimensions: 384,
    diskMb: 0,
    ramMb: 0,
    languages: 'any (spelling overlap only)',
    note: 'default, instant, no download',
    queryPrefix: '',
    passagePrefix: '',
    minSimilarity: 0.35,
    duplicateSimilarity: 0.9
  },
  {
    id: 'minilm-en',
    label: 'all-MiniLM-L6-v2',
    hfModel: 'Xenova/all-MiniLM-L6-v2',
    revision: '751bff37182d3f1213fa05d7196b954e230abad9',
    dimensions: 384,
    diskMb: 23,
    ramMb: 115,
    languages: 'English',
    note: 'lightest and fastest; English only, misses Spanish memories',
    queryPrefix: '',
    passagePrefix: '',
    minSimilarity: 0.45,
    duplicateSimilarity: 0.92
  },
  {
    id: RECOMMENDED_MODEL_ID,
    label: 'multilingual-e5-small',
    hfModel: 'Xenova/multilingual-e5-small',
    revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
    dimensions: 384,
    diskMb: 130,
    ramMb: 360,
    languages: '100+ (Spanish + English)',
    note: 'recommended balance of quality and size',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    minSimilarity: 0.82,
    duplicateSimilarity: 0.96
  },
  {
    id: 'minilm-multi',
    label: 'paraphrase-multilingual-MiniLM-L12-v2',
    hfModel: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
    revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
    dimensions: 384,
    diskMb: 130,
    ramMb: 360,
    languages: '50+ (Spanish + English)',
    note: 'tuned for paraphrases',
    queryPrefix: '',
    passagePrefix: '',
    minSimilarity: 0.25,
    duplicateSimilarity: 0.92
  },
  {
    id: 'e5-base',
    label: 'multilingual-e5-base',
    hfModel: 'Xenova/multilingual-e5-base',
    revision: '1ec9243030a27d1a115d5c340572074c125b58b2',
    dimensions: 768,
    diskMb: 283,
    ramMb: 510,
    languages: '100+ (Spanish + English)',
    note: 'most accurate, heaviest',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    minSimilarity: 0.78,
    duplicateSimilarity: 0.96
  }
]

export function findModelSpec(id: string | undefined | null): EmbedderModelSpec | undefined {
  if (!id) return undefined
  const normalized = id.trim().toLowerCase()
  return MODEL_CATALOG.find((spec) => spec.id === normalized)
}

export function isSemanticModel(spec: EmbedderModelSpec): boolean {
  return spec.hfModel !== null
}

/** Value stored in memory_vectors.model for vectors produced by this spec. */
export function vectorModelTag(spec: EmbedderModelSpec): string {
  return spec.hfModel === null ? LEXICAL_EMBEDDER_MODEL : `hf:${spec.hfModel}`
}
