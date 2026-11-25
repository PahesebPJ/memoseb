import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime, type WireSuccess } from 'hubseb'
import { executeMemoCli, type ExecuteMemoCliOptions } from '../src/bin/memoseb.ts'
import {
  findRerankerSpec,
  RERANKER_CATALOG,
  type EmbedderModelSpec,
  type RerankerModelSpec
} from '../src/core/model-catalog.ts'
import { computeP2PPayloadChecksum, P2P_ALIAS_ATTR } from '../src/core/p2p-contract.ts'
import { recallWithEmbedder, type MlBackend } from '../src/core/semantic.ts'
import { computeSnapshotChecksum } from '../src/core/snapshot.ts'
import { contentTokens } from '../src/core/text.ts'
import {
  modelCacheDir,
  MODEL_READY_MARKER,
  type MlPaths,
  type SemanticEmbedder,
  type SemanticReranker
} from '../src/core/transformers-embedder.ts'
import { MAX_ALIAS_LENGTH, MAX_ALIASES, MemoryVault, normalizeAliases } from '../src/core/vault.ts'

const PROJECT = 'gaps-test'
const V2 = findRerankerSpec('bge-reranker-v2-m3')!

class OverlapReranker implements SemanticReranker {
  readonly spec: RerankerModelSpec = { ...V2, minScore: 0 }
  seen: string[][] = []
  async score(query: string, passages: readonly string[]): Promise<number[]> {
    this.seen.push([...passages])
    const q = new Set(contentTokens(query))
    return passages.map((p) => contentTokens(p).filter((t) => q.has(t)).length / Math.max(1, q.size))
  }
  async dispose(): Promise<void> {}
}

class ThrowingReranker extends OverlapReranker {
  override async score(): Promise<number[]> {
    throw new Error('rerank down')
  }
}

const failingEmbedder = (): SemanticEmbedder => ({
  spec: { id: 'fake', minSimilarity: 0.1 } as unknown as EmbedderModelSpec,
  model: 'fake',
  dimensions: 4,
  embedQuery: async () => {
    throw new Error('embedder down')
  },
  embedPassages: async () => {
    throw new Error('embedder down')
  },
  dispose: async () => {}
})

function useVault() {
  const ctx = {} as { tmpDir: string; vault: MemoryVault }
  beforeEach(() => {
    ctx.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-gaps-'))
    ctx.vault = new MemoryVault({ dbPath: path.join(ctx.tmpDir, 'vault.sqlite') })
  })
  afterEach(() => {
    ctx.vault.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })
  return ctx
}

describe('normalizeAliases limits', () => {
  it('ignores non-arrays and non-string/blank items, truncates and caps', () => {
    assert.deepEqual(normalizeAliases(undefined), [])
    assert.deepEqual(normalizeAliases('a|b'), [])
    assert.deepEqual(normalizeAliases([1, null, {}, '   ', '\n\t', ' ok  \n question ']), ['ok question'])
    const long = normalizeAliases(['x'.repeat(MAX_ALIAS_LENGTH + 50)])
    assert.equal(long[0]?.length, MAX_ALIAS_LENGTH)
    const many = normalizeAliases(Array.from({ length: MAX_ALIASES + 8 }, (_, i) => `question ${i}`))
    assert.equal(many.length, MAX_ALIASES)
    assert.equal(many.at(-1), `question ${MAX_ALIASES - 1}`)
  })

  it('dedupes case-insensitively after truncation and whitespace collapsing', () => {
    const base = 'y'.repeat(MAX_ALIAS_LENGTH)
    assert.deepEqual(normalizeAliases([`${base}AAA`, `${base}bbb`]), [base])
    assert.deepEqual(normalizeAliases(['Where  IS it', 'where is\nit']), ['Where IS it'])
  })
})

describe('Aliases across import --replace and P2P exchange', () => {
  const ctx = useVault()
  const opts = { projectId: PROJECT, includeGlobal: false }

  it('replace import drops local aliases and indexes the incoming ones', () => {
    const { vault, tmpDir } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'Shared note body', aliases: ['zebra inquiry'] })
    const other = new MemoryVault({ dbPath: path.join(tmpDir, 'other.sqlite') })
    try {
      other.storeMemory({ projectId: PROJECT, content: 'Shared note body', aliases: ['walrus riddle'] })
      vault.importSnapshot(other.exportSnapshot({ projectId: PROJECT }), { strategy: 'replace', projectId: PROJECT })
      assert.equal(vault.recallMemories('zebra inquiry', opts).memories.length, 0)
      assert.deepEqual(vault.recallMemories('walrus riddle', opts).memories[0]?.aliases, ['walrus riddle'])
    } finally {
      other.close()
    }
  })

  it('merge import of an older incoming record keeps local aliases searchable', () => {
    const { vault, tmpDir } = ctx
    const other = new MemoryVault({ dbPath: path.join(tmpDir, 'other.sqlite') })
    try {
      other.storeMemory({ projectId: PROJECT, content: 'Same body', aliases: ['remote alias'] })
      vault.storeMemory({ projectId: PROJECT, content: 'Same body', aliases: ['local alias'] })
      const { checksum: _c, ...rest } = other.exportSnapshot({ projectId: PROJECT })
      rest.memories[0]!.updatedAt = new Date(0).toISOString()
      vault.importSnapshot({ ...rest, checksum: computeSnapshotChecksum(rest) })
      assert.deepEqual(vault.recallMemories('local alias', opts).memories[0]?.aliases, ['local alias'])
    } finally {
      other.close()
    }
  })

  it('P2P payload exchange carries aliases to a fresh node and makes them FTS-searchable', () => {
    const { vault, tmpDir } = ctx
    const stored = vault.storeMemory({ projectId: PROJECT, content: 'Opaque body', aliases: ['how do peers sync?', 'second q'] })
    const other = new MemoryVault({ dbPath: path.join(tmpDir, 'p2p.sqlite') })
    try {
      other.importP2PPayload(vault.exportP2PPayload({ projectId: PROJECT }))
      const res = other.recallMemories('peers sync', opts)
      assert.equal(res.memories[0]?.id, stored.memory.id)
      assert.deepEqual(res.memories[0]?.aliases, ['how do peers sync?', 'second q'])
    } finally {
      other.close()
    }
  })

  it('a newer P2P node without alias attrs keeps the local aliases', () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'Opaque body', aliases: ['keep me'] })
    const payload = vault.exportP2PPayload({ projectId: PROJECT })
    const future = new Date(Date.now() + 60_000).toISOString()
    const nodes = payload.nodes.map((node) => ({
      ...node,
      title: 'Newer title',
      updatedAt: future,
      attrs: (node.attrs ?? []).filter((a) => a.key !== P2P_ALIAS_ATTR)
    }))
    const { checksum: _c, ...rest } = { ...payload, nodes }
    const result = vault.importP2PPayload({ ...rest, checksum: computeP2PPayloadChecksum(rest) })
    assert.equal(result.memoriesUpdated, 1)
    const hit = vault.recallMemories('keep me', opts).memories[0]
    assert.equal(hit?.title, 'Newer title')
    assert.deepEqual(hit?.aliases, ['keep me'])
  })

  it('merge-on-update caps merged aliases at MAX_ALIASES', () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'Cap body', aliases: Array.from({ length: MAX_ALIASES }, (_, i) => `old ${i}`) })
    const updated = vault.storeMemory({ projectId: PROJECT, content: 'Cap body', aliases: ['brand new'] })
    assert.equal(updated.memory.aliases?.length, MAX_ALIASES)
    assert.ok(!updated.memory.aliases?.includes('brand new'))
  })
})

describe('migrateAliases with a partially migrated schema', () => {
  const ctx = useVault()
  const opts = { projectId: PROJECT, includeGlobal: false }

  it('memories.aliases missing but FTS already has the column', () => {
    const dbPath = path.join(ctx.tmpDir, 'half1.sqlite')
    const v = new MemoryVault({ dbPath })
    const s = v.storeMemory({ projectId: PROJECT, content: 'Half migrated one', aliases: ['alias lost'] })
    v.close()
    const raw = new DatabaseSync(dbPath)
    raw.exec('ALTER TABLE memories DROP COLUMN aliases')
    raw.close()
    const re = new MemoryVault({ dbPath })
    try {
      assert.deepEqual(re.recallMemories('half migrated', opts).memories[0]?.aliases, [])
      assert.equal(re.storeMemory({ projectId: PROJECT, content: 'Half migrated one', aliases: ['fresh'] }).memory.id, s.memory.id)
    } finally {
      re.close()
    }
  })

  it('memories.aliases present but FTS lacks the column: FTS is rebuilt from stored aliases', () => {
    const dbPath = path.join(ctx.tmpDir, 'half2.sqlite')
    const v = new MemoryVault({ dbPath })
    const s = v.storeMemory({ projectId: PROJECT, content: 'Half migrated two', aliases: ['where is the thing'] })
    v.close()
    const raw = new DatabaseSync(dbPath)
    raw.exec('DROP TABLE memories_fts')
    raw.exec('CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, project_id UNINDEXED, title, content, tags)')
    raw.close()
    const re = new MemoryVault({ dbPath })
    try {
      const res = re.recallMemories('where thing', opts)
      assert.equal(res.memories[0]?.id, s.memory.id)
      assert.deepEqual(res.memories[0]?.aliases, ['where is the thing'])
    } finally {
      re.close()
    }
  })
})

describe('Reranker with filters, budget and embedder failure', () => {
  const ctx = useVault()
  const base = { projectId: PROJECT, includeGlobal: false, limit: 5, maxTokens: 10_000 }

  it('only reranks candidates matching category and tags filters', async () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync decision alpha', category: 'decision', tags: ['net'] })
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync convention beta', category: 'convention', tags: ['net'] })
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync decision gamma', category: 'decision', tags: ['db'] })
    const reranker = new OverlapReranker()
    const res = await recallWithEmbedder(vault, 'peer sync', { ...base, category: 'decision', tags: ['net'] }, null, reranker)
    assert.equal(res.memories.length, 1)
    assert.match(res.memories[0]!.content, /alpha/)
    assert.equal(reranker.seen[0]?.length, 1)
  })

  it('applies maxTokens to the reranked order, not the retrieval order', async () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: `${'peer sync '.repeat(200)} filler`, importance: 1 })
    const small = vault.storeMemory({ projectId: PROJECT, content: 'peer sync tiny', importance: 0 }).memory
    const res = await recallWithEmbedder(vault, 'peer sync tiny', { ...base, maxTokens: 60 }, null, new OverlapReranker())
    assert.deepEqual(res.memories.map((m) => m.id), [small.id])
    assert.ok(res.memories.every((m) => m.rerankScore !== undefined))
  })

  it('keeps the semantic-failure warning and still reranks when the embedder fails', async () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync between nodes' })
    const res = await recallWithEmbedder(vault, 'peer sync', base, failingEmbedder(), new OverlapReranker())
    assert.match(res.warning ?? '', /Semantic search failed \(embedder down\)/)
    assert.equal(res.memories.length, 1)
    assert.ok(res.memories[0]!.rerankScore !== undefined)
  })

  it('concatenates both warnings when embedder AND reranker fail', async () => {
    const { vault } = ctx
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync between nodes' })
    const res = await recallWithEmbedder(vault, 'peer sync', base, failingEmbedder(), new ThrowingReranker())
    assert.match(res.warning ?? '', /Semantic search failed \(embedder down\).*Reranking failed \(rerank down\)/)
    assert.equal(res.memories.length, 1)
  })

  it('returns an empty result without crashing when there are no candidates', async () => {
    const res = await recallWithEmbedder(ctx.vault, 'nothing here', base, null, new OverlapReranker())
    assert.deepEqual(res.memories, [])
  })
})

describe('model reranker disable --purge and MEMOSEB_RERANKER status', () => {
  let tmpDir: string
  let dbPath: string
  let env: Record<string, string>
  let mlDir: string
  let options: ExecuteMemoCliOptions

  const backend: MlBackend = {
    isRuntimeInstalled: (_p: MlPaths) => false,
    isModelDownloaded: (_p: MlPaths, _s: Pick<EmbedderModelSpec, 'hfModel'>) => false,
    installRuntime: async () => ({ installed: false, sizeBytes: 0, prunedBytes: 0, log: '' }),
    createEmbedder: (): never => {
      throw new Error('unused')
    },
    createReranker: (): never => {
      throw new Error('unused')
    }
  }
  const mk = (extra: Record<string, string> = {}): ExecuteMemoCliOptions => ({
    runtime: new SystemRuntime({ homeDir: tmpDir, env: { ...env, ...extra } }),
    dbPath,
    cwd: tmpDir,
    mlBackend: backend,
    modelIo: { interactive: false, progress: () => {} }
  })
  const run = (...argv: string[]) => executeMemoCli([...argv, '--json'], options)
  const payload = <T>(stdout: string): T => (decodeWire<T>(stdout) as WireSuccess<T>).payload
  const modelsPaths = (): MlPaths => ({ modelsDir: path.join(mlDir, 'models') }) as MlPaths

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-gaps-cli-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    mlDir = path.join(tmpDir, 'ml')
    env = {
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
      XDG_STATE_HOME: path.join(tmpDir, '.local', 'state'),
      MEMOSEB_DB_PATH: dbPath,
      MEMOSEB_ML_DIR: mlDir
    }
    options = mk()
  })
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('--purge deletes only the reranker dirs carrying the ready marker', async () => {
    const readyDir = modelCacheDir(modelsPaths(), RERANKER_CATALOG[0]!)!
    const partialDir = modelCacheDir(modelsPaths(), RERANKER_CATALOG[1]!)!
    fs.mkdirSync(readyDir, { recursive: true })
    fs.writeFileSync(path.join(readyDir, 'model.onnx'), 'weights')
    fs.writeFileSync(path.join(readyDir, MODEL_READY_MARKER), 'rev\n')
    fs.mkdirSync(partialDir, { recursive: true })
    fs.writeFileSync(path.join(partialDir, 'model.onnx'), 'half download')

    const res = await run('model', 'reranker', 'disable', '--purge')
    assert.equal(res.exitCode, 0, res.stdout)
    assert.equal(fs.existsSync(readyDir), false)
    assert.equal(fs.existsSync(path.join(partialDir, 'model.onnx')), true)
    assert.ok(payload<{ freedBytes: number }>(res.stdout).freedBytes > 0)
  })

  it('disable without --purge keeps ready weights', async () => {
    const dir = modelCacheDir(modelsPaths(), RERANKER_CATALOG[0]!)!
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, MODEL_READY_MARKER), 'rev\n')
    const res = await run('model', 'reranker', 'disable')
    assert.equal(res.exitCode, 0)
    assert.equal(fs.existsSync(dir), true)
  })

  it('model status warns about an invalid MEMOSEB_RERANKER and reports it as not in use', async () => {
    options = mk({ MEMOSEB_RERANKER: 'bogus-model' })
    const res = await run('model', 'status')
    assert.equal(res.exitCode, 0, res.stdout)
    const data = payload<{ reranker: { active: string | null; source: string; inUse: boolean; warning: string | null } }>(res.stdout)
    assert.equal(data.reranker.active, null)
    assert.equal(data.reranker.source, 'env')
    assert.equal(data.reranker.inUse, false)
    assert.match(data.reranker.warning ?? '', /Unknown reranker "bogus-model"/)
  })
})
