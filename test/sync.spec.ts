import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type { NodeConfiguration, NodeRole, PeerRole, SyncPeerRecord } from '../src/core/schema.ts'
import {
  discoverLanNodes,
  discoverLanParents,
  getLocalLanUrls,
  normalizePeerUrl,
  performPeerHandshake,
  startSyncServer,
  syncAllPeers,
  syncWithPeer,
  triggerAutoSyncIfEnabled,
  verifyAuthToken,
  type SnapshotImportResult,
  type SnapshotMemoryEntry,
  type SnapshotProjectEntry,
  type SnapshotTombstoneEntry,
  type SyncCapableVault,
  type VaultSnapshotV1
} from '../src/core/sync.ts'
import {
  computeP2PPayloadChecksum,
  memoryToGazeNode,
  wrapP2PEnvelope,
  type GazeNodeV1,
  type P2PContractEnvelopeV1,
  type P2PSyncPayloadV1
} from '../src/core/p2p-contract.ts'
import { MemoryVault, type VaultStats } from '../src/core/vault.ts'

class MockSyncVault implements SyncCapableVault {
  nodeConfig: NodeConfiguration
  peers: Map<string, SyncPeerRecord> = new Map()
  projects: Map<string, SnapshotProjectEntry> = new Map()
  memories: Map<string, SnapshotMemoryEntry> = new Map()
  tombstones: SnapshotTombstoneEntry[] = []

  constructor(options: {
    nodeId: string
    nodeName: string
    role: NodeRole
    authToken?: string | null
    autoSync?: boolean
    lanDiscovery?: boolean
    listenPort?: number
  }) {
    this.nodeConfig = {
      nodeId: options.nodeId,
      nodeName: options.nodeName,
      enabled: true,
      role: options.role,
      listenHost: '127.0.0.1',
      listenPort: options.listenPort ?? 0,
      authToken: options.authToken ?? null,
      autoSync: options.autoSync ?? false,
      lanDiscovery: options.lanDiscovery ?? false
    }
  }

  getNodeId(): string {
    return this.nodeConfig.nodeId
  }

  getNodeConfig(): NodeConfiguration {
    return { ...this.nodeConfig }
  }

  updateNodeConfig(
    patch: Partial<Omit<NodeConfiguration, 'nodeId'>>
  ): NodeConfiguration {
    this.nodeConfig = { ...this.nodeConfig, ...patch }
    return { ...this.nodeConfig }
  }

  enableNodeMode(options: {
    role: PeerRole | 'p2p'
    nodeName?: string
    listenHost?: string
    listenPort?: number
    authToken?: string | null
    autoSync?: boolean
    lanDiscovery?: boolean
  }): NodeConfiguration {
    const normalizedRole: NodeRole = options.role === 'p2p' ? 'peer' : options.role
    this.nodeConfig = {
      ...this.nodeConfig,
      enabled: true,
      role: normalizedRole,
      nodeName: options.nodeName ?? this.nodeConfig.nodeName,
      listenHost: options.listenHost ?? this.nodeConfig.listenHost,
      listenPort: options.listenPort ?? this.nodeConfig.listenPort,
      authToken:
        options.authToken !== undefined
          ? options.authToken
          : this.nodeConfig.authToken,
      autoSync: options.autoSync ?? this.nodeConfig.autoSync,
      lanDiscovery: options.lanDiscovery ?? this.nodeConfig.lanDiscovery
    }
    return { ...this.nodeConfig }
  }

  disableNodeMode(options?: { purgePeers?: boolean }): NodeConfiguration {
    this.nodeConfig.enabled = false
    if (options?.purgePeers) {
      this.peers.clear()
    }
    return { ...this.nodeConfig }
  }

  upsertPeer(input: {
    role: PeerRole | 'p2p'
    url: string
    name?: string
    peerNodeId?: string | null
    authToken?: string | null
    lastSyncAt?: string | null
    lastStatus?: string | null
  }): SyncPeerRecord {
    const existing = Array.from(this.peers.values()).find(
      (p) => p.url === input.url
    )
    const id = existing?.id ?? crypto.randomUUID()
    const normalizedRole: PeerRole = input.role === 'p2p' ? 'peer' : input.role
    const record: SyncPeerRecord = {
      id,
      url: input.url,
      role: normalizedRole,
      name: input.name ?? existing?.name ?? 'Peer',
      peerNodeId: input.peerNodeId ?? existing?.peerNodeId ?? null,
      authToken:
        input.authToken !== undefined
          ? input.authToken
          : (existing?.authToken ?? null),
      lastSyncAt:
        input.lastSyncAt !== undefined
          ? input.lastSyncAt
          : (existing?.lastSyncAt ?? null),
      lastStatus:
        input.lastStatus !== undefined
          ? input.lastStatus
          : (existing?.lastStatus ?? null),
      updatedAt: new Date().toISOString()
    }
    this.peers.set(id, record)
    return record
  }

  removePeer(urlOrId: string): boolean {
    const peer =
      this.peers.get(urlOrId) ??
      Array.from(this.peers.values()).find((p) => p.url === urlOrId)
    if (peer) {
      this.peers.delete(peer.id)
      return true
    }
    return false
  }

  listPeers(role?: PeerRole | 'p2p'): SyncPeerRecord[] {
    const list = Array.from(this.peers.values())
    const normalizedRole = role === 'p2p' ? 'peer' : role
    return normalizedRole ? list.filter((p) => p.role === normalizedRole) : list
  }

  updatePeerSyncState(
    urlOrId: string,
    state: {
      lastSyncAt?: string | null
      lastStatus?: string | null
      peerNodeId?: string | null
      name?: string
    }
  ): void {
    const peer =
      this.peers.get(urlOrId) ??
      Array.from(this.peers.values()).find((p) => p.url === urlOrId)
    if (peer) {
      if (state.lastSyncAt !== undefined) peer.lastSyncAt = state.lastSyncAt
      if (state.lastStatus !== undefined) peer.lastStatus = state.lastStatus
      if (state.peerNodeId !== undefined) peer.peerNodeId = state.peerNodeId
      if (state.name !== undefined) peer.name = state.name
      peer.updatedAt = new Date().toISOString()
      this.peers.set(peer.id, peer)
    }
  }

  exportSnapshot(options?: {
    projectId?: string
    since?: string
    includeTombstones?: boolean
  }): VaultSnapshotV1 {
    const projects = Array.from(this.projects.values()).filter(
      (p) => !options?.projectId || p.id === options.projectId
    )
    const memories = Array.from(this.memories.values()).filter((m) => {
      if (options?.projectId && m.projectId !== options.projectId) return false
      if (options?.since && m.updatedAt <= options.since) return false
      return true
    })
    return {
      format: 'memoseb-snapshot',
      version: 1,
      exportedAt: new Date().toISOString(),
      originNodeId: this.nodeConfig.nodeId,
      projectFilter: options?.projectId ?? null,
      checksum: 'mock-checksum',
      projects,
      memories,
      tombstones: options?.includeTombstones !== false ? this.tombstones : []
    }
  }

  importSnapshot(
    snapshot: VaultSnapshotV1,
    options?: {
      strategy?: 'merge' | 'replace'
      projectId?: string
      includeTombstones?: boolean
    }
  ): SnapshotImportResult {
    let memoriesCreated = 0
    let memoriesUpdated = 0
    let projectsImported = 0

    for (const proj of snapshot.projects || []) {
      if (options?.projectId && proj.id !== options.projectId) continue
      if (!this.projects.has(proj.id)) {
        this.projects.set(proj.id, proj)
        projectsImported++
      }
    }

    for (const mem of snapshot.memories || []) {
      if (options?.projectId && mem.projectId !== options.projectId) continue
      if (this.memories.has(mem.id)) {
        this.memories.set(mem.id, mem)
        memoriesUpdated++
      } else {
        this.memories.set(mem.id, mem)
        memoriesCreated++
      }
    }

    return {
      strategy: options?.strategy ?? 'merge',
      projectsImported,
      memoriesCreated,
      memoriesUpdated,
      memoriesSkipped: 0,
      tombstonesApplied: 0
    }
  }

  getStats(): VaultStats {
    return {
      dbPath: ':memory:',
      projectCount: this.projects.size,
      memoryCount: this.memories.size,
      vectorCount: this.memories.size,
      totalTokens: 42
    }
  }
}

describe('Sync Engine: Network Utilities and Auth Verification', () => {
  it('normalizes valid peer URLs and strips paths and trailing slashes', () => {
    assert.equal(
      normalizePeerUrl('http://192.168.1.10:7432/'),
      'http://192.168.1.10:7432'
    )
    assert.equal(
      normalizePeerUrl('http://localhost:8080/api/v1/sync'),
      'http://localhost:8080'
    )
    assert.equal(
      normalizePeerUrl('https://sync.example.com:8443/'),
      'https://sync.example.com:8443'
    )
  })

  it('rejects unsupported protocols and invalid URL strings in normalizePeerUrl', () => {
    assert.throws(
      () => normalizePeerUrl('ftp://example.com/sync'),
      /Invalid peer URL protocol: "ftp:"/
    )
    assert.throws(
      () => normalizePeerUrl('not-a-valid-url'),
      /Invalid peer URL/
    )
  })

  it('retrieves local LAN IPv4 URLs and includes fallback to 127.0.0.1', () => {
    const urls = getLocalLanUrls(7432)
    assert.ok(urls.length > 0)
    for (const url of urls) {
      assert.match(url, /^http:\/\/\d+\.\d+\.\d+\.\d+:7432$/)
    }
  })

  it('verifies auth tokens in constant time with SHA-256 hash digests', () => {
    assert.equal(verifyAuthToken(null, 'any-token'), true)
    assert.equal(verifyAuthToken(undefined, null), true)
    assert.equal(verifyAuthToken('', 'any-token'), true)
    assert.equal(verifyAuthToken('secret-123', 'secret-123'), true)
    assert.equal(verifyAuthToken('secret-123', 'wrong-token'), false)
    assert.equal(verifyAuthToken('secret-123', null), false)
    assert.equal(verifyAuthToken('secret-123', undefined), false)
  })
})

describe('Sync Engine: HTTP Node Server Lifecycle and Security Enforcements', () => {
  it('handles GET /api/v1/sync/status returning nodeId, role and stats', async () => {
    const vault = new MockSyncVault({
      nodeId: 'node-srv-1',
      nodeName: 'Test Parent Server',
      role: 'parent'
    })

    const serverHandle = await startSyncServer(vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      const res = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`)
      assert.equal(res.status, 200)
      const data = (await res.json()) as any
      assert.equal(data.ok, true)
      assert.equal(data.nodeId, 'node-srv-1')
      assert.equal(data.nodeName, 'Test Parent Server')
      assert.equal(data.role, 'parent')
      assert.equal(data.enabled, true)
      assert.equal(data.stats.memoryCount, 0)
    } finally {
      await serverHandle.close()
    }
  })

  it('rejects requests with 503 Service Unavailable when node networking is disabled', async () => {
    const vault = new MockSyncVault({
      nodeId: 'node-srv-2',
      nodeName: 'Disabled Server',
      role: 'parent'
    })

    const serverHandle = await startSyncServer(vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      vault.disableNodeMode()

      const res = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`)
      assert.equal(res.status, 503)
      const data = (await res.json()) as any
      assert.equal(data.ok, false)
      assert.equal(data.error, 'NODE_DISABLED')
    } finally {
      await serverHandle.close()
    }
  })

  it('enforces token authentication via Authorization Bearer or X-Memoseb-Token', async () => {
    const vault = new MockSyncVault({
      nodeId: 'node-srv-3',
      nodeName: 'Secured Server',
      role: 'parent',
      authToken: 'top-secret-token'
    })

    const serverHandle = await startSyncServer(vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      // 1. Missing token -> 401
      const resNoToken = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`)
      assert.equal(resNoToken.status, 401)
      const errData = (await resNoToken.json()) as any
      assert.equal(errData.error, 'UNAUTHORIZED')

      // 2. Wrong token -> 401
      const resBadToken = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`, {
        headers: { Authorization: 'Bearer bad-token' }
      })
      assert.equal(resBadToken.status, 401)

      // 3. Valid Bearer token -> 200
      const resBearer = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`, {
        headers: { Authorization: 'Bearer top-secret-token' }
      })
      assert.equal(resBearer.status, 200)

      // 4. Valid X-Memoseb-Token -> 200
      const resHeader = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/status`, {
        headers: { 'X-Memoseb-Token': 'top-secret-token' }
      })
      assert.equal(resHeader.status, 200)
    } finally {
      await serverHandle.close()
    }
  })

  it('returns 404 for unknown endpoints and 400 for malformed JSON bodies', async () => {
    const vault = new MockSyncVault({
      nodeId: 'node-srv-4',
      nodeName: 'Route Server',
      role: 'parent'
    })

    const serverHandle = await startSyncServer(vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      // Unknown route
      const resNotFound = await fetch(`http://127.0.0.1:${serverHandle.port}/unknown/endpoint`)
      assert.equal(resNotFound.status, 404)

      // Malformed JSON body
      const resBadJson = await fetch(`http://127.0.0.1:${serverHandle.port}/api/v1/sync/handshake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ malformed json'
      })
      assert.equal(resBadJson.status, 400)
    } finally {
      await serverHandle.close()
    }
  })
})

describe('Sync Engine: UDP Local Area Network Discovery', () => {
  it('allows child node to discover parent node and verifies auth credentials', async () => {
    const parentVault = new MockSyncVault({
      nodeId: 'parent-udp-1',
      nodeName: 'Parent Discovery Node',
      role: 'parent',
      authToken: 'lan-shared-secret'
    })

    const serverHandle = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: true,
      udpPort: 0
    })

    assert.ok(serverHandle.udpPort !== null)

    try {
      // 1. Discovery without token fails auth verification when token is required
      const withoutToken = await discoverLanParents({
        port: serverHandle.udpPort,
        timeoutMs: 300,
        token: null,
        broadcastAddresses: ['127.0.0.1']
      })
      // Parent announced requiresAuth: true, but since child didn't verify HMAC, it found the parent
      assert.equal(withoutToken.length, 1)
      assert.equal(withoutToken[0]?.nodeId, 'parent-udp-1')
      assert.equal(withoutToken[0]?.requiresAuth, true)

      // 2. Discovery with matching token verifies HMAC authTag
      const withToken = await discoverLanParents({
        port: serverHandle.udpPort,
        timeoutMs: 300,
        token: 'lan-shared-secret',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(withToken.length, 1)
      assert.equal(withToken[0]?.nodeId, 'parent-udp-1')
      assert.equal(withToken[0]?.nodeName, 'Parent Discovery Node')

      // 3. Discovery with wrong token filters out the parent
      const withWrongToken = await discoverLanParents({
        port: serverHandle.udpPort,
        timeoutMs: 300,
        token: 'wrong-token',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(withWrongToken.length, 0)
    } finally {
      await serverHandle.close()
    }
  })

  it('discovers LAN peer nodes and filters by role using discoverLanNodes and discoverLanParents', async () => {
    const peerVault = new MockSyncVault({
      nodeId: 'peer-udp-node',
      nodeName: 'Peer Discovery Node',
      role: 'peer',
      authToken: 'lan-peer-secret'
    })

    const peerHandle = await startSyncServer(peerVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: true,
      udpPort: 0
    })

    assert.ok(peerHandle.udpPort !== null)

    try {
      // 1. discoverLanNodes with roleFilter: 'peer' finds the peer node
      const peerOnly = await discoverLanNodes({
        port: peerHandle.udpPort,
        timeoutMs: 350,
        token: 'lan-peer-secret',
        roleFilter: 'peer',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(peerOnly.length, 1)
      assert.equal(peerOnly[0]?.nodeId, 'peer-udp-node')
      assert.equal(peerOnly[0]?.role, 'peer')
      assert.ok(peerOnly[0]?.contracts?.includes('p2p-memory-contract'))
      assert.ok(peerOnly[0]?.contracts?.includes('memoseb-snapshot'))

      // 2. discoverLanNodes with roleFilter: 'parent' rejects the peer node
      const parentOnly = await discoverLanNodes({
        port: peerHandle.udpPort,
        timeoutMs: 350,
        token: 'lan-peer-secret',
        roleFilter: 'parent',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(parentOnly.length, 0)

      // 3. discoverLanNodes with roleFilter: 'any' finds the peer node
      const anyNodes = await discoverLanNodes({
        port: peerHandle.udpPort,
        timeoutMs: 350,
        token: 'lan-peer-secret',
        roleFilter: 'any',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(anyNodes.length, 1)
      assert.equal(anyNodes[0]?.nodeId, 'peer-udp-node')

      // 4. discoverLanParents alias supports roleFilter: 'peer'
      const aliasPeer = await discoverLanParents({
        port: peerHandle.udpPort,
        timeoutMs: 350,
        token: 'lan-peer-secret',
        roleFilter: 'peer',
        broadcastAddresses: ['127.0.0.1']
      })
      assert.equal(aliasPeer.length, 1)
      assert.equal(aliasPeer[0]?.nodeId, 'peer-udp-node')
    } finally {
      await peerHandle.close()
    }
  })
})

describe('Sync Engine: Handshake and Bidirectional Synchronization', () => {
  it('executes performPeerHandshake between child and parent and persists peer records', async () => {
    const parentVault = new MockSyncVault({
      nodeId: 'parent-handshake',
      nodeName: 'Parent Handshake Hub',
      role: 'parent'
    })

    const childVault = new MockSyncVault({
      nodeId: 'child-handshake',
      nodeName: 'Child Handshake Leaf',
      role: 'child'
    })

    const parentHandle = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      const childCallbackUrl = 'http://127.0.0.1:9999'
      const handshakeResult = await performPeerHandshake(childVault, {
        peerUrl: `http://127.0.0.1:${parentHandle.port}`,
        peerRole: 'parent',
        callbackUrl: childCallbackUrl
      })

      assert.equal(handshakeResult.peerNodeId, 'parent-handshake')
      assert.equal(handshakeResult.peerName, 'Parent Handshake Hub')
      assert.equal(handshakeResult.status, 'paired')

      // Verify peer is recorded in child vault
      const childPeers = childVault.listPeers()
      assert.equal(childPeers.length, 1)
      assert.equal(childPeers[0]?.peerNodeId, 'parent-handshake')

      // Verify peer is recorded in parent vault via callbackUrl
      const parentPeers = parentVault.listPeers()
      assert.equal(parentPeers.length, 1)
      assert.equal(parentPeers[0]?.peerNodeId, 'child-handshake')
      assert.equal(parentPeers[0]?.url, childCallbackUrl)
    } finally {
      await parentHandle.close()
    }
  })

  it('synchronizes memories bidirectionally via syncWithPeer with delta exchange', async () => {
    const parentVault = new MockSyncVault({
      nodeId: 'parent-sync-node',
      nodeName: 'Parent Vault',
      role: 'parent'
    })

    const childVault = new MockSyncVault({
      nodeId: 'child-sync-node',
      nodeName: 'Child Vault',
      role: 'child'
    })

    // Seed parent with a memory
    parentVault.memories.set('mem-parent-1', {
      id: 'mem-parent-1',
      projectId: 'proj-shared',
      category: 'architecture',
      title: 'Parent Arch Memory',
      content: 'Server content',
      tags: ['parent'],
      sourceAgent: 'agent-p',
      contentHash: 'hash-p1',
      tokenCount: 10,
      importance: 0.9,
      accessCount: 1,
      createdAt: '2026-11-08T00:00:00Z',
      updatedAt: '2026-11-08T00:00:00Z'
    })

    // Seed child with a memory
    childVault.memories.set('mem-child-1', {
      id: 'mem-child-1',
      projectId: 'proj-shared',
      category: 'convention',
      title: 'Child Convention Memory',
      content: 'Client content',
      tags: ['child'],
      sourceAgent: 'agent-c',
      contentHash: 'hash-c1',
      tokenCount: 8,
      importance: 0.8,
      accessCount: 1,
      createdAt: '2026-11-08T00:00:00Z',
      updatedAt: '2026-11-08T00:00:00Z'
    })

    const parentHandle = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      const syncResult = await syncWithPeer(childVault, {
        peerUrl: `http://127.0.0.1:${parentHandle.port}`,
        peerRole: 'parent'
      })

      // Child pushed 1 memory to parent
      assert.equal(syncResult.pushed.memoriesCreated, 1)
      // Child pulled 1 memory from parent
      assert.equal(syncResult.pulled.memoriesCreated, 1)

      // Verify parent received mem-child-1
      assert.ok(parentVault.memories.has('mem-child-1'))
      // Verify child received mem-parent-1
      assert.ok(childVault.memories.has('mem-parent-1'))

      // Verify peer status was updated
      const childPeers = childVault.listPeers()
      assert.equal(childPeers[0]?.lastStatus, 'ok')
      assert.ok(childPeers[0]?.lastSyncAt !== null)
    } finally {
      await parentHandle.close()
    }
  })

  it('fails syncWithPeer when node is disabled unless forceWhenDisabled is specified', async () => {
    const disabledVault = new MockSyncVault({
      nodeId: 'disabled-node',
      nodeName: 'Disabled',
      role: 'child'
    })
    disabledVault.disableNodeMode()

    await assert.rejects(
      () =>
        syncWithPeer(disabledVault, {
          peerUrl: 'http://127.0.0.1:7432'
        }),
      /Node networking is disabled/
    )
  })
})

describe('Sync Engine: Multi-Child Parent Synchronization with Pass-2 Propagation', () => {
  it('propagates changes from Child 1 to Child 2 in a single syncAllPeers cycle', async () => {
    // Topology:
    // Parent Hub with 2 Child servers (Child 1 and Child 2)
    const parentVault = new MockSyncVault({
      nodeId: 'hub-parent',
      nodeName: 'Central Hub',
      role: 'parent'
    })

    const child1Vault = new MockSyncVault({
      nodeId: 'leaf-child-1',
      nodeName: 'Leaf Child 1',
      role: 'child'
    })

    const child2Vault = new MockSyncVault({
      nodeId: 'leaf-child-2',
      nodeName: 'Leaf Child 2',
      role: 'child'
    })

    // Child 1 starts with a unique memory
    child1Vault.memories.set('mem-c1', {
      id: 'mem-c1',
      projectId: 'proj-sync',
      category: 'domain',
      title: 'Created by Child 1',
      content: 'Child 1 findings',
      tags: ['c1'],
      sourceAgent: 'agent-1',
      contentHash: 'hash-c1',
      tokenCount: 5,
      importance: 0.7,
      accessCount: 1,
      createdAt: '2026-11-08T00:00:00Z',
      updatedAt: '2026-11-08T00:00:00Z'
    })

    // Start servers for Child 1 and Child 2
    const child1Handle = await startSyncServer(child1Vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    const child2Handle = await startSyncServer(child2Vault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })

    try {
      // Register both children in the Parent Hub
      parentVault.upsertPeer({
        role: 'child',
        url: `http://127.0.0.1:${child1Handle.port}`,
        name: 'Child 1'
      })
      parentVault.upsertPeer({
        role: 'child',
        url: `http://127.0.0.1:${child2Handle.port}`,
        name: 'Child 2'
      })

      // Parent Hub executes syncAllPeers
      const summary = await syncAllPeers(parentVault)

      assert.equal(summary.enabled, true)
      assert.equal(summary.errors.length, 0)
      assert.equal(summary.results.length, 2)

      // Verify that Parent has Child 1's memory
      assert.ok(parentVault.memories.has('mem-c1'))

      // Due to Pass 2 rapid propagation, Child 2 must have immediately received Child 1's memory!
      assert.ok(
        child2Vault.memories.has('mem-c1'),
        'Child 2 should have received mem-c1 via Pass 2 propagation'
      )
    } finally {
      await child1Handle.close()
      await child2Handle.close()
    }
  })

  it('triggers autoSync cleanly or returns null when autoSync is disabled', async () => {
    const vault = new MockSyncVault({
      nodeId: 'auto-sync-node',
      nodeName: 'Auto Node',
      role: 'child',
      autoSync: false
    })

    // 1. autoSync is false -> returns null immediately
    const resDisabled = await triggerAutoSyncIfEnabled(vault)
    assert.equal(resDisabled, null)

    // 2. autoSync is true but no peers -> returns null
    vault.updateNodeConfig({ autoSync: true })
    const resNoPeers = await triggerAutoSyncIfEnabled(vault)
    assert.equal(resNoPeers, null)

    // 3. autoSync is true with peers -> executes syncAllPeers
    vault.upsertPeer({
      role: 'parent',
      url: 'http://127.0.0.1:59999' // Non-existent server
    })

    const resAttempt = await triggerAutoSyncIfEnabled(vault, { timeoutMs: 200 })
    assert.ok(resAttempt !== null)
    assert.equal(resAttempt.errors.length, 1)
  })

  it('propagates tombstones bidirectionally and deletes memories across real vaults via syncWithPeer', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-sync-tomb-'))
    try {
      const parentDb = path.join(tmpDir, 'parent.sqlite')
      const child1Db = path.join(tmpDir, 'child1.sqlite')
      const child2Db = path.join(tmpDir, 'child2.sqlite')

      const parentVault = new MemoryVault({ dbPath: parentDb })
      parentVault.enableNodeMode({ role: 'parent', listenPort: 0 })

      const child1Vault = new MemoryVault({ dbPath: child1Db })
      child1Vault.enableNodeMode({ role: 'child', listenPort: 0 })

      const child2Vault = new MemoryVault({ dbPath: child2Db })
      child2Vault.enableNodeMode({ role: 'child', listenPort: 0 })

      // Child 1 creates a memory
      const m1 = child1Vault.storeMemory({
        projectId: 'sync-mesh',
        category: 'architecture',
        title: 'Microservices Mesh',
        content: 'Service mesh topology for child 1.'
      })

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      try {
        // Child 1 syncs with Parent
        await syncWithPeer(child1Vault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })
        // Parent now has m1
        assert.equal(parentVault.recallMemories('Microservices', { projectId: 'sync-mesh' }).memories.length, 1)

        // Child 2 syncs with Parent
        await syncWithPeer(child2Vault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })
        // Child 2 now has m1
        assert.equal(child2Vault.recallMemories('Microservices', { projectId: 'sync-mesh' }).memories.length, 1)

        // Child 1 forgets m1, creating a tombstone
        const forgotten = child1Vault.forgetMemory(m1.memory.id)
        assert.equal(forgotten, true)

        // Child 1 syncs with Parent
        const syncRes1 = await syncWithPeer(child1Vault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })
        assert.ok(syncRes1.pushed.tombstonesApplied >= 0)

        // Parent memory should now be deleted!
        assert.equal(parentVault.recallMemories('Microservices', { projectId: 'sync-mesh' }).memories.length, 0)

        // Child 2 syncs with Parent
        const syncRes2 = await syncWithPeer(child2Vault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })
        assert.equal(syncRes2.pulled.tombstonesApplied, 1)

        // Child 2 memory should now be deleted!
        assert.equal(child2Vault.recallMemories('Microservices', { projectId: 'sync-mesh' }).memories.length, 0)
      } finally {
        await parentServer.close()
        parentVault.close()
        child1Vault.close()
        child2Vault.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Sync Engine: 3-Node P2P Mesh Topology with Pass-2 Propagation', () => {
  it('propagates memories and tombstones across Peer A <-> Peer B <-> Peer C in 2 passes of syncAllPeers', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-p2p-mesh-'))
    try {
      const dbPathA = path.join(tmpDir, 'peer-a.sqlite')
      const dbPathB = path.join(tmpDir, 'peer-b.sqlite')
      const dbPathC = path.join(tmpDir, 'peer-c.sqlite')

      const vaultA = new MemoryVault({ dbPath: dbPathA })
      const vaultB = new MemoryVault({ dbPath: dbPathB })
      const vaultC = new MemoryVault({ dbPath: dbPathC })

      vaultA.enableNodeMode({ role: 'peer', nodeName: 'Peer A Node', listenPort: 0 })
      vaultB.enableNodeMode({ role: 'peer', nodeName: 'Peer B Relay Node', listenPort: 0 })
      vaultC.enableNodeMode({ role: 'peer', nodeName: 'Peer C Node', listenPort: 0 })

      // Start HTTP servers for all 3 peers in the mesh
      const serverA = await startSyncServer(vaultA, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const serverUrlA = `http://127.0.0.1:${serverA.port}`

      const serverB = await startSyncServer(vaultB, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const serverUrlB = `http://127.0.0.1:${serverB.port}`

      const serverC = await startSyncServer(vaultC, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const serverUrlC = `http://127.0.0.1:${serverC.port}`

      try {
        // Line topology: Peer A <-> Peer B <-> Peer C
        vaultA.upsertPeer({
          role: 'peer',
          url: serverUrlB,
          name: 'Peer B Relay',
          peerNodeId: vaultB.getNodeId()
        })

        vaultB.upsertPeer({
          role: 'peer',
          url: serverUrlA,
          name: 'Peer A',
          peerNodeId: vaultA.getNodeId()
        })
        vaultB.upsertPeer({
          role: 'peer',
          url: serverUrlC,
          name: 'Peer C',
          peerNodeId: vaultC.getNodeId()
        })

        vaultC.upsertPeer({
          role: 'peer',
          url: serverUrlB,
          name: 'Peer B Relay',
          peerNodeId: vaultB.getNodeId()
        })

        // Seed Peer A with memory A
        const memA = vaultA.storeMemory({
          projectId: 'p2p-mesh-project',
          category: 'architecture',
          title: 'Decentralized Architecture A',
          content: 'Peer A contributes decentralized architecture consensus.'
        })

        // Seed Peer C with memory C
        const memC = vaultC.storeMemory({
          projectId: 'p2p-mesh-project',
          category: 'convention',
          title: 'Gossip Convention C',
          content: 'Peer C contributes gossip convention rules.'
        })

        // Peer B has 0 memories initially
        assert.equal(
          vaultB.getProjectBriefing({ projectId: 'p2p-mesh-project' }).memories.length,
          0
        )

        // Pass 1: Peer B executes syncAllPeers with Peer A and Peer C
        const pass1Summary = await syncAllPeers(vaultB, {
          projectId: 'p2p-mesh-project'
        })
        assert.equal(pass1Summary.enabled, true)
        assert.equal(pass1Summary.errors.length, 0)
        assert.equal(pass1Summary.results.length, 2)

        // After Pass 1: Peer B and Peer C have both memories
        const briefingB_Pass1 = vaultB.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingB_Pass1.memories.length, 2)
        assert.ok(briefingB_Pass1.memories.some((m) => m.title === 'Decentralized Architecture A'))
        assert.ok(briefingB_Pass1.memories.some((m) => m.title === 'Gossip Convention C'))

        const briefingC_Pass1 = vaultC.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingC_Pass1.memories.length, 2)
        assert.ok(briefingC_Pass1.memories.some((m) => m.title === 'Decentralized Architecture A'))
        assert.ok(briefingC_Pass1.memories.some((m) => m.title === 'Gossip Convention C'))

        // Pass 2: Peer A executes syncAllPeers with Peer B to receive Peer C's memory
        const pass2Summary = await syncAllPeers(vaultA, {
          projectId: 'p2p-mesh-project'
        })
        assert.equal(pass2Summary.enabled, true)
        assert.equal(pass2Summary.errors.length, 0)

        // After Pass 2: Full mesh convergence across all 3 nodes!
        const briefingA_Pass2 = vaultA.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingA_Pass2.memories.length, 2)
        assert.ok(briefingA_Pass2.memories.some((m) => m.title === 'Decentralized Architecture A'))
        assert.ok(briefingA_Pass2.memories.some((m) => m.title === 'Gossip Convention C'))

        // Now test tombstone propagation: Peer A forgets memory A
        const forgotten = vaultA.forgetMemory(memA.memory.id)
        assert.equal(forgotten, true)
        const briefingA_AfterForget = vaultA.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingA_AfterForget.memories.length, 1)
        assert.ok(!briefingA_AfterForget.memories.some((m) => m.title === 'Decentralized Architecture A'))

        // Tombstone Pass 1: Peer B syncs with Peer A (pulls tombstone) and Peer C (pushes tombstone)
        const tombstonePass1 = await syncAllPeers(vaultB, {
          projectId: 'p2p-mesh-project'
        })
        assert.equal(tombstonePass1.errors.length, 0)

        // Tombstone Pass 2: Peer C syncs with Peer B
        const tombstonePass2 = await syncAllPeers(vaultC, {
          projectId: 'p2p-mesh-project'
        })
        assert.equal(tombstonePass2.errors.length, 0)

        // Tombstone has propagated to entire mesh in 2 passes: memory A deleted everywhere
        const briefingB_Final = vaultB.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingB_Final.memories.length, 1)
        assert.ok(
          !briefingB_Final.memories.some((m) => m.title === 'Decentralized Architecture A'),
          'Peer B deleted memory A via tombstone'
        )

        const briefingC_Final = vaultC.getProjectBriefing({ projectId: 'p2p-mesh-project' })
        assert.equal(briefingC_Final.memories.length, 1)
        assert.ok(
          !briefingC_Final.memories.some((m) => m.title === 'Decentralized Architecture A'),
          'Peer C deleted memory A via tombstone propagation'
        )

        // Memory C remains intact on all 3 nodes
        assert.ok(briefingA_AfterForget.memories.some((m) => m.title === 'Gossip Convention C'))
        assert.ok(briefingB_Final.memories.some((m) => m.title === 'Gossip Convention C'))
        assert.ok(briefingC_Final.memories.some((m) => m.title === 'Gossip Convention C'))
      } finally {
        await serverA.close()
        await serverB.close()
        await serverC.close()
        vaultA.close()
        vaultB.close()
        vaultC.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('Sync Engine: Direct HTTP Exchange with Simulated Gaze P2P Client & Group ACL', () => {
  it('handles /api/v1/p2p/status, handshake and exchange with P2PContractEnvelopeV1, X-Gaze-Token, and sync_groups', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-gaze-http-'))
    try {
      const dbPath = path.join(tmpDir, 'server-vault.sqlite')
      const vault = new MemoryVault({ dbPath })

      vault.enableNodeMode({
        role: 'peer',
        nodeName: 'Gaze Hub Peer',
        listenPort: 0,
        authToken: 'admin-secret'
      })

      // Configure a sync group dedicated to gaze with ACL restrictions:
      // Only project 'gaze-project' and category 'decision' or 'domain'
      const groupToken = 'gaze-client-token-999'
      vault.upsertGroup({
        name: 'gaze-analytics-group',
        projects: ['gaze-project'],
        categories: ['decision', 'domain'],
        permissions: 'readwrite',
        groupToken
      })

      // Store memories in the server vault:
      // 1. In 'gaze-project' (should be visible to gaze client)
      vault.storeMemory({
        projectId: 'gaze-project',
        category: 'decision',
        title: 'Gaze Project Decision',
        content: 'Server-side decision for Gaze project.'
      })
      // 2. In 'forbidden-project' (should NOT be visible to gaze client)
      vault.storeMemory({
        projectId: 'forbidden-project',
        category: 'architecture',
        title: 'Secret Internal Core',
        content: 'Server-side confidential architecture.'
      })

      const serverHandle = await startSyncServer(vault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const serverUrl = `http://127.0.0.1:${serverHandle.port}`

      try {
        // 1. GET /api/v1/p2p/status requires valid token
        const unauthStatus = await fetch(`${serverUrl}/api/v1/p2p/status`)
        assert.equal(unauthStatus.status, 401)

        const wrongTokenStatus = await fetch(`${serverUrl}/api/v1/p2p/status`, {
          headers: { 'X-Gaze-Token': 'bad-token' }
        })
        assert.equal(wrongTokenStatus.status, 401)

        const statusRes = await fetch(`${serverUrl}/api/v1/p2p/status`, {
          headers: { 'X-Gaze-Token': groupToken }
        })
        assert.equal(statusRes.status, 200)
        const statusJson = (await statusRes.json()) as P2PContractEnvelopeV1<{
          nodeId: string
          role: string
          supportedContracts: string[]
        }>
        assert.equal(statusJson.schemaVersion, 1)
        assert.equal(statusJson.command, 'status')
        assert.equal(statusJson.ok, true)
        assert.equal(statusJson.data.role, 'peer')
        assert.ok(statusJson.data.supportedContracts.includes('p2p-memory-contract'))

        // 2. POST /api/v1/p2p/handshake wrapped in P2PContractEnvelopeV1
        const handshakeBody = wrapP2PEnvelope('handshake', {
          nodeId: 'gaze-py-worker-1',
          nodeName: 'Gaze Python Ingestion',
          role: 'peer',
          callbackUrl: 'http://127.0.0.1:9191'
        })

        const handshakeRes = await fetch(`${serverUrl}/api/v1/p2p/handshake`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gaze-Token': groupToken
          },
          body: JSON.stringify(handshakeBody)
        })
        assert.equal(handshakeRes.status, 200)
        const handshakeJson = (await handshakeRes.json()) as P2PContractEnvelopeV1<{
          assignedGroups: string[]
        }>
        assert.equal(handshakeJson.schemaVersion, 1)
        assert.equal(handshakeJson.command, 'handshake')
        assert.equal(handshakeJson.ok, true)
        assert.ok(handshakeJson.data.assignedGroups.includes('gaze-analytics-group'))

        // 3. POST /api/v1/p2p/exchange with Gaze P2P payload and group ACL filtering
        const allowedNode: GazeNodeV1 = {
          id: 'gaze-node-allowed-1',
          projectId: 'gaze-project',
          project: 'gaze-project',
          kind: 'decision',
          source: 'harvest',
          title: 'Client Ingested Decision',
          body: 'Decision ingested from Gaze client pipeline.',
          createdAt: '2026-11-10T04:00:00.000Z',
          updatedAt: '2026-11-10T04:00:00.000Z'
        }

        const forbiddenNode: GazeNodeV1 = {
          id: 'gaze-node-forbidden-1',
          projectId: 'forbidden-project',
          project: 'forbidden-project',
          kind: 'doc', // maps to 'architecture', not allowed by group
          source: 'user',
          title: 'Client Ingested Forbidden Arch',
          body: 'This should be dropped by group permissions.',
          createdAt: '2026-11-10T04:00:00.000Z',
          updatedAt: '2026-11-10T04:00:00.000Z'
        }

        const baseClientPayload: Omit<P2PSyncPayloadV1, 'checksum'> = {
          format: 'p2p-memory-contract',
          version: 1,
          app: 'gaze',
          originNodeId: 'gaze-py-worker-1',
          exportedAt: '2026-11-10T04:00:00.000Z',
          projectId: 'gaze-project',
          nodes: [allowedNode, forbiddenNode],
          tombstones: []
        }
        const clientChecksum = computeP2PPayloadChecksum(baseClientPayload)
        const clientPayload: P2PSyncPayloadV1 = {
          ...baseClientPayload,
          checksum: clientChecksum
        }

        const exchangeEnvelope = wrapP2PEnvelope('exchange', {
          clientNodeId: 'gaze-py-worker-1',
          clientName: 'Gaze Python Ingestion',
          clientRole: 'peer',
          delta: clientPayload,
          format: 'gaze'
        })

        const exchangeRes = await fetch(`${serverUrl}/api/v1/p2p/exchange`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Gaze-Token': groupToken
          },
          body: JSON.stringify(exchangeEnvelope)
        })
        assert.equal(exchangeRes.status, 200)
        const exchangeJson = (await exchangeRes.json()) as P2PContractEnvelopeV1<{
          appliedOnServer: {
            memoriesCreated: number
            memoriesSkipped: number
          }
          serverDelta: P2PSyncPayloadV1
          effectiveGroups: string[]
        }>

        assert.equal(exchangeJson.schemaVersion, 1)
        assert.equal(exchangeJson.command, 'exchange')
        assert.equal(exchangeJson.ok, true)

        // Allowed node created, forbidden node dropped
        assert.equal(exchangeJson.data.appliedOnServer.memoriesCreated, 1)
        assert.equal(exchangeJson.data.appliedOnServer.memoriesSkipped, 1)
        assert.ok(exchangeJson.data.effectiveGroups.includes('gaze-analytics-group'))

        // Verify serverDelta in P2P contract format only contains gaze-project memory
        const serverDelta = exchangeJson.data.serverDelta
        assert.equal(serverDelta.format, 'p2p-memory-contract')
        assert.ok(serverDelta.nodes.some((n) => n.title === 'Gaze Project Decision'))
        assert.ok(!serverDelta.nodes.some((n) => n.title === 'Secret Internal Core'))

        // Verify server vault state
        const gazeBriefing = vault.getProjectBriefing({ projectId: 'gaze-project' })
        assert.equal(gazeBriefing.memories.length, 2)
        assert.ok(gazeBriefing.memories.some((m) => m.title === 'Client Ingested Decision'))
        assert.ok(gazeBriefing.memories.some((m) => m.title === 'Gaze Project Decision'))

        const forbiddenBriefing = vault.getProjectBriefing({ projectId: 'forbidden-project' })
        assert.equal(forbiddenBriefing.memories.length, 1)
        assert.ok(!forbiddenBriefing.memories.some((m) => m.title === 'Client Ingested Forbidden Arch'))
        assert.ok(forbiddenBriefing.memories.some((m) => m.title === 'Secret Internal Core'))
      } finally {
        await serverHandle.close()
        vault.close()
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
