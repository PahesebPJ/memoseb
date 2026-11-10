import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type MemoryCategory =
  | 'architecture'
  | 'convention'
  | 'bugfix'
  | 'decision'
  | 'domain'

export type NodeRole = 'standalone' | 'parent' | 'child' | 'peer'
export type PeerRole = 'parent' | 'child' | 'peer'
export type GroupPermissionMode = 'readwrite' | 'readonly' | 'writeonly'
export type UnassignedGroupPolicy = 'none' | 'all'

export interface NodeConfiguration {
  nodeId: string
  nodeName: string
  enabled: boolean
  role: NodeRole
  listenHost: string
  listenPort: number
  authToken: string | null
  autoSync: boolean
  lanDiscovery: boolean
  unassignedGroupPolicy?: UnassignedGroupPolicy
  syncIntervalMinutes?: number
  tailscaleDiscovery?: boolean
  tailscaleBin?: string | null
}

export const DEFAULT_SYNC_INTERVAL_MINUTES = 5
export const MIN_SYNC_INTERVAL_MINUTES = 1
export const MAX_SYNC_INTERVAL_MINUTES = 1440

export function clampSyncInterval(minutes: number): number {
  return Math.min(MAX_SYNC_INTERVAL_MINUTES, Math.max(MIN_SYNC_INTERVAL_MINUTES, minutes))
}

export interface SyncPeerRecord {
  id: string
  peerNodeId: string | null
  role: PeerRole
  name: string
  url: string
  authToken: string | null
  lastSyncAt: string | null
  lastStatus: string | null
  updatedAt: string
}

export interface SyncGroupRecord {
  id: string
  name: string
  description: string
  projects: string[]
  categories: string[]
  permissions: GroupPermissionMode
  groupToken: string | null
  memberNodeIds: string[]
  createdAt: string
  updatedAt: string
}

export interface EffectivePeerPermissions {
  unrestricted: boolean
  groups: string[]
  canPush: (projectId: string, category?: MemoryCategory | string) => boolean
  canPull: (projectId: string, category?: MemoryCategory | string) => boolean
}

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'architecture',
  'convention',
  'bugfix',
  'decision',
  'domain'
] as const

export const NODE_ROLES: readonly NodeRole[] = [
  'standalone',
  'parent',
  'child',
  'peer'
] as const

export const PEER_ROLES: readonly PeerRole[] = [
  'parent',
  'child',
  'peer'
] as const

export const GROUP_PERMISSION_MODES: readonly GroupPermissionMode[] = [
  'readwrite',
  'readonly',
  'writeonly'
] as const

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value)
}

export function isNodeRole(value: unknown): value is NodeRole {
  return (
    typeof value === 'string' &&
    (NODE_ROLES as readonly string[]).includes(value)
  )
}

export function isPeerRole(value: unknown): value is PeerRole {
  return (
    typeof value === 'string' &&
    (PEER_ROLES as readonly string[]).includes(value)
  )
}

/**
 * Normaliza cualquier entrada de rol a NodeRole válido.
 * Acepta 'p2p' como alias insensible a mayúsculas que mapea a 'peer'.
 */
export function normalizeNodeRole(value: unknown): NodeRole {
  if (typeof value !== 'string') return 'standalone'
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'p2p') return 'peer'
  if (isNodeRole(trimmed)) return trimmed
  return 'standalone'
}

/**
 * Normaliza cualquier entrada de rol de par a PeerRole válido.
 * Acepta 'p2p' como alias insensible a mayúsculas que mapea a 'peer'.
 */
export function normalizePeerRole(value: unknown): PeerRole {
  if (typeof value !== 'string') return 'peer'
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'p2p') return 'peer'
  if (isPeerRole(trimmed)) return trimmed
  return 'peer'
}

/**
 * Parsea un input para NodeRole retornando null si la cadena no es válida.
 * Acepta 'p2p' mapeándolo a 'peer'.
 */
export function parseNodeRoleInput(value: unknown): NodeRole | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'p2p') return 'peer'
  if (isNodeRole(trimmed)) return trimmed
  return null
}

/**
 * Parsea un input para PeerRole retornando null si la cadena no es válida.
 * Acepta 'p2p' mapeándolo a 'peer'.
 */
export function parsePeerRoleInput(value: unknown): PeerRole | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (trimmed === 'p2p') return 'peer'
  if (isPeerRole(trimmed)) return trimmed
  return null
}

export function isGroupPermissionMode(
  value: string
): value is GroupPermissionMode {
  return (GROUP_PERMISSION_MODES as readonly string[]).includes(value)
}

export function isUnassignedGroupPolicy(
  value: string
): value is UnassignedGroupPolicy {
  return value === 'none' || value === 'all'
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_agent TEXT,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 1,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  project_id UNINDEXED,
  title,
  content,
  tags
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_tombstones (
  memory_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  origin_node_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tombstones_updated ON memory_tombstones(deleted_at);
CREATE INDEX IF NOT EXISTS idx_tombstones_project_hash ON memory_tombstones(project_id, content_hash);

CREATE TABLE IF NOT EXISTS node_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_peers (
  id TEXT PRIMARY KEY,
  peer_node_id TEXT,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  auth_token TEXT,
  last_sync_at TEXT,
  last_status TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_peers_role ON sync_peers(role);

CREATE TABLE IF NOT EXISTS sync_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  projects TEXT NOT NULL DEFAULT '["*"]',
  categories TEXT NOT NULL DEFAULT '["*"]',
  permissions TEXT NOT NULL DEFAULT 'readwrite',
  group_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_group_members (
  group_id TEXT NOT NULL,
  peer_identifier TEXT NOT NULL,
  added_at TEXT NOT NULL,
  PRIMARY KEY (group_id, peer_identifier),
  FOREIGN KEY (group_id) REFERENCES sync_groups(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sync_group_members_peer ON sync_group_members(peer_identifier);
`

export function openVaultDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  restrictVaultFilePermissions(dbPath)
  return db
}

/** La bóveda guarda tokens: en POSIX solo la lee su dueño (0600). */
export function restrictVaultFilePermissions(
  dbPath: string,
  platform: NodeJS.Platform = process.platform
): void {
  if (dbPath === ':memory:' || platform === 'win32') return
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, 0o600)
    } catch {
      // el archivo -wal/-shm puede no existir todavía
    }
  }
}
