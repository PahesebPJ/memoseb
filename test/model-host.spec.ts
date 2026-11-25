import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { findModelSpec, findRerankerSpec } from '../src/core/model-catalog.ts'
import { createModelHostBackend, defaultModelHostEntry, ModelHostClient, runModelHost } from '../src/core/model-host.ts'
import { cachedActiveReranker, createModelIdleReleaser, defaultMlBackend, releaseCachedEmbedder, type MlBackend } from '../src/core/semantic.ts'
import { MemoryVault } from '../src/core/vault.ts'
import { PassThrough } from 'node:stream'
import { createModelHostReleaser, handleMcpRequest, startMcpServer } from '../src/mcp/server.ts'
import type { MlPaths } from '../src/core/transformers-embedder.ts'

const FAKE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-model-host.ts')
const E5 = findModelSpec('e5-small')!
const V2 = findRerankerSpec('bge-reranker-v2-m3')!
const PATHS: MlPaths = { root: '/tmp/ml', runtimeDir: '/tmp/ml/runtime', modelsDir: '/tmp/ml/models' } as MlPaths

describe('ModelHostClient', () => {
  let host: ModelHostClient

  afterEach(async () => {
    await host?.shutdown()
  })

  const backendFor = (h: ModelHostClient) => createModelHostBackend(defaultMlBackend, h)

  it('runs embeddings and reranking in a child process, keeping Float32Array', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const backend = backendFor(host)
    const embedder = backend.createEmbedder(E5, PATHS)
    assert.equal(host.running, false, 'creating a proxy must not spawn the host')
    const query = await embedder.embedQuery('hola')
    assert.ok(query instanceof Float32Array)
    assert.equal(query[0], 4)
    assert.notEqual(query[1], process.pid)
    assert.equal(query[1], host.pid)
    const passages = await embedder.embedPassages(['a', 'abc'])
    assert.deepEqual(passages.map((v) => v[0]), [1, 3])
    assert.equal(embedder.model, defaultMlBackend.createEmbedder(E5, PATHS).model)
    assert.equal(embedder.dimensions, E5.dimensions)
    const scores = await backend.createReranker(V2, PATHS).score('q', ['xx', 'xxxx'])
    assert.deepEqual(scores, [0.02, 0.04])
  })

  it('shutdown kills the host and the next request respawns it', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = backendFor(host).createEmbedder(E5, PATHS)
    const firstPid = (await embedder.embedQuery('x'))[1]
    await host.shutdown()
    assert.equal(host.running, false)
    assert.throws(() => process.kill(firstPid!, 0), /ESRCH/)
    const secondPid = (await embedder.embedQuery('x'))[1]
    assert.notEqual(secondPid, firstPid)
  })

  it('dispose never spawns a host', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    await backendFor(host).createEmbedder(E5, PATHS).dispose()
    await backendFor(host).createReranker(V2, PATHS).dispose()
    assert.equal(host.running, false)
  })

  it('propagates model errors without killing the host', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const backend = backendFor(host)
    await assert.rejects(backend.createEmbedder(E5, PATHS).embedQuery('boom'), /onnx exploded/)
    await assert.rejects(backend.createReranker(V2, PATHS).score('boom', ['a']), /rerank exploded/)
    const pid = host.pid
    assert.equal((await backend.createEmbedder(E5, PATHS).embedQuery('ok'))[1], pid)
  })

  it('rejects in-flight calls when the host crashes and recovers on the next call', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = backendFor(host).createEmbedder(E5, PATHS)
    await assert.rejects(embedder.embedQuery('crash'), /Model host exited \(code 3\)/)
    assert.equal(host.running, false)
    assert.equal((await embedder.embedQuery('abc'))[0], 3)
  })

  it('rejects when the entry cannot run', async () => {
    host = new ModelHostClient({ entry: path.join(path.dirname(FAKE_HOST), 'does-not-exist.ts') })
    await assert.rejects(backendFor(host).createEmbedder(E5, PATHS).embedQuery('x'), /Model host exited/)
  })

  it('delegates install checks to the base backend', () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const calls: string[] = []
    const base = {
      isRuntimeInstalled: () => (calls.push('runtime'), true),
      isModelDownloaded: () => (calls.push('model'), false),
      installRuntime: async () => (calls.push('install'), { installed: true, sizeBytes: 0, prunedBytes: 0, log: '' }),
      createEmbedder: () => assert.fail('must not load in the server process'),
      createReranker: () => assert.fail('must not load in the server process')
    } satisfies MlBackend
    const backend = createModelHostBackend(base, host)
    assert.equal(backend.isRuntimeInstalled(PATHS), true)
    assert.equal(backend.isModelDownloaded(PATHS, E5), false)
    void backend.installRuntime(PATHS)
    backend.createEmbedder(E5, PATHS)
    assert.deepEqual(calls, ['runtime', 'model', 'install'])
  })

  it('defaults to the sibling model-host-child entry with the running extension', () => {
    const entry = defaultModelHostEntry()
    assert.match(path.basename(entry), /^model-host-child\.(ts|js)$/)
  })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('ModelHostClient edge cases', () => {
  let host: ModelHostClient
  afterEach(async () => {
    await host?.shutdown()
  })
  const embedderFor = (h: ModelHostClient) => createModelHostBackend(defaultMlBackend, h).createEmbedder(E5, PATHS)

  it('routes concurrent in-flight requests to the right caller by id', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = embedderFor(host)
    const reranker = createModelHostBackend(defaultMlBackend, host).createReranker(V2, PATHS)
    const texts = ['slow:80:a', 'b', 'slow:40:abcd', 'abcdefg', 'slow:10:x']
    const [q, passages, scores, ...rest] = await Promise.all([
      embedder.embedQuery(texts[0]!),
      embedder.embedPassages(texts),
      reranker.score('q', ['xx', 'xxxx']),
      ...texts.map((t) => embedder.embedQuery(t))
    ])
    assert.equal(q[0], texts[0]!.length)
    assert.deepEqual(passages.map((v) => v[0]), texts.map((t) => t.length))
    assert.deepEqual(scores, [0.02, 0.04])
    assert.deepEqual(rest.map((v) => v[0]), texts.map((t) => t.length))
    assert.equal(new Set(rest.map((v) => v[1])).size, 1, 'a single host serves all requests')
  })

  it('shutdown rejects in-flight requests and the next request respawns', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = embedderFor(host)
    const firstPid = (await embedder.embedQuery('x'))[1]!
    const inflight = [embedder.embedQuery('slow:2000:a'), embedder.embedQuery('slow:2000:b')].map((p) =>
      assert.rejects(p, /Model host was shut down/)
    )
    await sleep(20)
    await host.shutdown()
    await Promise.all(inflight)
    assert.equal(host.running, false)
    assert.equal(alive(firstPid), false)
    const next = await embedder.embedQuery('abc')
    assert.equal(next[0], 3)
    assert.notEqual(next[1], firstPid)
  })

  it('double and concurrent shutdown are idempotent', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = embedderFor(host)
    await host.shutdown()
    const pid = (await embedder.embedQuery('x'))[1]!
    await Promise.all([host.shutdown(), host.shutdown(), host.shutdown()])
    await host.shutdown()
    assert.equal(host.running, false)
    assert.equal(alive(pid), false)
  })

  it('a request issued right after un-awaited shutdown gets a fresh host', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = embedderFor(host)
    const firstPid = (await embedder.embedQuery('x'))[1]!
    const down = host.shutdown()
    const next = await embedder.embedQuery('abcd')
    await down
    assert.equal(next[0], 4)
    assert.notEqual(next[1], firstPid)
    assert.equal(host.running, true)
    assert.equal(host.pid, next[1])
    assert.equal(alive(firstPid), false)
  })

  it('shutdown with a pending request in the old host does not reject the new host request', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const embedder = embedderFor(host)
    await embedder.embedQuery('x')
    const old = embedder.embedQuery('slow:2000:a')
    const oldRejected = assert.rejects(old, /shut down/)
    await sleep(20)
    const down = host.shutdown()
    const fresh = embedder.embedQuery('slow:30:zz')
    await down
    await oldRejected
    assert.equal((await fresh)[0], 'slow:30:zz'.length)
  })
})

describe('process lifecycle', () => {
  const LIFECYCLE = path.join(path.dirname(FAKE_HOST), 'host-lifecycle-script.ts')
  const script = (arg: string) => spawnSync(process.execPath, [LIFECYCLE, arg], { encoding: 'utf8', timeout: 8000 })

  it('exits on its own after replies even if the host is never shut down', () => {
    const res = script('keep')
    assert.equal(res.error, undefined, 'process must not hang (timeout)')
    assert.equal(res.status, 0, res.stderr)
    const pid = Number(/pid (\d+)/.exec(res.stdout)![1])
    for (let i = 0; i < 50 && alive(pid); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    assert.equal(alive(pid), false, 'host must exit when its parent goes away')
    assert.ok(pid > 0)
  })
})

describe('model host + idle releaser integration', () => {
  let tmpDir: string
  let vault: MemoryVault
  let host: ModelHostClient

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-host-idle-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(async () => {
    await host?.shutdown()
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('kills the host after idleMs and the next call through the cached reranker respawns it', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const base: MlBackend = {
      ...defaultMlBackend,
      isRuntimeInstalled: () => true,
      isModelDownloaded: (_p, spec) => spec.hfModel === V2.hfModel
    }
    const backend = createModelHostBackend(base, host)
    vault.setConfiguredRerankerId(V2.id)
    let released = 0
    const idle = createModelIdleReleaser(vault, {
      idleMs: 40,
      release: async (v) => {
        await releaseCachedEmbedder(v)
        await host.shutdown()
      },
      onRelease: () => released++
    })
    const score = () => idle.run(() => cachedActiveReranker(vault, backend).reranker!.score('q', ['xxxx']))
    assert.deepEqual(await score(), [0.04])
    const firstPid = host.pid!
    assert.ok(alive(firstPid))
    for (let i = 0; i < 50 && released === 0; i++) await sleep(20)
    assert.equal(released, 1)
    assert.equal(host.running, false)
    assert.equal(alive(firstPid), false)
    assert.deepEqual(await score(), [0.04])
    assert.equal(host.running, true)
    assert.notEqual(host.pid, firstPid)
    idle.stop()
  })

  it('memory_recall via handleMcpRequest works after the host was released', async () => {
    host = new ModelHostClient({ entry: FAKE_HOST })
    const base: MlBackend = {
      ...defaultMlBackend,
      isRuntimeInstalled: () => true,
      isModelDownloaded: (_p, spec) => spec.hfModel === V2.hfModel
    }
    const backend = createModelHostBackend(base, host)
    vault.setConfiguredRerankerId(V2.id)
    vault.storeMemory({ projectId: 'p', content: 'peer sync between nodes uses HTTP exchange endpoints' })
    const idle = createModelIdleReleaser(vault, {
      idleMs: 30,
      release: async (v) => {
        await releaseCachedEmbedder(v)
        await host.shutdown()
      }
    })
    const recall = () =>
      handleMcpRequest(
        vault,
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'peer sync', projectId: 'p' } } },
        backend,
        idle
      )
    const first = await recall()
    assert.equal(first?.error, undefined)
    const pid = host.pid!
    assert.ok(alive(pid))
    // running flips on detach; the process itself exits a moment later.
    for (let i = 0; i < 100 && (host.running || alive(pid)); i++) await sleep(20)
    assert.equal(host.running, false)
    assert.equal(alive(pid), false)
    const second = await recall()
    assert.equal(second?.error, undefined)
    assert.ok(second?.result)
    assert.equal(host.running, true)
    idle.stop()
  })
})

describe('MCP server shutdown paths', () => {
  let tmpDir: string
  let vault: MemoryVault
  let host: ModelHostClient | undefined

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-host-mcp-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(async () => {
    delete process.env.FAKE_HOST_DISPOSE_MS
    await host?.shutdown()
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('a call arriving while the idle release disposes models gets a fresh host', async () => {
    // Slow dispose widens the window where the old host is still alive.
    process.env.FAKE_HOST_DISPOSE_MS = '150'
    host = new ModelHostClient({ entry: FAKE_HOST })
    const base: MlBackend = {
      ...defaultMlBackend,
      isRuntimeInstalled: () => true,
      isModelDownloaded: (_p, spec) => spec.hfModel === V2.hfModel
    }
    const backend = createModelHostBackend(base, host)
    vault.setConfiguredRerankerId(V2.id)
    const idle = createModelHostReleaser(vault, host, { idleMs: 20 })
    const score = () => idle.run(() => cachedActiveReranker(vault, backend).reranker!.score('q', ['xxxx']))
    assert.deepEqual(await score(), [0.04])
    const firstPid = host.pid!
    await sleep(50)
    assert.deepEqual(await score(), [0.04])
    assert.notEqual(host.pid, firstPid)
    idle.stop()
  })

  it('stdin EOF right after the last request still answers it before shutting down', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stopped = false
    let answeredBeforeStop = false
    const idle = {
      run: async <T>(fn: () => Promise<T>) => {
        await sleep(60)
        return fn()
      },
      stop: () => {
        stopped = true
      }
    }
    let out = ''
    output.on('data', (d) => {
      out += d
      if (!stopped) answeredBeforeStop = true
    })
    startMcpServer(vault, input, output, idle)
    input.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'memory_store', arguments: { content: 'piped then EOF', projectId: 'p' } }
      }) + '\n'
    )
    for (let i = 0; i < 50 && !stopped; i++) await sleep(20)
    assert.ok(stopped)
    assert.ok(answeredBeforeStop)
    const reply = JSON.parse(out.trim()) as { id: number; result?: { isError?: boolean } }
    assert.equal(reply.id, 7)
    assert.notEqual(reply.result?.isError, true)
  })
})

describe('runModelHost', () => {
  it('reuses one instance per model, disposes on request and exits on disconnect', async () => {
    const proc = new EventEmitter() as EventEmitter & { send: (m: unknown) => boolean; exit: (c: number) => void }
    const sent: Array<{ id: number; ok: boolean; value?: unknown }> = []
    let exitCode: number | undefined
    proc.send = (m) => (sent.push(m as { id: number; ok: boolean }), true)
    proc.exit = (c) => {
      exitCode = c
    }
    let created = 0
    let disposed = 0
    runModelHost(
      {
        createEmbedder: (spec) => {
          created++
          return {
            spec,
            model: 'm',
            dimensions: 1,
            embedQuery: async () => Float32Array.of(created),
            embedPassages: async () => [],
            dispose: async () => {
              disposed++
            }
          }
        },
        createReranker: () => assert.fail('unused')
      },
      proc as unknown as NodeJS.Process
    )
    const ref = { kind: 'embedder', spec: E5, paths: PATHS }
    const flush = () => new Promise((r) => setImmediate(r))
    proc.emit('message', { id: 1, op: 'embedQuery', text: 'a', ...ref })
    proc.emit('message', { id: 2, op: 'embedQuery', text: 'b', ...ref })
    await flush()
    assert.equal(created, 1)
    proc.emit('message', { id: 3, op: 'dispose', ...ref })
    await flush()
    assert.equal(disposed, 1)
    proc.emit('message', { id: 4, op: 'embedQuery', text: 'c', ...ref })
    await flush()
    assert.equal(created, 2)
    assert.deepEqual(sent.map((m) => [m.id, m.ok]), [[1, true], [2, true], [3, true], [4, true]])
    proc.emit('disconnect')
    assert.equal(exitCode, 0)
  })
})
