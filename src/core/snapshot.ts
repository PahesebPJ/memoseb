import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  isP2PContractPayload,
  p2pPayloadToSnapshot,
  unwrapP2PEnvelope
} from './p2p-contract.ts'
import type { MemoryRecord } from './vault.ts'

export interface ExportedProject {
  id: string
  name: string
  rootPath: string
  updatedAt: string
}

export interface ExportedTombstone {
  memoryId: string
  projectId: string
  contentHash: string
  deletedAt: string
  originNodeId: string | null
}

export interface VaultSnapshotV1 {
  format: 'memoseb-snapshot'
  version: 1
  exportedAt: string
  originNodeId: string
  projectFilter: string | null
  checksum: string
  projects: ExportedProject[]
  memories: MemoryRecord[]
  tombstones: ExportedTombstone[]
}

export interface ExportOptions {
  projectId?: string
  since?: string
  includeTombstones?: boolean
}

export interface ImportOptions {
  strategy?: 'merge' | 'replace'
  projectId?: string
  includeTombstones?: boolean
}

export interface ImportResult {
  strategy: 'merge' | 'replace'
  projectsImported: number
  memoriesCreated: number
  memoriesUpdated: number
  memoriesSkipped: number
  tombstonesApplied: number
}

export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const entries = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`)
  return `{${entries.join(',')}}`
}

export function computeSnapshotChecksum(
  payload: Omit<VaultSnapshotV1, 'checksum'>
): string {
  const normalized = {
    format: payload.format,
    version: payload.version,
    originNodeId: payload.originNodeId,
    projectFilter: payload.projectFilter ?? null,
    projects: payload.projects,
    memories: payload.memories,
    tombstones: payload.tombstones
  }
  return crypto
    .createHash('sha256')
    .update(canonicalStringify(normalized))
    .digest('hex')
}

export function verifySnapshot(snapshot: unknown): VaultSnapshotV1 {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid snapshot: expected a non-null JSON object.')
  }
  const s = snapshot as Record<string, unknown>

  if (s.format !== 'memoseb-snapshot') {
    throw new Error(
      `Invalid snapshot format: expected "memoseb-snapshot", received "${String(s.format)}".`
    )
  }
  if (s.version !== 1) {
    throw new Error(
      `Unsupported snapshot version: expected 1, received ${String(s.version)}.`
    )
  }
  if (typeof s.originNodeId !== 'string' || s.originNodeId.trim().length === 0) {
    throw new Error('Invalid snapshot: originNodeId must be a non-empty string.')
  }
  if (s.projectFilter !== null && typeof s.projectFilter !== 'string') {
    throw new Error('Invalid snapshot: projectFilter must be a string or null.')
  }
  if (typeof s.exportedAt !== 'string' || s.exportedAt.trim().length === 0) {
    throw new Error('Invalid snapshot: exportedAt must be a non-empty string.')
  }
  if (!Array.isArray(s.projects)) {
    throw new Error('Invalid snapshot: projects must be an array.')
  }
  if (!Array.isArray(s.memories)) {
    throw new Error('Invalid snapshot: memories must be an array.')
  }
  if (!Array.isArray(s.tombstones)) {
    throw new Error('Invalid snapshot: tombstones must be an array.')
  }
  if (typeof s.checksum !== 'string' || s.checksum.trim().length === 0) {
    throw new Error('Invalid snapshot: checksum must be a non-empty string.')
  }

  const typedSnapshot = s as unknown as VaultSnapshotV1
  const expectedChecksum = computeSnapshotChecksum(typedSnapshot)
  if (s.checksum !== expectedChecksum) {
    throw new Error(
      `Snapshot checksum mismatch: expected ${expectedChecksum}, received ${s.checksum}.`
    )
  }

  return typedSnapshot
}

export function writeSnapshotFile(
  filePath: string,
  snapshot: VaultSnapshotV1
): string {
  const verified = verifySnapshot(snapshot)
  const resolvedPath = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, JSON.stringify(verified, null, 2), 'utf-8')
  return resolvedPath
}

export function readSnapshotFile(filePath: string): VaultSnapshotV1 {
  const resolvedPath = path.resolve(filePath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Snapshot file does not exist: ${resolvedPath}`)
  }
  const content = fs.readFileSync(resolvedPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(
      `Failed to parse snapshot JSON at ${resolvedPath}: ${(err as Error).message}`
    )
  }
  const unwrapped = unwrapP2PEnvelope(parsed)
  if (isP2PContractPayload(unwrapped)) {
    return p2pPayloadToSnapshot(unwrapped)
  }
  return verifySnapshot(unwrapped)
}

export function filterSnapshotByPermissions(
  snapshot: VaultSnapshotV1,
  predicate: (projectId: string, category?: string) => boolean
): {
  filtered: VaultSnapshotV1
  droppedMemories: number
  droppedTombstones: number
} {
  const allowedMemories = snapshot.memories.filter((m) =>
    predicate(m.projectId, m.category)
  )
  const allowedTombstones = snapshot.tombstones.filter((t) =>
    predicate(t.projectId)
  )
  const referencedProjectIds = new Set<string>()
  for (const m of allowedMemories) {
    referencedProjectIds.add(m.projectId)
  }
  for (const t of allowedTombstones) {
    referencedProjectIds.add(t.projectId)
  }
  const allowedProjects = snapshot.projects.filter(
    (p) => referencedProjectIds.has(p.id) || predicate(p.id)
  )

  const basePayload: Omit<VaultSnapshotV1, 'checksum'> = {
    format: 'memoseb-snapshot',
    version: 1,
    exportedAt: snapshot.exportedAt,
    originNodeId: snapshot.originNodeId,
    projectFilter: snapshot.projectFilter ?? null,
    projects: allowedProjects,
    memories: allowedMemories,
    tombstones: allowedTombstones
  }
  const checksum = computeSnapshotChecksum(basePayload)

  return {
    filtered: {
      ...basePayload,
      checksum
    },
    droppedMemories: snapshot.memories.length - allowedMemories.length,
    droppedTombstones: snapshot.tombstones.length - allowedTombstones.length
  }
}
