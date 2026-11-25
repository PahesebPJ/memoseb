import { runModelHost } from './model-host.ts'
import { TransformersEmbedder, TransformersReranker } from './transformers-embedder.ts'

// Entry forked by ModelHostClient; models are only ever read from disk here.
runModelHost({
  createEmbedder: (spec, paths) => new TransformersEmbedder(spec, paths),
  createReranker: (spec, paths) => new TransformersReranker(spec, paths)
})
