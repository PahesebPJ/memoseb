import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { findModelSpec, findRerankerSpec, type EmbedderModelSpec, type RerankerModelSpec } from '../src/core/model-catalog.ts'
import {
  createModelIdleReleaser,
  DEFAULT_MODEL_IDLE_MINUTES,
  MAX_MODEL_IDLE_MS,
  resolveModelIdleMs,
  type MlBackend
} from '../src/core/semantic.ts'
import type { MlPaths, SemanticEmbedder, SemanticReranker } from '../src/core/transformers-embedder.ts'
import { MemoryVault } from '../src/core/vault.ts'
import { PassThrough } from 'node:stream'
import { handleMcpRequest, startMcpServer } from '../src/mcp/server.ts'

const PROJECT = 'idle-test'
const V2 = findRerankerSpec('bge-reranker-v2-m3')!

class FakeReranker implements SemanticReranker {
  readonly spec: RerankerModelSpec
  disposed = false
  constructor(spec: RerankerModelSpec) {
    this.spec = { ...spec, minScore: 0 }
  }
  async score(_query: string, passages: readonly string[]): Promise<number[]> {
    return passages.map(() => 0.5)
  }
  async dispose(): Promise<void> {
    this.disposed = true
  }
}

const E5 = findModelSpec('e5-small')!

class FakeEmbedder implements SemanticEmbedder {
  readonly spec = E5
  readonly model = 'fake-embedder'
  readonly dimensions = E5.dimensions
  disposed = false
  async embedQuery(): Promise<Float32Array> {
    return new Float32Array(this.dimensions).fill(0.1)
  }
  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map(() => new Float32Array(this.dimensions).fill(0.1))
  }
  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function createEmbedderBackend() {
  const backend = {
    embedders: [] as FakeEmbedder[],
    isRuntimeInstalled: (_p: MlPaths) => true,
    isModelDownloaded: (_p: MlPaths, spec: Pick<EmbedderModelSpec, 'hfModel'>) => spec.hfModel === E5.hfModel,
    installRuntime: async () => ({ installed: true, sizeBytes: 0, prunedBytes: 0, log: '' }),
    createEmbedder: () => {
      const embedder = new FakeEmbedder()
      backend.embedders.push(embedder)
      return embedder
    },
    createReranker: (): never => {
      throw new Error('rerankers are not used here')
    }
  }
  return backend satisfies MlBackend
}

const call = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args }
})

function createBackend() {
  const backend = {
    rerankers: [] as FakeReranker[],
    isRuntimeInstalled: (_p: MlPaths) => true,
    isModelDownloaded: (_p: MlPaths, spec: Pick<EmbedderModelSpec, 'hfModel'>) => spec.hfModel === V2.hfModel,
    installRuntime: async () => ({ installed: true, sizeBytes: 0, prunedBytes: 0, log: '' }),
    createEmbedder: (): never => {
      throw new Error('embedders are not used in this suite')
    },
    createReranker: (spec: RerankerModelSpec) => {
      const reranker = new FakeReranker(spec)
      backend.rerankers.push(reranker)
      return reranker
    }
  }
  return backend satisfies MlBackend
}

describe('resolveModelIdleMs', () => {
  it('defaults to five minutes', () => {
    assert.equal(DEFAULT_MODEL_IDLE_MINUTES, 5)
    assert.equal(resolveModelIdleMs({}), 5 * 60_000)
  })

  it('reads MEMOSEB_MODEL_IDLE_MINUTES, including fractions and 0', () => {
    assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: '10' }), 600_000)
    assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: '0.5' }), 30_000)
    assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: '0' }), 0)
  })

  it('falls back to the default on invalid values', () => {
    for (const value of ['', '  ', 'abc', '-1', 'Infinity', 'NaN']) {
      assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: value }), 5 * 60_000, value)
    }
  })

  it('clamps huge values below the setTimeout limit and tiny positives to 1 ms', () => {
    assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: '100000' }), MAX_MODEL_IDLE_MS)
    assert.equal(resolveModelIdleMs({ MEMOSEB_MODEL_IDLE_MINUTES: '1e-9' }), 1)
  })
})

describe('createModelIdleReleaser', () => {
  let tmpDir: string
  let vault: MemoryVault

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-idle-test-'))
    vault = new MemoryVault({ dbPath: path.join(tmpDir, 'vault.sqlite') })
  })

  afterEach(() => {
    vault.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const counting = (idleMs: number) => {
    const state = { releases: 0 }
    const idle = createModelIdleReleaser(vault, {
      idleMs,
      release: async () => {
        state.releases++
      }
    })
    return { idle, state }
  }

  it('releases once after the idle period and returns the call result', async () => {
    const { idle, state } = counting(30)
    assert.equal(await idle.run(async () => 42), 42)
    assert.equal(state.releases, 0)
    await sleep(80)
    assert.equal(state.releases, 1)
    await sleep(60)
    assert.equal(state.releases, 1)
  })

  it('never releases while a call is in flight', async () => {
    const { idle, state } = counting(20)
    let finish!: () => void
    const slow = idle.run(() => new Promise<void>((resolve) => (finish = resolve)))
    await idle.run(async () => {})
    await sleep(60)
    assert.equal(state.releases, 0)
    finish()
    await slow
    await sleep(60)
    assert.equal(state.releases, 1)
  })

  it('restarts the countdown on each call', async () => {
    const { idle, state } = counting(60)
    await idle.run(async () => {})
    await sleep(35)
    await idle.run(async () => {})
    await sleep(35)
    assert.equal(state.releases, 0)
    await sleep(60)
    assert.equal(state.releases, 1)
  })

  it('arms the countdown even when the call throws', async () => {
    const { idle, state } = counting(20)
    await assert.rejects(idle.run(async () => Promise.reject(new Error('boom'))), /boom/)
    await sleep(60)
    assert.equal(state.releases, 1)
  })

  it('keeps models loaded with idleMs 0 and stop() cancels a pending release', async () => {
    const never = counting(0)
    await never.idle.run(async () => {})
    const stopped = counting(20)
    await stopped.idle.run(async () => {})
    stopped.idle.stop()
    await sleep(60)
    assert.equal(never.state.releases, 0)
    assert.equal(stopped.state.releases, 0)
  })

  it('does not re-arm when an in-flight call finishes after stop()', async () => {
    const { idle, state } = counting(20)
    let finish!: () => void
    const slow = idle.run(() => new Promise<void>((resolve) => (finish = resolve)))
    idle.stop()
    finish()
    await slow
    await sleep(60)
    assert.equal(state.releases, 0)
  })

  it('swallows release failures', async () => {
    const idle = createModelIdleReleaser(vault, {
      idleMs: 10,
      release: async () => Promise.reject(new Error('dispose failed'))
    })
    await idle.run(async () => {})
    await sleep(40)
  })

  it('MCP memory_recall unloads the reranker when idle and reloads it on the next call', async () => {
    const backend = createBackend()
    vault.setConfiguredRerankerId(V2.id)
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync between nodes uses HTTP exchange endpoints' })
    let released = 0
    const idle = createModelIdleReleaser(vault, { idleMs: 30, onRelease: () => released++ })
    const recall = () =>
      handleMcpRequest(
        vault,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'memory_recall', arguments: { query: 'peer sync', projectId: PROJECT } }
        },
        backend,
        idle
      )

    await recall()
    await recall()
    assert.equal(backend.rerankers.length, 1)
    await sleep(80)
    assert.equal(released, 1)
    assert.ok(backend.rerankers[0]!.disposed)

    await recall()
    assert.equal(backend.rerankers.length, 2)
    assert.equal(backend.rerankers[1]!.disposed, false)
    idle.stop()
  })

  it('overlapping runs release only after the last one finishes', async () => {
    const { idle, state } = counting(20)
    let finishA!: () => void
    let finishB!: () => void
    const a = idle.run(() => new Promise<void>((r) => (finishA = r)))
    const b = idle.run(() => new Promise<void>((r) => (finishB = r)))
    finishA()
    await a
    await sleep(60)
    assert.equal(state.releases, 0)
    finishB()
    await b
    await sleep(60)
    assert.equal(state.releases, 1)
  })

  it('a call starting during release gets a fresh, non-disposed reranker', async () => {
    const backend = createBackend()
    vault.setConfiguredRerankerId(V2.id)
    vault.storeMemory({ projectId: PROJECT, content: 'peer sync between nodes uses HTTP exchange endpoints' })
    const idle = createModelIdleReleaser(vault, { idleMs: 15 })
    const recall = () => handleMcpRequest(vault, call('memory_recall', { query: 'peer sync', projectId: PROJECT }), backend, idle)
    await recall()
    await sleep(15 + 2)
    await recall()
    await sleep(5)
    const last = backend.rerankers.at(-1)!
    assert.equal(last.disposed, false)
    assert.ok(backend.rerankers.length >= 2)
    idle.stop()
  })

  it('MCP memory_store releases and disposes a semantic embedder, then reloads it', async () => {
    const backend = createEmbedderBackend()
    vault.setConfiguredEmbedderId(E5.id)
    let released = 0
    const idle = createModelIdleReleaser(vault, { idleMs: 25, onRelease: () => released++ })
    const store = (content: string) =>
      handleMcpRequest(vault, call('memory_store', { content, projectId: PROJECT }), backend, idle)
    const first = await store('first semantic memory')
    assert.equal(first?.error, undefined)
    await store('second semantic memory')
    assert.equal(backend.embedders.length, 1)
    await sleep(70)
    assert.equal(released, 1)
    assert.ok(backend.embedders[0]!.disposed)
    await store('third semantic memory')
    assert.equal(backend.embedders.length, 2)
    assert.equal(backend.embedders[1]!.disposed, false)
    idle.stop()
  })

  it('memory_briefing does not arm the idle timer', async () => {
    let released = 0
    const idle = createModelIdleReleaser(vault, { idleMs: 15, onRelease: () => released++ })
    const res = await handleMcpRequest(vault, call('memory_briefing', { projectId: PROJECT }), createBackend(), idle)
    assert.ok(res?.result)
    await sleep(50)
    assert.equal(released, 0)
  })

  it('startMcpServer stops the idle releaser when input closes', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let stops = 0
    let runs = 0
    const idle = {
      run: async <T>(fn: () => Promise<T>) => {
        runs++
        return fn()
      },
      stop: () => {
        stops++
      }
    }
    startMcpServer(vault, input, output, idle)
    input.write(JSON.stringify(call('memory_store', { content: 'via stdio', projectId: PROJECT })) + '\n')
    await sleep(50)
    assert.equal(runs, 1)
    input.end()
    await sleep(20)
    assert.equal(stops, 1)
  })

  it('startMcpServer leaves no pending release after close', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let released = 0
    const idle = createModelIdleReleaser(vault, { idleMs: 25, onRelease: () => released++ })
    startMcpServer(vault, input, output, idle)
    await idle.run(async () => {})
    input.end()
    await sleep(70)
    assert.equal(released, 0)
  })
})
