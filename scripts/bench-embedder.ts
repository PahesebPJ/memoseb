// Measures RAM, load time, latency and recall quality of a catalog model.
// Usage: MEMOSEB_ML_DIR=<dir with runtime/> node scripts/bench-embedder.ts <model-id>
// The model is downloaded into <dir>/models on first run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cosineSimilarity } from '../src/core/embedder.ts'
import { findModelSpec } from '../src/core/model-catalog.ts'
import { recallWithEmbedder, reindexVault } from '../src/core/semantic.ts'
import { resolveMlPaths, TransformersEmbedder } from '../src/core/transformers-embedder.ts'
import { MemoryVault } from '../src/core/vault.ts'
import {
  EVAL_MEMORIES,
  evalRecallOptions,
  formatEvalReport,
  LEXICAL_QUERIES,
  runRecallEval,
  seedEvalVault,
  PARAPHRASE_QUERIES,
  UNRELATED_QUERIES
} from '../test/fixtures/recall-eval.ts'

const spec = findModelSpec(process.argv[2] ?? 'e5-small')
if (!spec?.hfModel) {
  console.error('Usage: node scripts/bench-embedder.ts <semantic model id>')
  process.exit(2)
}
if (!process.env.MEMOSEB_ML_DIR) {
  console.error('Set MEMOSEB_ML_DIR to a directory containing runtime/node_modules/@huggingface/transformers')
  process.exit(2)
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`
const paths = resolveMlPaths('unused.sqlite')
const rssBefore = process.memoryUsage().rss

const embedder = new TransformersEmbedder(spec, paths, { allowRemote: true })
let t = performance.now()
await embedder.load()
const loadMs = performance.now() - t
const rssLoaded = process.memoryUsage().rss

t = performance.now()
const runs = 20
for (let i = 0; i < runs; i++) await embedder.embedQuery(`how does the sync protocol work ${i}`)
const queryMs = (performance.now() - t) / runs

const passages = EVAL_MEMORIES.map((m) => `${m.title}\n${m.content}`)
t = performance.now()
await embedder.embedPassages(passages)
const batchMs = performance.now() - t
const rssPeak = process.memoryUsage().rss

console.log(`[bench] ${spec.id} (${spec.hfModel})`)
console.log(`  RSS before load   : ${mb(rssBefore)}`)
console.log(`  RSS model loaded  : ${mb(rssLoaded)} (+${mb(rssLoaded - rssBefore)})`)
console.log(`  RSS after batch   : ${mb(rssPeak)}`)
console.log(`  load time         : ${loadMs.toFixed(0)} ms (includes download on first run)`)
console.log(`  query latency     : ${queryMs.toFixed(1)} ms avg over ${runs}`)
console.log(`  passages batch    : ${batchMs.toFixed(0)} ms for ${passages.length} (${(batchMs / passages.length).toFixed(1)} ms each)`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-bench-'))
const vault = new MemoryVault({ dbPath: path.join(dir, 'vault.sqlite') })
try {
  const ids = seedEvalVault(vault)
  await reindexVault(vault, embedder)
  const report = await runRecallEval(ids, (query) =>
    recallWithEmbedder(vault, query, evalRecallOptions(), embedder)
  )
  console.log(formatEvalReport(spec.id, report))

  // Similarity calibration: best match for answerable queries vs unrelated ones.
  const memoryVectors = await embedder.embedPassages(passages)
  const best = async (query: string): Promise<number> => {
    const q = await embedder.embedQuery(query)
    return Math.max(...memoryVectors.map((v) => cosineSimilarity(q, v)))
  }
  const relevant = []
  for (const { query } of [...LEXICAL_QUERIES, ...PARAPHRASE_QUERIES]) relevant.push(await best(query))
  const unrelated = []
  for (const { query } of UNRELATED_QUERIES) unrelated.push(await best(query))
  console.log(`  calibration: relevant top-1 min=${Math.min(...relevant).toFixed(3)} | unrelated top-1 max=${Math.max(...unrelated).toFixed(3)} (current minSimilarity=${spec.minSimilarity})`)
} finally {
  vault.close()
  fs.rmSync(dir, { recursive: true, force: true })
  await embedder.dispose()
}
