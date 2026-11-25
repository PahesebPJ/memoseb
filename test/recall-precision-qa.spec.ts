import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { decodeWire, SystemRuntime, type WireFailure, type WireSuccess } from 'hubseb'
import { executeMemoCli, type ExecuteMemoCliOptions } from '../src/bin/memoseb.ts'
import { LEXICAL_EMBEDDER_MODEL, LocalFeatureHashEmbedder } from '../src/core/embedder.ts'
import { vectorModelTag, type EmbedderModelSpec } from '../src/core/model-catalog.ts'
import { recallWithEmbedder, type MlBackend } from '../src/core/semantic.ts'
import type { MlPaths, SemanticEmbedder } from '../src/core/transformers-embedder.ts'
import { MemoryVault, sanitizeFtsQuery, type RecallResult, type StoreMemoryResult } from '../src/core/vault.ts'

const SYNONYMS: Record<string, string> = {
  replicar: 'sync',
  sincronizacion: 'sync',
  maquinas: 'nodes',
  nodos: 'nodes'
}

class FakeEmbedder implements SemanticEmbedder {
  readonly spec: EmbedderModelSpec
  readonly model: string
  readonly dimensions: number
  disposed = false
  private readonly inner = new LocalFeatureHashEmbedder()

  private readonly failOnLoad: boolean

  constructor(spec: EmbedderModelSpec, failOnLoad = false) {
    this.failOnLoad = failOnLoad
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
    if (this.failOnLoad) throw new Error('onnx load boom')
    return this.inner.embed(this.canon(text))
  }

  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    if (this.failOnLoad) throw new Error('onnx load boom')
    return texts.map((t) => this.inner.embed(this.canon(t)))
  }

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function createBackend(opts: { failOnLoad?: boolean; installOk?: boolean } = {}) {
  const backend = {
    runtimeInstalled: false,
    downloaded: new Set<string>(),
    installs: 0,
    created: [] as FakeEmbedder[],
    isRuntimeInstalled: (_p: MlPaths) => backend.runtimeInstalled,
    isModelDownloaded: (_p: MlPaths, spec: EmbedderModelSpec) => backend.downloaded.has(spec.id),
    installRuntime: async () => {
      backend.installs++
      if (opts.installOk === false) {
        return { installed: false, sizeBytes: 0, prunedBytes: 0, log: 'npm ERR! offline' }
      }
      backend.runtimeInstalled = true
      return { installed: true, sizeBytes: 1024, prunedBytes: 0, log: '' }
    },
    createEmbedder: (spec: EmbedderModelSpec) => {
      backend.downloaded.add(spec.id)
      const e = new FakeEmbedder(spec, opts.failOnLoad)
      backend.created.push(e)
      return e
    },
    createReranker: (): never => {
      throw new Error('reranker is not used in this suite')
    }
  }
  return backend satisfies MlBackend
}

describe('recall precision QA matrix', () => {
  let tmpDir: string
  let dbPath: string
  let env: Record<string, string>
  let runtime: SystemRuntime
  let backend: ReturnType<typeof createBackend>
  let progress: string[]
  let answers: string[]
  let questions: string[]
  let options: ExecuteMemoCliOptions

  const mkRuntime = (extra: Record<string, string> = {}) =>
    new SystemRuntime({ homeDir: tmpDir, env: { ...env, ...extra } })
  const run = (...argv: string[]) => executeMemoCli([...argv, '--json'], options)
  const ok = <T>(stdout: string): T => (decodeWire<T>(stdout) as WireSuccess<T>).payload
  const code = (stdout: string): string => (decodeWire(stdout) as WireFailure).fault.code
  const withVault = <T>(fn: (v: MemoryVault) => T): T => {
    const v = new MemoryVault({ dbPath, runtime })
    try {
      return fn(v)
    } finally {
      v.close()
    }
  }
  const rawSql = (sql: string, ...params: Array<string | number>) => {
    const db = new DatabaseSync(dbPath)
    try {
      db.prepare(sql).run(...params)
    } finally {
      db.close()
    }
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-qa-'))
    dbPath = path.join(tmpDir, 'vault.sqlite')
    env = {
      HOME: tmpDir,
      XDG_CONFIG_HOME: path.join(tmpDir, '.config'),
      XDG_STATE_HOME: path.join(tmpDir, '.local', 'state'),
      MEMOSEB_DB_PATH: dbPath,
      MEMOSEB_ML_DIR: path.join(tmpDir, 'ml')
    }
    runtime = mkRuntime()
    backend = createBackend()
    progress = []
    answers = []
    questions = []
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

  describe('lexical recall edge cases', () => {
    beforeEach(async () => {
      await run('remember', 'Redis cache invalidation on update events', '--project', 'p', '--category', 'architecture', '--tags', 'cache,redis')
      await run('remember', 'Deploy pipeline uses GitHub Actions', '--project', 'p', '--category', 'convention', '--tags', 'ci')
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p', '--category', 'architecture', '--tags', 'sync')
    })

    const doRecall = async (q: string, ...rest: string[]) =>
      ok<RecallResult>((await run('recall', q, '--project', 'p', ...rest)).stdout)

    it('CLI rejects empty and whitespace-only queries with MISSING_QUERY', async () => {
      for (const q of ['', '   ']) {
        const res = await run('recall', q, '--project', 'p')
        assert.equal(res.exitCode, 2)
        assert.equal(code(res.stdout), 'MISSING_QUERY')
      }
    })

    it('vault-level empty and whitespace queries return memories by importance without a similarity floor', () => {
      withVault((v) => {
        assert.equal(v.recallMemories('', { projectId: 'p' }).memories.length, 3)
        assert.equal(v.recallMemories('   ', { projectId: 'p' }).memories.length, 3)
      })
    })

    it('query made only of English stopwords does not throw and returns nothing', async () => {
      assert.equal((await doRecall('the of and')).memories.length, 0)
    })

    it('query made only of Spanish stopwords does not throw and returns nothing', async () => {
      assert.equal((await doRecall('de la el')).memories.length, 0)
    })

    it('punctuation-only queries return nothing and do not throw', async () => {
      for (const q of ['!!!', '...', '"', '""', '*', '()', '-', '^', ':', '{}']) {
        const res = await run('recall', q, '--project', 'p')
        assert.equal(res.exitCode, 0, `query ${JSON.stringify(q)}: ${res.stdout}${res.stderr}`)
        assert.equal(ok<RecallResult>(res.stdout).memories.length, 0, `query ${JSON.stringify(q)}`)
      }
    })

    it('FTS operators in queries are neutralised into plain quoted terms', async () => {
      assert.equal(sanitizeFtsQuery('redis AND cache'), '"redis" OR "cache"')
      assert.equal(sanitizeFtsQuery('redis*'), '"redis"')
      assert.equal(sanitizeFtsQuery('col:redis'), '"col" OR "redis"')
      for (const q of ['redis AND', 'OR redis', 'NOT redis', 'NEAR(redis cache, 2)', '"redis', 'redis*', 'title:redis', '-redis']) {
        const res = await run('recall', q, '--project', 'p')
        assert.equal(res.exitCode, 0, `query ${q}: ${res.stdout}`)
        const memories = ok<RecallResult>(res.stdout).memories
        assert.ok(memories.some((m) => /Redis/.test(m.content)), `query ${q} should still find Redis`)
      }
    })

    it('sanitizeFtsQuery returns empty for punctuation-only input and dedupes tokens', () => {
      assert.equal(sanitizeFtsQuery('!!! ???'), '')
      assert.equal(sanitizeFtsQuery('redis Redis REDIS'), '"redis"')
      assert.equal(sanitizeFtsQuery(''), '')
    })

    it('is accent-insensitive in both directions', async () => {
      assert.equal((await doRecall('sincronizacion')).memories[0]?.content, 'Sincronización P2P entre nodos')
      assert.equal((await doRecall('sincronización')).memories[0]?.content, 'Sincronización P2P entre nodos')
    })

    it('category filter combined with the similarity floor excludes other categories', async () => {
      assert.equal((await doRecall('redis cache invalidation', '--category', 'convention')).memories.length, 0)
      assert.equal((await doRecall('redis cache invalidation', '--category', 'architecture')).memories.length, 1)
    })

    it('tags filter combined with a query only returns tagged matches', async () => {
      assert.equal((await doRecall('redis cache invalidation', '--tags', 'ci')).memories.length, 0)
      assert.equal((await doRecall('redis cache invalidation', '--tags', 'CACHE')).memories.length, 1)
    })

    it('unrelated query returns no noise', async () => {
      assert.equal((await doRecall('kubernetes helm chart')).memories.length, 0)
    })

    it('a vectorModel with no stored vectors yields no vector-only hits', () => {
      withVault((v) => {
        const res = v.recallMemories('zzzz unrelated', {
          projectId: 'p',
          vectorModel: 'nonexistent-model',
          queryVector: new Float32Array(384).fill(0.1)
        })
        assert.equal(res.memories.length, 0)
      })
    })
  })

  describe('model command edge cases', () => {
    it('invalid MEMOSEB_EMBEDDER falls back to hash with a warning in status, recall and remember', async () => {
      const bad = { ...options, runtime: mkRuntime({ MEMOSEB_EMBEDDER: 'bogus-9' }) }
      const status = ok<{ active: string; source: string; inUse: string; warning: string | null }>(
        (await executeMemoCli(['model', 'status', '--json'], bad)).stdout
      )
      assert.deepEqual([status.active, status.source, status.inUse], ['hash', 'env', 'hash'])
      assert.match(status.warning ?? '', /Unknown embedder "bogus-9"/)
      const recall = await executeMemoCli(['recall', 'anything'], bad)
      assert.equal(recall.exitCode, 0)
      assert.match(recall.stderr, /Unknown embedder "bogus-9"/)
      const remember = await executeMemoCli(['remember', 'Some note about things', '--project', 'p'], bad)
      assert.equal(remember.exitCode, 0)
      assert.match(remember.stderr, /Unknown embedder "bogus-9"/)
    })

    it('invalid stored config value falls back to hash and status flags it', async () => {
      withVault(() => undefined)
      rawSql(`INSERT INTO node_meta (key, value, updated_at) VALUES ('embedder.model', 'ghost', ?)`, new Date().toISOString())
      const status = ok<{ active: string; source: string; warning: string | null }>((await run('model', 'status')).stdout)
      assert.equal(status.active, 'hash')
      assert.equal(status.source, 'config')
      assert.match(status.warning ?? '', /ghost/)
    })

    it('"model enable hash" behaves like disable (no install, config hash, lexical vectors)', async () => {
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p')
      await run('model', 'enable', 'e5-small', '--yes')
      const res = await run('model', 'enable', 'hash')
      assert.equal(res.exitCode, 0, res.stdout)
      const data = ok<{ enabled: boolean; model: string; purged: boolean; reindexed: number }>(res.stdout)
      assert.deepEqual([data.enabled, data.model, data.purged, data.reindexed], [false, 'hash', false, 1])
      assert.equal(backend.installs, 1)
      withVault((v) => {
        assert.equal(v.getConfiguredEmbedderId(), 'hash')
        assert.deepEqual(v.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }])
      })
    })

    it('"model enable hash" needs no --yes and installs nothing', async () => {
      const res = await run('model', 'enable', 'hash')
      assert.equal(res.exitCode, 0)
      assert.equal(backend.installs, 0)
    })

    it('MODEL_LOAD_FAILED leaves config, vectors and the active embedder unchanged', async () => {
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p')
      const failing = createBackend({ failOnLoad: true })
      const res = await executeMemoCli(['model', 'enable', 'e5-small', '--yes', '--json'], { ...options, mlBackend: failing })
      assert.equal(res.exitCode, 2)
      assert.equal(code(res.stdout), 'MODEL_LOAD_FAILED')
      assert.match((decodeWire(res.stdout) as WireFailure).fault.reason, /onnx load boom/)
      assert.equal(failing.created[0]?.disposed, true)
      withVault((v) => {
        assert.equal(v.getConfiguredEmbedderId(), null)
        assert.equal(v.getActiveEmbedder().spec.id, 'hash')
        assert.deepEqual(v.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }])
      })
    })

    it('MODEL_LOAD_FAILED keeps a previously enabled model configured', async () => {
      await run('model', 'enable', 'e5-small', '--yes')
      const failing = createBackend({ failOnLoad: true })
      failing.runtimeInstalled = true
      failing.downloaded.add('minilm-multi')
      const res = await executeMemoCli(['model', 'enable', 'minilm-multi', '--json'], { ...options, mlBackend: failing })
      assert.equal(code(res.stdout), 'MODEL_LOAD_FAILED')
      withVault((v) => assert.equal(v.getConfiguredEmbedderId(), 'e5-small'))
    })

    it('RUNTIME_INSTALL_FAILED leaves config unchanged', async () => {
      const failing = createBackend({ installOk: false })
      const res = await executeMemoCli(['model', 'enable', 'e5-small', '--yes', '--json'], { ...options, mlBackend: failing })
      assert.equal(code(res.stdout), 'RUNTIME_INSTALL_FAILED')
      assert.equal(failing.created.length, 0)
      withVault((v) => assert.equal(v.getConfiguredEmbedderId(), null))
    })

    it('model reindex in hash mode re-embeds stale vectors and is idempotent', async () => {
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p')
      rawSql(`UPDATE memory_vectors SET model = 'stale-model'`)
      const first = ok<{ model: string; reindexed: number }>((await run('model', 'reindex')).stdout)
      // MemoryVault's constructor already self-heals, so 0 or 1 are both acceptable; the model must be lexical.
      assert.equal(first.model, LEXICAL_EMBEDDER_MODEL)
      withVault((v) => assert.deepEqual(v.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }]))
      assert.equal(ok<{ reindexed: number }>((await run('model', 'reindex')).stdout).reindexed, 0)
    })

    it('model reindex in hash mode on an empty vault succeeds with 0', async () => {
      const res = await run('model', 'reindex')
      assert.equal(res.exitCode, 0)
      assert.equal(ok<{ reindexed: number }>(res.stdout).reindexed, 0)
    })

    it('unknown subcommand returns UNKNOWN_SUBCOMMAND', async () => {
      const res = await run('model', 'frobnicate')
      assert.equal(res.exitCode, 2)
      assert.equal(code(res.stdout), 'UNKNOWN_SUBCOMMAND')
    })

    describe('interactive menu', () => {
      const interactive = (): ExecuteMemoCliOptions => ({
        ...options,
        modelIo: {
          interactive: true,
          progress: (t) => progress.push(t),
          ask: async (q) => {
            questions.push(q)
            return answers.shift() ?? ''
          }
        }
      })

      it('chooses a model by number and confirms', async () => {
        answers = ['3', 'y']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.equal(res.exitCode, 0, res.stderr + res.stdout)
        assert.match(res.stdout, /ENABLED with e5-small/)
        assert.equal(backend.installs, 1)
        assert.match(questions[0]!, /Choose a model/)
        assert.match(questions[1]!, /Continue\? \[y\/N\]/)
        withVault((v) => assert.equal(v.getConfiguredEmbedderId(), 'e5-small'))
      })

      it('chooses a model by id', async () => {
        answers = ['minilm-multi', 'yes']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.match(res.stdout, /ENABLED with minilm-multi/)
      })

      it('Enter picks the recommended model', async () => {
        answers = ['', 's']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.match(res.stdout, /ENABLED with e5-small/)
      })

      it('declining the confirmation installs nothing and changes no config', async () => {
        answers = ['2', 'n']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.equal(res.exitCode, 0)
        assert.match(res.stdout, /Cancelled\. Nothing was downloaded\./)
        assert.equal(backend.installs, 0)
        assert.equal(backend.created.length, 0)
        withVault((v) => assert.equal(v.getConfiguredEmbedderId(), null))
      })

      it('an empty confirmation answer defaults to No', async () => {
        answers = ['2', '']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.match(res.stdout, /Cancelled/)
        assert.equal(backend.installs, 0)
      })

      it('out-of-range number and unknown id yield UNKNOWN_MODEL without installing', async () => {
        for (const answer of ['0', '9', 'nope']) {
          answers = [answer]
          const text = await executeMemoCli(['model', 'enable'], interactive())
          assert.equal(text.exitCode, 2, `answer ${answer}`)
          assert.match(text.stderr, /Unknown model/)
        }
        assert.equal(backend.installs, 0)
      })

      it('--json never opens the menu even when interactive', async () => {
        const res = await executeMemoCli(['model', 'enable', '--json'], interactive())
        assert.equal(code(res.stdout), 'CONFIRMATION_REQUIRED')
        assert.equal(questions.length, 0)
      })

      it('choosing hash in the menu disables without asking for confirmation', async () => {
        answers = ['1']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.equal(res.exitCode, 0)
        assert.match(res.stdout, /DISABLED/)
        assert.equal(questions.length, 1)
      })

      it('skips the confirmation when the model is already installed', async () => {
        backend.runtimeInstalled = true
        backend.downloaded.add('e5-small')
        answers = ['e5-small']
        const res = await executeMemoCli(['model', 'enable'], interactive())
        assert.match(res.stdout, /ENABLED/)
        assert.equal(questions.length, 1)
      })
    })
  })

  describe('vault and semantic edge cases', () => {
    it('writeVectors ignores ids of deleted or unknown memories', async () => {
      const stored = ok<StoreMemoryResult>((await run('remember', 'Temporary note about sync', '--project', 'p')).stdout)
      withVault((v) => {
        assert.equal(v.forgetMemory(stored.memory.id), true)
        const vec = new Float32Array(8).fill(1)
        assert.equal(
          v.writeVectors('some-model', [
            { id: stored.memory.id, vector: vec },
            { id: 'ghost', vector: vec }
          ]),
          0
        )
        assert.deepEqual(v.vectorModelCounts(), [])
        assert.equal(v.writeVectors('some-model', []), 0)
      })
    })

    it('forget + recall with a semantic embedder never returns the forgotten memory', async () => {
      await run('model', 'enable', 'e5-small', '--yes')
      const a = ok<StoreMemoryResult>((await run('remember', 'Sincronizar nodos cada 5 minutos', '--project', 'p')).stdout)
      const b = ok<StoreMemoryResult>((await run('remember', 'Replicar datos entre maquinas', '--project', 'p')).stdout)
      const before = ok<RecallResult>((await run('recall', 'replicar maquinas', '--project', 'p')).stdout)
      assert.ok(before.memories.some((m) => m.id === a.memory.id))
      await run('forget', a.memory.id)
      const after = ok<RecallResult>((await run('recall', 'replicar maquinas', '--project', 'p')).stdout)
      assert.ok(!after.memories.some((m) => m.id === a.memory.id))
      assert.ok(after.memories.some((m) => m.id === b.memory.id))
      withVault((v) => assert.equal(v.countMemoriesNeedingVectors(vectorModelTag(v.getActiveEmbedder().spec)), 0))
    })

    it('snapshot import while a semantic model is active heals vectors on the next recall', async () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-qa-src-'))
      try {
        const srcDb = path.join(otherDir, 'src.sqlite')
        const src = new MemoryVault({ dbPath: srcDb, runtime: mkRuntime({ MEMOSEB_DB_PATH: srcDb }) })
        src.storeMemory({ projectId: 'p', content: 'Sincronizar nodos cada 5 minutos' })
        src.storeMemory({ projectId: 'p', content: 'Redis cache invalidation on update events' })
        const snapshot = src.exportSnapshot()
        src.close()

        await run('model', 'enable', 'e5-small', '--yes')
        withVault((v) => v.importSnapshot(snapshot))
        const tag = withVault((v) => vectorModelTag(v.getActiveEmbedder().spec))
        assert.equal(withVault((v) => v.countMemoriesNeedingVectors(tag)), 2)

        const res = ok<RecallResult>((await run('recall', 'replicar maquinas', '--project', 'p')).stdout)
        assert.equal(res.memories[0]?.content, 'Sincronizar nodos cada 5 minutos')
        assert.equal(withVault((v) => v.countMemoriesNeedingVectors(tag)), 0)
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true })
      }
    })

    it('recallWithEmbedder with a blank query skips embedding and healing', async () => {
      await run('remember', 'Some note', '--project', 'p')
      const embedder = new FakeEmbedder({ id: 'e5-small', dimensions: 384, minSimilarity: 0.35 } as EmbedderModelSpec)
      embedder.embedQuery = async () => {
        throw new Error('must not embed')
      }
      const vault = new MemoryVault({ dbPath, runtime })
      try {
        const res = await recallWithEmbedder(vault, '  ', { projectId: 'p' }, embedder)
        assert.equal(res.memories.length, 1)
      } finally {
        // Windows cannot delete an open SQLite file, so afterEach would fail with EBUSY.
        vault.close()
      }
    })

    it('stale lexical vectors of an old model tag are re-embedded on open when hash is active', async () => {
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p')
      rawSql(`UPDATE memory_vectors SET model = 'local-feature-hash-v1'`)
      withVault((v) => assert.deepEqual(v.vectorModelCounts(), [{ model: LEXICAL_EMBEDDER_MODEL, count: 1 }]))
    })

    it('does not rewrite semantic vectors to lexical on open when a semantic model is active', async () => {
      await run('remember', 'Sincronización P2P entre nodos', '--project', 'p')
      await run('model', 'enable', 'e5-small', '--yes')
      withVault((v) => {
        const tag = vectorModelTag(v.getActiveEmbedder().spec)
        assert.deepEqual(v.vectorModelCounts(), [{ model: tag, count: 1 }])
      })
    })
  })

  describe('near-duplicate hint', () => {
    it('prints "Possible duplicate" in text output only for close same-category memories', async () => {
      const first = await executeMemoCli(
        ['remember', 'Redis cache invalidation happens on update events', '--project', 'p', '--category', 'architecture'],
        options
      )
      assert.doesNotMatch(first.stdout, /Possible duplicate/)
      const dup = await executeMemoCli(
        ['remember', 'Redis cache invalidation happens on update events too', '--project', 'p', '--category', 'architecture'],
        options
      )
      assert.match(
        dup.stdout,
        /Possible duplicate of \[[^\]]+\] .* \(similarity \d\.\d\d\)\. Remove the outdated one with "memoseb forget <id>"\./
      )
      const json = ok<StoreMemoryResult>(
        (await run('remember', 'Redis cache invalidation happens on update events also', '--project', 'p', '--category', 'architecture')).stdout
      )
      assert.ok((json.similar ?? []).length >= 1)
      const other = await executeMemoCli(
        ['remember', 'Redis cache invalidation happens on update events now', '--project', 'p', '--category', 'convention'],
        options
      )
      assert.doesNotMatch(other.stdout, /Possible duplicate/)
      const unrelated = await executeMemoCli(
        ['remember', 'Kubernetes helm chart values live in the infra repo', '--project', 'p', '--category', 'architecture'],
        options
      )
      assert.doesNotMatch(unrelated.stdout, /Possible duplicate/)
    })

    it('re-storing identical content reports an update, not a duplicate', async () => {
      await run('remember', 'Redis cache invalidation on update events', '--project', 'p')
      const res = await executeMemoCli(['remember', 'Redis cache invalidation on update events', '--project', 'p'], options)
      assert.match(res.stdout, /Updated existing memory/)
      assert.doesNotMatch(res.stdout, /Possible duplicate/)
    })
  })
})
