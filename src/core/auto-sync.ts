import type { SystemRuntime } from 'hubseb'
import { DEFAULT_SYNC_INTERVAL_MINUTES } from './schema.ts'
import {
  discoverLanNodes,
  discoverTailnetNodes,
  registerDiscoveredPeers,
  syncAllPeers,
  syncWithPeer,
  type DiscoveredLanNode,
  type SyncCapableVault,
  type SyncSummaryResult
} from './sync.ts'
import { probeTailscale, type TailscaleProbeResult } from './tailscale.ts'

export type AutoSyncReason =
  | 'startup'
  | 'interval'
  | 'local-write'
  | 'remote-import'
  | 'discovery'
  | 'manual'

export interface AutoSyncEvent {
  reason: AutoSyncReason
  summary?: SyncSummaryResult
  discovered?: string[]
  error?: string
}

export interface AutoSyncLoopOptions {
  intervalMs?: number
  discoveryIntervalMs?: number
  debounceMs?: number
  maxDebounceMs?: number
  changePollMs?: number
  timeoutMs?: number
  discover?: () => Promise<DiscoveredLanNode[]>
  callbackUrl?: (peerUrl: string) => string | undefined
  onEvent?: (event: AutoSyncEvent) => void
}

export interface AutoSyncLoopHandle {
  notifyChange(reason?: 'local-write' | 'remote-import'): void
  syncNow(reason?: AutoSyncReason): Promise<void>
  discoverNow(): Promise<string[]>
  close(): Promise<void>
}

/**
 * Bucle de auto-sync de `memoseb node serve`:
 * - al arrancar: descubrimiento y sync con todos los peers,
 * - cada intervalMs (syncIntervalMinutes, 5 min por omisión): sync con todos,
 * - tras escrituras locales de otros procesos (PRAGMA data_version) o
 *   importaciones remotas que aplicaron cambios: sync con debounce,
 * - cada discoveryIntervalMs: descubrimiento; un peer nuevo se sincroniza al momento.
 * Nunca hay dos syncs a la vez; un aviso durante un sync deja otro pendiente.
 */
export function startAutoSyncLoop(
  vault: SyncCapableVault,
  options: AutoSyncLoopOptions = {}
): AutoSyncLoopHandle {
  const configuredMinutes =
    vault.getNodeConfig().syncIntervalMinutes ?? DEFAULT_SYNC_INTERVAL_MINUTES
  const intervalMs = options.intervalMs ?? configuredMinutes * 60_000
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 60_000
  const debounceMs = options.debounceMs ?? 10_000
  const maxDebounceMs = options.maxDebounceMs ?? 60_000
  const changePollMs = options.changePollMs ?? 2_000
  const emit = (event: AutoSyncEvent) => {
    try {
      options.onEvent?.(event)
    } catch {
      // Los observadores nunca detienen el bucle
    }
  }

  let closed = false
  let running: Promise<void> | null = null
  let pendingReason: AutoSyncReason | null = null
  let debounceTimer: NodeJS.Timeout | null = null
  let firstChangeAt: number | null = null
  let lastDataVersion = safeDataVersion(vault)

  const autoSyncActive = () => {
    const config = vault.getNodeConfig()
    return config.enabled && config.autoSync
  }

  const runSync = async (reason: AutoSyncReason): Promise<void> => {
    if (closed) return
    if (running) {
      pendingReason = reason
      return running
    }
    running = (async () => {
      try {
        if (!autoSyncActive() || vault.listPeers().length === 0) return
        const summary = await syncAllPeers(vault, {
          timeoutMs: options.timeoutMs,
          callbackUrl: options.callbackUrl
        })
        emit({ reason, summary })
      } catch (err: any) {
        emit({ reason, error: err?.message ?? String(err) })
      } finally {
        lastDataVersion = safeDataVersion(vault)
      }
    })()
    try {
      await running
    } finally {
      running = null
    }
    if (pendingReason && !closed) {
      const next = pendingReason
      pendingReason = null
      await runSync(next)
    }
  }

  const runDiscovery = async (): Promise<string[]> => {
    if (closed || !options.discover || !vault.getNodeConfig().enabled) return []
    let nodes: DiscoveredLanNode[] = []
    try {
      nodes = await options.discover()
    } catch (err: any) {
      emit({ reason: 'discovery', error: err?.message ?? String(err) })
      return []
    }
    if (closed) return []
    const registered = registerDiscoveredPeers(vault, nodes)
    if (registered.length === 0) return []
    const urls = registered.map((p) => p.url)
    emit({ reason: 'discovery', discovered: urls })
    if (autoSyncActive()) {
      for (const peer of registered) {
        try {
          await syncWithPeer(vault, {
            peerUrl: peer.url,
            peerRole: 'peer',
            timeoutMs: options.timeoutMs,
            callbackUrl: options.callbackUrl?.(peer.url)
          })
        } catch (err: any) {
          emit({ reason: 'discovery', error: err?.message ?? String(err) })
        }
      }
      lastDataVersion = safeDataVersion(vault)
    }
    return urls
  }

  const notifyChange = (reason: 'local-write' | 'remote-import' = 'local-write') => {
    if (closed) return
    const now = Date.now()
    if (firstChangeAt === null) firstChangeAt = now
    if (debounceTimer) clearTimeout(debounceTimer)
    const waited = now - firstChangeAt
    const delay = Math.max(0, Math.min(debounceMs, maxDebounceMs - waited))
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      firstChangeAt = null
      void runSync(reason)
    }, delay)
    debounceTimer.unref?.()
  }

  const intervalTimer = setInterval(() => {
    void runSync('interval')
  }, intervalMs)
  intervalTimer.unref?.()

  const discoveryTimer = options.discover
    ? setInterval(() => {
        void runDiscovery()
      }, discoveryIntervalMs)
    : null
  discoveryTimer?.unref?.()

  const changeTimer = setInterval(() => {
    if (closed || running) return
    const current = safeDataVersion(vault)
    if (current !== lastDataVersion) {
      lastDataVersion = current
      notifyChange('local-write')
    }
  }, changePollMs)
  changeTimer.unref?.()

  const startup = (async () => {
    await runDiscovery()
    await runSync('startup')
  })()

  return {
    notifyChange,
    syncNow: (reason = 'manual') => runSync(reason),
    discoverNow: runDiscovery,
    close: async () => {
      closed = true
      clearInterval(intervalTimer)
      clearInterval(changeTimer)
      if (discoveryTimer) clearInterval(discoveryTimer)
      if (debounceTimer) clearTimeout(debounceTimer)
      pendingReason = null
      await startup.catch(() => undefined)
      if (running) await (running as Promise<void>).catch(() => undefined)
    }
  }
}

function safeDataVersion(vault: SyncCapableVault): number | null {
  try {
    return vault.getDataVersion ? vault.getDataVersion() : null
  } catch {
    return null
  }
}

export interface PeerDiscoveryResult {
  nodes: DiscoveredLanNode[]
  lan: DiscoveredLanNode[]
  tailnet: DiscoveredLanNode[]
  tailscale: TailscaleProbeResult['state'] | 'disabled'
}

/**
 * Descubrimiento combinado: broadcast UDP de LAN (si está activo) y sondeo
 * unicast de los peers en línea del tailnet. Sin Tailscale solo queda la LAN.
 */
export async function discoverPeers(
  vault: SyncCapableVault,
  runtime: Pick<SystemRuntime, 'platform' | 'env' | 'execProcess'>,
  options: {
    port: number
    lan?: boolean
    tailscale?: boolean
    timeoutMs?: number
    probeTailscale?: typeof probeTailscale
  }
): Promise<PeerDiscoveryResult> {
  const config = vault.getNodeConfig()
  const token = config.authToken
  const lanPromise =
    options.lan === false
      ? Promise.resolve([] as DiscoveredLanNode[])
      : discoverLanNodes({
          port: options.port,
          timeoutMs: options.timeoutMs ?? 800,
          token,
          roleFilter: 'peer'
        }).catch(() => [] as DiscoveredLanNode[])

  const useTailscale = options.tailscale ?? config.tailscaleDiscovery !== false
  let tailscaleState: PeerDiscoveryResult['tailscale'] = 'disabled'
  let tailnet: DiscoveredLanNode[] = []
  if (useTailscale) {
    const probe = await (options.probeTailscale ?? probeTailscale)(runtime, {
      binary: config.tailscaleBin ?? null
    })
    tailscaleState = probe.state
    if (probe.state === 'running') {
      tailnet = await discoverTailnetNodes(probe.status, {
        port: options.port,
        token,
        selfNodeId: config.nodeId
      })
    }
  }

  const lan = (await lanPromise).filter((n) => n.nodeId !== config.nodeId)
  const byId = new Map<string, DiscoveredLanNode>()
  for (const node of [...tailnet, ...lan]) {
    if (!byId.has(node.nodeId)) byId.set(node.nodeId, node)
  }
  return { nodes: Array.from(byId.values()), lan, tailnet, tailscale: tailscaleState }
}
