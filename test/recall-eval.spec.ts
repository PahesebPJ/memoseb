import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { LEXICAL_EMBEDDER_MODEL, LocalFeatureHashEmbedder } from '../src/core/embedder.ts'
import { contentTokens, normalizeText } from '../src/core/text.ts'
import { MemoryVault, sanitizeFtsQuery } from '../src/core/vault.ts'
import {
  evalRecallOptions,
  formatEvalReport,
  runRecallEval,
  seedEvalVault
} from './fixtures/recall-eval.ts'

describe('Text normalization shared by FTS5 and the lexical embedder', () => {
  it('strips diacritics so accented words match the unicode61 index', () => {
    assert.equal(normalizeText('Sincronización Jerárquica Ñandú'), 'sincronizacion jerarquica nandu')
    assert.equal(sanitizeFtsQuery('sincronización'), '"sincronizacion"')
  })

  it('drops Spanish and English stopwords but keeps queries made only of stopwords', () => {
    assert.deepEqual(contentTokens('cómo funciona la sincronización'), ['funciona', 'sincronizacion'])
    assert.deepEqual(contentTokens('how does the sync work'), ['sync', 'work'])
    assert.deepEqual(contentTokens('the'), ['the'])
  })

  it('tokenizes like FTS5 unicode61 (underscores split identifiers)', () => {
    assert.deepEqual(contentTokens('sync_groups'), ['sync', 'groups'])
  })

  it('produces identical lexical vectors for accented and unaccented spellings', () => {
    const embedder = new LocalFeatureHashEmbedder()
    assert.deepEqual(embedder.embed('sincronización'), embedder.embed('sincronizacion'))
  })
})

describe('Recall precision evaluation (lexical hash embedder)', () => {
  let tmpDir: string
  let vault: MemoryVault

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-eval-test-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(() => {
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('meets the lexical precision bar and returns nothing for unrelated queries', async () => {
    const ids = seedEvalVault(vault)
    const report = await runRecallEval(ids, (q) => vault.recallMemories(q, evalRecallOptions()))
    const summary = formatEvalReport('lexical hash', report)
    // Baseline before this change: recall@3 94.4%, MRR 0.900, noise 5.00/query.
    assert.ok(report.lexical.recallAt3 >= 0.95, summary)
    assert.ok(report.lexical.mrr >= 0.9, summary)
    assert.equal(report.noisePerQuery, 0, summary)
  })

  it('finds an accented memory from an accented query (regression: 0 FTS hits before)', () => {
    const ids = seedEvalVault(vault)
    const res = vault.recallMemories('como funciona la sincronización', evalRecallOptions())
    assert.equal(res.memories[0]?.id, ids.get('sync-p2p'))
    assert.ok((res.memories[0]?.ftsScore ?? 0) > 0)
  })

  it('re-embeds vectors from an older lexical model when the vault is opened', () => {
    const dbPath = path.join(tmpDir, 'legacy.sqlite')
    const legacy = new MemoryVault({ dbPath })
    const stored = legacy.storeMemory({ projectId: 'legacy', content: 'Sincronización entre nodos peer' })
    legacy.close()

    const raw = new DatabaseSync(dbPath)
    raw.prepare(`UPDATE memory_vectors SET model = 'local-feature-hash-v1'`).run()
    raw.close()

    const reopened = new MemoryVault({ dbPath })
    try {
      assert.deepEqual(reopened.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }])
      const res = reopened.recallMemories('sincronizacion', { projectId: 'legacy' })
      assert.equal(res.memories[0]?.id, stored.memory.id)
    } finally {
      reopened.close()
    }
  })

  it('ignores vectors produced by a different model during recall', () => {
    vault.storeMemory({ projectId: 'mixed', content: 'zeta omega lambda kappa' })
    const res = vault.recallMemories('zetta omegga', {
      projectId: 'mixed',
      vectorModel: 'hf:some/other-model'
    })
    assert.equal(res.memories.length, 0)
  })

  it('reports near-duplicate memories instead of silently storing a twin', () => {
    const first = vault.storeMemory({
      projectId: 'dup',
      category: 'bugfix',
      content: 'memoseb node serve fails with EADDRINUSE when port 7077 is already in use'
    })
    const second = vault.storeMemory({
      projectId: 'dup',
      category: 'bugfix',
      content: 'memoseb node serve fails with EADDRINUSE when port 7078 is already in use'
    })
    assert.equal(second.created, true)
    assert.equal(second.similar?.[0]?.id, first.memory.id)

    const unrelated = vault.storeMemory({
      projectId: 'dup',
      category: 'bugfix',
      content: 'FTS5 MATCH crashed on unbalanced double quotes in the query'
    })
    assert.equal(unrelated.similar, undefined)
  })
})
