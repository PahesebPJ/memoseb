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
    }
  ): SnapshotImportResult
  getStats(): VaultStats
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
  authTag?: string
}

export interface SyncServerHandle {
  host: string
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

interface HttpRequestOptions {
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

interface HttpResponse {
  statusCode: number
  statusMessage: string
  headers: http.IncomingHttpHeaders
  body: string
}

function sendHttpRequest(
  targetUrl: string,
  options: HttpRequestOptions
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl)
    const isHttps = parsed.protocol === 'https:'
    const client = isHttps ? https : http
    const timeout = options.timeoutMs ?? 15000

    const req = client.request(
      parsed,
      {
        method: options.method,
        headers: options.headers,
        timeout
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            body
          })
        })
      }
    )

    req.on('timeout', () => {
      req.destroy(new Error(`Request timed out after ${timeout}ms`))
    })

    req.on('error', (err) => {
      reject(err)
    })

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
  }
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json'
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
  const discoverPacket: DiscoverPacket = {
    magic: DISCOVERY_MAGIC_REQUEST,
    nonce,
    timestamp: new Date().toISOString(),
    ...(token
      ? {
          authTag: crypto
            .createHmac('sha256', token)
            .update(nonce)
            .digest('hex')
        }
      : {})
  }

  const payload = Buffer.from(JSON.stringify(discoverPacket))
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
          const expectedTag = crypto
            .createHmac('sha256', token)
            .update(nonce)
            .digest('hex')
          if (!verifyAuthToken(expectedTag, typeof raw.authTag === 'string' ? raw.authTag : null)) {
            return
          }
        }
        const port = typeof raw.port === 'number' ? raw.port : targetPort
        const urls: string[] = Array.isArray(raw.urls) ? raw.urls : []
        const fallbackUrl = `http://${rinfo.address}:${port}`
        if (!urls.includes(fallbackUrl)) {
          urls.push(fallbackUrl)
        }

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
            contracts: Array.isArray(raw.contracts) ? raw.contracts : undefined
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
        socket.send(payload, 0, payload.length, targetPort, target, () => {
          // ignore target errors
        })
      }
    })
  })
}

export const discoverLanParents = discoverLanNodes

export async function startSyncServer(
  vault: SyncCapableVault,
  options?: {
    host?: string
    port?: number
    token?: string | null
    enableUdpDiscovery?: boolean
    udpPort?: number
  }
): Promise<SyncServerHandle> {
  const initialConfig = vault.getNodeConfig()
  const listenHost = options?.host ?? initialConfig.listenHost ?? '0.0.0.0'
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

      // 2. Auth Verification (Dual: Node Global Token or Group Token)
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
      const isGlobalTokenValid = verifyAuthToken(expectedToken, providedToken)

      if (!isGlobalTokenValid && !matchedGroup) {
        sendJson(401, {
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'Invalid or missing sync token.'
        })
        return
      }

      const parsedUrl = new URL(
        req.url ?? '/',
        `http://${req.headers.host ?? 'localhost'}`
      )
      const pathname = parsedUrl.pathname

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

          let safeCallbackUrl: string | undefined
          if (typeof callbackUrl === 'string' && callbackUrl.trim().length > 0) {
            try {
              safeCallbackUrl = normalizePeerUrl(callbackUrl)
            } catch {
              // ignore malformed callbackUrl
            }
          }

          if (
            safeCallbackUrl &&
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
              lastStatus: 'paired'
            })
          }

          if (matchedGroup) {
            vault.addNodeToGroup?.(matchedGroup.id, nodeId)
            if (safeCallbackUrl) {
              vault.addNodeToGroup?.(matchedGroup.id, safeCallbackUrl)
            }
          }

          const requestedGroups: string[] = Array.isArray(groups) ? groups : []
          if (isGlobalTokenValid && requestedGroups.length > 0) {
            for (const groupName of requestedGroups) {
              if (typeof groupName === 'string') {
                const grp = vault.getGroup?.(groupName)
                if (grp) {
                  vault.addNodeToGroup?.(grp.id, nodeId)
                  if (safeCallbackUrl) {
                    vault.addNodeToGroup?.(grp.id, safeCallbackUrl)
                  }
                }
              }
            }
          }

          let existingPeerId: string | null = null
          if (vault.listPeers) {
            const peers = vault.listPeers()
            const found = peers.find(
              (p) =>
                (nodeId && p.peerNodeId === nodeId) ||
                (safeCallbackUrl && p.url === safeCallbackUrl)
            )
            if (found) existingPeerId = found.id
          }

          const policy: EffectivePeerPermissions = vault.evaluatePeerPermissions
            ? vault.evaluatePeerPermissions(
                !isGlobalTokenValid && matchedGroup
                  ? { matchedGroupByToken: matchedGroup.id }
                  : {
                      peerId: existingPeerId,
                      peerNodeId: nodeId,
                      peerName: nodeName || null,
                      peerUrl: safeCallbackUrl || null,
                      matchedGroupByToken: matchedGroup?.id ?? null
                    }
              )
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

          let safeCallbackUrl: string | undefined
          if (typeof callbackUrl === 'string' && callbackUrl.trim().length > 0) {
            try {
              safeCallbackUrl = normalizePeerUrl(callbackUrl)
            } catch {
              // ignore malformed callbackUrl
            }
          }

          if (matchedGroup && clientNodeId) {
            vault.addNodeToGroup?.(matchedGroup.id, clientNodeId)
            if (safeCallbackUrl) {
              vault.addNodeToGroup?.(matchedGroup.id, safeCallbackUrl)
            }
          }

          let existingPeerId: string | null = null
          if (vault.listPeers) {
            const peers = vault.listPeers()
            const found = peers.find(
              (p) =>
                (clientNodeId && p.peerNodeId === clientNodeId) ||
                (safeCallbackUrl && p.url === safeCallbackUrl)
            )
            if (found) existingPeerId = found.id
          }

          const policy: EffectivePeerPermissions = vault.evaluatePeerPermissions
            ? vault.evaluatePeerPermissions(
                !isGlobalTokenValid && matchedGroup
                  ? { matchedGroupByToken: matchedGroup.id }
                  : {
                      peerId: existingPeerId,
                      peerNodeId: clientNodeId ?? null,
                      peerName: clientName ?? null,
                      peerUrl: safeCallbackUrl ?? null,
                      matchedGroupByToken: matchedGroup?.id ?? null
                    }
              )
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
            projectId: projectId ?? undefined
          })
          if (incomingDroppedMemories > 0) {
            appliedOnServer.memoriesSkipped += incomingDroppedMemories
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

          if (safeCallbackUrl) {
            vault.upsertPeer({
              role: clientRole,
              url: safeCallbackUrl,
              name: clientName || 'Peer',
              peerNodeId: clientNodeId ?? null,
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
        if (data.authTag && hasAuth) {
          if (typeof data.authTag === 'string') {
            for (const candidate of availableTokens) {
              const expectedTag = crypto
                .createHmac('sha256', candidate)
                .update(nonce)
                .digest('hex')
              if (verifyAuthToken(expectedTag, data.authTag)) {
                matchedToken = candidate
                break
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
                authTag: crypto
                  .createHmac('sha256', signingToken)
                  .update(nonce)
                  .digest('hex')
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
    port: actualHttpPort,
    udpPort: actualUdpPort,
    urls,
    close: async () => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
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

  const effectiveToken =
    options.token !== undefined
      ? options.token
      : (existingPeer?.authToken ?? null)
  const peerRole = normalizePeerRole(
    options.peerRole ?? existingPeer?.role ?? 'parent'
  )
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
      callbackUrl: undefined,
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

  // Pass 1: Bi-directional synchronization across all target peers
  for (const peer of targetPeers) {
    try {
      const res = await syncWithPeer(vault, {
        peerUrl: peer.url,
        peerRole: peer.role,
        token: options?.token !== undefined ? options.token : peer.authToken,
        projectId: options?.projectId,
        full: options?.full,
        timeoutMs: options?.timeoutMs
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
      const pass1Success = results.some((r) => r.peerUrl === peer.url)
      if (!pass1Success) {
        continue
      }
      try {
        const propResult = await syncWithPeer(vault, {
          peerUrl: peer.url,
          peerRole: peer.role,
          token: options?.token !== undefined ? options.token : peer.authToken,
          projectId: options?.projectId,
          full: false,
          timeoutMs: options?.timeoutMs
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
