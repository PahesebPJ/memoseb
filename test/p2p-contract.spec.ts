import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  computeP2PPayloadChecksum,
  GAZE_EDGE_KINDS,
  GAZE_KINDS,
  GAZE_SOURCES,
  gazeNodeToMemory,
  isGazeEdgeKind,
  isGazeKind,
  isGazeSource,
  isP2PContractPayload,
  memoryToGazeNode,
  p2pPayloadToSnapshot,
  readP2PPayloadFile,
  snapshotToP2PPayload,
  unwrapP2PEnvelope,
  verifyP2PPayload,
  wrapP2PEnvelope,
  writeP2PPayloadFile,
  type GazeNodeV1,
  type P2PSyncPayloadV1
} from '../src/core/p2p-contract.ts'
import {
  isNodeRole,
  isPeerRole,
  normalizeNodeRole,
  normalizePeerRole,
  parseNodeRoleInput,
  parsePeerRoleInput,
  type MemoryCategory
} from '../src/core/schema.ts'
import {
  computeSnapshotChecksum,
  readSnapshotFile,
  writeSnapshotFile,
  type VaultSnapshotV1
} from '../src/core/snapshot.ts'
import {
  discoverLanNodes,
  performPeerHandshake,
  startSyncServer,
  syncWithPeer
} from '../src/core/sync.ts'
import { MemoryVault, type MemoryRecord } from '../src/core/vault.ts'

describe('P2P Contract & Gaze Compatibility Engine', () => {
  it('validates schema roles and normalization helpers including p2p alias', () => {
    assert.equal(isNodeRole('standalone'), true)
    assert.equal(isNodeRole('parent'), true)
    assert.equal(isNodeRole('child'), true)
    assert.equal(isNodeRole('peer'), true)
    assert.equal(isNodeRole('invalid'), false)

    assert.equal(isPeerRole('parent'), true)
    assert.equal(isPeerRole('child'), true)
    assert.equal(isPeerRole('peer'), true)
    assert.equal(isPeerRole('standalone'), false)

    assert.equal(normalizeNodeRole('p2p'), 'peer')
    assert.equal(normalizeNodeRole('P2P'), 'peer')
    assert.equal(normalizeNodeRole('peer'), 'peer')
    assert.equal(normalizeNodeRole('child'), 'child')
    assert.equal(normalizeNodeRole('parent'), 'parent')
    assert.equal(normalizeNodeRole('unknown'), 'standalone')

    assert.equal(normalizePeerRole('p2p'), 'peer')
    assert.equal(normalizePeerRole('P2P'), 'peer')
    assert.equal(normalizePeerRole('peer'), 'peer')
    assert.equal(normalizePeerRole('child'), 'child')
    assert.equal(normalizePeerRole('unknown'), 'peer')

    assert.equal(parseNodeRoleInput('p2p'), 'peer')
    assert.equal(parseNodeRoleInput('peer'), 'peer')
    assert.equal(parseNodeRoleInput('child'), 'child')
    assert.equal(parseNodeRoleInput('parent'), 'parent')
    assert.equal(parseNodeRoleInput('invalid'), null)

    assert.equal(parsePeerRoleInput('p2p'), 'peer')
    assert.equal(parsePeerRoleInput('peer'), 'peer')
    assert.equal(parsePeerRoleInput('child'), 'child')
    assert.equal(parsePeerRoleInput('parent'), 'parent')
    assert.equal(parsePeerRoleInput('invalid'), null)
  })

  it('validates Gaze enum constants and type guards', () => {
    for (const k of GAZE_KINDS) {
      assert.equal(isGazeKind(k), true)
    }
    assert.equal(isGazeKind('unknown_kind'), false)

    for (const s of GAZE_SOURCES) {
      assert.equal(isGazeSource(s), true)
    }
    assert.equal(isGazeSource('custom_agent'), false)

    for (const e of GAZE_EDGE_KINDS) {
      assert.equal(isGazeEdgeKind(e), true)
    }
    assert.equal(isGazeEdgeKind('unknown_edge'), false)
  })

  it('performs lossless roundtrip conversion for all 5 memoseb categories', () => {
    const categories: MemoryCategory[] = [
      'convention',
      'decision',
      'architecture',
      'domain',
      'bugfix'
    ]

    for (const category of categories) {
      const original: MemoryRecord = {
        id: `mem-${category}-1`,
        projectId: 'project-test',
        category,
        title: `Test Title for ${category}`,
        content: `Detailed body content for category ${category}.`,
        tags: ['alpha', 'beta', 'gaze:edge:target-node-99:link:0.8'],
        sourceAgent: 'developer',
        contentHash: 'hash-abc-123',
        tokenCount: 42,
        importance: 0.95,
        accessCount: 15,
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T01:00:00.000Z'
      }

      const gazeNode = memoryToGazeNode(original)
      assert.equal(gazeNode.id, original.id)
      assert.equal(gazeNode.projectId, original.projectId)
      assert.equal(gazeNode.title, original.title)
      assert.equal(gazeNode.body, original.content)
      assert.equal(gazeNode.pinned, true)
      assert.equal(gazeNode.hits, 15)
      assert.ok(Array.isArray(gazeNode.edges))
      assert.equal(gazeNode.edges?.length, 1)
      assert.equal(gazeNode.edges?.[0]?.targetId, 'target-node-99')

      const recovered = gazeNodeToMemory(gazeNode, 'project-test')
      assert.equal(recovered.id, original.id)
      assert.equal(recovered.projectId, original.projectId)
      assert.equal(recovered.category, original.category)
      assert.equal(recovered.title, original.title)
      assert.equal(recovered.content, original.content)
      assert.equal(recovered.sourceAgent, original.sourceAgent)
      assert.equal(recovered.importance, original.importance)
      assert.equal(recovered.accessCount, original.accessCount)
      assert.equal(recovered.tokenCount, original.tokenCount)
      assert.ok(recovered.tags.includes('alpha'))
      assert.ok(recovered.tags.includes('beta'))
      assert.ok(recovered.tags.some((t) => t.startsWith('gaze:edge:target-node-99:link')))
    }
  })

  it('converts native Gaze nodes with various kinds without memoseb:category', () => {
    const nativeNodes: Array<{ kind: GazeNodeV1['kind']; expectedCategory: MemoryCategory }> = [
      { kind: 'rule', expectedCategory: 'convention' },
      { kind: 'decision', expectedCategory: 'decision' },
      { kind: 'issue', expectedCategory: 'bugfix' },
      { kind: 'doc', expectedCategory: 'architecture' },
      { kind: 'meeting', expectedCategory: 'decision' },
      { kind: 'fact', expectedCategory: 'domain' },
      { kind: 'memory', expectedCategory: 'domain' },
      { kind: 'entry', expectedCategory: 'domain' }
    ]

    for (const { kind, expectedCategory } of nativeNodes) {
      const node: GazeNodeV1 = {
        id: `gaze-${kind}-node`,
        kind,
        source: 'harvest',
        title: `Native ${kind}`,
        body: `Body of ${kind}`,
        pinned: true,
        createdAt: '2026-11-10T02:00:00.000Z',
        updatedAt: '2026-11-10T02:30:00.000Z',
        hits: 7,
        tags: ['native-tag']
      }

      const mem = gazeNodeToMemory(node, 'proj-default')
      assert.equal(mem.category, expectedCategory)
      assert.equal(mem.importance, 0.9)
      assert.equal(mem.accessCount, 7)
      assert.ok(mem.tags.includes(`gaze:kind:${kind}`))
      assert.ok(mem.tags.includes('gaze:source:harvest'))
      assert.ok(mem.tags.includes('native-tag'))
    }
  })

  it('computes and validates deterministic SHA-256 checksums and rejects corrupted payloads', () => {
    const memory: MemoryRecord = {
      id: 'mem-checksum-1',
      projectId: 'proj-chk',
      category: 'decision',
      title: 'Checksum Test',
      content: 'Content test',
      tags: ['tag1'],
      sourceAgent: 'user',
      contentHash: 'hash1',
      tokenCount: 5,
      importance: 0.8,
      accessCount: 2,
      createdAt: '2026-11-10T00:00:00.000Z',
      updatedAt: '2026-11-10T00:00:00.000Z'
    }

    const gazeNode = memoryToGazeNode(memory)
    const basePayload: Omit<P2PSyncPayloadV1, 'checksum'> = {
      format: 'p2p-memory-contract',
      version: 1,
      app: 'memoseb',
      originNodeId: 'node-chk-1',
      exportedAt: '2026-11-10T00:00:00.000Z',
      projectId: 'proj-chk',
      nodes: [gazeNode],
      tombstones: []
    }

    const checksum = computeP2PPayloadChecksum(basePayload)
    const payload: P2PSyncPayloadV1 = { ...basePayload, checksum }

    assert.equal(isP2PContractPayload(payload), true)
    const verified = verifyP2PPayload(payload)
    assert.equal(verified.checksum, checksum)

    const corrupted: P2PSyncPayloadV1 = { ...payload, checksum: 'bad-checksum-deadbeef' }
    assert.throws(() => verifyP2PPayload(corrupted), /checksum mismatch/)
  })

  it('wraps and unwraps P2P contract envelopes', () => {
    const data = { ping: 'pong', count: 123 }
    const envelope = wrapP2PEnvelope('test-cmd', data)
    assert.equal(envelope.schemaVersion, 1)
    assert.equal(envelope.ok, true)
    assert.equal(envelope.command, 'test-cmd')
    assert.deepEqual(envelope.data, data)

    const unwrapped = unwrapP2PEnvelope(envelope)
    assert.deepEqual(unwrapped, data)

    const plain = { hello: 'world' }
    assert.deepEqual(unwrapP2PEnvelope(plain), plain)
  })

  it('converts VaultSnapshotV1 to P2PSyncPayloadV1 and back transparently', () => {
    const baseSnapshot: Omit<VaultSnapshotV1, 'checksum'> = {
      format: 'memoseb-snapshot',
      version: 1,
      originNodeId: 'node-roundtrip',
      exportedAt: '2026-11-10T00:00:00.000Z',
      projectFilter: 'proj-roundtrip',
      projects: [
        {
          id: 'proj-roundtrip',
          name: 'Project Roundtrip',
          rootPath: '/path/to/proj',
          updatedAt: '2026-11-10T00:00:00.000Z'
        }
      ],
      memories: [
        {
          id: 'mem-rt-1',
          projectId: 'proj-roundtrip',
          category: 'architecture',
          title: 'RT Arch',
          content: 'RT Arch Content',
          tags: ['arch'],
          sourceAgent: 'claude',
          contentHash: 'hash-rt-1',
          tokenCount: 10,
          importance: 0.9,
          accessCount: 4,
          createdAt: '2026-11-10T00:00:00.000Z',
          updatedAt: '2026-11-10T00:00:00.000Z'
        }
      ],
      tombstones: [
        {
          memoryId: 'mem-deleted-1',
          projectId: 'proj-roundtrip',
          contentHash: 'hash-deleted-1',
          deletedAt: '2026-11-10T00:05:00.000Z',
          originNodeId: 'node-roundtrip'
        }
      ]
    }
    const checksum = computeSnapshotChecksum(baseSnapshot)
    const snapshot: VaultSnapshotV1 = { ...baseSnapshot, checksum }

    const p2pPayload = snapshotToP2PPayload(snapshot)
    assert.equal(p2pPayload.format, 'p2p-memory-contract')
    assert.equal(p2pPayload.nodes.length, 1)
    assert.equal(p2pPayload.tombstones.length, 1)

    const recoveredSnapshot = p2pPayloadToSnapshot(p2pPayload)
    assert.equal(recoveredSnapshot.format, 'memoseb-snapshot')
    assert.equal(recoveredSnapshot.memories.length, 1)
    assert.equal(recoveredSnapshot.memories[0]?.id, 'mem-rt-1')
    assert.equal(recoveredSnapshot.memories[0]?.category, 'architecture')
    assert.equal(recoveredSnapshot.tombstones.length, 1)
    assert.equal(recoveredSnapshot.tombstones[0]?.memoryId, 'mem-deleted-1')
  })

  it('reads P2P payloads transparently through readSnapshotFile and writes P2P payload files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-p2p-test-'))
    try {
      const memory: MemoryRecord = {
        id: 'mem-file-1',
        projectId: 'proj-file',
        category: 'convention',
        title: 'File Test',
        content: 'File content',
        tags: ['file-tag'],
        sourceAgent: 'user',
        contentHash: 'hash-file',
        tokenCount: 8,
        importance: 0.7,
        accessCount: 1,
        createdAt: '2026-11-10T00:00:00.000Z',
        updatedAt: '2026-11-10T00:00:00.000Z'
      }

      const gazeNode = memoryToGazeNode(memory)
      const basePayload: Omit<P2PSyncPayloadV1, 'checksum'> = {
        format: 'p2p-memory-contract',
        version: 1,
        app: 'memoseb',
        originNodeId: 'node-file',
        exportedAt: '2026-11-10T00:00:00.000Z',
        projectId: 'proj-file',
        nodes: [gazeNode],
        tombstones: []
      }
      const checksum = computeP2PPayloadChecksum(basePayload)
      const p2pPayload: P2PSyncPayloadV1 = { ...basePayload, checksum }

      const filePath = path.join(tmpDir, 'gaze-bundle.json')
      writeP2PPayloadFile(filePath, p2pPayload)

      const readBackP2P = readP2PPayloadFile(filePath)
      assert.equal(readBackP2P.checksum, checksum)

      // Transparent read through readSnapshotFile
      const asSnapshot = readSnapshotFile(filePath)
      assert.equal(asSnapshot.format, 'memoseb-snapshot')
      assert.equal(asSnapshot.memories.length, 1)
      assert.equal(asSnapshot.memories[0]?.id, 'mem-file-1')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('handles live HTTP P2P status, handshake and exchange between peer nodes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-p2p-http-'))
    const dbPathA = path.join(tmpDir, 'vault-a.db')
    const dbPathB = path.join(tmpDir, 'vault-b.db')

    const vaultA = new MemoryVault({ dbPath: dbPathA })
    const vaultB = new MemoryVault({ dbPath: dbPathB })

    try {
      vaultA.enableNodeMode({
        role: 'peer',
        nodeName: 'Peer A Node',
        authToken: 'secret-p2p-token'
      })
      vaultB.enableNodeMode({
        role: 'peer',
        nodeName: 'Peer B Node',
        authToken: 'secret-p2p-token'
      })

      // Store a memory in Peer A
      vaultA.storeMemory({
        projectId: 'proj-p2p',
        category: 'decision',
        title: 'P2P Mesh Consensus',
        content: 'Decided on decentralized peer gossip with LWW.'
      })

      const serverHandleA = await startSyncServer(vaultA, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })

      const serverUrlA = `http://127.0.0.1:${serverHandleA.port}`

      // Test GET /api/v1/p2p/status with X-Gaze-Token
      const statusRes = await fetch(`${serverUrlA}/api/v1/p2p/status`, {
        headers: {
          'X-Gaze-Token': 'secret-p2p-token'
        }
      })
      assert.equal(statusRes.status, 200)
      const statusJson = (await statusRes.json()) as any
      assert.equal(statusJson.schemaVersion, 1)
      assert.equal(statusJson.command, 'status')
      assert.equal(statusJson.data.role, 'peer')
      assert.equal(statusJson.data.nodeName, 'Peer A Node')

      // Perform handshake from Peer B to Peer A
      const handshake = await performPeerHandshake(vaultB, {
        peerUrl: serverUrlA,
        peerRole: 'peer',
        token: 'secret-p2p-token'
      })
      assert.equal(handshake.status, 'paired')
      assert.equal(handshake.peerRole, 'peer')

      // Synchronize Peer B with Peer A using contract: 'p2p'
      const syncResult = await syncWithPeer(vaultB, {
        peerUrl: serverUrlA,
        peerRole: 'peer',
        token: 'secret-p2p-token',
        contract: 'p2p'
      })

      assert.equal(syncResult.pulled.memoriesCreated, 1)

      // Verify Peer B now has the memory from Peer A
      const recallB = vaultB.recallMemories('decentralized', { projectId: 'proj-p2p' })
      assert.equal(recallB.memories.length, 1)
      assert.equal(recallB.memories[0]?.title, 'P2P Mesh Consensus')

      await serverHandleA.close()
    } finally {
      vaultA.close()
      vaultB.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
