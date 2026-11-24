import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime, type WireFailure, type WireSuccess } from 'hubseb'
import { executeMemoCli, type ExecuteMemoCliOptions } from '../src/bin/memoseb.ts'
import { findRerankerSpec, type EmbedderModelSpec, type RerankerModelSpec } from '../src/core/model-catalog.ts'
import {
  cachedActiveReranker,
  MIN_RERANK_CANDIDATES,
  recallWithEmbedder,
  releaseCachedEmbedder,
  resolveActiveReranker,
  type MlBackend
} from '../src/core/semantic.ts'
import { contentTokens } from '../src/core/text.ts'
import {
  modelSource,
  resolveMlPaths,
  type MlPaths,
  type SemanticReranker
} from '../src/core/transformers-embedder.ts'
import { MemoryVault, type RecallResult } from '../src/core/vault.ts'
import { handleMcpRequest } from '../src/mcp/server.ts'

const PROJECT = 'rerank-test'

/** Scores by the share of query tokens found in the passage; "boost" words win outright. */
class FakeReranker implements SemanticReranker {
  readonly spec: RerankerModelSpec
  calls: Array<{ query: string; passages: readonly string[] }> = []
  disposed = false
  private readonly opts: { fail?: boolean; boost?: string }
  constructor(spec: RerankerModelSpec, opts: { fail?: boolean; boost?: string } = {}) {
    this.spec = { ...spec, minScore: 0.1 }
    this.opts = opts
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    this.calls.push({ query, passages })
    if (this.opts.fail) throw new Error('onnx exploded')
    const q = new Set(contentTokens(query))
    return passages.map((passage) => {
      if (this.opts.boost && passage.includes(this.opts.boost)) return 0.99
      const own = new Set(contentTokens(passage))
      let shared = 0
      for (const token of q) if (own.has(token)) shared++
      return q.size === 0 ? 0 : (shared / q.size) * 0.9
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function createBackend(opts: { fail?: boolean; boost?: string; installOk?: boolean } = {}) {
  const backend = {
    runtimeInstalled: false,
    downloaded: new Set<string>(),
    installs: 0,
    rerankers: [] as FakeReranker[],
    isRuntimeInstalled: (_p: MlPaths) => backend.runtimeInstalled,
    isModelDownloaded: (_p: MlPaths, spec: Pick<EmbedderModelSpec, 'hfModel'>) =>
      backend.downloaded.has(spec.hfModel ?? ''),
    installRuntime: async () => {
      backend.installs++
      if (opts.installOk === false) return { installed: false, sizeBytes: 0, prunedBytes: 0, log: 'npm ERR! offline' }
      backend.runtimeInstalled = true
      return { installed: true, sizeBytes: 1024, prunedBytes: 0, log: '' }
    },
    createEmbedder: (): never => {
      throw new Error('embedders are not used in this suite')
    },
    createReranker: (spec: RerankerModelSpec) => {
      backend.downloaded.add(spec.hfModel)
      const reranker = new FakeReranker(spec, opts)
      backend.rerankers.push(reranker)
      return reranker
    }
  }
  return backend satisfies MlBackend
}

const V2 = findRerankerSpec('bge-reranker-v2-m3')!

describe('Reranking recall results', () => {
  let tmpDir: string
  let vault: MemoryVault

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-rerank-test-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(() => {
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const store = (content: string, importance = 0.5) =>
    vault.storeMemory({ projectId: PROJECT, content, importance }).memory

  const opts = { projectId: PROJECT, includeGlobal: false, limit: 3, maxTokens: 10_000 }

  it('reorders candidates by reranker score and records rerankScore', async () => {
    const weak = store('sync logs are rotated weekly', 1)
    const strong = store('peer sync between nodes uses HTTP exchange endpoints', 0)
    const baseline = vault.recallMemories('peer sync nodes', opts)
    const reranker = new FakeReranker(V2, { boost: 'HTTP exchange' })
    const res = await recallWithEmbedder(vault, 'peer sync nodes', opts, null, reranker)
    assert.ok(baseline.memories.some((m) => m.id === weak.id))
    assert.equal(res.memories[0]?.id, strong.id)
    assert.equal(res.memories[0]?.rerankScore, 0.99)
    assert.equal(res.warning, undefined)
  })

  it('drops candidates below the reranker minScore', async () => {
    store('peer sync between nodes')
    const unrelated = store('nodes of the pizza oven')
    const reranker = new FakeReranker(V2)
    const res = await recallWithEmbedder(vault, 'peer sync oven', { ...opts, limit: 5 }, null, reranker)
    assert.ok(res.memories.every((m) => (m.rerankScore ?? 0) >= 0.1))
    assert.ok(res.memories.some((m) => m.id === unrelated.id))
    const strict = new FakeReranker(V2)
    ;(strict.spec as { minScore: number }).minScore = 0.95
    const none = await recallWithEmbedder(vault, 'peer sync oven', opts, null, strict)
    assert.equal(none.memories.length, 0)
  })

  it('sends at least MIN_RERANK_CANDIDATES candidates but still applies the limit', async () => {
    for (let i = 0; i < MIN_RERANK_CANDIDATES + 10; i++) store(`sync note number ${i} about peers`)
    const reranker = new FakeReranker(V2)
    const res = await recallWithEmbedder(vault, 'sync peers', { ...opts, limit: 2 }, null, reranker)
    assert.equal(reranker.calls[0]?.passages.length, MIN_RERANK_CANDIDATES)
    assert.equal(res.memories.length, 2)
  })

  it('keeps the retrieval order with a warning when the reranker fails', async () => {
    store('peer sync between nodes')
    const baseline = vault.recallMemories('peer sync', opts)
    const res = await recallWithEmbedder(vault, 'peer sync', opts, null, new FakeReranker(V2, { fail: true }))
    assert.deepEqual(res.memories.map((m) => m.id), baseline.memories.map((m) => m.id))
    assert.match(res.warning ?? '', /Reranking failed \(onnx exploded\)/)
  })

  it('does not call the reranker for an empty query', async () => {
    store('anything at all')
    const reranker = new FakeReranker(V2)
    await recallWithEmbedder(vault, '   ', opts, null, reranker)
    assert.equal(reranker.calls.length, 0)
  })

  it('counts access only for the memories finally returned', async () => {
    const a = store('peer sync between nodes')
    const b = store('peer sync logs')
    await recallWithEmbedder(vault, 'peer sync', { ...opts, limit: 1 }, null, new FakeReranker(V2, { boost: 'between' }))
    const counts = vault.recallMemories('peer sync', { ...opts, limit: 5 }).memories
    // recallMemories above adds 1 to both; only `a` was returned by the reranked call.
    assert.equal(counts.find((m) => m.id === a.id)?.accessCount, 2)
    assert.equal(counts.find((m) => m.id === b.id)?.accessCount, 1)
  })
})

describe('Reranker configuration', () => {
  let tmpDir: string
  let dbPath: string
  let env: Record<string, string>
  let backend: ReturnType<typeof createBackend>
  let options: ExecuteMemoCliOptions

  const mkRuntime = (extra: Record<string, string> = {}) =>
    new SystemRuntime({ homeDir: tmpDir, env: { ...env, ...extra } })
  const run = (...argv: string[]) => executeMemoCli([...argv, '--json'], options)
  const ok = <T>(stdout: string): T => (decodeWire<T>(stdout) as WireSuccess<T>).payload
  const failure = (stdout: string) => decodeWire(stdout) as WireFailure

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-rerank-cli-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    env = {
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
      XDG_STATE_HOME: path.join(tmpDir, '.local', 'state'),
      MEMOSEB_DB_PATH: dbPath,
      MEMOSEB_ML_DIR: path.join(tmpDir, 'ml')
    }
    backend = createBackend({ boost: 'HTTP exchange' })
    options = {
      runtime: mkRuntime(),
      dbPath,
      cwd: tmpDir,
      mlBackend: backend,
      modelIo: { interactive: false, progress: () => {} }
    }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('is off by default; MEMOSEB_RERANKER overrides the stored config; "none" disables', () => {
    const vault = new MemoryVault({ dbPath, runtime: mkRuntime() })
    try {
      assert.deepEqual(vault.getActiveReranker(), { spec: null, source: 'default' })
      vault.setConfiguredRerankerId('bge-reranker-base')
      assert.equal(vault.getActiveReranker().spec?.id, 'bge-reranker-base')
      assert.equal(vault.getActiveReranker().source, 'config')
      vault.setConfiguredRerankerId(null)
      assert.equal(vault.getActiveReranker().spec, null)
      assert.throws(() => vault.setConfiguredRerankerId('jina-reranker'), /Unknown reranker/)
    } finally {
      vault.close()
    }
    const withEnv = new MemoryVault({ dbPath, runtime: mkRuntime({ MEMOSEB_RERANKER: 'bge-reranker-v2-m3' }) })
    try {
      withEnv.setConfiguredRerankerId('bge-reranker-base')
      assert.equal(withEnv.getActiveReranker().spec?.id, 'bge-reranker-v2-m3')
      assert.equal(withEnv.getActiveReranker().source, 'env')
    } finally {
      withEnv.close()
    }
    const off = new MemoryVault({ dbPath, runtime: mkRuntime({ MEMOSEB_RERANKER: 'none' }) })
    try {
      assert.deepEqual(off.getActiveReranker(), { spec: null, source: 'env' })
    } finally {
      off.close()
    }
  })

  it('warns instead of failing for an unknown or uninstalled reranker', () => {
    const bad = new MemoryVault({ dbPath, runtime: mkRuntime({ MEMOSEB_RERANKER: 'nope' }) })
    try {
      const res = resolveActiveReranker(bad, backend)
      assert.equal(res.reranker, null)
      assert.match(res.warning ?? '', /Unknown reranker "nope"/)
    } finally {
      bad.close()
    }
    const missing = new MemoryVault({ dbPath, runtime: mkRuntime({ MEMOSEB_RERANKER: 'bge-reranker-v2-m3' }) })
    try {
      const res = resolveActiveReranker(missing, backend)
      assert.equal(res.reranker, null)
      assert.match(res.warning ?? '', /not installed/)
    } finally {
      missing.close()
    }
  })

  it('lists rerankers, requires confirmation, enables with --yes and reranks CLI recall', async () => {
    const list = ok<{ rerankers: Array<{ id: string; recommended: boolean }>; active: string | null }>(
      (await run('model', 'reranker', 'list')).stdout
    )
    assert.deepEqual(list.rerankers.map((r) => r.id), ['bge-reranker-v2-m3', 'bge-reranker-base'])
    assert.equal(list.rerankers.find((r) => r.recommended)?.id, 'bge-reranker-v2-m3')
    assert.equal(list.active, null)

    const unconfirmed = await run('model', 'reranker', 'enable')
    assert.equal(unconfirmed.exitCode, 2)
    assert.equal(failure(unconfirmed.stdout).fault.code, 'CONFIRMATION_REQUIRED')
    assert.equal(backend.installs, 0)

    const unknown = await run('model', 'reranker', 'enable', 'jina-reranker-v2', '--yes')
    assert.equal(failure(unknown.stdout).fault.code, 'UNKNOWN_RERANKER')

    const enabled = await run('model', 'reranker', 'enable', '--yes')
    assert.equal(enabled.exitCode, 0, enabled.stdout)
    assert.equal(ok<{ reranker: string }>(enabled.stdout).reranker, 'bge-reranker-v2-m3')
    assert.equal(backend.installs, 1)
    assert.ok(backend.rerankers[0]?.disposed)

    await run('remember', 'sync logs are rotated weekly', '--project', PROJECT, '--importance', '1')
    await run('remember', 'peer sync between nodes uses HTTP exchange endpoints', '--project', PROJECT, '--importance', '0')
    const recall = ok<RecallResult>((await run('recall', 'peer sync nodes', '--project', PROJECT)).stdout)
    assert.match(recall.memories[0]?.content ?? '', /HTTP exchange/)
    assert.equal(recall.memories[0]?.rerankScore, 0.99)

    const status = ok<{ reranker: { active: string; inUse: boolean } }>((await run('model', 'status')).stdout)
    assert.deepEqual({ active: status.reranker.active, inUse: status.reranker.inUse }, { active: 'bge-reranker-v2-m3', inUse: true })

    const disabled = await run('model', 'reranker', 'disable')
    assert.equal(disabled.exitCode, 0)
    const after = ok<RecallResult>((await run('recall', 'peer sync nodes', '--project', PROJECT)).stdout)
    assert.equal(after.memories[0]?.rerankScore, undefined)
  })

  it('reports a failed runtime install without enabling the reranker', async () => {
    backend = createBackend({ installOk: false })
    options = { ...options, mlBackend: backend }
    const res = await run('model', 'reranker', 'enable', '--yes')
    assert.equal(failure(res.stdout).fault.code, 'RUNTIME_INSTALL_FAILED')
    const vault = new MemoryVault({ dbPath, runtime: mkRuntime() })
    try {
      assert.equal(vault.getActiveReranker().spec, null)
    } finally {
      vault.close()
    }
  })

  it('MCP memory_recall keeps one reranker loaded across calls', async () => {
    const vault = new MemoryVault({ dbPath, runtime: mkRuntime() })
    try {
      backend.runtimeInstalled = true
      backend.downloaded.add(V2.hfModel)
      vault.setConfiguredRerankerId(V2.id)
      vault.storeMemory({ projectId: PROJECT, content: 'peer sync between nodes uses HTTP exchange endpoints' })
      const call = async (query: string) => {
        const response = await handleMcpRequest(
          vault,
          { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_recall', arguments: { query, projectId: PROJECT } } },
          backend
        )
        return JSON.parse(((response?.result as { content: Array<{ text: string }> }).content[0]!).text) as RecallResult
      }
      assert.equal((await call('peer sync')).memories[0]?.rerankScore, 0.99)
      await call('sync nodes')
      assert.equal(backend.rerankers.length, 1)
      assert.equal(backend.rerankers[0]!.calls.length, 2)
      assert.equal(cachedActiveReranker(vault, backend).reranker, backend.rerankers[0])
      await releaseCachedEmbedder(vault)
      assert.ok(backend.rerankers[0]!.disposed)
    } finally {
      vault.close()
    }
  })
})

describe('Offline model source', () => {
  let tmpDir: string
  let paths: MlPaths

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-source-test-'))
    paths = resolveMlPaths('unused.sqlite', { MEMOSEB_ML_DIR: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeModel = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), '{}')
    fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), '{}')
  }

  it('downloads by repo id and pinned revision', () => {
    assert.deepEqual(modelSource(paths, V2, true), { model: V2.hfModel, revision: V2.revision })
  })

  it('loads offline from the pinned revision directory, then the legacy flat layout', () => {
    const root = path.join(paths.modelsDir, ...V2.hfModel.split('/'))
    // Nothing on disk: keep the repo id so transformers.js reports a clear "not found".
    assert.deepEqual(modelSource(paths, V2, false), { model: V2.hfModel, revision: V2.revision })
    writeModel(root)
    assert.deepEqual(modelSource(paths, V2, false), { model: root, revision: undefined })
    writeModel(path.join(root, V2.revision))
    assert.deepEqual(modelSource(paths, V2, false), { model: path.join(root, V2.revision), revision: undefined })
  })
})
