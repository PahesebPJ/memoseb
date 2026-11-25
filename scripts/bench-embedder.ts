// Measures RAM, load time, latency and recall quality of a catalog model, optionally
// with a reranker on top, over the bundled evaluation fixture.
// Usage: MEMOSEB_ML_DIR=<dir with runtime/> node scripts/bench-embedder.ts <model-id|hash>
//          [--reranker <id>] [--aliases] [--misses]
// Models are downloaded into <dir>/models on first run.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cosineSimilarity } from '../src/core/embedder.ts'
import { findModelSpec, findRerankerSpec, LEXICAL_MODEL_ID } from '../src/core/model-catalog.ts'
import { recallWithEmbedder, reindexVault } from '../src/core/semantic.ts'
import {
  resolveMlPaths,
  TransformersEmbedder,
  TransformersReranker,
  type SemanticEmbedder,
  type SemanticReranker
} from '../src/core/transformers-embedder.ts'
import { embeddingTextFor, MemoryVault } from '../src/core/vault.ts'
import {
  EVAL_MEMORIES,
  evalRecallOptions,
  formatEvalReport,
  LEXICAL_QUERIES,
  PARAPHRASE_QUERIES,
  runRecallEval,
  seedEvalVault,
  UNRELATED_QUERIES
} from '../test/fixtures/recall-eval.ts'

const args = process.argv.slice(2)
const flagValue = (name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const rerankerId = flagValue('--reranker')
const withAliases = args.includes('--aliases')
const modelId = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--reranker') ?? 'e5-small'

const spec = findModelSpec(modelId === 'lexical' ? LEXICAL_MODEL_ID : modelId)
const rerankerSpec = rerankerId ? findRerankerSpec(rerankerId) : undefined
if (!spec || (rerankerId && !rerankerSpec)) {
  console.error('Usage: node scripts/bench-embedder.ts <model id|hash> [--reranker <id>] [--aliases] [--misses]')
  process.exit(2)
}
if (!process.env.MEMOSEB_ML_DIR && (spec.hfModel || rerankerSpec)) {
  console.error('Set MEMOSEB_ML_DIR to a directory containing runtime/node_modules/@huggingface/transformers')
  process.exit(2)
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MB`
const paths = resolveMlPaths('unused.sqlite')
const label = [spec.id, rerankerSpec ? `+ ${rerankerSpec.id}` : '', withAliases ? '+ aliases' : '']
  .filter(Boolean)
  .join(' ')
console.log(`[bench] ${label}`)

const passages = EVAL_MEMORIES.map((m) =>
  embeddingTextFor(m.title, m.content, m.tags ?? [], withAliases ? (m.aliases ?? []) : [])
)
let embedder: SemanticEmbedder | null = null
if (spec.hfModel) {
  const rssBefore = process.memoryUsage().rss
  const loaded = new TransformersEmbedder(spec, paths, { allowRemote: true })
  let t = performance.now()
  await loaded.load()
  const loadMs = performance.now() - t
  const rssLoaded = process.memoryUsage().rss
  t = performance.now()
  const runs = 20
  for (let i = 0; i < runs; i++) await loaded.embedQuery(`how does the sync protocol work ${i}`)
  const queryMs = (performance.now() - t) / runs
  t = performance.now()
  await loaded.embedPassages(passages)
  const batchMs = performance.now() - t
  console.log(`  embedder RAM      : +${mb(rssLoaded - rssBefore)} loaded, ${mb(process.memoryUsage().rss)} RSS after batch`)
  console.log(`  embedder load     : ${loadMs.toFixed(0)} ms (includes download on first run)`)
  console.log(`  query embedding   : ${queryMs.toFixed(1)} ms avg over ${runs}`)
  console.log(`  passages batch    : ${(batchMs / passages.length).toFixed(1)} ms each (${passages.length})`)
  embedder = loaded
}

let reranker: SemanticReranker | null = null
if (rerankerSpec) {
  const rssBefore = process.memoryUsage().rss
  const loaded = new TransformersReranker(rerankerSpec, paths, { allowRemote: true })
  const t = performance.now()
  await loaded.load()
  console.log(`  reranker RAM      : +${mb(process.memoryUsage().rss - rssBefore)} loaded`)
  console.log(`  reranker load     : ${(performance.now() - t).toFixed(0)} ms`)
  reranker = loaded
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-bench-'))
const vault = new MemoryVault({ dbPath: path.join(dir, 'vault.sqlite') })
try {
  const ids = seedEvalVault(vault, { withAliases })
  if (embedder) await reindexVault(vault, embedder)
  let recallMs = 0
  let recalls = 0
  const report = await runRecallEval(ids, async (query) => {
    const t = performance.now()
    const result = await recallWithEmbedder(vault, query, evalRecallOptions(), embedder, reranker)
    recallMs += performance.now() - t
    recalls++
    if (result.warning) throw new Error(result.warning)
    return result
  })
  console.log(`  recall latency    : ${(recallMs / recalls).toFixed(0)} ms avg per query (end to end)`)
  console.log(formatEvalReport(label, report, { misses: args.includes('--misses') }))

  // Calibration of the vector-only noise floor: for each candidate minSimilarity,
  // how many answerable queries keep their expected memory vs unrelated queries kept.
  if (embedder) {
    const vectors = await embedder.embedPassages(passages)
    const keyIndex = new Map(EVAL_MEMORIES.map((m, i) => [m.key, i]))
    const expectedSims: number[] = []
    for (const { query, expected } of [...LEXICAL_QUERIES, ...PARAPHRASE_QUERIES]) {
      const q = await embedder.embedQuery(query)
      expectedSims.push(cosineSimilarity(q, vectors[keyIndex.get(expected)!]!))
    }
    const unrelatedBest: number[] = []
    for (const { query } of UNRELATED_QUERIES) {
      const q = await embedder.embedQuery(query)
      unrelatedBest.push(Math.max(...vectors.map((v) => cosineSimilarity(q, v))))
    }
    const sorted = [...expectedSims].sort((a, b) => a - b)
    const pctl = (p: number): number => sorted[Math.floor((sorted.length - 1) * p)]!
    console.log(
      `  calibration: expected-memory cosine p10=${pctl(0.1).toFixed(3)} p25=${pctl(0.25).toFixed(3)} p50=${pctl(0.5).toFixed(3)} | unrelated best max=${Math.max(...unrelatedBest).toFixed(3)} median=${[...unrelatedBest].sort((a, b) => a - b)[Math.floor(unrelatedBest.length / 2)]!.toFixed(3)} (current minSimilarity=${spec.minSimilarity})`
    )
    for (const floor of [-0.04, -0.02, 0, 0.02, 0.04].map((d) => Number((spec.minSimilarity + d).toFixed(2)))) {
      const kept = expectedSims.filter((s) => s >= floor).length
      const noisy = unrelatedBest.filter((s) => s >= floor).length
      console.log(`    floor ${floor.toFixed(2)}: expected kept ${kept}/${expectedSims.length}, unrelated with a hit ${noisy}/${unrelatedBest.length}`)
    }
  }
} finally {
  vault.close()
  fs.rmSync(dir, { recursive: true, force: true })
  await embedder?.dispose()
  await reranker?.dispose()
}
