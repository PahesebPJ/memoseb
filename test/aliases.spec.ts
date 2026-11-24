import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime, type WireSuccess } from 'hubseb'
import { executeMemoCli } from '../src/bin/memoseb.ts'
import { computeSnapshotChecksum } from '../src/core/snapshot.ts'
import { gazeNodeToMemory, memoryToGazeNode, P2P_ALIAS_ATTR } from '../src/core/p2p-contract.ts'
import {
  embeddingTextFor,
  MAX_ALIASES,
  MemoryVault,
  normalizeAliases,
  type StoreMemoryResult
} from '../src/core/vault.ts'
import { handleMcpRequest } from '../src/mcp/server.ts'

const PROJECT = 'alias-test'

describe('Memory aliases ("questions this memory answers")', () => {
  let tmpDir: string
  let vault: MemoryVault

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-aliases-test-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(() => {
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('normalizes aliases: trims, collapses spaces, dedupes case-insensitively, caps the count', () => {
    assert.deepEqual(normalizeAliases(['  ¿Cómo  se sincroniza? ', '¿cómo se sincroniza?', '', 3, 'b']), [
      '¿Cómo se sincroniza?',
      'b'
    ])
    assert.deepEqual(normalizeAliases('not an array'), [])
    assert.deepEqual(normalizeAliases(undefined), [])
    const many = Array.from({ length: MAX_ALIASES + 5 }, (_, i) => `question ${i}`)
    assert.equal(normalizeAliases(many).length, MAX_ALIASES)
  })

  it('keeps the embedding text unchanged for memories without aliases', () => {
    assert.equal(embeddingTextFor('T', 'C', ['a']), 'T\nC\na')
    assert.equal(embeddingTextFor('T', 'C', ['a'], []), 'T\nC\na')
    assert.equal(embeddingTextFor('T', 'C', ['a'], ['q1', 'q2']), 'T\nC\na\nq1\nq2')
  })

  it('finds a memory through its alias when the content shares no words with the query', () => {
    const stored = vault.storeMemory({
      projectId: PROJECT,
      content: 'Los tombstones propagan los borrados en la siguiente sincronización.',
      aliases: ['¿por qué reaparece una memoria que eliminé?']
    })
    assert.deepEqual(stored.memory.aliases, ['¿por qué reaparece una memoria que eliminé?'])
    const res = vault.recallMemories('reaparece eliminé', { projectId: PROJECT, includeGlobal: false })
    assert.equal(res.memories[0]?.id, stored.memory.id)
    assert.ok(res.memories[0]!.ftsScore > 0)
  })

  it('merges aliases when the same memory is stored again', () => {
    const content = 'memoseb node serve escucha en el puerto 7077.'
    vault.storeMemory({ projectId: PROJECT, content, aliases: ['¿qué puerto usa?'] })
    const again = vault.storeMemory({ projectId: PROJECT, content, aliases: ['which port?', '¿Qué puerto usa?'] })
    assert.equal(again.created, false)
    assert.deepEqual(again.memory.aliases, ['¿qué puerto usa?', 'which port?'])
    const res = vault.recallMemories('which port', { projectId: PROJECT, includeGlobal: false })
    assert.equal(res.memories[0]?.id, again.memory.id)
  })

  it('migrates a vault created before aliases existed and keeps it searchable', () => {
    const dbPath = path.join(tmpDir, 'legacy.sqlite')
    const legacy = new MemoryVault({ dbPath })
    const stored = legacy.storeMemory({ projectId: PROJECT, content: 'Sincronización entre nodos peer', tags: ['sync'] })
    legacy.close()

    // Recreate the pre-aliases schema: no memories.aliases, FTS without the column.
    const raw = new DatabaseSync(dbPath)
    raw.exec(`ALTER TABLE memories DROP COLUMN aliases`)
    raw.exec(`DROP TABLE memories_fts`)
    raw.exec(`CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, project_id UNINDEXED, title, content, tags)`)
    raw
      .prepare(`INSERT INTO memories_fts (memory_id, project_id, title, content, tags) VALUES (?, ?, ?, ?, ?)`)
      .run(stored.memory.id, PROJECT, stored.memory.title, stored.memory.content, 'sync')
    raw.close()

    const reopened = new MemoryVault({ dbPath })
    try {
      const res = reopened.recallMemories('sincronizacion', { projectId: PROJECT, includeGlobal: false })
      assert.equal(res.memories[0]?.id, stored.memory.id)
      assert.deepEqual(res.memories[0]?.aliases, [])
      const updated = reopened.storeMemory({
        projectId: PROJECT,
        content: 'Sincronización entre nodos peer',
        aliases: ['replicate between machines']
      })
      assert.deepEqual(updated.memory.aliases, ['replicate between machines'])
      const byAlias = reopened.recallMemories('replicate machines', { projectId: PROJECT, includeGlobal: false })
      assert.equal(byAlias.memories[0]?.id, stored.memory.id)
    } finally {
      reopened.close()
    }
    // Opening again is a no-op (idempotent migration).
    new MemoryVault({ dbPath }).close()
  })

  it('round-trips aliases through a native snapshot', () => {
    const stored = vault.storeMemory({ projectId: PROJECT, content: 'WAL permite lecturas concurrentes', aliases: ['¿pueden dos procesos abrir la bóveda?'] })
    const snapshot = vault.exportSnapshot({ projectId: PROJECT })
    assert.deepEqual(snapshot.memories[0]?.aliases, ['¿pueden dos procesos abrir la bóveda?'])

    const other = new MemoryVault({ dbPath: path.join(tmpDir, 'other.sqlite') })
    try {
      other.importSnapshot(snapshot)
      const res = other.recallMemories('procesos abrir', { projectId: PROJECT, includeGlobal: false })
      assert.equal(res.memories[0]?.id, stored.memory.id)
      assert.deepEqual(res.memories[0]?.aliases, ['¿pueden dos procesos abrir la bóveda?'])
    } finally {
      other.close()
    }
  })

  it('keeps local aliases when a newer record arrives from a node that predates aliases', () => {
    vault.storeMemory({ projectId: PROJECT, content: 'Contenido compartido', aliases: ['pregunta local'] })
    const snapshot = vault.exportSnapshot({ projectId: PROJECT })
    const legacyMemory = { ...snapshot.memories[0]!, title: 'Título nuevo', updatedAt: new Date(Date.now() + 60_000).toISOString() }
    delete legacyMemory.aliases
    const { checksum: _old, ...rest } = { ...snapshot, memories: [legacyMemory] }
    const result = vault.importSnapshot({ ...rest, checksum: computeSnapshotChecksum(rest) })
    assert.equal(result.memoriesUpdated, 1)
    const res = vault.recallMemories('pregunta local', { projectId: PROJECT, includeGlobal: false })
    assert.equal(res.memories[0]?.title, 'Título nuevo')
    assert.deepEqual(res.memories[0]?.aliases, ['pregunta local'])
  })

  it('round-trips aliases through the P2P/gaze contract as memoseb:alias attrs', () => {
    const { memory } = vault.storeMemory({ projectId: PROJECT, content: 'Gaze contract', aliases: ['q one', 'q two'] })
    const node = memoryToGazeNode(memory)
    assert.deepEqual(
      node.attrs?.filter((a) => a.key === P2P_ALIAS_ATTR).map((a) => a.value),
      ['q one', 'q two']
    )
    assert.deepEqual(gazeNodeToMemory(node).aliases, ['q one', 'q two'])

    const withoutAliases = memoryToGazeNode({ ...memory, aliases: [] })
    assert.equal(gazeNodeToMemory(withoutAliases).aliases, undefined)
  })
})

describe('Aliases from the CLI and MCP', () => {
  let tmpDir: string
  let dbPath: string
  let runtime: SystemRuntime

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-aliases-cli-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    runtime = new SystemRuntime({
      homeDir: tmpDir,
      env: {
        HOME: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
        XDG_STATE_HOME: path.join(tmpDir, '.local', 'state'),
        MEMOSEB_DB_PATH: dbPath,
        MEMOSEB_ML_DIR: path.join(tmpDir, 'ml')
      }
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('remember --aliases splits on "|" so questions may contain commas', async () => {
    const res = await executeMemoCli(
      ['remember', 'El bump toca package.json y src/version.ts', '--project', PROJECT, '--aliases', '¿qué archivos, exactamente, cambio?| where is the version? ', '--json'],
      { runtime, dbPath, cwd: tmpDir }
    )
    assert.equal(res.exitCode, 0, res.stderr)
    const stored = (decodeWire<StoreMemoryResult>(res.stdout) as WireSuccess<StoreMemoryResult>).payload
    assert.deepEqual(stored.memory.aliases, ['¿qué archivos, exactamente, cambio?', 'where is the version?'])
  })

  it('memory_store accepts an aliases array and recall finds the memory through it', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await handleMcpRequest(vault, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
        return JSON.parse(((response?.result as { content: Array<{ text: string }> }).content[0]!).text)
      }
      const stored = await call('memory_store', {
        content: 'Stripe Checkout maneja los datos de tarjeta',
        projectId: PROJECT,
        aliases: ['do we keep credit card numbers?']
      })
      assert.deepEqual(stored.memory.aliases, ['do we keep credit card numbers?'])
      const recall = await call('memory_recall', { query: 'credit card numbers', projectId: PROJECT })
      assert.equal(recall.memories[0]?.id, stored.memory.id)
    } finally {
      vault.close()
    }
  })
})
