import type { MemoryVault, RecallResult } from '../../src/core/vault.ts'
import {
  EVAL_MEMORIES,
  LEXICAL_QUERIES,
  PARAPHRASE_QUERIES,
  UNRELATED_QUERIES,
  type EvalLanguage,
  type EvalQuery
} from './recall-eval-data.ts'

export * from './recall-eval-data.ts'

export const EVAL_PROJECT_ID = 'recall-eval'
export const EVAL_LANGUAGES: readonly EvalLanguage[] = ['es', 'en', 'mixed']

export interface SeedOptions {
  /** Store each memory's "questions it answers" too (off measures the plain text only). */
  withAliases?: boolean
}

export function seedEvalVault(vault: MemoryVault, _options: SeedOptions = {}): Map<string, string> {
  const idByKey = new Map<string, string>()
  for (const memory of EVAL_MEMORIES) {
    const stored = vault.storeMemory({
      projectId: EVAL_PROJECT_ID,
      category: memory.category,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      importance: 0.5
    })
    idByKey.set(memory.key, stored.memory.id)
  }
  for (const { expected, query } of [...LEXICAL_QUERIES, ...PARAPHRASE_QUERIES]) {
    if (!idByKey.has(expected)) throw new Error(`Eval query "${query}" expects unknown memory "${expected}"`)
  }
  return idByKey
}

export interface EvalMetrics {
  count: number
  recallAt1: number
  recallAt3: number
  mrr: number
  misses: string[]
}

export interface EvalReport {
  lexical: EvalMetrics
  paraphrase: EvalMetrics
  /** Answerable queries (lexical + paraphrase) split by query language. */
  byLanguage: Record<EvalLanguage, EvalMetrics>
  /** Average number of results returned for unrelated queries (lower is better). */
  noisePerQuery: number
}

export type RecallFn = (query: string) => RecallResult | Promise<RecallResult>

interface QueryOutcome {
  query: EvalQuery
  rank: number
}

function summarize(outcomes: readonly QueryOutcome[]): EvalMetrics {
  let top1 = 0
  let top3 = 0
  let reciprocalSum = 0
  const misses: string[] = []
  for (const { query, rank } of outcomes) {
    if (rank === 1) top1++
    if (rank > 0 && rank <= 3) top3++
    else misses.push(`[${query.lang}] ${query.query} → ${query.expected} (rank ${rank || '-'})`)
    if (rank > 0) reciprocalSum += 1 / rank
  }
  const count = outcomes.length
  const ratio = (value: number): number => (count === 0 ? 0 : value / count)
  return { count, recallAt1: ratio(top1), recallAt3: ratio(top3), mrr: ratio(reciprocalSum), misses }
}

export async function runRecallEval(idByKey: Map<string, string>, recall: RecallFn): Promise<EvalReport> {
  const outcomes: QueryOutcome[] = []
  for (const query of [...LEXICAL_QUERIES, ...PARAPHRASE_QUERIES]) {
    const result = await recall(query.query)
    const rank = result.memories.findIndex((m) => m.id === idByKey.get(query.expected)) + 1
    outcomes.push({ query, rank })
  }
  let noise = 0
  for (const { query } of UNRELATED_QUERIES) {
    noise += (await recall(query)).memories.length
  }
  const byLanguage = Object.fromEntries(
    EVAL_LANGUAGES.map((lang) => [lang, summarize(outcomes.filter((o) => o.query.lang === lang))])
  ) as Record<EvalLanguage, EvalMetrics>
  return {
    lexical: summarize(outcomes.filter((o) => o.query.kind === 'lexical')),
    paraphrase: summarize(outcomes.filter((o) => o.query.kind === 'paraphrase')),
    byLanguage,
    noisePerQuery: noise / UNRELATED_QUERIES.length
  }
}

export function evalRecallOptions(): { projectId: string; includeGlobal: boolean; limit: number; maxTokens: number } {
  return { projectId: EVAL_PROJECT_ID, includeGlobal: false, limit: 5, maxTokens: 100_000 }
}

export function formatEvalReport(label: string, report: EvalReport, options: { misses?: boolean } = {}): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`.padStart(6)
  const row = (name: string, m: EvalMetrics): string =>
    `  ${name.padEnd(10)} n=${String(m.count).padStart(2)}  R@1=${pct(m.recallAt1)}  R@3=${pct(m.recallAt3)}  MRR=${m.mrr.toFixed(3)}`
  const lines = [
    `[recall-eval] ${label}`,
    row('lexical', report.lexical),
    row('paraphrase', report.paraphrase),
    ...EVAL_LANGUAGES.map((lang) => row(`lang:${lang}`, report.byLanguage[lang])),
    `  noise      ${report.noisePerQuery.toFixed(2)} results per unrelated query`
  ]
  if (options.misses ?? true) {
    lines.push(
      ...report.lexical.misses.map((m) => `  miss(lexical) ${m}`),
      ...report.paraphrase.misses.map((m) => `  miss(paraphrase) ${m}`)
    )
  }
  return lines.join('\n')
}
