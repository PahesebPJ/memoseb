import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime, type WireFailure, type WireSuccess } from 'hubseb'
import { executeMemoCli, type ExecuteMemoCliOptions } from '../src/bin/memoseb.ts'
import { LEXICAL_EMBEDDER_MODEL, LocalFeatureHashEmbedder } from '../src/core/embedder.ts'
import { findModelSpec, vectorModelTag, type EmbedderModelSpec } from '../src/core/model-catalog.ts'
import type { MlBackend } from '../src/core/semantic.ts'
import {
  isModelDownloaded,
  MODEL_READY_MARKER,
  resolveMlPaths,
  type MlPaths,
  type SemanticEmbedder
} from '../src/core/transformers-embedder.ts'
import { MemoryVault, type RecallResult, type StoreMemoryResult } from '../src/core/vault.ts'
import { handleMcpRequest } from '../src/mcp/server.ts'

/** Canonicalizes synonyms so the fake model "understands" paraphrases. */
const SYNONYMS: Record<string, string> = {
  replicar: 'sync',
  replicate: 'sync',
  sincronizacion: 'sync',
  sincronizar: 'sync',
  maquinas: 'nodes',
  nodos: 'nodes'
}

class FakeSemanticEmbedder implements SemanticEmbedder {
  readonly spec: EmbedderModelSpec
  readonly model: string
  readonly dimensions: number
  loads = 0
  disposed = false
  private readonly inner = new LocalFeatureHashEmbedder()

  constructor(spec: EmbedderModelSpec) {
    // The fake's similarity scale is lexical, so it needs the lexical noise floor.
    this.spec = { ...spec, minSimilarity: 0.35 }
    this.model = vectorModelTag(spec)
    this.dimensions = spec.dimensions
  }

  private canon(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => SYNONYMS[w] ?? w)
      .join(' ')
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.loads++
    return this.inner.embed(this.canon(text))
  }

  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    this.loads++
    return texts.map((t) => this.inner.embed(this.canon(t)))
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function createFakeBackend(): MlBackend & {
  runtimeInstalled: boolean
  downloaded: Set<string>
  installs: number
  created: FakeSemanticEmbedder[]
} {
  const backend = {
    runtimeInstalled: false,
    downloaded: new Set<string>(),
    installs: 0,
    created: [] as FakeSemanticEmbedder[],
    isRuntimeInstalled: (_paths: MlPaths) => backend.runtimeInstalled,
    isModelDownloaded: (_paths: MlPaths, spec: EmbedderModelSpec) => backend.downloaded.has(spec.id),
    installRuntime: async () => {
      backend.installs++
      backend.runtimeInstalled = true
      return { installed: true, sizeBytes: 190 * 1024 * 1024, prunedBytes: 0, log: '' }
    },
    createEmbedder: (spec: EmbedderModelSpec) => {
      backend.downloaded.add(spec.id)
      const embedder = new FakeSemanticEmbedder(spec)
      backend.created.push(embedder)
      return embedder
    }
  }
  return backend
}

describe('memoseb model: opt-in semantic embedders', () => {
  let tmpDir: string
  let dbPath: string
  let mlDir: string
  let runtime: SystemRuntime
  let backend: ReturnType<typeof createFakeBackend>
  let progress: string[]
  let options: ExecuteMemoCliOptions

  const run = (...argv: string[]) => executeMemoCli([...argv, '--json'], options)
  const ok = <T>(stdout: string): T => (decodeWire<T>(stdout) as WireSuccess<T>).payload

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-model-test-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    mlDir = path.join(tmpDir, 'ml')
    runtime = new SystemRuntime({
      homeDir: tmpDir,
      env: {
        HOME: tmpDir,
        XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
        XDG_STATE_HOME: path.join(tmpDir, '.local', 'state'),
        MEMOSEB_DB_PATH: dbPath,
        MEMOSEB_ML_DIR: mlDir
      }
    })
    backend = createFakeBackend()
    progress = []
    options = {
      runtime,
      dbPath,
      cwd: tmpDir,
      mlBackend: backend,
      modelIo: { interactive: false, progress: (t) => progress.push(t) }
    }
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('lists the catalog with the lexical hash active by default', async () => {
    const res = await run('model', 'list')
    assert.equal(res.exitCode, 0)
    const { models } = ok<{ models: Array<{ id: string; active: boolean; recommended: boolean; ramMb: number }> }>(res.stdout)
    assert.deepEqual(
      models.map((m) => m.id),
      ['hash', 'minilm-en', 'e5-small', 'minilm-multi', 'e5-base']
    )
    assert.equal(models.find((m) => m.active)?.id, 'hash')
    assert.equal(models.find((m) => m.recommended)?.id, 'e5-small')

    const text = await executeMemoCli(['model', 'list'], options)
    assert.match(text.stdout, /\* +1\. hash/)
    assert.match(text.stdout, /e5-small .*\(recommended\)/)
  })

  it('requires --yes before downloading in non-interactive mode', async () => {
    const res = await run('model', 'enable', 'e5-small')
    assert.equal(res.exitCode, 2)
    const failure = decodeWire(res.stdout) as WireFailure
    assert.equal(failure.fault.code, 'CONFIRMATION_REQUIRED')
    assert.match(failure.fault.reason, /~215 MB/)
    assert.equal(backend.installs, 0)
    assert.equal(ok<{ active: string }>((await run('model', 'status')).stdout).active, 'hash')
  })

  it('rejects unknown models with the list of valid ids', async () => {
    const res = await run('model', 'enable', 'gpt-9', '--yes')
    assert.equal(res.exitCode, 2)
    const failure = decodeWire(res.stdout) as WireFailure
    assert.equal(failure.fault.code, 'UNKNOWN_MODEL')
    assert.match(failure.fault.remedy ?? '', /e5-small/)
  })

  it('enables a model, reindexes existing memories and finds paraphrases', async () => {
    await run('remember', 'Sincronización P2P entre nodos peer', '--project', 'p')
    await run('remember', 'Redis cache invalidation on update events', '--project', 'p')

    const lexical = ok<RecallResult>((await run('recall', 'replicar datos entre máquinas', '--project', 'p')).stdout)
    assert.equal(lexical.memories.length, 0)

    const enabled = await run('model', 'enable', 'e5-small', '--yes')
    assert.equal(enabled.exitCode, 0, enabled.stdout)
    const data = ok<{ enabled: boolean; model: string; reindexed: number }>(enabled.stdout)
    assert.deepEqual([data.enabled, data.model, data.reindexed], [true, 'e5-small', 2])
    assert.equal(backend.installs, 1)
    assert.ok(progress.some((p) => p.includes('Reindexing memories: 2/2')))
    assert.equal(backend.created[0]?.disposed, true)

    const status = ok<{ active: string; source: string; pendingReindex: number; inUse: string }>(
      (await run('model', 'status')).stdout
    )
    assert.deepEqual(
      [status.active, status.source, status.pendingReindex, status.inUse],
      ['e5-small', 'config', 0, 'e5-small']
    )

    const semantic = ok<RecallResult>((await run('recall', 'replicar datos entre máquinas', '--project', 'p')).stdout)
    assert.equal(semantic.memories[0]?.content, 'Sincronización P2P entre nodos peer')
  })

  it('embeds new memories with the active model and self-heals vectors written by sync paths', async () => {
    backend.runtimeInstalled = true
    await run('model', 'enable', 'e5-small', '--yes')
    const stored = ok<StoreMemoryResult>((await run('remember', 'Sincronizar nodos cada 5 minutos', '--project', 'p')).stdout)

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const tag = vectorModelTag({ hfModel: 'Xenova/multilingual-e5-small' } as EmbedderModelSpec)
      assert.deepEqual(vault.vectorModelCounts(), [{ model: tag, count: 1 }])
      // Imports and P2P sync always write lexical vectors.
      vault.storeMemory({ projectId: 'p', content: 'Imported memory about replication' })
      assert.equal(vault.countMemoriesNeedingVectors(tag), 1)
    } finally {
      vault.close()
    }

    const recalled = ok<RecallResult>((await run('recall', 'replicar maquinas', '--project', 'p')).stdout)
    assert.equal(recalled.memories[0]?.id, stored.memory.id)
    const after = new MemoryVault({ dbPath, runtime })
    try {
      assert.equal(after.countMemoriesNeedingVectors(vectorModelTag(after.getActiveEmbedder().spec)), 0)
    } finally {
      after.close()
    }
  })

  it('disables back to the lexical hash and purges downloads on request', async () => {
    await run('remember', 'Sincronización P2P entre nodos peer', '--project', 'p')
    await run('model', 'enable', 'e5-small', '--yes')
    fs.mkdirSync(path.join(mlDir, 'models', 'Xenova'), { recursive: true })
    fs.writeFileSync(path.join(mlDir, 'models', 'Xenova', 'weights.onnx'), 'x'.repeat(1024))
    fs.mkdirSync(path.join(mlDir, 'runtime'), { recursive: true })
    fs.writeFileSync(path.join(mlDir, '.memoseb-ml'), '')

    const disabled = await run('model', 'disable', '--purge')
    assert.equal(disabled.exitCode, 0)
    const data = ok<{ enabled: boolean; model: string; reindexed: number; purged: boolean }>(disabled.stdout)
    assert.deepEqual([data.enabled, data.model, data.reindexed, data.purged], [false, 'hash', 1, true])
    assert.equal(fs.existsSync(path.join(mlDir, 'models')), false)
    assert.equal(fs.existsSync(path.join(mlDir, 'runtime')), false)

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      assert.deepEqual(vault.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }])
    } finally {
      vault.close()
    }
    const recalled = ok<RecallResult>((await run('recall', 'sincronizacion', '--project', 'p')).stdout)
    assert.equal(recalled.memories.length, 1)
  })

  it('lets MEMOSEB_EMBEDDER override the stored setting and warns when the model is missing', async () => {
    const envRuntime = new SystemRuntime({
      homeDir: tmpDir,
      env: { ...runtime.env, MEMOSEB_EMBEDDER: 'e5-base' }
    })
    const envOptions = { ...options, runtime: envRuntime }
    const status = ok<{ active: string; source: string; inUse: string; warning: string | null }>(
      (await executeMemoCli(['model', 'status', '--json'], envOptions)).stdout
    )
    assert.deepEqual([status.active, status.source, status.inUse], ['e5-base', 'env', 'hash'])
    assert.match(status.warning ?? '', /not installed/)

    const recall = await executeMemoCli(['recall', 'anything'], envOptions)
    assert.match(recall.stderr, /Warning: Model "e5-base" is not installed/)
  })

  it('reindex fails clearly when the configured model is not installed', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    vault.setConfiguredEmbedderId('minilm-multi')
    vault.close()
    const res = await run('model', 'reindex')
    assert.equal(res.exitCode, 2)
    assert.equal((decodeWire(res.stdout) as WireFailure).fault.code, 'MODEL_NOT_INSTALLED')
  })

  it('MCP keeps one loaded embedder across calls and reports it in the briefing', async () => {
    backend.runtimeInstalled = true
    backend.downloaded.add('e5-small')
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      vault.setConfiguredEmbedderId('e5-small')
      const call = (name: string, args: Record<string, unknown>) =>
        handleMcpRequest(vault, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, backend)
      await call('memory_store', { content: 'Sincronización P2P entre nodos', projectId: 'p' })
      const recall = await call('memory_recall', { query: 'replicar maquinas', projectId: 'p' })
      const text = ((recall?.result as { content: Array<{ text: string }> }).content[0]!).text
      assert.equal((JSON.parse(text) as RecallResult).memories.length, 1)
      assert.equal(backend.created.length, 1)

      const briefing = await call('memory_briefing', { projectId: 'p' })
      const briefingText = ((briefing?.result as { content: Array<{ text: string }> }).content[0]!).text
      assert.deepEqual((JSON.parse(briefingText) as { embedder: unknown }).embedder, {
        active: 'e5-small',
        source: 'config'
      })
    } finally {
      vault.close()
    }
  })
})

describe('CLI hygiene', () => {
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-hygiene-test-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prints help for "remember --help" instead of storing "--help" as a memory', async () => {
    const res = await executeMemoCli(['remember', '--help'], { dbPath, cwd: tmpDir })
    assert.equal(res.exitCode, 0)
    assert.match(res.stdout, /memoseb model enable/)
    const vault = new MemoryVault({ dbPath })
    try {
      assert.equal(vault.getStats().memoryCount, 0)
    } finally {
      vault.close()
    }
  })

  it('refuses flag-like content', async () => {
    const res = await executeMemoCli(['remember', '--', '-v'], { dbPath, cwd: tmpDir })
    assert.equal(res.exitCode, 2)
    assert.match(res.stderr, /looks like a command-line flag/)
  })
})

describe('Review fixes: safety and graceful degradation', () => {
  let tmpDir: string
  let dbPath: string
  let runtime: SystemRuntime

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-fixes-test-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    runtime = new SystemRuntime({
      homeDir: tmpDir,
      env: { HOME: tmpDir, MEMOSEB_DB_PATH: dbPath, MEMOSEB_ML_DIR: path.join(tmpDir, 'ml') }
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('opening the vault in hash mode never downgrades semantic vectors; disable converts them', async () => {
    const semanticTag = 'hf:Xenova/multilingual-e5-small'
    const vault = new MemoryVault({ dbPath, runtime })
    const stored = vault.storeMemory({ projectId: 'p', content: 'Sincronización entre nodos' })
    vault.writeVectors(semanticTag, [{ id: stored.memory.id, vector: new Float32Array(384).fill(0.1) }])
    vault.close()

    const reopened = new MemoryVault({ dbPath, runtime })
    try {
      assert.deepEqual(reopened.vectorModelCounts(), [{ model: semanticTag, count: 1 }])
    } finally {
      reopened.close()
    }

    const res = await executeMemoCli(['model', 'disable', '--json'], {
      runtime,
      dbPath,
      mlBackend: createFakeBackend()
    })
    assert.equal(res.exitCode, 0)
    const after = new MemoryVault({ dbPath, runtime })
    try {
      assert.deepEqual(after.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }])
    } finally {
      after.close()
    }
  })

  it('--purge refuses to delete a directory memoseb did not create', async () => {
    const mlDir = path.join(tmpDir, 'ml')
    fs.mkdirSync(path.join(mlDir, 'models', 'keep'), { recursive: true })
    fs.writeFileSync(path.join(mlDir, 'models', 'keep', 'user-file.bin'), 'data')
    const res = await executeMemoCli(['model', 'disable', '--purge'], {
      runtime,
      dbPath,
      mlBackend: createFakeBackend()
    })
    assert.equal(res.exitCode, 0)
    assert.match(res.stdout, /Nothing purged: .* was not created by memoseb/)
    assert.equal(fs.existsSync(path.join(mlDir, 'models', 'keep', 'user-file.bin')), true)
  })

  it('falls back to lexical search and storage when the semantic model fails at runtime', async () => {
    const backend = createFakeBackend()
    backend.runtimeInstalled = true
    backend.downloaded.add('e5-small')
    backend.createEmbedder = (spec) => {
      const broken = new FakeSemanticEmbedder(spec)
      broken.embedQuery = async () => {
        throw new Error('onnx session crashed')
      }
      broken.embedPassages = async () => {
        throw new Error('onnx session crashed')
      }
      return broken
    }
    const vault = new MemoryVault({ dbPath, runtime })
    vault.setConfiguredEmbedderId('e5-small')
    vault.close()
    const opts = { runtime, dbPath, mlBackend: backend }

    const stored = await executeMemoCli(['remember', 'Sincronización P2P entre nodos', '--project', 'p'], opts)
    assert.equal(stored.exitCode, 0)
    assert.match(stored.stderr, /Semantic embedding failed \(onnx session crashed\)/)

    const recall = await executeMemoCli(['recall', 'sincronizacion', '--project', 'p'], opts)
    assert.equal(recall.exitCode, 0)
    assert.match(recall.stdout, /Found 1 memories/)
    assert.match(recall.stderr, /Semantic search failed .*used lexical search/)
  })

  it('treats a download without the ready marker as not downloaded', () => {
    const paths = resolveMlPaths(dbPath, runtime.env)
    const spec = findModelSpec('e5-small')!
    const modelDir = path.join(paths.modelsDir, 'Xenova', 'multilingual-e5-small')
    fs.mkdirSync(path.join(modelDir, 'onnx'), { recursive: true })
    assert.equal(isModelDownloaded(paths, spec), false)
    fs.writeFileSync(path.join(modelDir, MODEL_READY_MARKER), 'rev\n')
    assert.equal(isModelDownloaded(paths, spec), true)
  })

  it('accepts negative numbers as memory content but still refuses bare flags', async () => {
    const opts = { runtime, dbPath, cwd: tmpDir }
    assert.equal((await executeMemoCli(['remember', '-1'], opts)).exitCode, 0)
    assert.equal((await executeMemoCli(['remember', '--verbose'], opts)).exitCode, 2)
  })

  it('refuses to install the runtime into a populated directory it did not create', async () => {
    const { installMlRuntime } = await import('../src/core/ml-runtime.ts')
    const paths = resolveMlPaths(dbPath, runtime.env)
    fs.mkdirSync(path.join(paths.root, 'models'), { recursive: true })
    fs.writeFileSync(path.join(paths.root, 'models', 'user-file.bin'), 'data')
    const result = await installMlRuntime(paths, {
      spawnProcess: (() => {
        throw new Error('npm must not run')
      }) as never
    })
    assert.equal(result.installed, false)
    assert.match(result.log, /not created by memoseb/)
    assert.equal(fs.existsSync(path.join(paths.root, '.memoseb-ml')), false)
  })

  it('includes the missing-model warning in --json recall output', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    vault.setConfiguredEmbedderId('e5-small')
    vault.close()
    const res = await executeMemoCli(['recall', 'anything', '--json'], {
      runtime,
      dbPath,
      mlBackend: createFakeBackend()
    })
    const payload = (decodeWire<RecallResult>(res.stdout) as WireSuccess<RecallResult>).payload
    assert.match(payload.warning ?? '', /not installed/)
  })

  it('resolves MEMOSEB_ML_DIR to an absolute path', () => {
    assert.equal(path.isAbsolute(resolveMlPaths(dbPath, { MEMOSEB_ML_DIR: 'relative/ml' }).root), true)
  })
})
