import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  computeSnapshotChecksum,
  readSnapshotFile,
  verifySnapshot,
  writeSnapshotFile,
  type VaultSnapshotV1
} from '../src/core/snapshot.ts'
import { MemoryVault } from '../src/core/vault.ts'

describe('Vault Snapshot Engine: Export, Import, Tamper Detection, and Merging Strategies', () => {
  let tmpDir: string
  let vaultA: MemoryVault
  let dbPathA: string
  let vaultB: MemoryVault
  let dbPathB: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-snapshot-spec-'))
    dbPathA = path.join(tmpDir, 'vault-a.sqlite')
    dbPathB = path.join(tmpDir, 'vault-b.sqlite')
    vaultA = new MemoryVault({ dbPath: dbPathA })
    vaultB = new MemoryVault({ dbPath: dbPathB })
  })

  afterEach(() => {
    vaultA.close()
    vaultB.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exports full vault snapshot with multiple projects, memories, and tombstones to JSON file', () => {
    // 1. Populate multiple projects and global memories in vaultA
    const memAlpha1 = vaultA.storeMemory({
      projectId: 'project-alpha',
      category: 'architecture',
      title: 'Alpha Architecture Hexagonal',
      content: 'Core domain remains decoupled from SQLite and HTTP drivers via port interfaces.',
      tags: ['hexagonal', 'architecture', 'alpha'],
      sourceAgent: 'architect',
      importance: 0.9
    })

    const memAlpha2 = vaultA.storeMemory({
      projectId: 'project-alpha',
      category: 'convention',
      title: 'Alpha Commit Hygiene',
      content: 'Never include AI author signatures in conventional commit messages.',
      tags: ['git', 'conventions'],
      sourceAgent: 'developer',
      importance: 0.6
    })

    vaultA.storeMemory({
      projectId: 'project-beta',
      category: 'decision',
      title: 'Beta Fastify Server',
      content: 'Use high-performance HTTP engine for edge proxy nodes.',
      tags: ['http', 'edge'],
      sourceAgent: 'devops',
      importance: 0.8
    })

    vaultA.storeMemory({
      projectId: 'global',
      category: 'domain',
      title: 'Global Token Budgeting',
      content: 'Truncate context when briefing exceeds 1200 tokens.',
      tags: ['budget', 'tokens'],
      sourceAgent: 'architect',
      importance: 0.85
    })

    // 2. Delete one memory to generate a tombstone
    const forgotten = vaultA.forgetMemory(memAlpha2.memory.id)
    assert.equal(forgotten, true)

    // 3. Export snapshot
    const snapshot = vaultA.exportSnapshot()

    assert.equal(snapshot.format, 'memoseb-snapshot')
    assert.equal(snapshot.version, 1)
    assert.equal(snapshot.originNodeId, vaultA.getNodeId())
    assert.equal(snapshot.projectFilter, null)
    assert.ok(snapshot.exportedAt.length > 0)
    assert.equal(typeof snapshot.checksum, 'string')
    assert.equal(snapshot.checksum.length, 64)

    // Verified projects, memories, and tombstones counts
    assert.ok(snapshot.projects.length >= 2)
    assert.equal(snapshot.memories.length, 3)
    assert.equal(snapshot.tombstones.length, 1)
    assert.equal(snapshot.tombstones[0]?.memoryId, memAlpha2.memory.id)
    assert.equal(snapshot.tombstones[0]?.projectId, 'project-alpha')
    assert.equal(snapshot.tombstones[0]?.originNodeId, vaultA.getNodeId())

    // 4. Write snapshot file to disk
    const snapshotFilePath = path.join(tmpDir, 'backup', 'vault-a-snapshot.json')
    const writtenPath = writeSnapshotFile(snapshotFilePath, snapshot)
    assert.equal(fs.existsSync(writtenPath), true)

    // 5. Read back snapshot file from disk
    const readSnapshot = readSnapshotFile(writtenPath)
    assert.deepEqual(readSnapshot, snapshot)
  })

  it('detects tamper or corruption in snapshot file and validates checksum integrity', () => {
    // Populate vaultA with a memory
    vaultA.storeMemory({
      projectId: 'project-secure',
      category: 'decision',
      title: 'HMAC Authentication Protocol',
      content: 'Sign UDP discovery datagrams using SHA-256 HMAC tokens.',
      tags: ['security', 'hmac']
    })

    const snapshot = vaultA.exportSnapshot()
    const snapshotFilePath = path.join(tmpDir, 'tamper-test.json')
    writeSnapshotFile(snapshotFilePath, snapshot)

    // 1. Verify valid snapshot passes
    const verified = verifySnapshot(snapshot)
    assert.equal(verified.checksum, snapshot.checksum)

    // 2. Tamper memory content -> verifySnapshot throws checksum mismatch
    const tamperedContent: VaultSnapshotV1 = JSON.parse(JSON.stringify(snapshot))
    tamperedContent.memories[0]!.content = 'Tampered content: backdoor inserted!'
    assert.throws(
      () => verifySnapshot(tamperedContent),
      /Snapshot checksum mismatch/
    )

    // 3. Tamper memory title -> verifySnapshot throws checksum mismatch
    const tamperedTitle: VaultSnapshotV1 = JSON.parse(JSON.stringify(snapshot))
    tamperedTitle.memories[0]!.title = 'Tampered Title'
    assert.throws(
      () => verifySnapshot(tamperedTitle),
      /Snapshot checksum mismatch/
    )

    // 4. Tamper checksum directly
    const tamperedChecksum: VaultSnapshotV1 = JSON.parse(JSON.stringify(snapshot))
    tamperedChecksum.checksum = '0000000000000000000000000000000000000000000000000000000000000000'
    assert.throws(
      () => verifySnapshot(tamperedChecksum),
      /Snapshot checksum mismatch/
    )

    // 5. Tamper tombstones array
    const tamperedTombstones: VaultSnapshotV1 = JSON.parse(JSON.stringify(snapshot))
    tamperedTombstones.tombstones.push({
      memoryId: 'fake-id',
      projectId: 'project-secure',
      contentHash: 'fake-hash',
      deletedAt: new Date().toISOString(),
      originNodeId: 'node-x'
    })
    assert.throws(
      () => verifySnapshot(tamperedTombstones),
      /Snapshot checksum mismatch/
    )

    // 6. Invalid format
    const invalidFormat = { ...snapshot, format: 'malicious-format' }
    assert.throws(
      () => verifySnapshot(invalidFormat),
      /Invalid snapshot format: expected "memoseb-snapshot"/
    )

    // 7. Invalid version
    const invalidVersion = { ...snapshot, version: 99 }
    assert.throws(
      () => verifySnapshot(invalidVersion),
      /Unsupported snapshot version: expected 1/
    )

    // 8. Corrupt non-JSON file in readSnapshotFile
    const corruptJsonPath = path.join(tmpDir, 'corrupt.json')
    fs.writeFileSync(corruptJsonPath, '{ invalid json: [missing bracket', 'utf-8')
    assert.throws(
      () => readSnapshotFile(corruptJsonPath),
      /Failed to parse snapshot JSON/
    )

    // 9. Non-existent file in readSnapshotFile
    assert.throws(
      () => readSnapshotFile(path.join(tmpDir, 'does-not-exist.json')),
      /Snapshot file does not exist/
    )
  })

  it('imports snapshot into empty vault and accurately recovers memories via lexical FTS5 and vector similarity search', () => {
    // 1. Create rich memories in vaultA
    vaultA.storeMemory({
      projectId: 'distributed-ledger',
      category: 'architecture',
      title: 'Deterministic FNV-1a Feature Hashing',
      content: 'Offline zero-dependency 64-dimensional float32 embeddings using deterministic token hashing.',
      tags: ['fnv1a', 'vector', 'embeddings'],
      sourceAgent: 'architect',
      importance: 0.95
    })

    vaultA.storeMemory({
      projectId: 'distributed-ledger',
      category: 'decision',
      title: 'Raft Consensus Protocol for Clustering',
      content: 'Quorum leader election algorithm ensuring consistency during network partitions.',
      tags: ['raft', 'consensus', 'clustering'],
      sourceAgent: 'architect',
      importance: 0.85
    })

    const snapshot = vaultA.exportSnapshot()

    // 2. Confirm vaultB is initially empty
    const statsBefore = vaultB.getStats()
    assert.equal(statsBefore.memoryCount, 0)
    assert.equal(statsBefore.projectCount, 0)
    assert.equal(statsBefore.vectorCount, 0)

    // 3. Import snapshot into vaultB
    const importResult = vaultB.importSnapshot(snapshot)
    assert.equal(importResult.strategy, 'merge')
    assert.equal(importResult.memoriesCreated, 2)
    assert.equal(importResult.memoriesUpdated, 0)
    assert.equal(importResult.memoriesSkipped, 0)

    const statsAfter = vaultB.getStats()
    assert.equal(statsAfter.memoryCount, 2)
    assert.equal(statsAfter.vectorCount, 2)
    assert.ok(statsAfter.projectCount >= 1)

    // 4. Test Lexical FTS5 retrieval on imported vaultB
    const lexicalRecall = vaultB.recallMemories('deterministic FNV-1a hashing', {
      projectId: 'distributed-ledger'
    })
    assert.ok(lexicalRecall.memories.length >= 1)
    const topLexical = lexicalRecall.memories[0]!
    assert.equal(topLexical.title, 'Deterministic FNV-1a Feature Hashing')
    assert.ok(topLexical.score > 0)
    assert.ok(topLexical.ftsScore > 0)

    // 5. Test Dense Float32Array vector similarity retrieval on imported vaultB
    const vectorRecall = vaultB.recallMemories('quorum leader election consistency', {
      projectId: 'distributed-ledger'
    })
    assert.ok(vectorRecall.memories.length >= 1)
    const topVector = vectorRecall.memories[0]!
    assert.equal(topVector.title, 'Raft Consensus Protocol for Clustering')
    assert.ok(topVector.score > 0)
    assert.ok(topVector.vectorScore > 0)

    // 6. Verify vector embeddings in database table are deserializable Float32Array
    const dbRaw = (vaultB as unknown as { db: { prepare: (sql: string) => { all: () => Array<{ embedding: Uint8Array; dimensions: number }> } } }).db
    const vectorRows = dbRaw.prepare('SELECT embedding, dimensions FROM memory_vectors').all()
    assert.equal(vectorRows.length, 2)
    for (const row of vectorRows) {
      assert.equal(row.dimensions, 384)
      assert.equal(row.embedding.byteLength, 384 * 4) // 384 floats * 4 bytes
    }
  })

  it('executes merge strategy with Last-Write-Wins, accessCount preservation, and tombstone lifecycle', () => {
    // 1. Initial shared memory in Vault A
    const storedA = vaultA.storeMemory({
      projectId: 'sync-proj',
      category: 'architecture',
      title: 'Initial Architecture Title',
      content: 'Initial architecture documentation content.',
      tags: ['init']
    })
    const memId = storedA.memory.id

    // Export and import to Vault B so both have the same baseline
    const baseSnapshot = vaultA.exportSnapshot()
    vaultB.importSnapshot(baseSnapshot)

    // 2. Simulate activity in Vault B: accessed 10 times, older timestamp
    const dbB = (vaultB as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
    dbB.prepare('UPDATE memories SET access_count = 10, updated_at = ? WHERE id = ?').run(
      '2026-01-01T01:00:00.000Z',
      memId
    )

    // 3. Vault A updates the memory later with newer timestamp and accessCount = 3
    const dbA = (vaultA as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db
    dbA.prepare(
      'UPDATE memories SET title = ?, access_count = 3, updated_at = ? WHERE id = ?'
    ).run('Updated Title in A', '2026-01-01T05:00:00.000Z', memId)

    // 4. Export from Vault A and import (merge) into Vault B
    const updateSnapshotA = vaultA.exportSnapshot()
    const mergeResult = vaultB.importSnapshot(updateSnapshotA, { strategy: 'merge' })

    assert.equal(mergeResult.memoriesUpdated, 1)

    // Verify accessCount preservation before recallMemories increments it: Math.max(10, 3) = 10
    const rawMemB = (vaultB as unknown as { db: { prepare: (sql: string) => { get: (id: string) => { access_count: number } } } }).db
      .prepare('SELECT access_count FROM memories WHERE id = ?')
      .get(memId)
    assert.equal(rawMemB.access_count, 10)

    // Verify LWW: title updated to Vault A's newer title
    const recallB = vaultB.recallMemories('Updated Title in A', { projectId: 'sync-proj' })
    assert.equal(recallB.memories.length, 1)
    const memB = recallB.memories[0]!
    assert.equal(memB.title, 'Updated Title in A')
    // recallMemories increments access_count from 10 to 11
    assert.equal(memB.accessCount, 11)

    // 5. Test LWW prevents regression: Older snapshot from Vault A cannot overwrite newer Vault B
    const olderSnapshot: VaultSnapshotV1 = JSON.parse(JSON.stringify(baseSnapshot))
    olderSnapshot.memories[0]!.updatedAt = '2025-12-31T00:00:00.000Z'
    olderSnapshot.memories[0]!.title = 'Outdated Stale Title'
    olderSnapshot.checksum = computeSnapshotChecksum(olderSnapshot)

    vaultB.importSnapshot(olderSnapshot, { strategy: 'merge' })
    const memBAfterStale = vaultB.recallMemories('Updated Title in A', { projectId: 'sync-proj' })
    assert.equal(memBAfterStale.memories[0]?.title, 'Updated Title in A')

    // 6. Tombstone application: Vault A deletes the memory
    const deletedInA = vaultA.forgetMemory(memId)
    assert.equal(deletedInA, true)

    const tombstoneSnapshotA = vaultA.exportSnapshot()
    assert.equal(tombstoneSnapshotA.tombstones.length, 1)

    // Import into Vault B: tombstone must delete memory in Vault B
    const tombstoneResult = vaultB.importSnapshot(tombstoneSnapshotA, { strategy: 'merge' })
    assert.equal(tombstoneResult.tombstonesApplied, 1)

    const memBAfterDelete = vaultB.recallMemories('Updated Title', { projectId: 'sync-proj' })
    assert.equal(memBAfterDelete.memories.length, 0)

    // 7. Verify memory does NOT resurrect if older snapshot is re-imported
    const resurrectAttempt = vaultB.importSnapshot(updateSnapshotA, { strategy: 'merge' })
    assert.equal(resurrectAttempt.memoriesCreated, 0)
    assert.equal(resurrectAttempt.memoriesSkipped, 1)

    const memBAfterResurrect = vaultB.recallMemories('Updated Title', { projectId: 'sync-proj' })
    assert.equal(memBAfterResurrect.memories.length, 0)
  })

  it('executes replace strategy globally and filtered by project', () => {
    // 1. Populate Vault B with project-one and project-two
    vaultB.storeMemory({
      projectId: 'project-one',
      category: 'domain',
      title: 'P1 Existing Memory',
      content: 'Project one existing memory.'
    })
    vaultB.storeMemory({
      projectId: 'project-two',
      category: 'domain',
      title: 'P2 Existing Memory',
      content: 'Project two existing memory.'
    })

    assert.equal(vaultB.getStats().memoryCount, 2)

    // 2. Populate Vault A with project-one new memories
    vaultA.storeMemory({
      projectId: 'project-one',
      category: 'decision',
      title: 'P1 Replacement Memory',
      content: 'Replacement decision for project one.'
    })

    const snapshotAlpha = vaultA.exportSnapshot({ projectId: 'project-one' })
    assert.equal(snapshotAlpha.memories.length, 1)
    assert.equal(snapshotAlpha.projectFilter, 'project-one')

    // 3. Import into Vault B with strategy: 'replace' filtered by project-one
    const projectReplaceResult = vaultB.importSnapshot(snapshotAlpha, {
      strategy: 'replace',
      projectId: 'project-one'
    })
    assert.equal(projectReplaceResult.strategy, 'replace')
    assert.equal(projectReplaceResult.memoriesCreated, 1)

    // Verify project-one was replaced
    const p1Memories = vaultB.recallMemories('Replacement', { projectId: 'project-one' })
    assert.equal(p1Memories.memories.length, 1)
    assert.equal(p1Memories.memories[0]?.title, 'P1 Replacement Memory')

    // Verify project-two was NOT touched
    const p2Memories = vaultB.recallMemories('P2 Existing', { projectId: 'project-two' })
    assert.equal(p2Memories.memories.length, 1)
    assert.equal(p2Memories.memories[0]?.title, 'P2 Existing Memory')

    // Total memory count is 2 (1 in project-one, 1 in project-two)
    assert.equal(vaultB.getStats().memoryCount, 2)

    // 4. Global replace: export global snapshot from Vault A (projectFilter: null)
    // Add a single memory in Vault A under project-three
    vaultA.storeMemory({
      projectId: 'project-three',
      category: 'domain',
      title: 'Global Only Memory',
      content: 'Only this memory should survive global replace.'
    })
    const fullSnapshotA = vaultA.exportSnapshot()
    assert.equal(fullSnapshotA.projectFilter, null)

    // Import globally with strategy: 'replace'
    const globalReplaceResult = vaultB.importSnapshot(fullSnapshotA, {
      strategy: 'replace'
    })
    assert.equal(globalReplaceResult.strategy, 'replace')

    // Vault B now ONLY contains Vault A's memories; project-two is completely wiped
    assert.equal(vaultB.getStats().memoryCount, 2) // project-one replacement + project-three
    const p2AfterGlobal = vaultB.recallMemories('P2 Existing', { projectId: 'project-two' })
    assert.equal(p2AfterGlobal.memories.length, 0)

    const p3AfterGlobal = vaultB.recallMemories('Global Only', { projectId: 'project-three' })
    assert.equal(p3AfterGlobal.memories.length, 1)
  })
})
