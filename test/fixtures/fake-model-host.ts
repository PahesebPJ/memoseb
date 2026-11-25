import { runModelHost } from '../../src/core/model-host.ts'
import { vectorModelTag, type EmbedderModelSpec, type RerankerModelSpec } from '../../src/core/model-catalog.ts'

const delayOf = (text: string) => (text.startsWith('slow:') ? Number(text.slice(5).split(':')[0]) : 0)
const pause = (text: string) => new Promise<void>((r) => setTimeout(r, delayOf(text)))

const vector = (text: string) => {
  if (text === 'crash') process.exit(3)
  if (text === 'boom') throw new Error('onnx exploded')
  return Float32Array.from([text.length, process.pid])
}

runModelHost({
  createEmbedder: (spec: EmbedderModelSpec) => ({
    spec,
    model: vectorModelTag(spec),
    dimensions: 2,
    embedQuery: async (text: string) => (await pause(text), vector(text)),
    embedPassages: async (texts: readonly string[]) => texts.map(vector),
    dispose: async () => {}
  }),
  createReranker: (spec: RerankerModelSpec) => ({
    spec,
    score: async (query: string, passages: readonly string[]) => {
      if (query === 'boom') throw new Error('rerank exploded')
      return passages.map((p) => p.length / 100)
    },
    dispose: () => new Promise<void>((resolve) => setTimeout(resolve, Number(process.env.FAKE_HOST_DISPOSE_MS ?? 0)))
  })
})
