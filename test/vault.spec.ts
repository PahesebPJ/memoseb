import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  cosineSimilarity,
  deserializeVector,
  LocalFeatureHashEmbedder,
  serializeVector
} from '../src/core/embedder.ts'
import { MemoryVault, sanitizeFtsQuery } from '../src/core/vault.ts'

describe('MemoryVault & Hybrid Search Engine', () => {
  let tmpDir: string
  let dbPath: string
  let vault: MemoryVault

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-vault-test-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    vault = new MemoryVault({ dbPath })
  })

  afterEach(() => {
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('initializes SQLite vault in an isolated temporary directory and reports zeroed stats', () => {
    assert.equal(fs.existsSync(dbPath), true)
    const stats = vault.getStats()
    assert.equal(stats.dbPath, dbPath)
    assert.equal(stats.projectCount, 0)
    assert.equal(stats.memoryCount, 0)
    assert.equal(stats.vectorCount, 0)
    assert.equal(stats.totalTokens, 0)
  })

  it('stores memories and deduplicates identical content per project via SHA-256 content_hash', () => {
    const first = vault.storeMemory({
      projectId: 'project-alpha',
      category: 'architecture',
      title: 'Initial Title',
      content: 'Use SQLite WAL mode with FTS5 and Float32Array vectors.',
      tags: ['sqlite', 'fts5'],
      sourceAgent: 'architect',
      importance: 0.7
    })

    assert.equal(first.created, true)
    assert.equal(first.memory.projectId, 'project-alpha')
    assert.equal(first.memory.category, 'architecture')
    assert.equal(first.memory.title, 'Initial Title')
    assert.deepEqual(first.memory.tags, ['sqlite', 'fts5'])
    assert.equal(first.memory.importance, 0.7)
    assert.equal(first.memory.contentHash.length, 64)

    const duplicate = vault.storeMemory({
      projectId: 'project-alpha',
      category: 'architecture',
      title: 'Updated Title',
      content: '  Use SQLite WAL mode with FTS5 and Float32Array vectors.  ',
      tags: ['sqlite', 'fts5', 'hybrid'],
      importance: 0.95
    })

    assert.equal(duplicate.created, false)
    assert.equal(duplicate.memory.id, first.memory.id)
    assert.equal(duplicate.memory.contentHash, first.memory.contentHash)
    assert.equal(duplicate.memory.title, 'Updated Title')
    assert.deepEqual(duplicate.memory.tags, ['sqlite', 'fts5', 'hybrid'])
    assert.equal(duplicate.memory.importance, 0.95)

    const stats = vault.getStats()
    assert.equal(stats.memoryCount, 1)
    assert.equal(stats.vectorCount, 1)
    assert.equal(stats.projectCount, 1)
  })

  it('enforces strict isolation between project-alpha and project-beta while optionally including global memories', () => {
    vault.storeMemory({
      projectId: 'project-alpha',
      category: 'decision',
      title: 'Alpha Auth Strategy',
      content: 'Authenticate microservice calls using Ed25519 signed JWT tokens.'
    })

    vault.storeMemory({
      projectId: 'project-beta',
      category: 'decision',
      title: 'Beta Auth Strategy',
      content: 'Authenticate legacy endpoints using mutual TLS client certificates.'
    })

    vault.storeMemory({
      projectId: 'global',
      category: 'convention',
      title: 'Global Commit Standard',
      content: 'All repositories use Conventional Commits and Ed25519 commit signing.'
    })

    const alphaWithGlobal = vault.recallMemories('Ed25519', {
      projectId: 'project-alpha',
      includeGlobal: true
    })
    const alphaIds = alphaWithGlobal.memories.map((m) => m.projectId)
    assert.equal(alphaIds.includes('project-alpha'), true)
    assert.equal(alphaIds.includes('global'), true)
    assert.equal(alphaIds.includes('project-beta'), false)

    const alphaStrict = vault.recallMemories('Ed25519', {
      projectId: 'project-alpha',
      includeGlobal: false
    })
    assert.equal(alphaStrict.memories.length, 1)
    assert.equal(alphaStrict.memories[0]?.projectId, 'project-alpha')

    const betaRecall = vault.recallMemories('certificates mutual TLS', {
      projectId: 'project-beta',
      includeGlobal: false
    })
    assert.equal(betaRecall.memories.length, 1)
    assert.equal(betaRecall.memories[0]?.projectId, 'project-beta')

    const projects = vault.listProjects()
    assert.equal(projects.length, 3)
  })

  it('performs hybrid RRF search (dense Float32Array vector + FTS5 BM25) and handles special characters safely', () => {
    const embedder = new LocalFeatureHashEmbedder()
    const v1 = embedder.embed('sqlite fts5 vector search')
    const serialized = serializeVector(v1)
    const restored = deserializeVector(serialized)
    assert.ok(Math.abs(cosineSimilarity(v1, restored) - 1) < 1e-6)

    vault.storeMemory({
      projectId: 'project-alpha',
      category: 'bugfix',
      title: 'FTS5 Syntax Escape Fix',
      content:
        'Sanitize special FTS5 operators like :, -, /, ", and * before running MATCH queries in SQLite.',
      tags: ['sqlite', 'fts5', 'security'],
      importance: 0.9
    })

    vault.storeMemory({
      projectId: 'project-alpha',
      category: 'domain',
      title: 'Unrelated Queue Worker',
      content: 'Background cron jobs poll Redis streams every 30 seconds.',
      tags: ['redis', 'cron'],
      importance: 0.3
    })

    const sanitized = sanitizeFtsQuery('fts5: syntax-error / "quote" * wildcard*')
    assert.ok(sanitized.length > 0)

    const specialQueryResult = vault.recallMemories(
      'fts5: syntax-error / "quote" * -- SQLite?:*!',
      { projectId: 'project-alpha' }
    )
    assert.ok(specialQueryResult.memories.length >= 1)
    assert.equal(specialQueryResult.memories[0]?.title, 'FTS5 Syntax Escape Fix')
    assert.ok((specialQueryResult.memories[0]?.score ?? 0) > 0)
    assert.ok((specialQueryResult.memories[0]?.vectorScore ?? 0) > 0)
    assert.ok((specialQueryResult.memories[0]?.ftsScore ?? 0) > 0)
    assert.equal(specialQueryResult.memories[0]?.accessCount, 1)

    const pureSymbolsResult = vault.recallMemories('::: --- /// """ ***', {
      projectId: 'project-alpha'
    })
    assert.equal(Array.isArray(pureSymbolsResult.memories), true)
  })

  it('enforces strict maxTokens budget truncation in recallMemories and getProjectBriefing', () => {
    const first = vault.storeMemory({
      projectId: 'project-alpha',
      category: 'architecture',
      title: 'Core Architecture Priority 1',
      content:
        'High priority architectural rule covering modular hexagonal adapters and strict boundaries.',
      importance: 1.0
    })

    const second = vault.storeMemory({
      projectId: 'project-alpha',
      category: 'convention',
      title: 'Code Convention Priority 2',
      content:
        'Secondary coding convention requiring explicit return types on all exported TypeScript functions.',
      importance: 0.8
    })

    vault.storeMemory({
      projectId: 'project-alpha',
      category: 'domain',
      title: 'Domain Note Priority 3',
      content:
        'Tertiary domain context describing billing invoice reconciliation and ledger settlement.',
      importance: 0.4
    })

    const tightBudget = first.memory.tokenCount + 2
    assert.ok(tightBudget < first.memory.tokenCount + second.memory.tokenCount)

    const briefing = vault.getProjectBriefing({
      projectId: 'project-alpha',
      maxTokens: tightBudget
    })
    assert.equal(briefing.projectId, 'project-alpha')
    assert.equal(briefing.truncatedByBudget, true)
    assert.equal(briefing.memories.length, 1)
    assert.equal(briefing.memories[0]?.id, first.memory.id)
    assert.ok(briefing.totalTokens <= tightBudget)

    const recallBudgeted = vault.recallMemories('priority architecture convention domain', {
      projectId: 'project-alpha',
      maxTokens: tightBudget,
      limit: 5
    })
    assert.equal(recallBudgeted.truncatedByBudget, true)
    assert.ok(recallBudgeted.totalTokens <= tightBudget)
    assert.equal(recallBudgeted.memories.length, 1)
  })

  it('completely removes records from memories, memories_fts, and memory_vectors on forgetMemory(id)', () => {
    const stored = vault.storeMemory({
      projectId: 'project-alpha',
      category: 'bugfix',
      title: 'Memory Leak in Worker',
      content: 'Close DatabaseSync handles in finally blocks to avoid file descriptor leaks.'
    })

    const id = stored.memory.id
    assert.equal(vault.getStats().memoryCount, 1)
    assert.equal(vault.getStats().vectorCount, 1)

    const deleted = vault.forgetMemory(id)
    assert.equal(deleted, true)
    assert.equal(vault.forgetMemory(id), false)

    assert.equal(vault.getStats().memoryCount, 0)
    assert.equal(vault.getStats().vectorCount, 0)

    const verifyDb = new DatabaseSync(dbPath)
    try {
      const memCount = verifyDb
        .prepare('SELECT COUNT(*) AS cnt FROM memories WHERE id = ?')
        .get(id) as { cnt: number }
      const ftsCount = verifyDb
        .prepare('SELECT COUNT(*) AS cnt FROM memories_fts WHERE memory_id = ?')
        .get(id) as { cnt: number }
      const vecCount = verifyDb
        .prepare('SELECT COUNT(*) AS cnt FROM memory_vectors WHERE memory_id = ?')
        .get(id) as { cnt: number }

      assert.equal(Number(memCount.cnt), 0)
      assert.equal(Number(ftsCount.cnt), 0)
      assert.equal(Number(vecCount.cnt), 0)
    } finally {
      verifyDb.close()
    }
  })
})
