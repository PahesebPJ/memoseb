export const DEFAULT_DIMENSIONS = 384

export interface EmbeddingProvider {
  readonly model: string
  readonly dimensions: number
  embed(text: string): Float32Array
}

export function estimateTokens(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return 0
  }
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length)
  if (len === 0) {
    return 0
  }
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < len; i++) {
    const va = a[i]!
    const vb = b[i]!
    dot += va * vb
    normA += va * va
    normB += vb * vb
  }
  if (normA === 0 || normB === 0) {
    return 0
  }
  return dot / Math.sqrt(normA * normB)
}

export function serializeVector(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

export function deserializeVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength)
  copy.set(blob)
  return new Float32Array(copy.buffer)
}

function fnv1a32(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

export class LocalFeatureHashEmbedder implements EmbeddingProvider {
  readonly model = 'local-feature-hash-v1'
  readonly dimensions: number

  constructor(dimensions: number = DEFAULT_DIMENSIONS) {
    this.dimensions = dimensions
  }

  embed(text: string): Float32Array {
    const vec = new Float32Array(this.dimensions)
    const normalized = text.toLowerCase().normalize('NFKD')
    const words = normalized.match(/[a-z0-9]+/g) ?? []
    if (words.length === 0) {
      return vec
    }

    const addFeature = (feature: string, weight: number): void => {
      const h1 = fnv1a32(feature, 0x811c9dc5)
      const h2 = fnv1a32(feature, 0x9e3779b9)
      const index = h1 % this.dimensions
      const sign = (h2 & 1) === 0 ? 1 : -1
      vec[index] = vec[index]! + sign * weight
    }

    for (let i = 0; i < words.length; i++) {
      const word = words[i]!
      addFeature(`w:${word}`, 2.0)

      if (word.length >= 4) {
        addFeature(`p4:${word.slice(0, 4)}`, 1.0)
      }
      if (word.length >= 5) {
        addFeature(`p5:${word.slice(0, 5)}`, 1.0)
      }

      if (i + 1 < words.length) {
        addFeature(`b:${word}_${words[i + 1]!}`, 1.5)
      }

      const padded = `^${word}$`
      for (let j = 0; j <= padded.length - 3; j++) {
        addFeature(`c3:${padded.slice(j, j + 3)}`, 0.75)
      }
    }

    let normSq = 0
    for (let i = 0; i < this.dimensions; i++) {
      const v = vec[i]!
      normSq += v * v
    }
    if (normSq > 0) {
      const invNorm = 1 / Math.sqrt(normSq)
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] = vec[i]! * invNorm
      }
    }

    return vec
  }
}
