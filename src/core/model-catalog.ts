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
  /** How token embeddings become one vector; BGE-M3 is trained for the CLS token. Default mean. */
  pooling?: 'mean' | 'cls'
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
  },
  {
    id: 'e5-large',
    label: 'multilingual-e5-large',
    hfModel: 'Xenova/multilingual-e5-large',
    revision: '00fc3aeb3dbb95842de2ac1961d33c6319acf57b',
    dimensions: 1024,
    diskMb: 562,
    ramMb: 1000,
    languages: '100+ (Spanish + English)',
    note: 'large E5; slow to load',
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
    minSimilarity: 0.78,
    duplicateSimilarity: 0.96
  },
  {
    id: 'bge-m3',
    label: 'BGE-M3 (dense)',
    hfModel: 'Xenova/bge-m3',
    revision: '4de13258303883538bd53b696b452bf8099f0858',
    dimensions: 1024,
    diskMb: 570,
    ramMb: 1000,
    languages: '100+ (Spanish + English)',
    note: 'large multilingual retriever, long texts',
    queryPrefix: '',
    passagePrefix: '',
    pooling: 'cls',
    minSimilarity: 0.5,
    duplicateSimilarity: 0.95
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

export const RECOMMENDED_RERANKER_ID = 'bge-reranker-v2-m3'

/** Cross-encoder that rescores (query, memory) pairs after retrieval. */
export interface RerankerModelSpec {
  id: string
  label: string
  hfModel: string
  /** Pinned commit of hfModel. */
  revision: string
  diskMb: number
  ramMb: number
  languages: string
  license: string
  note: string
  /**
   * Candidates whose relevance probability (sigmoid of the logit) is below this
   * are dropped. Correct paraphrases often score 1e-3..1e-2, so the floor sits
   * just above the best unrelated match measured with scripts/bench-embedder.ts.
   */
  minScore: number
}

// jina-reranker-v2-base-multilingual is left out on purpose: CC-BY-NC (non-commercial) license.
export const RERANKER_CATALOG: readonly RerankerModelSpec[] = [
  {
    id: RECOMMENDED_RERANKER_ID,
    label: 'bge-reranker-v2-m3',
    hfModel: 'onnx-community/bge-reranker-v2-m3-ONNX',
    revision: '6f5ff65298512715a1e669753bc754d2bc8f367b',
    diskMb: 571,
    ramMb: 1100,
    languages: '100+ (Spanish + English)',
    license: 'Apache-2.0',
    note: 'multilingual, most accurate',
    minScore: 0.0005
  },
  {
    id: 'bge-reranker-base',
    label: 'bge-reranker-base',
    hfModel: 'Xenova/bge-reranker-base',
    revision: '280bcc27a84e0b898c251e06fddb25171bd9b101',
    diskMb: 279,
    ramMb: 600,
    languages: 'English + Chinese',
    license: 'MIT',
    note: 'lighter; weak on Spanish',
    minScore: 0.002
  }
]

export function findRerankerSpec(id: string | undefined | null): RerankerModelSpec | undefined {
  if (!id) return undefined
  const normalized = id.trim().toLowerCase()
  return RERANKER_CATALOG.find((spec) => spec.id === normalized)
}
