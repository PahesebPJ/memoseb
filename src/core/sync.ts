import crypto from 'node:crypto'
import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import {
  normalizeNodeRole,
  normalizePeerRole,
  parseNodeRoleInput,
  parsePeerRoleInput,
  type EffectivePeerPermissions,
  type GroupPermissionMode,
  type MemoryCategory,
  type NodeConfiguration,
  type NodeRole,
  type PeerRole,
  type SyncGroupRecord,
  type SyncPeerRecord
} from './schema.ts'
import {
  isP2PContractPayload,
  p2pPayloadToSnapshot,
  snapshotToP2PPayload,
  unwrapP2PEnvelope,
  wrapP2PEnvelope,
  type P2PContractEnvelopeV1,
  type P2PSyncPayloadV1
} from './p2p-contract.ts'
import {
  filterSnapshotByPermissions,
  type ExportedProject,
  type ExportedTombstone,
  type ImportResult,
  type VaultSnapshotV1
} from './snapshot.ts'
import {
  firstIpv4,
  isTailscaleIpv4,
  localTailscaleIpv4,
  type TailscaleStatus
} from './tailscale.ts'
import type { MemoryRecord, VaultStats } from './vault.ts'

export const DISCOVERY_MAGIC_REQUEST = 'MEMOSEB_DISCOVER_V1' as const
export const DISCOVERY_MAGIC_RESPONSE = 'MEMOSEB_ANNOUNCE_V1' as const
export const MAX_SYNC_BODY_BYTES = 25 * 1024 * 1024 // 25 MB

export type SnapshotProjectEntry = ExportedProject
export type SnapshotMemoryEntry = MemoryRecord & { vector?: number[] }
export type SnapshotTombstoneEntry = ExportedTombstone
export type SnapshotImportResult = ImportResult
export type { VaultSnapshotV1 }

export interface SyncCapableVault {
  getNodeId(): string
  getNodeConfig(): NodeConfiguration
  updateNodeConfig(
    patch: Partial<Omit<NodeConfiguration, 'nodeId'>>
  ): NodeConfiguration
  enableNodeMode(options: {
    role: PeerRole | 'p2p'
    nodeName?: string
    listenHost?: string
    listenPort?: number
    authToken?: string | null
    autoSync?: boolean
    lanDiscovery?: boolean
  }): NodeConfiguration
  disableNodeMode(options?: { purgePeers?: boolean }): NodeConfiguration
  upsertPeer(input: {
    role: PeerRole | 'p2p'
    url: string
    name?: string
    peerNodeId?: string | null
    authToken?: string | null
    lastSyncAt?: string | null
    lastStatus?: string | null
  }): SyncPeerRecord
  removePeer(urlOrId: string): boolean
  listPeers(role?: PeerRole | 'p2p'): SyncPeerRecord[]
  updatePeerSyncState(
    urlOrId: string,
    state: {
      lastSyncAt?: string | null
      lastStatus?: string | null
      peerNodeId?: string | null
      name?: string
    }
  ): void
  exportSnapshot(options?: {
    projectId?: string
    since?: string
    includeTombstones?: boolean
  }): VaultSnapshotV1 | any
  importSnapshot(
    snapshot: VaultSnapshotV1 | any,
    options?: {
      strategy?: 'merge' | 'replace'
      projectId?: string
      includeTombstones?: boolean
      canApply?: (projectId: string, category?: string) => boolean
    }
  ): SnapshotImportResult
  getStats(): VaultStats
  getDataVersion?(): number
  getExcludedPeerIds?(): string[]
  upsertGroup?(input: {
    name: string
    description?: string
    projects?: readonly string[]
    categories?: readonly string[]
    permissions?: GroupPermissionMode
    groupToken?: string | null
  }): SyncGroupRecord
  getGroup?(nameOrId: string): SyncGroupRecord | null
  listGroups?(): SyncGroupRecord[]
  deleteGroup?(nameOrId: string): boolean
  addNodeToGroup?(groupNameOrId: string, peerIdentifier: string): SyncGroupRecord
  removeNodeFromGroup?(groupNameOrId: string, peerIdentifier: string): SyncGroupRecord
  getPeerGroups?(peerIdentifiers: readonly (string | null | undefined)[]): SyncGroupRecord[]
  findGroupByToken?(token: string | null | undefined): SyncGroupRecord | null
  evaluatePeerPermissions?(input: {
    peerId?: string | null
    peerNodeId?: string | null
    peerName?: string | null
    peerUrl?: string | null
    matchedGroupByToken?: string | null
  }): EffectivePeerPermissions
}

export interface DiscoveredLanNode {
  nodeId: string
  nodeName: string
  role: 'parent' | 'peer'
  port: number
  urls: string[]
  address: string
  requiresAuth: boolean
  app?: string
  contracts?: string[]
  /** El nodo demostró conocer el token con el reto HMAC. */
  authVerified?: boolean
}

export type DiscoveredParentNode = DiscoveredLanNode

export interface DiscoverPacket {
  magic: typeof DISCOVERY_MAGIC_REQUEST
  nonce: string
  timestamp: string
  authTag?: string
}

export interface AnnouncePacket {
  magic: typeof DISCOVERY_MAGIC_RESPONSE
  nonce: string
  nodeId: string
  nodeName: string
  role: 'parent' | 'peer'
  port: number
  urls: string[]
  requiresAuth: boolean
  app?: string
  contracts?: string[]
  /** Tag de respuesta por cada IPv4 local desde la que puede salir el datagrama. */
  authTags?: Record<string, string>
}

export interface SyncServerHandle {
  host: string
  hosts: string[]
  port: number
  udpPort: number | null
  urls: string[]
  close: () => Promise<void>
}

export interface HandshakeResult {
  peerUrl: string
  peerNodeId: string
  peerName: string
  peerRole: PeerRole
  status: string
  timestamp: string
  peer: SyncPeerRecord
  assignedGroups?: string[]
}

export interface PeerSyncResult {
  peerUrl: string
  peerNodeId: string
  peerName: string
  peerRole: PeerRole
  pushed: SnapshotImportResult
  pulled: SnapshotImportResult
  syncedAt: string
  effectiveGroups?: string[]
}

export interface SyncPeerError {
  peerUrl: string
  error: string
}

export interface SyncSummaryResult {
  enabled: boolean
  role: NodeRole
  results: PeerSyncResult[]
  errors: SyncPeerError[]
}

export function normalizePeerUrl(rawUrl: string): string {
  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new Error(
      `Invalid peer URL: "${rawUrl}". Expected a valid http: or https: URL.`
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid peer URL protocol: "${parsed.protocol}". Only http: and https: are supported.`
    )
  }
  return parsed.origin
}

export function getLocalLanUrls(port: number): string[] {
  const interfaces = os.networkInterfaces()
  const urls: string[] = []

  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name]
    if (!list) continue
    for (const info of list) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        urls.push(`http://${info.address}:${port}`)
      }
    }
  }

  if (urls.length === 0) {
    urls.push(`http://127.0.0.1:${port}`)
  }

  return Array.from(new Set(urls))
}

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h)
}

/**
 * URL por la que un peer puede devolvernos la llamada: loopback si el peer es
 * local, si no la IPv4 de Tailscale (preferida) o la primera IPv4 de LAN.
 * Devuelve undefined si el nodo solo escucha en loopback y el peer es remoto.
 */
export function resolveCallbackUrl(
  peerUrl: string,
  options: {
    port: number
    listenHost?: string | null
    interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>
  }
): string | undefined {
  let peerHost: string
  try {
    peerHost = new URL(peerUrl).hostname
  } catch {
    return undefined
  }
  const listenHost = options.listenHost?.trim() || '0.0.0.0'
  const isWildcard = listenHost === '0.0.0.0' || listenHost === '::'

  if (isLoopbackHost(peerHost)) {
    if (isWildcard || isLoopbackHost(listenHost)) {
      return `http://127.0.0.1:${options.port}`
    }
    return `http://${listenHost}:${options.port}`
  }
  if (isLoopbackHost(listenHost)) {
    return undefined
  }
  if (!isWildcard) {
    return `http://${listenHost}:${options.port}`
  }
  const interfaces = options.interfaces ?? os.networkInterfaces()
  const tailscaleIp = localTailscaleIpv4(interfaces)
  if (tailscaleIp) {
    return `http://${tailscaleIp}:${options.port}`
  }
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && info.address) {
        return `http://${info.address}:${options.port}`
      }
    }
  }
  return undefined
}

export function verifyAuthToken(
  expected: string | null | undefined,
  provided: string | null | undefined
): boolean {
  if (!expected) {
    return true
  }
  if (!provided) {
    return false
  }
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  return crypto.timingSafeEqual(expectedHash, providedHash)
}

export function normalizeRemoteAddress(address: string | null | undefined): string {
  const a = (address ?? '').trim().toLowerCase()
  return a.startsWith('::ffff:') ? a.slice(7) : a
}

export function hostnameOf(url: string): string {
  try {
    return normalizeRemoteAddress(new URL(url).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return ''
  }
}

export function sameHost(a: string, b: string): boolean {
  const x = normalizeRemoteAddress(a)
  const y = normalizeRemoteAddress(b)
  if (!x || !y) return false
  if (x === y) return true
  return isLoopbackHost(x) && isLoopbackHost(y)
}

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Valida el header Host contra DNS rebinding: loopback, IP de Tailscale o
 * MagicDNS (*.ts.net). Fuera del rol peer (LAN) también se aceptan IPs.
 */
export function isAllowedHostHeader(
  host: string | null | undefined,
  role?: NodeRole | null
): boolean {
  if (!host) return false
  const raw = host.trim().toLowerCase()
  let name: string
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']')
    if (end < 0) return false
    name = raw.slice(1, end)
  } else {
    name = raw.replace(/:\d+$/, '')
  }
  if (!name) return false
  if (isLoopbackHost(name)) return true
  if (IPV4_LITERAL.test(name) && isTailscaleIpv4(name)) return true
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\.?$/.test(name)) return true
  if (role !== 'peer' && IPV4_LITERAL.test(name)) return true
  return false
}

const NONCE_PATTERN = /^[A-Za-z0-9-]{16,128}$/

export function isValidNonce(nonce: string | null | undefined): boolean {
  return typeof nonce === 'string' && NONCE_PATTERN.test(nonce)
}

export function createChallengeNonce(): string {
  return crypto.randomBytes(24).toString('hex')
}

/** host:port normalizado (sin corchetes, sin ::ffff:, en minúsculas). */
export function challengeEndpoint(host: string, port: number | string): string {
  return `${normalizeRemoteAddress(host.replace(/^\[|\]$/g, ''))}:${port}`
}

/**
 * authTag = hex(HMAC-SHA256(token, nonce + "|" + host + ":" + port)), igual que
 * gaze. host:port es el endpoint que marcó el cliente, así un relay no sirve.
 */
export function computeChallengeTag(token: string, nonce: string, endpoint: string): string {
  return crypto.createHmac('sha256', token).update(`${nonce}|${endpoint}`).digest('hex')
}

function tagsEqual(expectedHex: string, tag: unknown): boolean {
  if (typeof tag !== 'string' || !/^[0-9a-f]{64}$/i.test(tag)) return false
  return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(tag.toLowerCase(), 'hex'))
}

export function verifyChallengeTag(
  token: string,
  nonce: string,
  endpoint: string,
  tag: unknown
): boolean {
  return tagsEqual(computeChallengeTag(token, nonce, endpoint), tag)
}

/** Tag de la petición UDP, ligado al ip:puerto destino y con dominio propio. */
export function udpRequestTag(token: string, nonce: string, endpoint: string): string {
  return crypto.createHmac('sha256', token).update(`udp|${nonce}|${endpoint}`).digest('hex')
}

/** Tag de la respuesta UDP, ligado al ip:puerto desde el que responde el nodo. */
export function udpResponseTag(token: string, nonce: string, endpoint: string): string {
  return crypto
    .createHmac('sha256', token)
    .update(`udp|response|${nonce}|${endpoint}`)
    .digest('hex')
}

/** IPv4 locales y sus direcciones de broadcast: destinos posibles de un sondeo UDP. */
export function localUdpDestinations(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): { local: string[]; destinations: string[] } {
  const local = new Set<string>(['127.0.0.1'])
  const destinations = new Set<string>(['127.0.0.1', '255.255.255.255'])
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || !info.address) continue
      local.add(info.address)
      destinations.add(info.address)
      const a = info.address.split('.').map(Number)
      const m = (info.netmask ?? '255.255.255.255').split('.').map(Number)
      if (a.length === 4 && m.length === 4) {
        destinations.add(a.map((octet, i) => (octet & m[i]!) | (~m[i]! & 255)).join('.'))
      }
    }
  }
  return { local: Array.from(local), destinations: Array.from(destinations) }
}

/** Nonce del reto: query ?nonce= o header X-P2P-Nonce. */
export function readChallengeNonce(
  rawUrl: string | undefined,
  headers: http.IncomingHttpHeaders
): string | null {
  const header = headers['x-p2p-nonce']
  if (typeof header === 'string' && header.length > 0) return header
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').searchParams.get('nonce')
  } catch {
    return null
  }
}

/**
 * Acepta un callbackUrl solo si su host es la IP de origen de la petición y
 * esa IP es de Tailscale (100.64.0.0/10) o loopback.
 */
export function acceptCallbackUrl(
  raw: unknown,
  remoteAddress: string
): string | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  let url: string
  try {
    url = normalizePeerUrl(raw)
  } catch {
    return undefined
  }
  const host = hostnameOf(url)
  const remote = normalizeRemoteAddress(remoteAddress)
  if (!host || !remote) return undefined
  if (isLoopbackHost(remote) && isLoopbackHost(host)) return url
  if (host === remote && isTailscaleIpv4(remote)) return url
  return undefined
}

export const MAX_RESPONSE_BYTES = 25 * 1024 * 1024

interface HttpRequestOptions {
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
}

interface HttpResponse {
  statusCode: number
  statusMessage: string
  headers: http.IncomingHttpHeaders
  body: string
}

export function sendHttpRequest(
  targetUrl: string,
  options: HttpRequestOptions
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl)
    const isHttps = parsed.protocol === 'https:'
    const client = isHttps ? https : http
    const timeout = options.timeoutMs ?? 15000
    const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES
    let settled = false
    const finish = (err: Error | null, value?: HttpResponse) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (err) reject(err)
      else resolve(value!)
    }
    // Plazo total (no solo de inactividad) para toda la petición
    const deadline = setTimeout(() => {
      finish(new Error(`Request timed out after ${timeout}ms`))
      req.destroy()
    }, timeout)

    const req = client.request(
      parsed,
      {
        method: options.method,
        headers: options.headers,
        timeout
      },
      (res) => {
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          received += buf.length
          if (received > maxBytes) {
            finish(new Error(`Response exceeded ${maxBytes} bytes`))
            req.destroy()
            return
          }
          chunks.push(buf)
        })
        res.on('error', (err) => finish(err))
        res.on('end', () => {
          finish(null, {
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8')
          })
        })
      }
    )

    req.on('timeout', () => {
      finish(new Error(`Request timed out after ${timeout}ms`))
      req.destroy()
    })

    req.on('error', (err) => finish(err))

    if (options.body) {
      req.write(options.body)
    }
    req.end()
  })
}

async function sendJsonRequest<T>(
  targetUrl: string,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE'
    token?: string | null
    body?: unknown
    timeoutMs?: number
    headers?: Record<string, string>
  }
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.headers ?? {})
  }
  let payload: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(options.body)
    headers['Content-Length'] = Buffer.byteLength(payload).toString()
  }
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`
  }

  const response = await sendHttpRequest(targetUrl, {
    method: options.method,
    headers,
    body: payload,
    timeoutMs: options.timeoutMs
  })

  let parsedBody: any
  try {
    parsedBody = response.body ? JSON.parse(response.body) : {}
  } catch {
    parsedBody = { raw: response.body }
  }

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorMsg =
      parsedBody?.message ||
      parsedBody?.error ||
      `HTTP request failed with status ${response.statusCode} ${response.statusMessage}`
    const error = new Error(errorMsg)
    ;(error as any).statusCode = response.statusCode
    ;(error as any).responseBody = parsedBody
    throw error
  }

  return parsedBody as T
}

export async function discoverLanNodes(options?: {
  port?: number
  timeoutMs?: number
  token?: string | null
  broadcastAddresses?: string[]
  roleFilter?: 'parent' | 'peer' | 'any'
}): Promise<DiscoveredLanNode[]> {
  const targetPort = options?.port ?? 7432
  const timeoutMs = options?.timeoutMs ?? 600
  const token = options?.token ?? null
  const roleFilter = options?.roleFilter ?? 'any'
  const broadcastAddresses = options?.broadcastAddresses ?? [
    '255.255.255.255',
    '127.0.0.1'
  ]

  const nonce = crypto.randomUUID()
  const packetFor = (target: string): Buffer => {
    const discoverPacket: DiscoverPacket = {
      magic: DISCOVERY_MAGIC_REQUEST,
      nonce,
      timestamp: new Date().toISOString(),
      ...(token
        ? { authTag: udpRequestTag(token, nonce, challengeEndpoint(target, targetPort)) }
        : {})
    }
    return Buffer.from(JSON.stringify(discoverPacket))
  }
  const discovered = new Map<string, DiscoveredLanNode>()

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    const cleanup = () => {
      try {
        socket.close()
      } catch {
        // ignore socket already closed
      }
      resolve(Array.from(discovered.values()))
    }

    const timer = setTimeout(cleanup, timeoutMs)

    socket.on('error', () => {
      clearTimeout(timer)
      cleanup()
    })

    socket.on('message', (msg, rinfo) => {
      try {
        const raw = JSON.parse(msg.toString('utf-8'))
        if (!raw || raw.magic !== DISCOVERY_MAGIC_RESPONSE) {
          return
        }
        if (raw.nonce !== nonce) {
          return
        }
        if ((raw.role !== 'parent' && raw.role !== 'peer') || !raw.nodeId) {
          return
        }
        if (roleFilter !== 'any' && raw.role !== roleFilter) {
          return
        }
        if (token) {
          const source = normalizeRemoteAddress(rinfo.address)
          const tag = raw.authTags && typeof raw.authTags === 'object' ? raw.authTags[source] : undefined
          if (!tagsEqual(udpResponseTag(token, nonce, challengeEndpoint(source, rinfo.port)), tag)) {
            return
          }
        }
        const port =
          Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536
            ? raw.port
            : targetPort
        // Nunca se confía en raw.urls: la URL sale de la IP de origen del datagrama
        const urls = [`http://${rinfo.address}:${port}`]

        if (!discovered.has(raw.nodeId)) {
          discovered.set(raw.nodeId, {
            nodeId: String(raw.nodeId),
            nodeName: String(
              raw.nodeName || (raw.role === 'peer' ? 'Peer Node' : 'Parent Node')
            ),
            role: raw.role as 'parent' | 'peer',
            port,
            urls,
            address: rinfo.address,
            requiresAuth: Boolean(raw.requiresAuth),
            app: typeof raw.app === 'string' ? raw.app : undefined,
            contracts: Array.isArray(raw.contracts) ? raw.contracts : undefined,
            authVerified: Boolean(token)
          })
        }
      } catch {
        // ignore invalid responses
      }
    })

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true)
      } catch {
        // Ignore setBroadcast errors on local loops
      }

      for (const target of broadcastAddresses) {
        const payload = packetFor(target)
        socket.send(payload, 0, payload.length, targetPort, target, () => {
          // ignore target errors
        })
      }
    })
  })
}

export const discoverLanParents = discoverLanNodes


/**
 * Sondea por HTTP unicast GET /api/v1/p2p/status en cada host. Solo devuelve
 * nodos que responden ok, anuncian p2p-memory-contract y no son el propio nodo.
 */
export async function probeP2PNodes(
  hosts: readonly string[],
  options: {
    port: number
    token?: string | null
    selfNodeId?: string
    timeoutMs?: number
    concurrency?: number
  }
): Promise<DiscoveredLanNode[]> {
  const unique = Array.from(new Set(hosts.filter((h) => h.trim().length > 0)))
  const found = new Map<string, DiscoveredLanNode>()
  const concurrency = Math.max(1, options.concurrency ?? 8)
  let cursor = 0

  const probeOne = async (host: string) => {
    const hostPart = host.includes(':') ? `[${host}]` : host
    const url = `http://${hostPart}:${options.port}`
    const timeoutMs = options.timeoutMs ?? 2000
    const token = options.token ?? null
    try {
      if (token) {
        // Reto y respuesta: el token solo viaja si el nodo demuestra conocerlo
        const nonce = createChallengeNonce()
        const challenge = await sendJsonRequest<any>(
          `${url}/api/v1/p2p/status?nonce=${nonce}`,
          { method: 'GET', headers: { 'X-P2P-Nonce': nonce }, timeoutMs }
        )
        const tag = challenge?.authTag ?? challenge?.data?.authTag
        if (!verifyChallengeTag(token, nonce, challengeEndpoint(host, options.port), tag)) {
          return
        }
      }
      const res = await sendJsonRequest<any>(`${url}/api/v1/p2p/status`, {
        method: 'GET',
        token,
        timeoutMs
      })
      const data = unwrapP2PEnvelope(res) as any
      const nodeId = typeof data?.nodeId === 'string' ? data.nodeId : null
      const contracts: string[] = Array.isArray(data?.supportedContracts)
        ? data.supportedContracts.filter((c: unknown) => typeof c === 'string')
        : []
      if (
        data?.ok !== true ||
        !nodeId ||
        nodeId === options.selfNodeId ||
        !contracts.includes('p2p-memory-contract')
      ) {
        return
      }
      if (found.has(nodeId)) return
      found.set(nodeId, {
        nodeId,
        nodeName: typeof data.nodeName === 'string' && data.nodeName ? data.nodeName : host,
        role: 'peer',
        port: options.port,
        urls: [url],
        address: host,
        requiresAuth: Boolean(token),
        app: typeof data.app === 'string' ? data.app : undefined,
        contracts,
        authVerified: Boolean(token)
      })
    } catch {
      // Host caído, sin memoseb/gaze o token rechazado: se ignora
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const host = unique[cursor++]!
      await probeOne(host)
    }
  })
  await Promise.all(workers)
  return Array.from(found.values())
}

/**
 * Descubrimiento unicast por Tailscale: sondea la primera IPv4 de cada peer en
 * línea del tailnet. Con Tailscale ausente o sin Running no hay nada que sondear.
 */
export async function discoverTailnetNodes(
  status: TailscaleStatus | null,
  options: {
    port: number
    token?: string | null
    selfNodeId?: string
    timeoutMs?: number
  }
): Promise<DiscoveredLanNode[]> {
  if (!status || status.backendState !== 'Running') {
    return []
  }
  const selfIps = new Set(status.selfIps)
  const hosts: string[] = []
  for (const peer of status.peers) {
    if (!peer.online) continue
    const ip = firstIpv4(peer.ips)
    if (ip && !selfIps.has(ip) && isTailscaleIpv4(ip)) {
      hosts.push(ip)
    }
  }
  return probeP2PNodes(hosts, options)
}

/**
 * Registra como peers los nodos descubiertos que aún no se conocen (por
 * nodeId o URL). Devuelve solo los registrados en esta llamada.
 */
export function registerDiscoveredPeers(
  vault: SyncCapableVault,
  nodes: readonly DiscoveredLanNode[],
  options?: { token?: string | null }
): SyncPeerRecord[] {
  const config = vault.getNodeConfig()
  if (config.role !== 'peer') return []
  const excluded = new Set(vault.getExcludedPeerIds?.() ?? [])
  const known = vault.listPeers()
  const registered: SyncPeerRecord[] = []
  for (const node of nodes) {
    if (node.role !== 'peer' || node.nodeId === config.nodeId) continue
    if (excluded.has(node.nodeId)) continue
    if (node.contracts && !node.contracts.includes('p2p-memory-contract')) continue
    const rawUrl = node.urls[0] ?? `http://${node.address}:${node.port}`
    let url: string
    try {
      url = normalizePeerUrl(rawUrl)
    } catch {
      continue
    }
    const exists = known.some(
      (p) => p.url === url || (p.peerNodeId !== null && p.peerNodeId === node.nodeId)
    )
    if (exists) continue
    const peer = vault.upsertPeer({
      role: 'peer',
      url,
      name: node.nodeName,
      peerNodeId: node.nodeId,
      ...(node.authVerified && options?.token ? { authToken: options.token } : {}),
      lastStatus: 'discovered'
    })
    known.push(peer)
    registered.push(peer)
  }
  return registered
}

export async function startSyncServer(
  vault: SyncCapableVault,
  options?: {
    host?: string
    port?: number
    token?: string | null
    enableUdpDiscovery?: boolean
    udpPort?: number
    additionalHosts?: string[]
    onImported?: (result: SnapshotImportResult) => void
  }
): Promise<SyncServerHandle> {
  const initialConfig = vault.getNodeConfig()
  const listenHost = options?.host ?? initialConfig.listenHost ?? '0.0.0.0'
  const listenHosts = Array.from(
    new Set([listenHost, ...(options?.additionalHosts ?? [])].filter((h) => h.trim()))
  )
  const listenPort = options?.port ?? initialConfig.listenPort ?? 7432

  const server = http.createServer(async (req, res) => {
    const sendJson = (statusCode: number, data: unknown) => {
      if (res.writableEnded) return
      const bodyStr = JSON.stringify(data)
      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      })
      res.end(bodyStr)
    }

    try {
      // 1. Configuration check on each request
      const currentConfig = vault.getNodeConfig()
      if (!currentConfig.enabled) {
        sendJson(503, {
          ok: false,
          error: 'NODE_DISABLED',
          message: 'Memoseb node networking is currently disabled.'
        })
        return
      }

      // 2. Host header (anti DNS rebinding)
      if (!isAllowedHostHeader(req.headers.host, currentConfig.role)) {
        sendJson(403, {
          ok: false,
          error: 'INVALID_HOST',
          message: 'Host header must be loopback, a Tailscale IP or a *.ts.net name.'
        })
        return
      }
      const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress)

      // 3. Auth Verification (Dual: Node Global Token or Group Token)
      const expectedToken =
        options?.token !== undefined ? options.token : currentConfig.authToken

      let providedToken: string | null = null
      const authHeader = req.headers['authorization']
      if (typeof authHeader === 'string') {
        const match = authHeader.match(/^Bearer\s+(.+)$/i)
        if (match && match[1]) {
          providedToken = match[1].trim()
        }
      }
      if (!providedToken && typeof req.headers['x-memoseb-token'] === 'string') {
        providedToken = req.headers['x-memoseb-token'].trim()
      }
      if (!providedToken && typeof req.headers['x-gaze-token'] === 'string') {
        providedToken = req.headers['x-gaze-token'].trim()
      }

      let matchedGroup: SyncGroupRecord | null = null
      if (providedToken && vault.findGroupByToken) {
        matchedGroup = vault.findGroupByToken(providedToken) ?? null
      }
      // Un nodo peer expuesto fuera de loopback nunca atiende sin token global.
      const tokenRequired =
        !expectedToken &&
        currentConfig.role === 'peer' &&
        listenHosts.some((h) => !isLoopbackHost(h))
      const isGlobalTokenValid = tokenRequired
        ? false
        : verifyAuthToken(expectedToken, providedToken)

      const challengePath = (req.url ?? '').split('?')[0]
      const challengeNonce =
        req.method === 'GET' && challengePath === '/api/v1/p2p/status'
          ? readChallengeNonce(req.url, req.headers)
          : null
      // Endpoint que marcó el cliente, visto desde este socket
      const localEndpoint = challengeEndpoint(
        req.socket.localAddress ?? '',
        req.socket.localPort ?? 0
      )
      if (challengeNonce !== null && !isValidNonce(challengeNonce)) {
        sendJson(400, { ok: false, error: 'BAD_REQUEST', message: 'Invalid nonce.' })
        return
      }
      if (!isGlobalTokenValid && !matchedGroup && challengeNonce && expectedToken) {
        // Reto de descubrimiento: prueba que conocemos el token sin revelar stats ni datos
        const authTag = computeChallengeTag(expectedToken, challengeNonce, localEndpoint)
        const challengeData = {
          ok: true,
          challenge: true,
          nonce: challengeNonce,
          authTag,
          requiresAuth: true,
          supportedContracts: ['memoseb-snapshot', 'p2p-memory-contract']
        }
        sendJson(200, {
          ...challengeData,
          schemaVersion: 1,
          command: 'status',
          data: challengeData
        })
        return
      }

      if (!isGlobalTokenValid && !matchedGroup) {
        sendJson(401, {
          ok: false,
          error: tokenRequired ? 'TOKEN_REQUIRED' : 'UNAUTHORIZED',
          message: tokenRequired
            ? 'This peer node has no sync token configured; refusing unauthenticated access. Configure one with "memoseb node enable --role peer --token <t>".'
            : 'Invalid or missing sync token.'
        })
        return
      }

      const parsedUrl = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`
      )
      const pathname = parsedUrl.pathname

      // La identidad sale del token de grupo o de un peer registrado localmente
      // cuya URL coincide con el origen; nunca de lo que el cuerpo declara.
      const isExcluded = (nodeId: unknown) =>
        typeof nodeId === 'string' && (vault.getExcludedPeerIds?.() ?? []).includes(nodeId)
      const resolveIdentity = (
        declaredNodeId: unknown,
        verifiedCallbackUrl: string | undefined
      ) => {
        if (!isGlobalTokenValid && matchedGroup) {
          return { matchedGroupByToken: matchedGroup.id }
        }
        const peers = vault.listPeers()
        const found =
          (verifiedCallbackUrl
            ? peers.find((p) => p.url === verifiedCallbackUrl)
            : undefined) ??
          peers.find(
            (p) =>
              typeof declaredNodeId === 'string' &&
              p.peerNodeId === declaredNodeId &&
              sameHost(hostnameOf(p.url), remoteAddress)
          )
        if (!found) {
          return { matchedGroupByToken: matchedGroup?.id ?? null }
        }
        return {
          peerId: found.id,
          peerNodeId: found.peerNodeId,
          peerName: found.name,
          peerUrl: found.url,
          matchedGroupByToken: matchedGroup?.id ?? null
        }
      }

      // Endpoint: GET /api/v1/sync/status or GET /api/v1/p2p/status
      if (
        req.method === 'GET' &&
        (pathname === '/api/v1/sync/status' || pathname === '/api/v1/p2p/status')
      ) {
        const statusData = {
          ok: true,
          nodeId: currentConfig.nodeId,
          nodeName: currentConfig.nodeName,
          enabled: currentConfig.enabled,
          role: currentConfig.role,
          stats: vault.getStats(),
          timestamp: new Date().toISOString(),
          supportedContracts: ['memoseb-snapshot', 'p2p-memory-contract']
        }
        if (pathname === '/api/v1/p2p/status') {
          if (challengeNonce && expectedToken) {
            Object.assign(statusData, {
              nonce: challengeNonce,
              authTag: computeChallengeTag(expectedToken, challengeNonce, localEndpoint)
            })
          }
          sendJson(200, {
            ...statusData,
            schemaVersion: 1,
            command: 'status',
            generatedAt: statusData.timestamp,
            data: statusData
          })
        } else {
          sendJson(200, statusData)
        }
        return
      }

      // POST Endpoints
      if (req.method === 'POST') {
        const contentType = String(req.headers['content-type'] ?? '')
        if (!/^application\/json\b/i.test(contentType.trim())) {
          sendJson(415, {
            ok: false,
            error: 'UNSUPPORTED_MEDIA_TYPE',
            message: 'POST requests must use Content-Type: application/json.'
          })
          return
        }
        let bodyBytes = 0
        const chunks: Buffer[] = []
        let tooLarge = false

        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bodyBytes += buf.length
          if (bodyBytes > MAX_SYNC_BODY_BYTES) {
            tooLarge = true
            break
          }
          chunks.push(buf)
        }

        if (tooLarge) {
          sendJson(413, {
            ok: false,
            error: 'PAYLOAD_TOO_LARGE',
            message: 'Payload exceeds maximum limit of 25MB.'
          })
          return
        }

        const rawBody = Buffer.concat(chunks).toString('utf-8')
        let body: any
        try {
          body = rawBody.length > 0 ? JSON.parse(rawBody) : {}
        } catch (err: any) {
          sendJson(400, {
            ok: false,
            error: 'INVALID_JSON',
            message: `Malformed JSON payload: ${err.message}`
          })
          return
        }

        // Endpoint: POST /api/v1/sync/handshake or POST /api/v1/p2p/handshake
        if (
          pathname === '/api/v1/sync/handshake' ||
          pathname === '/api/v1/p2p/handshake'
        ) {
          const isP2PRoute = pathname === '/api/v1/p2p/handshake'
          const isEnvelope =
            body &&
            typeof body === 'object' &&
            body.schemaVersion === 1 &&
            body.data
          const data = isEnvelope ? body.data : body

          const {
            nodeId,
            nodeName,
            callbackUrl,
            groups
          } = data

          const rawRole = data.role
          let clientRole = parsePeerRoleInput(rawRole)
          if (!clientRole && isP2PRoute) {
            clientRole = 'peer'
          }

          if (!nodeId || !clientRole) {
            sendJson(400, {
              ok: false,
              error: 'BAD_REQUEST',
              message: 'Missing nodeId or role in handshake request.'
            })
            return
          }

          const safeCallbackUrl = acceptCallbackUrl(callbackUrl, remoteAddress)

          if (
            safeCallbackUrl &&
            !isExcluded(nodeId) &&
            ((currentConfig.role === 'parent' && clientRole === 'child') ||
              (currentConfig.role === 'child' && clientRole === 'parent') ||
              currentConfig.role === 'peer' ||
              clientRole === 'peer')
          ) {
            vault.upsertPeer({
              role: clientRole,
              url: safeCallbackUrl,
              name: nodeName || 'Peer',
              peerNodeId: nodeId,
              authToken: providedToken,
              lastStatus: 'paired'
            })
          }

          if (matchedGroup && safeCallbackUrl) {
            vault.addNodeToGroup?.(matchedGroup.id, safeCallbackUrl)
          }

          const requestedGroups: string[] = Array.isArray(groups) ? groups : []
          if (isGlobalTokenValid && requestedGroups.length > 0) {
            for (const groupName of requestedGroups) {
              if (typeof groupName === 'string') {
                const grp = vault.getGroup?.(groupName)
                if (grp && safeCallbackUrl) {
                  vault.addNodeToGroup?.(grp.id, safeCallbackUrl)
                }
              }
            }
          }

          const policy: EffectivePeerPermissions = vault.evaluatePeerPermissions
            ? vault.evaluatePeerPermissions(resolveIdentity(nodeId, safeCallbackUrl))
            : {
                unrestricted: true,
                groups: [],
                canPush: () => true,
                canPull: () => true
              }

          const timestamp = new Date().toISOString()
          const handshakeData = {
            ok: true,
            nodeId: currentConfig.nodeId,
            nodeName: currentConfig.nodeName,
            role: currentConfig.role,
            assignedGroups: policy.groups,
            stats: vault.getStats(),
            timestamp,
            supportedContracts: ['memoseb-snapshot', 'p2p-memory-contract']
          }

          if (isP2PRoute || isEnvelope) {
            sendJson(200, {
              ...handshakeData,
              schemaVersion: 1,
              command: 'handshake',
              generatedAt: timestamp,
              data: handshakeData
            })
          } else {
            sendJson(200, handshakeData)
          }
          return
        }

        // Endpoint: POST /api/v1/sync/exchange or POST /api/v1/p2p/exchange
        if (
          pathname === '/api/v1/sync/exchange' ||
          pathname === '/api/v1/p2p/exchange'
        ) {
          const isP2PRoute = pathname === '/api/v1/p2p/exchange'
          const isEnvelope =
            body &&
            typeof body === 'object' &&
            body.schemaVersion === 1 &&
            body.data
          const data = isEnvelope ? body.data : body

          const {
            clientNodeId,
            clientName,
            clientRole: rawClientRole,
            callbackUrl,
            since,
            projectId,
            delta: rawDelta,
            contract,
            format
          } = data

          if (!rawDelta) {
            sendJson(400, {
              ok: false,
              error: 'BAD_REQUEST',
              message: 'Missing delta in exchange request.'
            })
            return
          }

          const clientRole: PeerRole = parsePeerRoleInput(rawClientRole) ?? 'peer'
          const isIncomingP2PDelta =
            isP2PContractPayload(rawDelta) ||
            (typeof rawDelta === 'object' &&
              rawDelta !== null &&
              (rawDelta.format === 'p2p-memory-contract' ||
                (rawDelta.schemaVersion === 1 && rawDelta.data)))

          let delta: VaultSnapshotV1
          if (isIncomingP2PDelta) {
            delta = p2pPayloadToSnapshot(rawDelta)
          } else {
            delta = rawDelta as VaultSnapshotV1
          }

          const safeCallbackUrl = acceptCallbackUrl(callbackUrl, remoteAddress)

          if (matchedGroup && safeCallbackUrl) {
            vault.addNodeToGroup?.(matchedGroup.id, safeCallbackUrl)
          }

          const policy: EffectivePeerPermissions = vault.evaluatePeerPermissions
            ? vault.evaluatePeerPermissions(resolveIdentity(clientNodeId, safeCallbackUrl))
            : {
                unrestricted: true,
                groups: [],
                canPush: () => true,
                canPull: () => true
              }

          let incomingDelta = delta
          let incomingDroppedMemories = 0
          if (
            !policy.unrestricted &&
            delta &&
            Array.isArray(delta.memories)
          ) {
            const { filtered, droppedMemories } = filterSnapshotByPermissions(
              delta,
              (proj, cat) => policy.canPush(proj, cat)
            )
            incomingDelta = filtered
            incomingDroppedMemories = droppedMemories
          }

          const appliedOnServer = vault.importSnapshot(incomingDelta, {
            strategy: 'merge',
            projectId: projectId ?? undefined,
            ...(policy.unrestricted
              ? {}
              : { canApply: (proj: string, cat?: string) => policy.canPush(proj, cat) })
          })
          if (incomingDroppedMemories > 0) {
            appliedOnServer.memoriesSkipped += incomingDroppedMemories
          }
          if (options?.onImported) {
            try {
              options.onImported(appliedOnServer)
            } catch {
              // El aviso de importación nunca rompe el intercambio
            }
          }

          const rawServerDelta = vault.exportSnapshot({
            since: since ?? undefined,
            projectId: projectId ?? undefined
          })

          let serverDelta = rawServerDelta
          if (
            !policy.unrestricted &&
            rawServerDelta &&
            Array.isArray((rawServerDelta as VaultSnapshotV1).memories)
          ) {
            const { filtered } = filterSnapshotByPermissions(
              rawServerDelta as VaultSnapshotV1,
              (proj, cat) => policy.canPull(proj, cat)
            )
            serverDelta = filtered
          }

          const serverTimestamp = new Date().toISOString()

          if (safeCallbackUrl && !isExcluded(clientNodeId)) {
            vault.upsertPeer({
              role: clientRole,
              url: safeCallbackUrl,
              name: clientName || 'Peer',
              peerNodeId: clientNodeId ?? null,
              authToken: providedToken,
              lastSyncAt: serverTimestamp,
              lastStatus: 'ok'
            })
          }

          const wantsP2P =
            isP2PRoute ||
            isEnvelope ||
            contract === 'p2p-memory-contract' ||
            format === 'p2p' ||
            format === 'gaze' ||
            isIncomingP2PDelta

          let responseDelta: any = serverDelta
          if (wantsP2P) {
            responseDelta = snapshotToP2PPayload(serverDelta as VaultSnapshotV1, {
              app: 'memoseb',
              originNodeName: currentConfig.nodeName
            })
          }

          const exchangeData = {
            ok: true,
            serverNodeId: currentConfig.nodeId,
            serverName: currentConfig.nodeName,
            serverRole: currentConfig.role,
            serverTimestamp,
            appliedOnServer,
            serverDelta: responseDelta,
            effectiveGroups: policy.groups
          }

          if (wantsP2P || isEnvelope) {
            sendJson(200, {
              ...exchangeData,
              schemaVersion: 1,
              command: 'exchange',
              generatedAt: serverTimestamp,
              data: exchangeData
            })
          } else {
            sendJson(200, exchangeData)
          }
          return
        }
      }

      sendJson(404, {
        ok: false,
        error: 'NOT_FOUND',
        message: `Cannot ${req.method} ${pathname}`
      })
    } catch (err: any) {
      sendJson(500, {
        ok: false,
        error: 'INTERNAL_ERROR',
        message: err.message || 'Internal server error'
      })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(listenPort, listenHost, () => {
      resolve()
    })
  })

  const addr = server.address() as AddressInfo
  const actualHttpPort = addr.port

  const extraServers: http.Server[] = []
  try {
    for (const host of listenHosts.slice(1)) {
      const extra = http.createServer((req, res) => server.emit('request', req, res))
      await new Promise<void>((resolve, reject) => {
        extra.once('error', reject)
        extra.listen(actualHttpPort, host, () => resolve())
      })
      extraServers.push(extra)
    }
  } catch (err) {
    for (const extra of extraServers) extra.close()
    server.close()
    throw err
  }
  const urls = getLocalLanUrls(actualHttpPort)

  let udpSocket: dgram.Socket | null = null
  let actualUdpPort: number | null = null

  const shouldEnableUdp =
    options?.enableUdpDiscovery ?? initialConfig.lanDiscovery

  if (shouldEnableUdp) {
    const requestedUdpPort = options?.udpPort ?? actualHttpPort
    udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

    udpSocket.on('message', (msg, rinfo) => {
      try {
        const cfg = vault.getNodeConfig()
        if (!cfg.enabled || (cfg.role !== 'parent' && cfg.role !== 'peer')) {
          return
        }
        const data = JSON.parse(msg.toString('utf-8'))
        if (!data || data.magic !== DISCOVERY_MAGIC_REQUEST) {
          return
        }
        const nonce = typeof data.nonce === 'string' ? data.nonce : ''

        const serverToken =
          options?.token !== undefined ? options.token : cfg.authToken
        const groupTokens: string[] = (vault.listGroups?.() ?? [])
          .map((g) => g.groupToken)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)

        const availableTokens: string[] = []
        if (serverToken && serverToken.length > 0) {
          availableTokens.push(serverToken)
        }
        for (const gt of groupTokens) {
          if (!availableTokens.includes(gt)) {
            availableTokens.push(gt)
          }
        }
        const hasAuth = availableTokens.length > 0

        let matchedToken: string | null = null
        const udpPort = udpSocket?.address().port ?? requestedUdpPort
        const { local, destinations } = localUdpDestinations()
        // Con token configurado no se responde a sondeos sin authTag válido para
        // alguno de nuestros destinos posibles (IP local o broadcast)
        if (hasAuth) {
          if (typeof data.authTag === 'string') {
            search: for (const candidate of availableTokens) {
              for (const dest of destinations) {
                if (tagsEqual(udpRequestTag(candidate, nonce, challengeEndpoint(dest, udpPort)), data.authTag)) {
                  matchedToken = candidate
                  break search
                }
              }
            }
          }
          if (!matchedToken) {
            return
          }
        }

        const signingToken =
          matchedToken ??
          (serverToken && serverToken.length > 0
            ? serverToken
            : (availableTokens[0] ?? null))

        const response: AnnouncePacket = {
          magic: DISCOVERY_MAGIC_RESPONSE,
          nonce,
          nodeId: cfg.nodeId,
          nodeName: cfg.nodeName,
          role: cfg.role as 'parent' | 'peer',
          port: actualHttpPort,
          urls: getLocalLanUrls(actualHttpPort),
          requiresAuth: hasAuth,
          app: 'memoseb',
          contracts: ['memoseb-snapshot', 'p2p-memory-contract'],
          ...(hasAuth && signingToken
            ? {
                authTags: Object.fromEntries(
                  local.map((ip) => [
                    ip,
                    udpResponseTag(signingToken, nonce, challengeEndpoint(ip, udpPort))
                  ])
                )
              }
            : {})
        }
        const outBuf = Buffer.from(JSON.stringify(response))
        udpSocket?.send(outBuf, 0, outBuf.length, rinfo.port, rinfo.address)
      } catch {
        // ignore invalid datagrams
      }
    })

    await new Promise<void>((resolve) => {
      udpSocket!.on('error', () => {
        actualUdpPort = null
        resolve()
      })
      udpSocket!.bind(requestedUdpPort, () => {
        try {
          const uAddr = udpSocket!.address()
          actualUdpPort = uAddr.port
        } catch {
          actualUdpPort = requestedUdpPort
        }
        resolve()
      })
    })
  }

  return {
    host: listenHost,
    hosts: listenHosts,
    port: actualHttpPort,
    udpPort: actualUdpPort,
    urls,
    close: async () => {
      for (const srv of [server, ...extraServers]) {
        if (typeof srv.closeAllConnections === 'function') {
          srv.closeAllConnections()
        }
        await new Promise<void>((resolve) => {
          srv.close(() => resolve())
        })
      }
      if (udpSocket) {
        await new Promise<void>((resolve) => {
          try {
            udpSocket!.close(() => resolve())
          } catch {
            resolve()
          }
        })
      }
    }
  }
}

export async function performPeerHandshake(
  vault: SyncCapableVault,
  options: {
    peerUrl: string
    peerRole: PeerRole | 'p2p'
    token?: string | null
    callbackUrl?: string
    groups?: readonly string[]
    timeoutMs?: number
  }
): Promise<HandshakeResult> {
  const normalizedUrl = normalizePeerUrl(options.peerUrl)
  const config = vault.getNodeConfig()
  const normalizedPeerRole = normalizePeerRole(options.peerRole)
  const myRole: PeerRole =
    config.role === 'standalone'
      ? normalizedPeerRole === 'parent'
        ? 'child'
        : normalizedPeerRole === 'child'
          ? 'parent'
          : 'peer'
      : (config.role as PeerRole)

  const bodyData = {
    nodeId: config.nodeId,
    nodeName: config.nodeName,
    role: myRole,
    callbackUrl: options.callbackUrl,
    groups: options.groups
  }

  const p2pEnvelope = wrapP2PEnvelope('handshake', bodyData)
  const isPeer = normalizedPeerRole === 'peer' || config.role === 'peer'

  let res: any
  if (isPeer) {
    try {
      res = await sendJsonRequest<any>(`${normalizedUrl}/api/v1/p2p/handshake`, {
        method: 'POST',
        token: options.token ?? null,
        body: {
          ...p2pEnvelope,
          ...bodyData
        },
        timeoutMs: options.timeoutMs ?? 5000
      })
    } catch (err: any) {
      if (err?.statusCode === 404) {
        res = await sendJsonRequest<any>(`${normalizedUrl}/api/v1/sync/handshake`, {
          method: 'POST',
          token: options.token ?? null,
          body: bodyData,
          timeoutMs: options.timeoutMs ?? 5000
        })
      } else {
        throw err
      }
    }
  } else {
    res = await sendJsonRequest<any>(`${normalizedUrl}/api/v1/sync/handshake`, {
      method: 'POST',
      token: options.token ?? null,
      body: bodyData,
      timeoutMs: options.timeoutMs ?? 5000
    })
  }

  const unwrappedRes = unwrapP2PEnvelope(res) as any
  const timestamp =
    unwrappedRes.timestamp ?? res.timestamp ?? new Date().toISOString()
  const peerNodeId = unwrappedRes.nodeId ?? res.nodeId
  const peerNodeName = (unwrappedRes.nodeName ?? res.nodeName) || 'Peer'

  const peerRecord = vault.upsertPeer({
    role: normalizedPeerRole,
    url: normalizedUrl,
    name: peerNodeName,
    peerNodeId,
    authToken: options.token ?? null,
    lastStatus: 'paired'
  })

  return {
    peerUrl: normalizedUrl,
    peerNodeId,
    peerName: peerNodeName,
    peerRole: normalizedPeerRole,
    status: 'paired',
    timestamp,
    peer: peerRecord,
    assignedGroups: unwrappedRes.assignedGroups ?? res.assignedGroups
  }
}

export async function syncWithPeer(
  vault: SyncCapableVault,
  options: {
    peerUrl: string
    peerRole?: PeerRole | 'p2p'
    token?: string | null
    projectId?: string
    full?: boolean
    forceWhenDisabled?: boolean
    timeoutMs?: number
    contract?: 'memoseb' | 'p2p' | 'gaze'
    callbackUrl?: string
  }
): Promise<PeerSyncResult> {
  const config = vault.getNodeConfig()
  if (!config.enabled && !options.forceWhenDisabled) {
    throw new Error(
      'Node networking is disabled. Enable it first with "memoseb node enable".'
    )
  }

  const normalizedUrl = normalizePeerUrl(options.peerUrl)
  const peers = vault.listPeers()
  const existingPeer = peers.find(
    (p) =>
      p.url === normalizedUrl ||
      p.id === options.peerUrl ||
      p.peerNodeId === options.peerUrl
  )

  const peerRole = normalizePeerRole(
    options.peerRole ?? existingPeer?.role ?? 'parent'
  )
  // Solo se envía el token propio del peer: nunca el token global a un peer
  // registrado sin token o con token de grupo.
  const effectiveToken =
    options.token !== undefined ? options.token : (existingPeer?.authToken ?? null)
  const since = options.full ? undefined : (existingPeer?.lastSyncAt ?? undefined)

  try {
    let localDelta = vault.exportSnapshot({
      since,
      projectId: options.projectId
    })

    const isAuthorityInitiator =
      config.role === 'parent' || config.role === 'peer'
    const targetPolicy: EffectivePeerPermissions =
      isAuthorityInitiator && vault.evaluatePeerPermissions
        ? vault.evaluatePeerPermissions({
            peerId: existingPeer?.id ?? null,
            peerNodeId: existingPeer?.peerNodeId ?? null,
            peerName: existingPeer?.name ?? null,
            peerUrl: normalizedUrl
          })
        : {
            unrestricted: true,
            groups: [],
            canPush: () => true,
            canPull: () => true
          }

    if (
      isAuthorityInitiator &&
      !targetPolicy.unrestricted &&
      localDelta &&
      Array.isArray((localDelta as VaultSnapshotV1).memories)
    ) {
      const { filtered } = filterSnapshotByPermissions(
        localDelta as VaultSnapshotV1,
        (proj, cat) => targetPolicy.canPull(proj, cat)
      )
      localDelta = filtered
    }

    const myRole: PeerRole =
      config.role === 'standalone'
        ? peerRole === 'parent'
          ? 'child'
          : peerRole === 'child'
            ? 'parent'
            : 'peer'
        : (config.role as PeerRole)

    const wantsP2P =
      options.contract === 'p2p' ||
      options.contract === 'gaze' ||
      peerRole === 'peer' ||
      config.role === 'peer'

    let payloadToSend: any = localDelta
    if (wantsP2P && localDelta) {
      payloadToSend = snapshotToP2PPayload(localDelta as VaultSnapshotV1, {
        app: 'memoseb',
        originNodeName: config.nodeName
      })
    }

    const exchangeData = {
      clientNodeId: config.nodeId,
      clientName: config.nodeName,
      clientRole: myRole,
      callbackUrl: options.callbackUrl,
      since: since ?? null,
      projectId: options.projectId ?? null,
      delta: payloadToSend,
      contract: wantsP2P ? 'p2p-memory-contract' : 'memoseb-snapshot',
      format: wantsP2P ? 'p2p' : 'memoseb'
    }

    let res: any
    if (wantsP2P) {
      try {
        const envelope = wrapP2PEnvelope('exchange', exchangeData)
        res = await sendJsonRequest<any>(`${normalizedUrl}/api/v1/p2p/exchange`, {
          method: 'POST',
          token: effectiveToken,
          body: {
            ...envelope,
            ...exchangeData
          },
          timeoutMs: options.timeoutMs ?? 15000
        })
      } catch (err: any) {
        if (err?.statusCode === 404) {
          res = await sendJsonRequest<any>(
            `${normalizedUrl}/api/v1/sync/exchange`,
            {
              method: 'POST',
              token: effectiveToken,
              body: exchangeData,
              timeoutMs: options.timeoutMs ?? 15000
            }
          )
        } else {
          throw err
        }
      }
    } else {
      res = await sendJsonRequest<any>(
        `${normalizedUrl}/api/v1/sync/exchange`,
        {
          method: 'POST',
          token: effectiveToken,
          body: exchangeData,
          timeoutMs: options.timeoutMs ?? 15000
        }
      )
    }

    const resData = unwrapP2PEnvelope(res) as any
    const rawServerDelta = resData.serverDelta ?? res.serverDelta
    const serverTimestamp =
      resData.serverTimestamp ?? res.serverTimestamp ?? new Date().toISOString()
    const serverNodeId = resData.serverNodeId ?? res.serverNodeId
    const serverName = resData.serverName ?? res.serverName
    const effectiveGroups = resData.effectiveGroups ?? res.effectiveGroups

    let serverDelta: VaultSnapshotV1
    if (
      isP2PContractPayload(rawServerDelta) ||
      (rawServerDelta &&
        typeof rawServerDelta === 'object' &&
        (rawServerDelta.format === 'p2p-memory-contract' ||
          (rawServerDelta.schemaVersion === 1 && rawServerDelta.data)))
    ) {
      serverDelta = p2pPayloadToSnapshot(rawServerDelta)
    } else {
      serverDelta = rawServerDelta as VaultSnapshotV1
    }

    let incomingServerDelta = serverDelta
    let incomingDroppedMemories = 0
    if (
      isAuthorityInitiator &&
      !targetPolicy.unrestricted &&
      serverDelta &&
      Array.isArray(serverDelta.memories)
    ) {
      const { filtered, droppedMemories } = filterSnapshotByPermissions(
        serverDelta,
        (proj, cat) => targetPolicy.canPush(proj, cat)
      )
      incomingServerDelta = filtered
      incomingDroppedMemories = droppedMemories
    }

    const pulled = vault.importSnapshot(incomingServerDelta, {
      strategy: 'merge',
      projectId: options.projectId
    })
    if (incomingDroppedMemories > 0) {
      pulled.memoriesSkipped += incomingDroppedMemories
    }

    if (existingPeer) {
      vault.updatePeerSyncState(existingPeer.id, {
        lastSyncAt: serverTimestamp,
        lastStatus: 'ok',
        peerNodeId: serverNodeId,
        name: serverName
      })
    } else {
      vault.upsertPeer({
        role: peerRole,
        url: normalizedUrl,
        name: serverName,
        peerNodeId: serverNodeId,
        authToken: effectiveToken,
        lastSyncAt: serverTimestamp,
        lastStatus: 'ok'
      })
    }

    return {
      peerUrl: normalizedUrl,
      peerNodeId: serverNodeId,
      peerName: serverName,
      peerRole,
      pushed: resData.appliedOnServer ?? res.appliedOnServer,
      pulled,
      syncedAt: serverTimestamp,
      effectiveGroups
    }
  } catch (err: any) {
    if (existingPeer) {
      vault.updatePeerSyncState(existingPeer.id, {
        lastStatus: `error: ${err.message}`
      })
    }
    throw err
  }
}

export async function syncAllPeers(
  vault: SyncCapableVault,
  options?: {
    projectId?: string
    full?: boolean
    token?: string | null
    timeoutMs?: number
    callbackUrl?: string | ((peerUrl: string) => string | undefined)
    signal?: AbortSignal
  }
): Promise<SyncSummaryResult> {
  const config = vault.getNodeConfig()
  if (!config.enabled) {
    return {
      enabled: false,
      role: config.role,
      results: [],
      errors: []
    }
  }

  const allPeers = vault.listPeers()
  let targetPeers: SyncPeerRecord[] = []
  if (config.role === 'child') {
    targetPeers = allPeers.filter(
      (p) => p.role === 'parent' || p.role === 'child'
    )
  } else if (config.role === 'parent') {
    targetPeers = allPeers.filter((p) => p.role === 'child')
  } else if (config.role === 'peer') {
    targetPeers = allPeers
  } else {
    targetPeers = allPeers
  }

  const results: PeerSyncResult[] = []
  const errors: SyncPeerError[] = []
  const callbackFor = (peerUrl: string): string | undefined =>
    typeof options?.callbackUrl === 'function'
      ? options.callbackUrl(peerUrl)
      : options?.callbackUrl

  // Pass 1: Bi-directional synchronization across all target peers
  for (const peer of targetPeers) {
    if (options?.signal?.aborted) break
    try {
      const res = await syncWithPeer(vault, {
        peerUrl: peer.url,
        peerRole: peer.role,
        token: options?.token !== undefined ? options.token : (peer.authToken ?? undefined),
        projectId: options?.projectId,
        full: options?.full,
        timeoutMs: options?.timeoutMs,
        callbackUrl: callbackFor(peer.url)
      })
      results.push(res)
    } catch (err: any) {
      errors.push({
        peerUrl: peer.url,
        error: err.message || 'Unknown sync error'
      })
    }
  }

  // Pass 2: If role is parent or peer with multiple peers, propagate newly received changes
  // so Peer A receives what Peer B uploaded during Pass 1
  if ((config.role === 'parent' || config.role === 'peer') && targetPeers.length > 1) {
    for (const peer of targetPeers) {
      if (options?.signal?.aborted) break
      const pass1Success = results.some((r) => r.peerUrl === peer.url)
      if (!pass1Success) {
        continue
      }
      try {
        const propResult = await syncWithPeer(vault, {
          peerUrl: peer.url,
          peerRole: peer.role,
          token: options?.token !== undefined ? options.token : (peer.authToken ?? undefined),
          projectId: options?.projectId,
          full: true,
          timeoutMs: options?.timeoutMs,
          callbackUrl: callbackFor(peer.url)
        })

        const prevIdx = results.findIndex((r) => r.peerUrl === peer.url)
        if (prevIdx >= 0) {
          const prev = results[prevIdx]!
          results[prevIdx] = {
            ...propResult,
            pushed: {
              strategy: propResult.pushed.strategy,
              projectsImported:
                prev.pushed.projectsImported +
                propResult.pushed.projectsImported,
              memoriesCreated:
                prev.pushed.memoriesCreated + propResult.pushed.memoriesCreated,
              memoriesUpdated:
                prev.pushed.memoriesUpdated + propResult.pushed.memoriesUpdated,
              memoriesSkipped:
                prev.pushed.memoriesSkipped + propResult.pushed.memoriesSkipped,
              tombstonesApplied:
                prev.pushed.tombstonesApplied +
                propResult.pushed.tombstonesApplied
            },
            pulled: {
              strategy: propResult.pulled.strategy,
              projectsImported:
                prev.pulled.projectsImported +
                propResult.pulled.projectsImported,
              memoriesCreated:
                prev.pulled.memoriesCreated + propResult.pulled.memoriesCreated,
              memoriesUpdated:
                prev.pulled.memoriesUpdated + propResult.pulled.memoriesUpdated,
              memoriesSkipped:
                prev.pulled.memoriesSkipped + propResult.pulled.memoriesSkipped,
              tombstonesApplied:
                prev.pulled.tombstonesApplied +
                propResult.pulled.tombstonesApplied
            }
          }
        }
      } catch {
        // Non-fatal if propagation pass encounters an issue
      }
    }
  }

  return {
    enabled: true,
    role: config.role,
    results,
    errors
  }
}

export async function triggerAutoSyncIfEnabled(
  vault: SyncCapableVault,
  options?: {
    projectId?: string
    timeoutMs?: number
  }
): Promise<SyncSummaryResult | null> {
  const config = vault.getNodeConfig()
  if (!config.enabled || !config.autoSync) {
    return null
  }
  const peers = vault.listPeers()
  if (peers.length === 0) {
    return null
  }
  try {
    return await syncAllPeers(vault, {
      projectId: options?.projectId,
      timeoutMs: options?.timeoutMs ?? 2500
    })
  } catch {
    return null
  }
}
