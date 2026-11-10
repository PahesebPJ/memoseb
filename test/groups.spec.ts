import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import type {
  GroupPermissionMode,
  MemoryCategory,
  SyncGroupRecord,
  UnassignedGroupPolicy
} from '../src/core/schema.ts'
import {
  performPeerHandshake,
  startSyncServer,
  syncAllPeers,
  syncWithPeer,
  type SyncServerHandle
} from '../src/core/sync.ts'
import { MemoryVault } from '../src/core/vault.ts'

describe('Sync Groups & ACL Permissions: Vault CRUD and Network Enforcement', () => {
  describe('MemoryVault Groups CRUD Operations', () => {
    it('creates groups with default options and normalizes group names', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-crud-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        const group = vault.upsertGroup({ name: 'Alpha Core Team' })
        assert.equal(group.name, 'alpha-core-team')
        assert.deepEqual(group.projects, ['*'])
        assert.deepEqual(group.categories, ['*'])
        assert.equal(group.permissions, 'readwrite')
        assert.equal(group.groupToken, null)
        assert.deepEqual(group.memberNodeIds, [])
        assert.ok(group.id)
        assert.ok(group.createdAt)
        assert.ok(group.updatedAt)

        // Lookup by normalized name and ID
        const byName = vault.getGroup('alpha-core-team')
        assert.ok(byName)
        assert.equal(byName.id, group.id)

        const byId = vault.getGroup(group.id)
        assert.ok(byId)
        assert.equal(byId.name, 'alpha-core-team')

        // Non-existent lookups
        assert.equal(vault.getGroup('non-existent'), null)
        assert.equal(vault.getGroup(''), null)
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('validates inputs and throws clear errors for invalid values', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-valid-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        assert.throws(
          () => vault.upsertGroup({ name: '' }),
          /Group name cannot be empty/
        )
        assert.throws(
          () => vault.upsertGroup({ name: '   ---   ' }),
          /Group name cannot be empty/
        )
        assert.throws(
          () =>
            vault.upsertGroup({
              name: 'invalid-cats',
              categories: ['invalid-cat' as unknown as MemoryCategory]
            }),
          /Invalid memory category/
        )
        assert.throws(
          () =>
            vault.upsertGroup({
              name: 'invalid-perm',
              permissions: 'superadmin' as unknown as GroupPermissionMode
            }),
          /Invalid group permission mode/
        )
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('updates existing group fields preserving unchanged values and clearing groupToken', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-update-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        const initial = vault.upsertGroup({
          name: 'beta-team',
          description: 'Initial beta team description',
          projects: ['proj-1', 'proj-2'],
          categories: ['architecture', 'bugfix'],
          permissions: 'readonly',
          groupToken: 'initial-beta-secret'
        })

        assert.equal(initial.name, 'beta-team')
        assert.equal(initial.description, 'Initial beta team description')
        assert.deepEqual(initial.projects, ['proj-1', 'proj-2'])
        assert.deepEqual(initial.categories, ['architecture', 'bugfix'])
        assert.equal(initial.permissions, 'readonly')
        assert.equal(initial.groupToken, 'initial-beta-secret')

        // Update description, permissions, and clear groupToken, leaving projects & categories unchanged
        const updated = vault.upsertGroup({
          name: 'beta-team',
          description: 'Updated beta team description',
          permissions: 'readwrite',
          groupToken: null
        })

        assert.equal(updated.id, initial.id)
        assert.equal(updated.name, 'beta-team')
        assert.equal(updated.description, 'Updated beta team description')
        assert.deepEqual(updated.projects, ['proj-1', 'proj-2'])
        assert.deepEqual(updated.categories, ['architecture', 'bugfix'])
        assert.equal(updated.permissions, 'readwrite')
        assert.equal(updated.groupToken, null)
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('manages group membership (addNodeToGroup and removeNodeFromGroup)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-members-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        const group = vault.upsertGroup({ name: 'infra-ops' })

        // Pre-register a peer in sync_peers to test automatic peer_node_id linking
        const peerNodeId = crypto.randomUUID()
        const registeredPeer = vault.upsertPeer({
          role: 'child',
          url: 'http://127.0.0.1:4040',
          name: 'Child-Infra-4040',
          peerNodeId
        })

        // La membresía de un peer registrado se guarda por su identidad local
        // (id y URL), nunca por el nodeId que declaró
        const afterAdd = vault.addNodeToGroup('infra-ops', 'http://127.0.0.1:4040')
        assert.ok(afterAdd.memberNodeIds.includes('http://127.0.0.1:4040'))
        assert.ok(afterAdd.memberNodeIds.includes(registeredPeer.id))
        assert.ok(!afterAdd.memberNodeIds.includes(peerNodeId))
        assert.deepEqual(vault.getPeerGroups([peerNodeId]), [])
        assert.deepEqual(vault.getPeerGroups(['Child-Infra-4040']), [])
        assert.equal(vault.getPeerGroups([registeredPeer.id])[0]?.name, 'infra-ops')

        // Adding arbitrary identifier
        const arbitraryNode = 'custom-worker-node-1'
        const afterSecondAdd = vault.addNodeToGroup(group.id, arbitraryNode)
        assert.ok(afterSecondAdd.memberNodeIds.includes(arbitraryNode))

        // Duplicate addition is idempotent
        const duplicateAdd = vault.addNodeToGroup('infra-ops', arbitraryNode)
        const occurrences = duplicateAdd.memberNodeIds.filter((id) => id === arbitraryNode)
        assert.equal(occurrences.length, 1)

        // Removing peer identifier removes related linked identifiers
        const afterRemove = vault.removeNodeFromGroup('infra-ops', 'http://127.0.0.1:4040')
        assert.ok(!afterRemove.memberNodeIds.includes('http://127.0.0.1:4040'))
        assert.ok(!afterRemove.memberNodeIds.includes(peerNodeId))
        assert.ok(afterRemove.memberNodeIds.includes(arbitraryNode))

        // Errors on non-existent group or empty node
        assert.throws(
          () => vault.addNodeToGroup('non-existent-group', 'node-1'),
          /Group "non-existent-group" not found/
        )
        assert.throws(
          () => vault.addNodeToGroup('infra-ops', '   '),
          /Peer identifier cannot be empty/
        )
        assert.throws(
          () => vault.removeNodeFromGroup('non-existent-group', 'node-1'),
          /Group "non-existent-group" not found/
        )
        assert.throws(
          () => vault.removeNodeFromGroup('infra-ops', '   '),
          /Peer identifier cannot be empty/
        )
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('lists groups ordered alphabetically and deletes group cascading member records', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-list-del-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        vault.upsertGroup({ name: 'zeta-team' })
        vault.upsertGroup({ name: 'alpha-team' })
        vault.upsertGroup({ name: 'gamma-team' })

        const groups = vault.listGroups()
        assert.equal(groups.length, 3)
        assert.equal(groups[0]!.name, 'alpha-team')
        assert.equal(groups[1]!.name, 'gamma-team')
        assert.equal(groups[2]!.name, 'zeta-team')

        vault.addNodeToGroup('gamma-team', 'node-gamma-1')

        // Delete group by name
        const deleted = vault.deleteGroup('gamma-team')
        assert.equal(deleted, true)
        assert.equal(vault.getGroup('gamma-team'), null)

        const remaining = vault.listGroups()
        assert.equal(remaining.length, 2)
        assert.ok(!remaining.some((g) => g.name === 'gamma-team'))

        // Deleting non-existent returns false
        assert.equal(vault.deleteGroup('non-existent'), false)
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('configures unassignedGroupPolicy (none vs all)', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-groups-policy-'))
      const dbPath = path.join(tmpDir, 'test.sqlite')
      const vault = new MemoryVault({ dbPath })

      try {
        assert.equal(vault.getNodeConfig().unassignedGroupPolicy, 'none')

        const cfgAll = vault.setUnassignedGroupPolicy('all')
        assert.equal(cfgAll.unassignedGroupPolicy, 'all')
        assert.equal(vault.getNodeConfig().unassignedGroupPolicy, 'all')

        const cfgNone = vault.setUnassignedGroupPolicy('none')
        assert.equal(cfgNone.unassignedGroupPolicy, 'none')
        assert.equal(vault.getNodeConfig().unassignedGroupPolicy, 'none')
      } finally {
        vault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('HTTP Sync Server Group ACL Enforcements', () => {
    it('enforces Project Isolation (grupo-x solo proyecto-x, grupo-y solo proyecto-y)', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-net-isolation-'))
      const parentDb = path.join(tmpDir, 'parent.sqlite')
      const childXDb = path.join(tmpDir, 'childX.sqlite')
      const childYDb = path.join(tmpDir, 'childY.sqlite')

      const parentVault = new MemoryVault({ dbPath: parentDb })
      const childXVault = new MemoryVault({ dbPath: childXDb })
      const childYVault = new MemoryVault({ dbPath: childYDb })

      parentVault.enableNodeMode({ role: 'parent', listenPort: 0, nodeName: 'Father-Node' })
      childXVault.enableNodeMode({ role: 'child', listenPort: 0, nodeName: 'Child-X-Node' })
      childYVault.enableNodeMode({ role: 'child', listenPort: 0, nodeName: 'Child-Y-Node' })

      // Father stores memories across three projects
      parentVault.storeMemory({
        projectId: 'proyecto-x',
        category: 'architecture',
        title: 'Project X Arch Spec',
        content: 'System architecture for project X only.'
      })
      parentVault.storeMemory({
        projectId: 'proyecto-y',
        category: 'architecture',
        title: 'Project Y Arch Spec',
        content: 'System architecture for project Y only.'
      })
      parentVault.storeMemory({
        projectId: 'proyecto-secreto',
        category: 'domain',
        title: 'Top Secret Domain Logic',
        content: 'Confidential corporate intelligence.'
      })

      // Father creates isolation groups
      parentVault.upsertGroup({
        name: 'grupo-x',
        projects: ['proyecto-x'],
        permissions: 'readwrite'
      })
      // La membresía se resuelve por el peer registrado localmente (no por el nodeId declarado)
      parentVault.upsertPeer({ role: 'child', url: 'http://127.0.0.1:41001', peerNodeId: childXVault.getNodeId() })
      parentVault.addNodeToGroup('grupo-x', childXVault.getNodeId())

      parentVault.upsertGroup({
        name: 'grupo-y',
        projects: ['proyecto-y'],
        permissions: 'readwrite'
      })
      // La membresía se resuelve por el peer registrado localmente (no por el nodeId declarado)
      parentVault.upsertPeer({ role: 'child', url: 'http://127.0.0.1:41002', peerNodeId: childYVault.getNodeId() })
      parentVault.addNodeToGroup('grupo-y', childYVault.getNodeId())

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      let childXServer: SyncServerHandle | null = null
      let childYServer: SyncServerHandle | null = null

      try {
        // Step 1: Child X syncs with Father -> receives ONLY proyecto-x memories
        const syncXRes1 = await syncWithPeer(childXVault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })
        assert.equal(syncXRes1.pulled.memoriesCreated, 1)

        const childXMemories = childXVault.exportSnapshot().memories
        assert.equal(childXMemories.length, 1)
        assert.equal(childXMemories[0]!.projectId, 'proyecto-x')
        assert.equal(childXMemories[0]!.title, 'Project X Arch Spec')

        // Verify Child X has 0 memories of proyecto-y or proyecto-secreto
        assert.equal(childXVault.exportSnapshot({ projectId: 'proyecto-y' }).memories.length, 0)
        assert.equal(childXVault.exportSnapshot({ projectId: 'proyecto-secreto' }).memories.length, 0)

        // Step 2: Child X stores locally one memory in proyecto-y and one in proyecto-x, then syncs with Father
        childXVault.storeMemory({
          projectId: 'proyecto-y',
          category: 'architecture',
          title: 'Child X Illegal Injection',
          content: 'Child X attempts to write into unauthorized project Y.'
        })
        childXVault.storeMemory({
          projectId: 'proyecto-x',
          category: 'convention',
          title: 'Child X Valid Convention',
          content: 'Child X legitimate contribution to project X.'
        })

        const syncXRes2 = await syncWithPeer(childXVault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })

        // Father accepts legitimate memory in proyecto-x, but skips/rejects injection in proyecto-y
        assert.equal(syncXRes2.pushed.memoriesCreated, 1)
        assert.equal(syncXRes2.pushed.memoriesSkipped, 1)

        // Verify Father vault: accepts valid memory in proyecto-x
        const fatherMemoriesX = parentVault.exportSnapshot({ projectId: 'proyecto-x' }).memories
        assert.equal(fatherMemoriesX.length, 2)
        assert.ok(fatherMemoriesX.some((m) => m.title === 'Child X Valid Convention'))

        // Verify Father vault: rejected illegal injection in proyecto-y
        const fatherMemoriesY = parentVault.exportSnapshot({ projectId: 'proyecto-y' }).memories
        assert.equal(fatherMemoriesY.length, 1)
        assert.equal(fatherMemoriesY[0]!.title, 'Project Y Arch Spec')
        assert.ok(!fatherMemoriesY.some((m) => m.title === 'Child X Illegal Injection'))

        // Step 3: Father executes syncAllPeers()
        // Spin up sync servers for both Child X and Child Y
        childXServer = await startSyncServer(childXVault, {
          host: '127.0.0.1',
          port: 0,
          enableUdpDiscovery: false
        })
        const childXUrl = `http://127.0.0.1:${childXServer.port}`

        childYServer = await startSyncServer(childYVault, {
          host: '127.0.0.1',
          port: 0,
          enableUdpDiscovery: false
        })
        const childYUrl = `http://127.0.0.1:${childYServer.port}`

        // Register children as peers on Father with their endpoints
        parentVault.removePeer('http://127.0.0.1:41001')
        parentVault.removePeer('http://127.0.0.1:41002')
        parentVault.upsertPeer({
          role: 'child',
          url: childXUrl,
          name: 'Child-X',
          peerNodeId: childXVault.getNodeId()
        })
        parentVault.addNodeToGroup('grupo-x', childXUrl)

        parentVault.upsertPeer({
          role: 'child',
          url: childYUrl,
          name: 'Child-Y',
          peerNodeId: childYVault.getNodeId()
        })
        parentVault.addNodeToGroup('grupo-y', childYUrl)

        const syncAllSummary = await syncAllPeers(parentVault)
        assert.equal(syncAllSummary.errors.length, 0)
        assert.equal(syncAllSummary.results.length, 2)

        // Child Y should receive ONLY proyecto-y memories (0 from proyecto-x, 0 from proyecto-secreto)
        const childYMemories = childYVault.exportSnapshot().memories
        assert.equal(childYMemories.length, 1)
        assert.equal(childYMemories[0]!.projectId, 'proyecto-y')
        assert.equal(childYMemories[0]!.title, 'Project Y Arch Spec')

        assert.equal(childYVault.exportSnapshot({ projectId: 'proyecto-x' }).memories.length, 0)
        assert.equal(childYVault.exportSnapshot({ projectId: 'proyecto-secreto' }).memories.length, 0)

        // Child X still only has proyecto-x memories (and local y), but 0 from proyecto-secreto
        assert.equal(childXVault.exportSnapshot({ projectId: 'proyecto-secreto' }).memories.length, 0)
      } finally {
        if (childXServer) await childXServer.close()
        if (childYServer) await childYServer.close()
        await parentServer.close()
        parentVault.close()
        childXVault.close()
        childYVault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('enforces Directional Permissions (readonly and writeonly) and Category filtering', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-net-perms-'))
      const parentDb = path.join(tmpDir, 'parent.sqlite')
      const childReadonlyDb = path.join(tmpDir, 'child-readonly.sqlite')
      const childWriteonlyDb = path.join(tmpDir, 'child-writeonly.sqlite')

      const parentVault = new MemoryVault({ dbPath: parentDb })
      const childReadonlyVault = new MemoryVault({ dbPath: childReadonlyDb })
      const childWriteonlyVault = new MemoryVault({ dbPath: childWriteonlyDb })

      parentVault.enableNodeMode({ role: 'parent', listenPort: 0, nodeName: 'Father-Node' })
      childReadonlyVault.enableNodeMode({ role: 'child', listenPort: 0, nodeName: 'Child-Readonly' })
      childWriteonlyVault.enableNodeMode({ role: 'child', listenPort: 0, nodeName: 'Child-Writeonly' })

      // Father stores diverse memories in target project and unrelated project
      const mArch = parentVault.storeMemory({
        projectId: 'core-platform',
        category: 'architecture',
        title: 'Core Platform Architecture',
        content: 'Immutable base architecture design.'
      })
      parentVault.storeMemory({
        projectId: 'core-platform',
        category: 'convention',
        title: 'Core Code Conventions',
        content: 'Linting, styling, and coding practices.'
      })
      parentVault.storeMemory({
        projectId: 'unrelated-project',
        category: 'architecture',
        title: 'Unrelated Architecture',
        content: 'Different domain architecture.'
      })

      // Setup readonly group restricted to 'architecture' category and 'core-platform' project
      parentVault.upsertGroup({
        name: 'core-readers',
        projects: ['core-platform'],
        categories: ['architecture'],
        permissions: 'readonly'
      })
      // La membresía se resuelve por el peer registrado localmente (no por el nodeId declarado)
      parentVault.upsertPeer({ role: 'child', url: 'http://127.0.0.1:41003', peerNodeId: childReadonlyVault.getNodeId() })
      parentVault.addNodeToGroup('core-readers', childReadonlyVault.getNodeId())

      // Setup writeonly group for telemetry / audit logging
      parentVault.upsertGroup({
        name: 'audit-writers',
        projects: ['core-platform'],
        permissions: 'writeonly'
      })
      // La membresía se resuelve por el peer registrado localmente (no por el nodeId declarado)
      parentVault.upsertPeer({ role: 'child', url: 'http://127.0.0.1:41004', peerNodeId: childWriteonlyVault.getNodeId() })
      parentVault.addNodeToGroup('audit-writers', childWriteonlyVault.getNodeId())

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      try {
        // --- READONLY & CATEGORY TEST ---
        // 1. Child Readonly pulls from Father
        const roSync1 = await syncWithPeer(childReadonlyVault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })

        // Should download ONLY the architecture memory in core-platform
        assert.equal(roSync1.pulled.memoriesCreated, 1)
        const roMemories = childReadonlyVault.exportSnapshot().memories
        assert.equal(roMemories.length, 1)
        assert.equal(roMemories[0]!.title, 'Core Platform Architecture')
        assert.equal(roMemories[0]!.category, 'architecture')
        assert.equal(roMemories[0]!.projectId, 'core-platform')

        // Conventions and other projects must NOT have been pulled
        assert.equal(childReadonlyVault.exportSnapshot({ projectId: 'unrelated-project' }).memories.length, 0)
        assert.ok(!roMemories.some((m) => m.category === 'convention'))

        // 2. Child Readonly attempts to push a new memory and forget existing memory
        childReadonlyVault.storeMemory({
          projectId: 'core-platform',
          category: 'architecture',
          title: 'Unauthorized Client Memory',
          content: 'Readonly node attempting to inject new content.'
        })

        const forgotten = childReadonlyVault.forgetMemory(mArch.memory.id)
        assert.equal(forgotten, true)

        const roSync2 = await syncWithPeer(childReadonlyVault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })

        // Father rejects pushes and tombstones from readonly node
        assert.equal(roSync2.pushed.memoriesCreated, 0)
        assert.equal(roSync2.pushed.memoriesSkipped, 1)

        // Father vault remains completely unaltered
        const fatherPlatformMemories = parentVault.exportSnapshot({ projectId: 'core-platform' }).memories
        assert.equal(fatherPlatformMemories.length, 2)
        assert.ok(
          fatherPlatformMemories.some((m) => m.title === 'Core Platform Architecture'),
          'Father memory must NOT be deleted by readonly tombstone'
        )
        assert.ok(fatherPlatformMemories.some((m) => m.title === 'Core Code Conventions'))
        assert.ok(
          !fatherPlatformMemories.some((m) => m.title === 'Unauthorized Client Memory'),
          'Father must NOT receive memory from readonly node'
        )

        // --- WRITEONLY TEST ---
        // Child Writeonly stores a memory and syncs
        childWriteonlyVault.storeMemory({
          projectId: 'core-platform',
          category: 'domain',
          title: 'Audit Log Node Event',
          content: 'Security event recorded by writeonly client.'
        })

        const woSync = await syncWithPeer(childWriteonlyVault, {
          peerUrl: parentUrl,
          peerRole: 'parent'
        })

        // Writeonly client pushes successfully, but pulls 0 memories
        assert.equal(woSync.pushed.memoriesCreated, 1)
        assert.equal(woSync.pulled.memoriesCreated, 0)

        // Father vault now contains the audit memory
        const fatherAuditMemories = parentVault.exportSnapshot({ projectId: 'core-platform' }).memories
        assert.ok(fatherAuditMemories.some((m) => m.title === 'Audit Log Node Event'))

        // Child Writeonly does NOT have Father's architecture or convention memories
        const childWoMemories = childWriteonlyVault.exportSnapshot().memories
        assert.equal(childWoMemories.length, 1)
        assert.equal(childWoMemories[0]!.title, 'Audit Log Node Event')
      } finally {
        await parentServer.close()
        parentVault.close()
        childReadonlyVault.close()
        childWriteonlyVault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('handles auto-enrollment with dedicated groupToken', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-net-group-token-'))
      const parentDb = path.join(tmpDir, 'parent.sqlite')
      const childAlphaDb = path.join(tmpDir, 'child-alpha.sqlite')

      const parentVault = new MemoryVault({ dbPath: parentDb })
      const childAlphaVault = new MemoryVault({ dbPath: childAlphaDb })

      const fatherMasterToken = 'father-master-secret-999'
      const alphaGroupToken = 'token-exclusivo-alpha'

      parentVault.enableNodeMode({
        role: 'parent',
        listenPort: 0,
        nodeName: 'Father-Node',
        authToken: fatherMasterToken
      })
      childAlphaVault.enableNodeMode({
        role: 'child',
        listenPort: 0,
        nodeName: 'Child-Alpha-AutoEnroll',
        authToken: null
      })

      // Father creates group with dedicated groupToken and isolation
      parentVault.upsertGroup({
        name: 'equipo-alpha',
        description: 'Team Alpha auto-enrolled group',
        projects: ['alpha-project'],
        permissions: 'readwrite',
        groupToken: alphaGroupToken
      })

      // Initially no members in equipo-alpha
      assert.deepEqual(parentVault.getGroup('equipo-alpha')?.memberNodeIds, [])

      // Father has memories in alpha-project and other-project
      parentVault.storeMemory({
        projectId: 'alpha-project',
        category: 'architecture',
        title: 'Alpha Team Specs',
        content: 'Alpha team architecture blueprint.'
      })
      parentVault.storeMemory({
        projectId: 'other-project',
        category: 'architecture',
        title: 'Other Team Specs',
        content: 'Unrelated team architecture blueprint.'
      })

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      try {
        // Child Alpha performs handshake using alphaGroupToken (not master token)
        const handshakeRes = await performPeerHandshake(childAlphaVault, {
          peerUrl: parentUrl,
          peerRole: 'parent',
          token: alphaGroupToken
        })

        assert.equal(handshakeRes.status, 'paired')
        assert.deepEqual(handshakeRes.assignedGroups, ['equipo-alpha'])

        // El token de grupo da acceso, pero el nodeId declarado en el cuerpo no se inscribe
        const groupAfterHandshake = parentVault.getGroup('equipo-alpha')
        assert.ok(groupAfterHandshake)
        assert.ok(!groupAfterHandshake.memberNodeIds.includes(childAlphaVault.getNodeId()))

        // Child Alpha syncs with Father
        const syncRes = await syncWithPeer(childAlphaVault, {
          peerUrl: parentUrl,
          peerRole: 'parent',
          token: alphaGroupToken
        })

        // Child Alpha receives ONLY alpha-project memories
        assert.equal(syncRes.pulled.memoriesCreated, 1)
        const childRecallAlpha = childAlphaVault.recallMemories('Alpha Team Specs', {
          projectId: 'alpha-project'
        })
        assert.equal(childRecallAlpha.memories.length, 1)

        const childRecallOther = childAlphaVault.recallMemories('Other Team Specs', {
          projectId: 'other-project'
        })
        assert.equal(childRecallOther.memories.length, 0)
      } finally {
        await parentServer.close()
        parentVault.close()
        childAlphaVault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('enforces unassignedGroupPolicy (none vs all) on authenticated unassigned nodes', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-net-unassigned-'))
      const parentDb = path.join(tmpDir, 'parent.sqlite')
      const unassignedChildDb = path.join(tmpDir, 'unassigned-child.sqlite')

      const parentVault = new MemoryVault({ dbPath: parentDb })
      const childVault = new MemoryVault({ dbPath: unassignedChildDb })

      const globalToken = 'master-cluster-token-12345'

      parentVault.enableNodeMode({
        role: 'parent',
        listenPort: 0,
        nodeName: 'Father-Node',
        authToken: globalToken
      })
      childVault.enableNodeMode({
        role: 'child',
        listenPort: 0,
        nodeName: 'Unassigned-Child',
        authToken: null
      })

      // Father creates a group so that groups exist on Father
      parentVault.upsertGroup({
        name: 'engineering',
        projects: ['shared-infra'],
        permissions: 'readwrite'
      })

      // Default unassigned policy is 'none'
      parentVault.setUnassignedGroupPolicy('none')

      parentVault.storeMemory({
        projectId: 'shared-infra',
        category: 'architecture',
        title: 'Cluster Topology',
        content: 'Overview of cluster network layout.'
      })

      childVault.storeMemory({
        projectId: 'shared-infra',
        category: 'bugfix',
        title: 'Emergency Hotfix',
        content: 'Fix for node connection timeouts.'
      })

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      try {
        // --- CASE 1: unassignedGroupPolicy = 'none' ---
        // Child connects with valid global token, but does not belong to any group
        const syncNoneRes = await syncWithPeer(childVault, {
          peerUrl: parentUrl,
          peerRole: 'parent',
          token: globalToken
        })

        // With policy 'none', cannot pull anything and cannot push anything
        assert.equal(syncNoneRes.pulled.memoriesCreated, 0)
        assert.equal(syncNoneRes.pushed.memoriesCreated, 0)
        assert.equal(syncNoneRes.pushed.memoriesSkipped, 1)

        // Father vault does not contain child's memory
        const fatherMemoriesNone = parentVault.exportSnapshot({ projectId: 'shared-infra' }).memories
        assert.equal(fatherMemoriesNone.length, 1)
        assert.equal(fatherMemoriesNone[0]!.title, 'Cluster Topology')
        assert.ok(!fatherMemoriesNone.some((m) => m.title === 'Emergency Hotfix'))

        // Child vault does not contain father's memory
        const childMemoriesNone = childVault.exportSnapshot({ projectId: 'shared-infra' }).memories
        assert.equal(childMemoriesNone.length, 1)
        assert.equal(childMemoriesNone[0]!.title, 'Emergency Hotfix')
        assert.ok(!childMemoriesNone.some((m) => m.title === 'Cluster Topology'))

        // --- CASE 2: unassignedGroupPolicy = 'all' ---
        parentVault.setUnassignedGroupPolicy('all')

        const syncAllRes = await syncWithPeer(childVault, {
          peerUrl: parentUrl,
          peerRole: 'parent',
          token: globalToken,
          full: true
        })

        // With policy 'all', unassigned node can push and pull unrestricted
        assert.equal(syncAllRes.pulled.memoriesCreated, 1)
        assert.equal(syncAllRes.pushed.memoriesCreated, 1)

        // Verify Father has child's memory
        const fatherMemoriesAll = parentVault.exportSnapshot({ projectId: 'shared-infra' }).memories
        assert.equal(fatherMemoriesAll.length, 2)
        assert.ok(fatherMemoriesAll.some((m) => m.title === 'Emergency Hotfix'))
        assert.ok(fatherMemoriesAll.some((m) => m.title === 'Cluster Topology'))

        // Verify Child has Father's memory
        const childMemoriesAll = childVault.exportSnapshot({ projectId: 'shared-infra' }).memories
        assert.equal(childMemoriesAll.length, 2)
        assert.ok(childMemoriesAll.some((m) => m.title === 'Emergency Hotfix'))
        assert.ok(childMemoriesAll.some((m) => m.title === 'Cluster Topology'))
      } finally {
        await parentServer.close()
        parentVault.close()
        childVault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    })

    it('prevents privilege escalation when a groupToken holder spoofs an admin clientNodeId', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-acl-anti-spoof-'))
      const guestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-acl-guest-spoof-'))
      const parentVault = new MemoryVault({ dbPath: path.join(tmpDir, 'parent.sqlite') })
      const guestVault = new MemoryVault({ dbPath: path.join(guestDir, 'guest.sqlite') })

      parentVault.enableNodeMode({
        role: 'parent',
        nodeName: 'Parent',
        authToken: 'master-admin-secret',
        autoSync: false,
        lanDiscovery: false
      })
      parentVault.storeMemory({
        projectId: 'classified-project',
        category: 'architecture',
        title: 'Classified Blueprint',
        content: 'Top secret architecture details.'
      })
      parentVault.storeMemory({
        projectId: 'public-docs',
        category: 'domain',
        title: 'Public FAQ',
        content: 'Publicly visible documentation.'
      })

      parentVault.upsertGroup({
        name: 'admin-group',
        projects: ['classified-project', 'public-docs'],
        permissions: 'readwrite'
      })
      parentVault.addNodeToGroup('admin-group', 'trusted-admin-node-id')

      parentVault.upsertGroup({
        name: 'guest-group',
        projects: ['public-docs'],
        permissions: 'readonly',
        groupToken: 'guest-only-token'
      })

      // Spoof guest node ID to match 'trusted-admin-node-id'
      guestVault.enableNodeMode({
        role: 'child',
        nodeName: 'Spoofing-Guest',
        authToken: 'guest-only-token',
        autoSync: false,
        lanDiscovery: false
      })
      ;(guestVault as unknown as { db: { prepare: (sql: string) => { run: (...args: string[]) => void } } }).db
        .prepare(`UPDATE node_meta SET value = ? WHERE key = 'node.id'`)
        .run('trusted-admin-node-id')

      const parentServer = await startSyncServer(parentVault, {
        host: '127.0.0.1',
        port: 0,
        enableUdpDiscovery: false
      })
      const parentUrl = `http://127.0.0.1:${parentServer.port}`

      try {
        const res = await syncWithPeer(guestVault, {
          peerUrl: parentUrl,
          peerRole: 'parent',
          token: 'guest-only-token'
        })
        assert.equal(res.pulled.memoriesCreated, 1)
        const guestClassified = guestVault.exportSnapshot({
          projectId: 'classified-project'
        }).memories
        assert.equal(guestClassified.length, 0)
      } finally {
        await parentServer.close()
        parentVault.close()
        guestVault.close()
        fs.rmSync(tmpDir, { recursive: true, force: true })
        fs.rmSync(guestDir, { recursive: true, force: true })
      }
    })
  })
})
