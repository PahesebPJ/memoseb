import { fork, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vectorModelTag, type EmbedderModelSpec, type RerankerModelSpec } from './model-catalog.ts'
import type { MlBackend } from './semantic.ts'
import type { MlPaths, SemanticEmbedder, SemanticReranker } from './transformers-embedder.ts'

/**
 * Freeing ONNX sessions inside a long-lived Node process does not give the
 * memory back to the OS (measured: ~500 MB stays resident after dispose), so
 * the MCP server runs its models in a child process and kills it when idle.
 */

type ModelKind = 'embedder' | 'reranker'

interface InstanceRef {
  kind: ModelKind
  spec: EmbedderModelSpec | RerankerModelSpec
  paths: MlPaths
}

export type HostRequest =
  | (InstanceRef & { op: 'embedQuery'; text: string })
  | (InstanceRef & { op: 'embedPassages'; texts: readonly string[] })
  | (InstanceRef & { op: 'score'; query: string; passages: readonly string[] })
  | (InstanceRef & { op: 'dispose' })

export type HostReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

/** Child entry next to this module, keeping the .ts/.js extension of the running build. */
export function defaultModelHostEntry(): string {
  const self = fileURLToPath(import.meta.url)
  return path.join(path.dirname(self), `model-host-child${path.extname(self)}`)
}

export class ModelHostClient {
  private readonly entry: string
  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(options: { entry?: string } = {}) {
    this.entry = options.entry ?? defaultModelHostEntry()
  }

  get running(): boolean {
    return this.child !== null
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  request(req: HostRequest): Promise<unknown> {
    const child = this.child ?? this.spawn()
    // Keep the event loop alive only while a reply is outstanding.
    child.channel?.ref()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        child.send({ id, ...req }, (err) => {
          if (err) this.settle(id, { id, ok: false, error: err.message })
        })
      } catch (err) {
        this.settle(id, { id, ok: false, error: err instanceof Error ? err.message : String(err) })
      }
    })
  }

  /** Forwards a dispose only to a live host: never spawns one just to unload. */
  async disposeInstance(ref: InstanceRef): Promise<void> {
    if (!this.child) return
    await this.request({ ...ref, op: 'dispose' }).catch(() => {})
  }

  /** Kills the host so the OS reclaims all model memory; the next request respawns it. */
  async shutdown(): Promise<void> {
    const child = this.child
    if (!child) return
    this.detach(child, 'Model host was shut down.')
    if (child.exitCode !== null || child.signalCode !== null) return
    // The child is unref'd: re-ref it so the event loop waits for its exit.
    child.ref()
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
    })
  }

  private spawn(): ChildProcess {
    // stdout is the MCP channel: the host must never write to it.
    const child = fork(this.entry, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' })
    child.on('message', (msg: HostReply) => this.settle(msg.id, msg))
    child.on('error', (err) => this.detach(child, `Model host failed: ${err.message}`))
    child.on('exit', (code, signal) =>
      this.detach(child, `Model host exited (${signal ?? `code ${code}`}).`)
    )
    // The MCP server may exit while the host idles; never keep it alive for the host.
    child.unref()
    child.channel?.unref()
    this.child = child
    return child
  }

  private settle(id: number, reply: HostReply): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (this.pending.size === 0) this.child?.channel?.unref()
    if (reply.ok) entry.resolve(reply.value)
    else entry.reject(new Error(reply.error))
  }

  private detach(child: ChildProcess, reason: string): void {
    if (this.child !== child) return
    this.child = null
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      entry.reject(new Error(reason))
    }
  }
}

class RemoteEmbedder implements SemanticEmbedder {
  readonly model: string
  readonly dimensions: number
  readonly spec: EmbedderModelSpec
  private readonly ref: InstanceRef
  private readonly host: ModelHostClient

  constructor(host: ModelHostClient, spec: EmbedderModelSpec, paths: MlPaths) {
    this.host = host
    this.spec = spec
    this.model = vectorModelTag(spec)
    this.dimensions = spec.dimensions
    this.ref = { kind: 'embedder', spec, paths }
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return (await this.host.request({ ...this.ref, op: 'embedQuery', text })) as Float32Array
  }

  async embedPassages(texts: readonly string[]): Promise<Float32Array[]> {
    return (await this.host.request({ ...this.ref, op: 'embedPassages', texts })) as Float32Array[]
  }

  dispose(): Promise<void> {
    return this.host.disposeInstance(this.ref)
  }
}

class RemoteReranker implements SemanticReranker {
  readonly spec: RerankerModelSpec
  private readonly ref: InstanceRef
  private readonly host: ModelHostClient

  constructor(host: ModelHostClient, spec: RerankerModelSpec, paths: MlPaths) {
    this.host = host
    this.spec = spec
    this.ref = { kind: 'reranker', spec, paths }
  }

  async score(query: string, passages: readonly string[]): Promise<number[]> {
    return (await this.host.request({ ...this.ref, op: 'score', query, passages })) as number[]
  }

  dispose(): Promise<void> {
    return this.host.disposeInstance(this.ref)
  }
}

/** Same install checks as `base`, but models load and run in the host process. */
export function createModelHostBackend(base: MlBackend, host: ModelHostClient): MlBackend {
  return {
    isRuntimeInstalled: (paths) => base.isRuntimeInstalled(paths),
    isModelDownloaded: (paths, spec) => base.isModelDownloaded(paths, spec),
    installRuntime: (paths, onOutput) => base.installRuntime(paths, onOutput),
    createEmbedder: (spec, paths) => new RemoteEmbedder(host, spec, paths),
    createReranker: (spec, paths) => new RemoteReranker(host, spec, paths)
  }
}

export type ModelFactory = Pick<MlBackend, 'createEmbedder' | 'createReranker'>

/** Child side: serves HostRequests over IPC with locally loaded models. */
export function runModelHost(factory: ModelFactory, proc: NodeJS.Process = process): void {
  const instances = new Map<string, SemanticEmbedder | SemanticReranker>()
  const keyOf = (ref: InstanceRef) => `${ref.kind}\0${ref.spec.id}\0${ref.paths.root}`

  const instance = (ref: InstanceRef) => {
    const key = keyOf(ref)
    let found = instances.get(key)
    if (!found) {
      found =
        ref.kind === 'embedder'
          ? factory.createEmbedder(ref.spec as EmbedderModelSpec, ref.paths)
          : factory.createReranker(ref.spec as RerankerModelSpec, ref.paths)
      instances.set(key, found)
    }
    return found
  }

  const handle = async (req: HostRequest): Promise<unknown> => {
    switch (req.op) {
      case 'embedQuery':
        return (instance(req) as SemanticEmbedder).embedQuery(req.text)
      case 'embedPassages':
        return (instance(req) as SemanticEmbedder).embedPassages(req.texts)
      case 'score':
        return (instance(req) as SemanticReranker).score(req.query, req.passages)
      case 'dispose': {
        const key = keyOf(req)
        const found = instances.get(key)
        instances.delete(key)
        await found?.dispose()
        return null
      }
    }
  }

  proc.on('message', (msg: HostRequest & { id: number }) => {
    handle(msg).then(
      (value) => proc.send?.({ id: msg.id, ok: true, value } satisfies HostReply),
      (err: unknown) =>
        proc.send?.({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies HostReply)
    )
  })
  // Orphaned hosts exit as soon as their MCP server goes away.
  proc.on('disconnect', () => proc.exit(0))
}
