import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { SystemRuntime } from 'hubseb'
import {
  cosineSimilarity,
  deserializeVector,
  estimateTokens,
  LocalFeatureHashEmbedder,
  serializeVector,
  type EmbeddingProvider
} from './embedder.ts'
import { detectProject, slugifyProjectId } from './project-detector.ts'
import {
  isGroupPermissionMode,
  isMemoryCategory,
  clampSyncInterval,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  MAX_SYNC_INTERVAL_MINUTES,
  MIN_SYNC_INTERVAL_MINUTES,
  isUnassignedGroupPolicy,
  normalizeNodeRole,
  normalizePeerRole,
  openVaultDatabase,
  type EffectivePeerPermissions,
  type GroupPermissionMode,
  type MemoryCategory,
  type NodeConfiguration,
  type NodeRole,
  type PeerRole,
  type SyncGroupRecord,
  type SyncPeerRecord,
  type UnassignedGroupPolicy
} from './schema.ts'
import {
  computeMemoryContentHash,
  isP2PContractPayload,
  p2pPayloadToSnapshot,
  snapshotToP2PPayload,
  unwrapP2PEnvelope,
  type P2PSyncPayloadV1
} from './p2p-contract.ts'
import {
  computeSnapshotChecksum,
  verifySnapshot,
  type ExportOptions,
  type ImportOptions,
  type ImportResult,
  type VaultSnapshotV1,
  type ExportedProject,
  type ExportedTombstone
} from './snapshot.ts'

export * from './snapshot.ts'

export interface MemoryRecord {
  id: string
  projectId: string
  category: MemoryCategory
  title: string
  content: string
  tags: string[]
  sourceAgent: string | null
  contentHash: string
  tokenCount: number
  importance: number
  accessCount: number
  createdAt: string
  updatedAt: string
}

export interface ScoredMemory extends MemoryRecord {
  score: number
  vectorScore: number
  ftsScore: number
}

export interface StoreMemoryInput {
  projectId?: string
  projectName?: string
  rootPath?: string
  category?: MemoryCategory
  title?: string
  content: string
  tags?: readonly string[]
  sourceAgent?: string
  importance?: number
  cwd?: string
}

export interface StoreMemoryResult {
  memory: MemoryRecord
  created: boolean
}

export interface RecallOptions {
  projectId?: string
  includeGlobal?: boolean
  category?: MemoryCategory
  tags?: readonly string[]
  limit?: number
  maxTokens?: number
  cwd?: string
}

export interface RecallResult {
  projectId: string
  memories: ScoredMemory[]
  totalTokens: number
  truncatedByBudget: boolean
}

export interface ProjectSummary {
  id: string
  name: string
  rootPath: string
  updatedAt: string
  memoryCount: number
  totalTokens: number
}

export interface VaultStats {
  dbPath: string
  projectCount: number
  memoryCount: number
  vectorCount: number
  totalTokens: number
}

interface RawMemoryRow {
  id: string
  project_id: string
  category: string
  title: string
  content: string
  tags: string
  source_agent: string | null
  content_hash: string
  token_count: number
  importance: number
  access_count: number
  created_at: string
  updated_at: string
}

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    }
  } catch {
    // Ignore malformed JSON tags
  }
  return []
}

function mapRowToMemoryRecord(row: RawMemoryRow): MemoryRecord {
  const category: MemoryCategory = isMemoryCategory(row.category)
    ? row.category
    : 'domain'
  return {
    id: row.id,
    projectId: row.project_id,
    category,
    title: row.title,
    content: row.content,
    tags: parseTags(row.tags),
    sourceAgent: row.source_agent ?? null,
    contentHash: row.content_hash,
    tokenCount: Number(row.token_count),
    importance: Number(row.importance),
    accessCount: Number(row.access_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function sanitizeFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.filter((token) => token.length > 0)
  if (!tokens || tokens.length === 0) {
    return ''
  }
  const unique = Array.from(new Set(tokens))
  return unique.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
}

function clampImportance(value: number | undefined): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0.5
  }
  return Math.min(1, Math.max(0, value))
}

function deriveDefaultTitle(content: string): string {
  const firstLine = content.trim().split(/\r?\n/)[0]?.trim() ?? 'Memory'
  if (firstLine.length <= 72) {
    return firstLine
  }
  return `${firstLine.slice(0, 69)}...`
}

interface RawGroupRow {
  id: string
  name: string
  description: string
  projects: string
  categories: string
  permissions: string
  group_token: string | null
  created_at: string
  updated_at: string
}

function normalizeGroupName(rawName: string): string {
  const trimmed = (rawName ?? '').trim()
  if (!trimmed) {
    throw new Error('Group name cannot be empty.')
  }
  const withoutScope = trimmed.replace(/^@[^/]+\//, '')
  const slug = withoutScope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) {
    throw new Error('Group name cannot be empty.')
  }
  return slug
}

interface RawPeerRow {
  id: string
  peer_node_id: string | null
  role: string
  name: string
  url: string
  auth_token: string | null
  last_sync_at: string | null
  last_status: string | null
  updated_at: string
}

function mapRowToPeerRecord(row: RawPeerRow): SyncPeerRecord {
  return {
    id: row.id,
    peerNodeId: row.peer_node_id ?? null,
    role: normalizePeerRole(row.role),
    name: row.name,
    url: row.url,
    authToken: row.auth_token ?? null,
    lastSyncAt: row.last_sync_at ?? null,
    lastStatus: row.last_status ?? null,
    updatedAt: row.updated_at
  }
}

/**
 * Ruta de la bóveda con la misma precedencia que MemoryVault, sin abrir la base.
 */
export function resolveVaultDbPath(
  runtime: SystemRuntime,
  dbPath?: string
): string {
  return (
    dbPath ??
    runtime.env.MEMOSEB_DB_PATH ??
    path.join(runtime.stateRoot, '..', 'memoseb', 'vault.sqlite')
  )
}

export class MemoryVault {
  readonly dbPath: string
  private readonly db: DatabaseSync
  private readonly embedder: EmbeddingProvider
  private readonly runtime: SystemRuntime

  constructor(options?: {
    dbPath?: string
    runtime?: SystemRuntime
    embedder?: EmbeddingProvider
  }) {
    this.runtime = options?.runtime ?? new SystemRuntime()
    this.dbPath = resolveVaultDbPath(this.runtime, options?.dbPath)
    this.db = openVaultDatabase(this.dbPath)
    this.embedder = options?.embedder ?? new LocalFeatureHashEmbedder()
    this.migrateContentHashes()
  }

  /**
   * Migración única: alinea memories.content_hash con la fórmula del contrato
   * (sha256(project:category:content.trim())). Las filas cuyo hash nuevo
   * chocaría con el UNIQUE (project_id, content_hash) se dejan como están.
   */
  private migrateContentHashes(): { updated: number; skipped: number } {
    const key = 'migration.content_hash_v1'
    const done = this.db
      .prepare(`SELECT value FROM node_meta WHERE key = ?`)
      .get(key) as { value: string } | undefined
    if (done) return { updated: 0, skipped: 0 }
    let updated = 0
    let skipped = 0
    this.db.exec('BEGIN IMMEDIATE;')
    try {
      const rows = this.db
        .prepare(`SELECT id, project_id, category, content, content_hash FROM memories`)
        .all() as Array<{
        id: string
        project_id: string
        category: string
        content: string
        content_hash: string
      }>
      const conflict = this.db.prepare(
        `SELECT id FROM memories WHERE project_id = ? AND content_hash = ? AND id <> ? LIMIT 1`
      )
      const update = this.db.prepare(`UPDATE memories SET content_hash = ? WHERE id = ?`)
      for (const row of rows) {
        const next = computeMemoryContentHash(row.project_id, row.category, row.content)
        if (next === row.content_hash) continue
        if (conflict.get(row.project_id, next, row.id)) {
          skipped++
          continue
        }
        update.run(next, row.id)
        updated++
      }
      this.db
        .prepare(
          `INSERT INTO node_meta (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(key, JSON.stringify({ updated, skipped }), new Date().toISOString())
      this.db.exec('COMMIT;')
    } catch (err) {
      this.db.exec('ROLLBACK;')
      throw err
    }
    return { updated, skipped }
  }

  private get runtimeEnvToken(): string | null {
    const token =
      this.runtime.env.MEMOSEB_SYNC_TOKEN?.trim() ||
      process.env.MEMOSEB_SYNC_TOKEN?.trim()
    return token && token.length > 0 ? token : null
  }

  private resolveProjectContext(input?: {
    projectId?: string
    projectName?: string
    rootPath?: string
    cwd?: string
  }): { id: string; name: string; rootPath: string } {
    if (input?.projectId && input.projectId.trim().length > 0) {
      const id = slugifyProjectId(input.projectId)
      const name = input.projectName?.trim() || id
      const rootPath =
        input.rootPath?.trim() ||
        (id === 'global' ? 'global' : path.resolve(input.cwd ?? process.cwd()))
      return { id, name, rootPath }
    }
    const detected = detectProject(input?.cwd)
    return {
      id: detected.id,
      name: input?.projectName?.trim() || detected.name,
      rootPath: input?.rootPath?.trim() || detected.rootPath
    }
  }

  storeMemory(input: StoreMemoryInput): StoreMemoryResult {
    const trimmedContent = input.content.trim()
    if (trimmedContent.length === 0) {
      throw new Error('Memory content must not be empty.')
    }

    const project = this.resolveProjectContext(input)
    const category: MemoryCategory =
      input.category && isMemoryCategory(input.category)
        ? input.category
        : 'domain'
    const title =
      input.title && input.title.trim().length > 0
        ? input.title.trim()
        : deriveDefaultTitle(trimmedContent)
    const tags = Array.from(
      new Set(
        (input.tags ?? [])
          .map((t) => t.trim())
          .filter((t) => t.length > 0)
      )
    )
    const tagsJson = JSON.stringify(tags)
    const tagsText = tags.join(' ')
    const sourceAgent = input.sourceAgent?.trim() ?? null
    const importance = clampImportance(input.importance)
    const now = new Date().toISOString()

    const contentHash = crypto
      .createHash('sha256')
      .update(`${project.id}:${category}:${trimmedContent}`)
      .digest('hex')

    this.db.prepare(
      `INSERT INTO projects (id, name, root_path, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         root_path = excluded.root_path,
         updated_at = excluded.updated_at`
    ).run(project.id, project.name, project.rootPath, now)

    const existing = this.db
      .prepare(
        `SELECT * FROM memories WHERE project_id = ? AND content_hash = ? LIMIT 1`
      )
      .get(project.id, contentHash) as unknown as RawMemoryRow | undefined

    const embeddingText = `${title}\n${trimmedContent}\n${tagsText}`
    const vector = this.embedder.embed(embeddingText)
    const serializedVector = serializeVector(vector)
    const tokenCount = estimateTokens(`${title}\n${trimmedContent}`)

    if (existing) {
      this.db
        .prepare(
          `DELETE FROM memory_tombstones
           WHERE (project_id = ? AND content_hash = ?) OR memory_id = ?`
        )
        .run(project.id, contentHash, existing.id)

      const mergedImportance =
        input.importance !== undefined
          ? importance
          : Number(existing.importance)
      const mergedTitle =
        input.title && input.title.trim().length > 0 ? title : existing.title
      const mergedTagsJson =
        input.tags !== undefined ? tagsJson : existing.tags
      const mergedTagsText = parseTags(mergedTagsJson).join(' ')
      const mergedSourceAgent =
        sourceAgent !== null ? sourceAgent : existing.source_agent

      this.db
        .prepare(
          `UPDATE memories
           SET title = ?,
               tags = ?,
               source_agent = ?,
               importance = ?,
               token_count = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          mergedTitle,
          mergedTagsJson,
          mergedSourceAgent,
          mergedImportance,
          tokenCount,
          now,
          existing.id
        )

      this.db
        .prepare(`DELETE FROM memories_fts WHERE memory_id = ?`)
        .run(existing.id)
      this.db
        .prepare(
          `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          existing.id,
          project.id,
          mergedTitle,
          trimmedContent,
          mergedTagsText
        )

      this.db
        .prepare(
          `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(memory_id) DO UPDATE SET
             dimensions = excluded.dimensions,
             embedding = excluded.embedding,
             model = excluded.model`
        )
        .run(
          existing.id,
          this.embedder.dimensions,
          serializedVector,
          this.embedder.model
        )

      const updatedRow = this.db
        .prepare(`SELECT * FROM memories WHERE id = ?`)
        .get(existing.id) as unknown as RawMemoryRow
      return {
        memory: mapRowToMemoryRecord(updatedRow),
        created: false
      }
    }

    const id = crypto.randomUUID()
    this.db
      .prepare(
        `DELETE FROM memory_tombstones
         WHERE (project_id = ? AND content_hash = ?) OR memory_id = ?`
      )
      .run(project.id, contentHash, id)

    this.db
      .prepare(
        `INSERT INTO memories (
          id, project_id, category, title, content, tags, source_agent,
          content_hash, token_count, importance, access_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        id,
        project.id,
        category,
        title,
        trimmedContent,
        tagsJson,
        sourceAgent,
        contentHash,
        tokenCount,
        importance,
        now,
        now
      )

    this.db
      .prepare(
        `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(id, project.id, title, trimmedContent, tagsText)

    this.db
      .prepare(
        `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
         VALUES (?, ?, ?, ?)`
      )
      .run(id, this.embedder.dimensions, serializedVector, this.embedder.model)

    const insertedRow = this.db
      .prepare(`SELECT * FROM memories WHERE id = ?`)
      .get(id) as unknown as RawMemoryRow

    return {
      memory: mapRowToMemoryRecord(insertedRow),
      created: true
    }
  }

  recallMemories(query: string, options?: RecallOptions): RecallResult {
    const project = this.resolveProjectContext({
      projectId: options?.projectId,
      cwd: options?.cwd
    })
    const includeGlobal = options?.includeGlobal !== false
    const allowedProjects =
      includeGlobal && project.id !== 'global'
        ? [project.id, 'global']
        : [project.id]
    const limit = Math.max(1, options?.limit ?? 5)
    const maxTokens = Math.max(1, options?.maxTokens ?? 1200)
    const filterCategory = options?.category
    const filterTags = (options?.tags ?? [])
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0)

    const placeholders = allowedProjects.map(() => '?').join(', ')
    const params: (string | number)[] = [...allowedProjects]
    let categoryClause = ''
    if (filterCategory) {
      categoryClause = ' AND m.category = ?'
      params.push(filterCategory)
    }

    const candidateRows = this.db
      .prepare(
        `SELECT m.*, mv.embedding AS vector_blob
         FROM memories m
         LEFT JOIN memory_vectors mv ON mv.memory_id = m.id
         WHERE m.project_id IN (${placeholders})${categoryClause}`
      )
      .all(...params) as unknown as Array<
      RawMemoryRow & { vector_blob?: Uint8Array | null }
    >

    if (candidateRows.length === 0) {
      return {
        projectId: project.id,
        memories: [],
        totalTokens: 0,
        truncatedByBudget: false
      }
    }

    const candidatesById = new Map<
      string,
      { record: MemoryRecord; vectorBlob?: Uint8Array | null }
    >()
    for (const row of candidateRows) {
      const record = mapRowToMemoryRecord(row)
      if (filterTags.length > 0) {
        const recordTagsLower = new Set(record.tags.map((t) => t.toLowerCase()))
        const matchesTag = filterTags.some((tag) => recordTagsLower.has(tag))
        if (!matchesTag) {
          continue
        }
      }
      candidatesById.set(record.id, {
        record,
        vectorBlob: row.vector_blob
      })
    }

    if (candidatesById.size === 0) {
      return {
        projectId: project.id,
        memories: [],
        totalTokens: 0,
        truncatedByBudget: false
      }
    }

    // 1. FTS5 lexical ranking
    const ftsRankById = new Map<string, { rank: number; rawScore: number }>()
    const ftsQuery = sanitizeFtsQuery(query)
    if (ftsQuery.length > 0) {
      try {
        const ftsRows = this.db
          .prepare(
            `SELECT memory_id, bm25(memories_fts, 2.0, 1.0, 1.5) AS bm25_score
             FROM memories_fts
             WHERE memories_fts MATCH ?
               AND project_id IN (${placeholders})
             ORDER BY bm25_score ASC`
          )
          .all(ftsQuery, ...allowedProjects) as Array<{
          memory_id: string
          bm25_score: number
        }>

        let rankIndex = 1
        for (const ftsRow of ftsRows) {
          if (!candidatesById.has(ftsRow.memory_id)) {
            continue
          }
          // SQLite bm25 returns negative values where more negative = better match
          const positiveLexical = Math.max(0, -Number(ftsRow.bm25_score))
          ftsRankById.set(ftsRow.memory_id, {
            rank: rankIndex,
            rawScore: positiveLexical
          })
          rankIndex++
        }
      } catch {
        // Fallback smoothly to vector ranking if FTS query fails
      }
    }

    // 2. Dense vector cosine ranking
    const queryVec = this.embedder.embed(query)
    const vectorScored: Array<{ id: string; similarity: number }> = []
    for (const [id, entry] of candidatesById.entries()) {
      let similarity = 0
      if (entry.vectorBlob && entry.vectorBlob.byteLength > 0) {
        const memVec = deserializeVector(entry.vectorBlob)
        similarity = Math.max(0, cosineSimilarity(queryVec, memVec))
      }
      vectorScored.push({ id, similarity })
    }
    vectorScored.sort((a, b) => b.similarity - a.similarity)

    const vecRankById = new Map<string, { rank: number; similarity: number }>()
    vectorScored.forEach((item, idx) => {
      vecRankById.set(item.id, {
        rank: idx + 1,
        similarity: item.similarity
      })
    })

    // 3. Reciprocal Rank Fusion (RRF) + Importance
    const rrfK = 10
    const scoredCandidates: ScoredMemory[] = []
    for (const [id, entry] of candidatesById.entries()) {
      const vecInfo = vecRankById.get(id)
      const ftsInfo = ftsRankById.get(id)
      const vectorScore = vecInfo?.similarity ?? 0
      const ftsScore = ftsInfo?.rawScore ?? 0

      // Exclude completely unrelated memories when query is non-empty
      if (query.trim().length > 0 && vectorScore <= 0 && !ftsInfo) {
        continue
      }

      const vecRrf =
        vecInfo && vecInfo.similarity > 0 ? 1.0 / (rrfK + vecInfo.rank) : 0
      const ftsRrf = ftsInfo ? 1.2 / (rrfK + ftsInfo.rank) : 0
      const rrfScore =
        vecRrf +
        ftsRrf +
        0.25 * vectorScore +
        0.1 * entry.record.importance

      scoredCandidates.push({
        ...entry.record,
        score: Number(rrfScore.toFixed(6)),
        vectorScore: Number(vectorScore.toFixed(6)),
        ftsScore: Number(ftsScore.toFixed(6))
      })
    }

    scoredCandidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score
      }
      return b.updatedAt.localeCompare(a.updatedAt)
    })

    const topLimited = scoredCandidates.slice(0, limit)
    const selected: ScoredMemory[] = []
    let totalTokens = 0
    let truncatedByBudget = false

    for (const candidate of topLimited) {
      const cost = Math.max(1, candidate.tokenCount)
      if (totalTokens + cost > maxTokens) {
        truncatedByBudget = true
        continue
      }
      selected.push(candidate)
      totalTokens += cost
    }

    if (selected.length > 0) {
      const updateStmt = this.db.prepare(
        `UPDATE memories SET access_count = access_count + 1 WHERE id = ?`
      )
      for (const item of selected) {
        updateStmt.run(item.id)
        item.accessCount += 1
      }
    }

    return {
      projectId: project.id,
      memories: selected,
      totalTokens,
      truncatedByBudget
    }
  }

  getProjectBriefing(options?: {
    projectId?: string
    maxTokens?: number
    cwd?: string
  }): RecallResult {
    const project = this.resolveProjectContext({
      projectId: options?.projectId,
      cwd: options?.cwd
    })
    const maxTokens = Math.max(1, options?.maxTokens ?? 1200)

    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE project_id IN (?, 'global')
         ORDER BY
           CASE WHEN project_id = ? THEN 0 ELSE 1 END ASC,
           importance DESC,
           updated_at DESC`
      )
      .all(project.id, project.id) as unknown as RawMemoryRow[]

    const selected: ScoredMemory[] = []
    let totalTokens = 0
    let truncatedByBudget = false

    for (const row of rows) {
      const record = mapRowToMemoryRecord(row)
      const cost = Math.max(1, record.tokenCount)
      if (totalTokens + cost > maxTokens) {
        truncatedByBudget = true
        continue
      }
      selected.push({
        ...record,
        score: record.importance,
        vectorScore: 0,
        ftsScore: 0
      })
      totalTokens += cost
    }

    return {
      projectId: project.id,
      memories: selected,
      totalTokens,
      truncatedByBudget
    }
  }

  forgetMemory(id: string): boolean {
    const existing = this.db
      .prepare(
        `SELECT id, project_id, content_hash FROM memories WHERE id = ?`
      )
      .get(id) as
      | { id: string; project_id: string; content_hash: string }
      | undefined
    if (!existing) {
      return false
    }

    const now = new Date().toISOString()
    const nodeId = this.getNodeId()

    this.db.prepare(`DELETE FROM memories_fts WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)

    this.db
      .prepare(
        `INSERT INTO memory_tombstones (
           memory_id, project_id, content_hash, deleted_at, origin_node_id
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           project_id = excluded.project_id,
           content_hash = excluded.content_hash,
           deleted_at = excluded.deleted_at,
           origin_node_id = excluded.origin_node_id`
      )
      .run(existing.id, existing.project_id, existing.content_hash, now, nodeId)

    return true
  }

  getNodeId(): string {
    const row = this.db
      .prepare(`SELECT value FROM node_meta WHERE key = 'node.id'`)
      .get() as { value: string } | undefined
    if (row && row.value.trim().length > 0) {
      return row.value.trim()
    }
    const newId = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO node_meta (key, value, updated_at)
         VALUES ('node.id', ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(newId, now)
    return newId
  }

  getNodeConfig(): NodeConfiguration {
    const rows = this.db
      .prepare(`SELECT key, value FROM node_meta`)
      .all() as Array<{ key: string; value: string }>
    const meta = new Map<string, string>()
    for (const r of rows) {
      meta.set(r.key, r.value)
    }

    const nodeId = this.getNodeId()
    const rawName = meta.get('node.name')?.trim()
    const nodeName = rawName && rawName.length > 0 ? rawName : os.hostname()
    const enabled = meta.get('node.enabled') === 'true'

    const rawRole = meta.get('node.role')
    const role: NodeRole = normalizeNodeRole(rawRole)

    const rawHost = meta.get('node.listen_host')?.trim()
    const listenHost = rawHost && rawHost.length > 0 ? rawHost : '0.0.0.0'

    const rawPort = Number(meta.get('node.listen_port'))
    const listenPort = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 7432

    const nodeAuthToken = meta.get('node.auth_token')?.trim()
    const authToken =
      nodeAuthToken && nodeAuthToken.length > 0
        ? nodeAuthToken
        : this.runtimeEnvToken

    const nodeAutoSync = meta.get('node.auto_sync')
    let autoSync = true
    if (nodeAutoSync !== undefined) {
      autoSync = nodeAutoSync === 'true'
    } else {
      const envAutoSync =
        this.runtime.env.MEMOSEB_AUTO_SYNC ?? process.env.MEMOSEB_AUTO_SYNC
      if (envAutoSync !== undefined) {
        autoSync = envAutoSync === 'true' || envAutoSync === '1'
      }
    }

    const rawLan = meta.get('node.lan_discovery')
    const lanDiscovery = rawLan !== undefined ? rawLan === 'true' : true

    const rawUnassigned = meta.get('node.unassigned_group_policy')
    const unassignedGroupPolicy: UnassignedGroupPolicy =
      rawUnassigned === 'all' ? 'all' : 'none'

    const rawInterval = Number(
      meta.get('node.sync_interval_min') ??
        this.runtime.env.MEMOSEB_SYNC_INTERVAL_MIN ??
        process.env.MEMOSEB_SYNC_INTERVAL_MIN
    )
    const syncIntervalMinutes =
      Number.isFinite(rawInterval) && rawInterval > 0
        ? clampSyncInterval(rawInterval)
        : DEFAULT_SYNC_INTERVAL_MINUTES

    const rawTailscale = meta.get('node.tailscale_discovery')
    const tailscaleDiscovery =
      rawTailscale !== undefined ? rawTailscale === 'true' : true
    const rawTailscaleBin = meta.get('node.tailscale_bin')?.trim()
    const tailscaleBin =
      rawTailscaleBin && rawTailscaleBin.length > 0 ? rawTailscaleBin : null

    return {
      nodeId,
      nodeName,
      enabled,
      role,
      listenHost,
      listenPort,
      authToken,
      autoSync,
      lanDiscovery,
      unassignedGroupPolicy,
      syncIntervalMinutes,
      tailscaleDiscovery,
      tailscaleBin
    }
  }

  updateNodeConfig(
    patch: Partial<Omit<NodeConfiguration, 'nodeId'>>
  ): NodeConfiguration {
    const now = new Date().toISOString()
    const upsert = this.db.prepare(
      `INSERT INTO node_meta (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`
    )
    const del = this.db.prepare(`DELETE FROM node_meta WHERE key = ?`)

    if (patch.nodeName !== undefined) {
      upsert.run('node.name', patch.nodeName.trim(), now)
    }
    if (patch.enabled !== undefined) {
      upsert.run('node.enabled', String(patch.enabled), now)
    }
    if (patch.role !== undefined) {
      upsert.run('node.role', normalizeNodeRole(patch.role), now)
    }
    if (patch.listenHost !== undefined) {
      upsert.run('node.listen_host', patch.listenHost.trim(), now)
    }
    if (patch.listenPort !== undefined) {
      upsert.run('node.listen_port', String(patch.listenPort), now)
    }
    if (patch.authToken !== undefined) {
      if (patch.authToken === null || patch.authToken === '') {
        del.run('node.auth_token')
      } else {
        upsert.run('node.auth_token', patch.authToken.trim(), now)
      }
    }
    if (patch.autoSync !== undefined) {
      upsert.run('node.auto_sync', String(patch.autoSync), now)
    }
    if (patch.lanDiscovery !== undefined) {
      upsert.run('node.lan_discovery', String(patch.lanDiscovery), now)
    }
    if (patch.syncIntervalMinutes !== undefined) {
      if (
        !Number.isFinite(patch.syncIntervalMinutes) ||
        patch.syncIntervalMinutes < MIN_SYNC_INTERVAL_MINUTES ||
        patch.syncIntervalMinutes > MAX_SYNC_INTERVAL_MINUTES
      ) {
        throw new Error(
          `syncIntervalMinutes must be between ${MIN_SYNC_INTERVAL_MINUTES} and ${MAX_SYNC_INTERVAL_MINUTES}.`
        )
      }
      upsert.run('node.sync_interval_min', String(patch.syncIntervalMinutes), now)
    }
    if (patch.tailscaleDiscovery !== undefined) {
      upsert.run('node.tailscale_discovery', String(patch.tailscaleDiscovery), now)
    }
    if (patch.tailscaleBin !== undefined) {
      if (patch.tailscaleBin === null || patch.tailscaleBin.trim() === '') {
        del.run('node.tailscale_bin')
      } else {
        upsert.run('node.tailscale_bin', patch.tailscaleBin.trim(), now)
      }
    }
    if (patch.unassignedGroupPolicy !== undefined) {
      const policyVal: UnassignedGroupPolicy =
        patch.unassignedGroupPolicy === 'all' ? 'all' : 'none'
      upsert.run('node.unassigned_group_policy', policyVal, now)
    }

    return this.getNodeConfig()
  }

  setUnassignedGroupPolicy(
    policy: UnassignedGroupPolicy
  ): NodeConfiguration {
    const validPolicy: UnassignedGroupPolicy = policy === 'all' ? 'all' : 'none'
    return this.updateNodeConfig({ unassignedGroupPolicy: validPolicy })
  }

  enableNodeMode(options: {
    role: PeerRole | 'p2p'
    nodeName?: string
    listenHost?: string
    listenPort?: number
    authToken?: string | null
    autoSync?: boolean
    lanDiscovery?: boolean
    syncIntervalMinutes?: number
    tailscaleDiscovery?: boolean
    tailscaleBin?: string | null
  }): NodeConfiguration {
    return this.updateNodeConfig({
      ...(options.syncIntervalMinutes !== undefined
        ? { syncIntervalMinutes: options.syncIntervalMinutes }
        : {}),
      ...(options.tailscaleDiscovery !== undefined
        ? { tailscaleDiscovery: options.tailscaleDiscovery }
        : {}),
      ...(options.tailscaleBin !== undefined
        ? { tailscaleBin: options.tailscaleBin }
        : {}),
      enabled: true,
      role: normalizeNodeRole(options.role),
      ...(options.nodeName !== undefined ? { nodeName: options.nodeName } : {}),
      ...(options.listenHost !== undefined
        ? { listenHost: options.listenHost }
        : {}),
      ...(options.listenPort !== undefined
        ? { listenPort: options.listenPort }
        : {}),
      ...(options.authToken !== undefined
        ? { authToken: options.authToken }
        : {}),
      ...(options.autoSync !== undefined ? { autoSync: options.autoSync } : {}),
      ...(options.lanDiscovery !== undefined
        ? { lanDiscovery: options.lanDiscovery }
        : {})
    })
  }

  disableNodeMode(options?: { purgePeers?: boolean }): NodeConfiguration {
    this.updateNodeConfig({
      enabled: false,
      role: 'standalone'
    })
    if (options?.purgePeers === true) {
      this.db.prepare(`DELETE FROM sync_peers`).run()
    }
    return this.getNodeConfig()
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
    const normalizedUrl = input.url.trim().replace(/\/+$/, '')
    const normalizedRole = normalizePeerRole(input.role)
    if (normalizedRole === 'parent') {
      this.db
        .prepare(`DELETE FROM sync_peers WHERE role = 'parent' AND url != ?`)
        .run(normalizedUrl)
    }

    const existing = this.db
      .prepare(`SELECT * FROM sync_peers WHERE url = ?`)
      .get(normalizedUrl) as RawPeerRow | undefined

    const now = new Date().toISOString()
    if (existing) {
      const peerName = input.name?.trim() || existing.name
      const peerNodeId =
        input.peerNodeId !== undefined ? input.peerNodeId : existing.peer_node_id
      const authToken =
        input.authToken !== undefined ? input.authToken : existing.auth_token
      const lastSyncAt =
        input.lastSyncAt !== undefined ? input.lastSyncAt : existing.last_sync_at
      const lastStatus =
        input.lastStatus !== undefined ? input.lastStatus : existing.last_status

      this.db
        .prepare(
          `UPDATE sync_peers
           SET role = ?,
               name = ?,
               peer_node_id = ?,
               auth_token = ?,
               last_sync_at = ?,
               last_status = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          normalizedRole,
          peerName,
          peerNodeId,
          authToken,
          lastSyncAt,
          lastStatus,
          now,
          existing.id
        )

      const updated = this.db
        .prepare(`SELECT * FROM sync_peers WHERE id = ?`)
        .get(existing.id) as unknown as RawPeerRow
      return mapRowToPeerRecord(updated)
    }

    const id = crypto.randomUUID()
    let defaultName = normalizedUrl
    try {
      defaultName = new URL(normalizedUrl).host || normalizedUrl
    } catch {
      defaultName = normalizedUrl
    }
    const peerName = input.name?.trim() || defaultName

    this.db
      .prepare(
        `INSERT INTO sync_peers (
           id, peer_node_id, role, name, url, auth_token, last_sync_at, last_status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.peerNodeId ?? null,
        normalizedRole,
        peerName,
        normalizedUrl,
        input.authToken ?? null,
        input.lastSyncAt ?? null,
        input.lastStatus ?? null,
        now
      )

    const inserted = this.db
      .prepare(`SELECT * FROM sync_peers WHERE id = ?`)
      .get(id) as unknown as RawPeerRow
    return mapRowToPeerRecord(inserted)
  }

  removePeer(urlOrId: string, options?: { exclude?: boolean }): boolean {
    const trimmed = urlOrId.trim()
    const normalizedUrl = trimmed.replace(/\/+$/, '')
    if (options?.exclude) {
      const rows = this.db
        .prepare(
          `SELECT peer_node_id FROM sync_peers
           WHERE id = ? OR peer_node_id = ? OR name = ? OR url = ? OR url = ?`
        )
        .all(trimmed, trimmed, trimmed, trimmed, normalizedUrl) as Array<{
        peer_node_id: string | null
      }>
      for (const row of rows) {
        if (row.peer_node_id) this.excludePeer(row.peer_node_id)
      }
    }
    const res = this.db
      .prepare(
        `DELETE FROM sync_peers
         WHERE id = ? OR peer_node_id = ? OR name = ? OR url = ? OR url = ?`
      )
      .run(trimmed, trimmed, trimmed, trimmed, normalizedUrl)
    return res.changes > 0
  }

  /** nodeIds que la discovery no vuelve a registrar (`node remove`). */
  getExcludedPeerIds(): string[] {
    const row = this.db
      .prepare(`SELECT value FROM node_meta WHERE key = 'node.excluded_peers'`)
      .get() as { value: string } | undefined
    if (!row) return []
    try {
      const parsed = JSON.parse(row.value)
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
    } catch {
      return []
    }
  }

  excludePeer(nodeId: string): void {
    this.writeExcludedPeers([...this.getExcludedPeerIds(), nodeId.trim()])
  }

  includePeer(nodeId: string): void {
    this.writeExcludedPeers(this.getExcludedPeerIds().filter((id) => id !== nodeId.trim()))
  }

  private writeExcludedPeers(ids: string[]): void {
    const unique = Array.from(new Set(ids.filter((id) => id.length > 0)))
    if (unique.length === 0) {
      this.db.prepare(`DELETE FROM node_meta WHERE key = 'node.excluded_peers'`).run()
      return
    }
    this.db
      .prepare(
        `INSERT INTO node_meta (key, value, updated_at) VALUES ('node.excluded_peers', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(unique), new Date().toISOString())
  }

  listPeers(role?: PeerRole | 'p2p'): SyncPeerRecord[] {
    let rows: RawPeerRow[]
    if (role) {
      const normalizedRole = normalizePeerRole(role)
      rows = this.db
        .prepare(
          `SELECT * FROM sync_peers WHERE role = ? ORDER BY updated_at DESC`
        )
        .all(normalizedRole) as unknown as RawPeerRow[]
    } else {
      rows = this.db
        .prepare(`SELECT * FROM sync_peers ORDER BY updated_at DESC`)
        .all() as unknown as RawPeerRow[]
    }
    return rows.map(mapRowToPeerRecord)
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
    const trimmed = urlOrId.trim()
    const normalizedUrl = trimmed.replace(/\/+$/, '')
    const peer = this.db
      .prepare(
        `SELECT * FROM sync_peers
         WHERE id = ? OR peer_node_id = ? OR name = ? OR url = ? OR url = ?
         LIMIT 1`
      )
      .get(trimmed, trimmed, trimmed, trimmed, normalizedUrl) as
      | RawPeerRow
      | undefined
    if (!peer) {
      return
    }
    const now = new Date().toISOString()
    const lastSyncAt =
      state.lastSyncAt !== undefined ? state.lastSyncAt : peer.last_sync_at
    const lastStatus =
      state.lastStatus !== undefined ? state.lastStatus : peer.last_status
    const peerNodeId =
      state.peerNodeId !== undefined ? state.peerNodeId : peer.peer_node_id
    const name =
      state.name !== undefined && state.name.trim().length > 0
        ? state.name.trim()
        : peer.name

    this.db
      .prepare(
        `UPDATE sync_peers
         SET last_sync_at = ?,
             last_status = ?,
             peer_node_id = ?,
             name = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(lastSyncAt, lastStatus, peerNodeId, name, now, peer.id)
  }

  upsertGroup(input: {
    name: string
    description?: string
    projects?: readonly string[]
    categories?: readonly string[]
    permissions?: GroupPermissionMode
    groupToken?: string | null
  }): SyncGroupRecord {
    const groupName = normalizeGroupName(input.name)
    const existing = this.getGroup(groupName)
    const now = new Date().toISOString()

    const description =
      input.description !== undefined
        ? input.description.trim()
        : existing
          ? existing.description
          : ''

    let projects: string[]
    if (input.projects !== undefined) {
      if (input.projects.length === 0 || input.projects.includes('*')) {
        projects = ['*']
      } else {
        const set = new Set<string>()
        for (const p of input.projects) {
          const trimmed = p.trim()
          if (!trimmed) continue
          const slug = slugifyProjectId(trimmed)
          if (slug) {
            set.add(slug)
          }
        }
        projects = Array.from(set)
      }
    } else if (existing) {
      projects = existing.projects
    } else {
      projects = ['*']
    }

    let categories: string[]
    if (input.categories !== undefined) {
      if (input.categories.length === 0 || input.categories.includes('*')) {
        categories = ['*']
      } else {
        const set = new Set<string>()
        for (const cat of input.categories) {
          const trimmed = cat.trim()
          if (!isMemoryCategory(trimmed)) {
            throw new Error(
              `Invalid memory category: "${cat}". Must be one of: architecture, convention, bugfix, decision, domain.`
            )
          }
          set.add(trimmed)
        }
        categories = Array.from(set)
      }
    } else if (existing) {
      categories = existing.categories
    } else {
      categories = ['*']
    }

    let permissions: GroupPermissionMode
    if (input.permissions !== undefined) {
      if (!isGroupPermissionMode(input.permissions)) {
        throw new Error(
          `Invalid group permission mode: "${input.permissions}". Must be one of: readwrite, readonly, writeonly.`
        )
      }
      permissions = input.permissions
    } else if (existing) {
      permissions = existing.permissions
    } else {
      permissions = 'readwrite'
    }

    let groupToken: string | null
    if (input.groupToken !== undefined) {
      if (input.groupToken === null || input.groupToken.trim() === '') {
        groupToken = null
      } else {
        groupToken = input.groupToken.trim()
      }
    } else if (existing) {
      groupToken = existing.groupToken
    } else {
      groupToken = null
    }

    if (existing) {
      this.db
        .prepare(
          `UPDATE sync_groups
           SET description = ?,
               projects = ?,
               categories = ?,
               permissions = ?,
               group_token = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          description,
          JSON.stringify(projects),
          JSON.stringify(categories),
          permissions,
          groupToken,
          now,
          existing.id
        )
      return this.getGroup(existing.id)!
    }

    const id = crypto.randomUUID()
    this.db
      .prepare(
        `INSERT INTO sync_groups (
           id, name, description, projects, categories, permissions, group_token, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        groupName,
        description,
        JSON.stringify(projects),
        JSON.stringify(categories),
        permissions,
        groupToken,
        now,
        now
      )

    return this.getGroup(id)!
  }

  getGroup(nameOrId: string): SyncGroupRecord | null {
    const trimmed = nameOrId?.trim()
    if (!trimmed) {
      return null
    }
    const slug = slugifyProjectId(trimmed)
    const row = this.db
      .prepare(
        `SELECT * FROM sync_groups
         WHERE id = ? OR name = ? OR name = ?
         LIMIT 1`
      )
      .get(trimmed, trimmed, slug) as RawGroupRow | undefined
    if (!row) {
      return null
    }
    return this.mapRowToGroupRecord(row)
  }

  listGroups(): SyncGroupRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM sync_groups ORDER BY name ASC`)
      .all() as unknown as RawGroupRow[]
    return rows.map((r) => this.mapRowToGroupRecord(r))
  }

  deleteGroup(nameOrId: string): boolean {
    const group = this.getGroup(nameOrId)
    if (!group) {
      return false
    }
    this.db
      .prepare(`DELETE FROM sync_group_members WHERE group_id = ?`)
      .run(group.id)
    const res = this.db
      .prepare(`DELETE FROM sync_groups WHERE id = ?`)
      .run(group.id)
    return res.changes > 0
  }

  addNodeToGroup(
    groupNameOrId: string,
    peerIdentifier: string
  ): SyncGroupRecord {
    const group = this.getGroup(groupNameOrId)
    if (!group) {
      throw new Error(`Group "${groupNameOrId}" not found.`)
    }

    const trimmedId = peerIdentifier?.trim()
    if (!trimmedId) {
      throw new Error('Peer identifier cannot be empty.')
    }
    const normalizedUrl = trimmedId.replace(/\/+$/, '')

    const peer = this.db
      .prepare(
        `SELECT * FROM sync_peers
         WHERE id = ? OR peer_node_id = ? OR name = ? OR url = ? OR url = ?
         LIMIT 1`
      )
      .get(trimmedId, trimmedId, trimmedId, trimmedId, normalizedUrl) as
      | RawPeerRow
      | undefined

    // Si el identificador corresponde a un peer registrado, la membresía se
    // guarda por su identidad local (id y URL), que es lo que se resuelve en red
    const identifiersToInsert = new Set<string>()
    identifiersToInsert.add(trimmedId)
    if (peer) {
      identifiersToInsert.add(peer.id)
      identifiersToInsert.add(peer.url.replace(/\/+$/, ''))
    }

    const now = new Date().toISOString()
    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO sync_group_members (group_id, peer_identifier, added_at)
       VALUES (?, ?, ?)`
    )
    for (const id of identifiersToInsert) {
      insertStmt.run(group.id, id, now)
    }

    return this.getGroup(group.id)!
  }

  removeNodeFromGroup(
    groupNameOrId: string,
    peerIdentifier: string
  ): SyncGroupRecord {
    const group = this.getGroup(groupNameOrId)
    if (!group) {
      throw new Error(`Group "${groupNameOrId}" not found.`)
    }

    const trimmedId = peerIdentifier?.trim()
    if (!trimmedId) {
      throw new Error('Peer identifier cannot be empty.')
    }
    const normalizedUrl = trimmedId.replace(/\/+$/, '')

    const peer = this.db
      .prepare(
        `SELECT * FROM sync_peers
         WHERE id = ? OR peer_node_id = ? OR name = ? OR url = ? OR url = ?
         LIMIT 1`
      )
      .get(trimmedId, trimmedId, trimmedId, trimmedId, normalizedUrl) as
      | RawPeerRow
      | undefined

    const toRemove = new Set<string>([trimmedId])
    if (peer) {
      if (peer.id) toRemove.add(peer.id)
      if (peer.peer_node_id) toRemove.add(peer.peer_node_id)
      if (peer.name) toRemove.add(peer.name)
      if (peer.url) {
        toRemove.add(peer.url)
        toRemove.add(peer.url.replace(/\/+$/, ''))
      }
    }

    const delStmt = this.db.prepare(
      `DELETE FROM sync_group_members WHERE group_id = ? AND peer_identifier = ?`
    )
    for (const id of toRemove) {
      delStmt.run(group.id, id)
    }

    return this.getGroup(group.id)!
  }

  getPeerGroups(
    peerIdentifiers: readonly (string | null | undefined)[]
  ): SyncGroupRecord[] {
    const searchIds = new Set<string>()
    for (const raw of peerIdentifiers) {
      if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed.length > 0) {
          searchIds.add(trimmed)
          searchIds.add(trimmed.replace(/\/+$/, ''))
        }
      }
    }

    if (searchIds.size === 0) {
      return []
    }

    const peerRows = this.db
      .prepare(`SELECT * FROM sync_peers`)
      .all() as unknown as RawPeerRow[]

    // Solo la identidad del peer registrado localmente (id, URL o su IP):
    // nunca su nombre ni el nodeId que declaró en un handshake
    for (const peer of peerRows) {
      const normUrl = peer.url.replace(/\/+$/, '')
      const matches = searchIds.has(peer.id) || searchIds.has(peer.url) || searchIds.has(normUrl)
      if (matches) {
        searchIds.add(peer.id)
        searchIds.add(peer.url)
        searchIds.add(normUrl)
        try {
          searchIds.add(new URL(peer.url).hostname.replace(/^\[|\]$/g, ''))
        } catch {
          // URL inválida: solo id y URL
        }
      }
    }

    const idList = Array.from(searchIds)
    const placeholders = idList.map(() => '?').join(',')
    const groupRows = this.db
      .prepare(
        `SELECT DISTINCT g.*
         FROM sync_groups g
         JOIN sync_group_members m ON g.id = m.group_id
         WHERE m.peer_identifier IN (${placeholders})
         ORDER BY g.name ASC`
      )
      .all(...idList) as unknown as RawGroupRow[]

    return groupRows.map((r) => this.mapRowToGroupRecord(r))
  }

  findGroupByToken(token: string | null | undefined): SyncGroupRecord | null {
    if (!token || typeof token !== 'string') {
      return null
    }
    const trimmed = token.trim()
    if (!trimmed) {
      return null
    }

    const tokenHash = crypto.createHash('sha256').update(trimmed).digest()

    const rows = this.db
      .prepare(
        `SELECT * FROM sync_groups
         WHERE group_token IS NOT NULL AND group_token != ''
         ORDER BY name ASC`
      )
      .all() as unknown as RawGroupRow[]

    for (const row of rows) {
      if (!row.group_token) continue
      const rowHash = crypto
        .createHash('sha256')
        .update(row.group_token.trim())
        .digest()
      if (crypto.timingSafeEqual(tokenHash, rowHash)) {
        return this.mapRowToGroupRecord(row)
      }
    }

    return null
  }

  evaluatePeerPermissions(input?: {
    peerId?: string | null
    peerNodeId?: string | null
    peerName?: string | null
    peerUrl?: string | null
    matchedGroupByToken?: string | null
  }): EffectivePeerPermissions {
    const allGroups = this.listGroups()
    if (allGroups.length === 0) {
      return {
        unrestricted: true,
        groups: [],
        canPush: () => true,
        canPull: () => true
      }
    }

    const memberGroups = this.getPeerGroups([input?.peerId, input?.peerUrl])

    if (input?.matchedGroupByToken && input.matchedGroupByToken.trim()) {
      const tokenGroup =
        this.getGroup(input.matchedGroupByToken) ??
        this.findGroupByToken(input.matchedGroupByToken)
      if (tokenGroup && !memberGroups.some((g) => g.id === tokenGroup.id)) {
        memberGroups.push(tokenGroup)
      }
    }

    if (memberGroups.length === 0) {
      const policy = this.getNodeConfig().unassignedGroupPolicy ?? 'none'
      if (policy === 'all') {
        return {
          unrestricted: true,
          groups: [],
          canPush: () => true,
          canPull: () => true
        }
      }
      return {
        unrestricted: false,
        groups: [],
        canPush: () => false,
        canPull: () => false
      }
    }

    return {
      unrestricted: false,
      groups: memberGroups.map((g) => g.name),
      canPush: (projectId: string, category?: MemoryCategory | string) => {
        const normProject = slugifyProjectId(projectId)
        const normCategory =
          category !== undefined &&
          category !== null &&
          String(category).trim().length > 0
            ? String(category).trim()
            : undefined
        return memberGroups.some((group) => {
          const hasPerm =
            group.permissions === 'readwrite' || group.permissions === 'writeonly'
          if (!hasPerm) return false

          const projectMatches =
            group.projects.includes('*') || group.projects.includes(normProject)
          if (!projectMatches) return false

          const categoryMatches =
            !normCategory ||
            group.categories.includes('*') ||
            group.categories.includes(normCategory)
          return categoryMatches
        })
      },
      canPull: (projectId: string, category?: MemoryCategory | string) => {
        const normProject = slugifyProjectId(projectId)
        const normCategory =
          category !== undefined &&
          category !== null &&
          String(category).trim().length > 0
            ? String(category).trim()
            : undefined
        return memberGroups.some((group) => {
          const hasPerm =
            group.permissions === 'readwrite' || group.permissions === 'readonly'
          if (!hasPerm) return false

          const projectMatches =
            group.projects.includes('*') || group.projects.includes(normProject)
          if (!projectMatches) return false

          const categoryMatches =
            !normCategory ||
            group.categories.includes('*') ||
            group.categories.includes(normCategory)
          return categoryMatches
        })
      }
    }
  }

  private mapRowToGroupRecord(row: RawGroupRow): SyncGroupRecord {
    const memberRows = this.db
      .prepare(
        `SELECT peer_identifier FROM sync_group_members
         WHERE group_id = ?
         ORDER BY added_at ASC, peer_identifier ASC`
      )
      .all(row.id) as Array<{ peer_identifier: string }>
    const memberNodeIds = memberRows.map((m) => m.peer_identifier)

    let projects: string[] = ['*']
    try {
      const parsed = JSON.parse(row.projects)
      if (Array.isArray(parsed)) {
        projects = parsed.map(String)
      }
    } catch {
      // fallback
    }

    let categories: string[] = ['*']
    try {
      const parsed = JSON.parse(row.categories)
      if (Array.isArray(parsed)) {
        categories = parsed.map(String)
      }
    } catch {
      // fallback
    }

    const permissions: GroupPermissionMode = isGroupPermissionMode(row.permissions)
      ? row.permissions
      : 'readwrite'

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      projects,
      categories,
      permissions,
      groupToken: row.group_token ?? null,
      memberNodeIds,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  }

  exportSnapshot(options?: ExportOptions): VaultSnapshotV1 {
    const targetProjectId = options?.projectId
      ? slugifyProjectId(options.projectId)
      : null
    const since = options?.since ?? null
    const includeTombstones = options?.includeTombstones !== false

    let memoriesSql = 'SELECT * FROM memories WHERE 1=1'
    const memoriesParams: string[] = []
    if (targetProjectId) {
      memoriesSql += ' AND project_id = ?'
      memoriesParams.push(targetProjectId)
    }
    // >= y no >: la marca `since` tiene resolución de milisegundos y un cambio
    // hecho en el mismo milisegundo que el último sync se perdía. Reenviar el
    // borde es idempotente (LWW lo descarta).
    if (since) {
      memoriesSql += ' AND updated_at >= ?'
      memoriesParams.push(since)
    }
    memoriesSql += ' ORDER BY created_at ASC, id ASC'
    const memoryRows = this.db
      .prepare(memoriesSql)
      .all(...memoriesParams) as unknown as RawMemoryRow[]
    const exportedMemories: MemoryRecord[] = memoryRows.map(mapRowToMemoryRecord)

    let exportedTombstones: ExportedTombstone[] = []
    if (includeTombstones) {
      let tombstonesSql = 'SELECT * FROM memory_tombstones WHERE 1=1'
      const tombstonesParams: string[] = []
      if (targetProjectId) {
        tombstonesSql += ' AND project_id = ?'
        tombstonesParams.push(targetProjectId)
      }
      if (since) {
        tombstonesSql += ' AND deleted_at >= ?'
        tombstonesParams.push(since)
      }
      tombstonesSql += ' ORDER BY deleted_at ASC, memory_id ASC'
      const tombstoneRows = this.db
        .prepare(tombstonesSql)
        .all(...tombstonesParams) as unknown as Array<{
        memory_id: string
        project_id: string
        content_hash: string
        deleted_at: string
        origin_node_id: string | null
      }>
      exportedTombstones = tombstoneRows.map((r) => ({
        memoryId: r.memory_id,
        projectId: r.project_id,
        contentHash: r.content_hash,
        deletedAt: r.deleted_at,
        originNodeId: r.origin_node_id ?? null
      }))
    }

    const projectMap = new Map<string, ExportedProject>()
    if (targetProjectId) {
      const pRow = this.db
        .prepare(`SELECT * FROM projects WHERE id = ?`)
        .get(targetProjectId) as
        | {
            id: string
            name: string
            root_path: string
            updated_at: string
          }
        | undefined
      if (pRow) {
        projectMap.set(pRow.id, {
          id: pRow.id,
          name: pRow.name,
          rootPath: pRow.root_path,
          updatedAt: pRow.updated_at
        })
      }
    } else if (since) {
      const pRows = this.db
        .prepare(`SELECT * FROM projects WHERE updated_at >= ?`)
        .all(since) as unknown as Array<{
        id: string
        name: string
        root_path: string
        updated_at: string
      }>
      for (const r of pRows) {
        projectMap.set(r.id, {
          id: r.id,
          name: r.name,
          rootPath: r.root_path,
          updatedAt: r.updated_at
        })
      }
    } else {
      const pRows = this.db
        .prepare(`SELECT * FROM projects`)
        .all() as unknown as Array<{
        id: string
        name: string
        root_path: string
        updated_at: string
      }>
      for (const r of pRows) {
        projectMap.set(r.id, {
          id: r.id,
          name: r.name,
          rootPath: r.root_path,
          updatedAt: r.updated_at
        })
      }
    }

    for (const mem of exportedMemories) {
      if (!projectMap.has(mem.projectId)) {
        const pRow = this.db
          .prepare(`SELECT * FROM projects WHERE id = ?`)
          .get(mem.projectId) as
          | {
              id: string
              name: string
              root_path: string
              updated_at: string
            }
          | undefined
        if (pRow) {
          projectMap.set(pRow.id, {
            id: pRow.id,
            name: pRow.name,
            rootPath: pRow.root_path,
            updatedAt: pRow.updated_at
          })
        }
      }
    }

    const exportedProjects = Array.from(projectMap.values()).sort((a, b) =>
      a.id.localeCompare(b.id)
    )

    const basePayload: Omit<VaultSnapshotV1, 'checksum'> = {
      format: 'memoseb-snapshot',
      version: 1,
      exportedAt: new Date().toISOString(),
      originNodeId: this.getNodeId(),
      projectFilter: targetProjectId,
      projects: exportedProjects,
      memories: exportedMemories,
      tombstones: exportedTombstones
    }

    const checksum = computeSnapshotChecksum(basePayload)
    return {
      ...basePayload,
      checksum
    }
  }

  exportP2PPayload(options?: ExportOptions): P2PSyncPayloadV1 {
    const snapshot = this.exportSnapshot(options)
    const config = this.getNodeConfig()
    return snapshotToP2PPayload(snapshot, {
      originNodeName: config.nodeName
    })
  }

  importP2PPayload(
    payload: P2PSyncPayloadV1 | unknown,
    options?: ImportOptions
  ): ImportResult {
    const snapshot = p2pPayloadToSnapshot(payload)
    return this.importSnapshot(snapshot, options)
  }

  importSnapshot(
    rawSnapshot: VaultSnapshotV1 | unknown,
    options?: ImportOptions
  ): ImportResult {
    const unwrapped = unwrapP2PEnvelope(rawSnapshot)
    let snapshot: VaultSnapshotV1
    if (isP2PContractPayload(unwrapped)) {
      snapshot = p2pPayloadToSnapshot(unwrapped)
    } else {
      snapshot = verifySnapshot(unwrapped)
    }
    const strategy = options?.strategy ?? 'merge'
    const targetProjectId = options?.projectId
      ? slugifyProjectId(options.projectId)
      : snapshot.projectFilter
    const includeTombstones = options?.includeTombstones !== false
    const canApply = options?.canApply
    const localById = this.db.prepare(
      `SELECT project_id, category FROM memories WHERE id = ?`
    )
    const isAllowed = (id: string, projectId: string, category?: string): boolean => {
      if (!canApply) return true
      if (!canApply(projectId, category)) return false
      const local = localById.get(id) as
        | { project_id: string; category: string }
        | undefined
      return !local || canApply(local.project_id, local.category)
    }

    let projectsImported = 0
    let memoriesCreated = 0
    let memoriesUpdated = 0
    let memoriesSkipped = 0
    let tombstonesApplied = 0

    this.db.exec('BEGIN IMMEDIATE;')
    try {
      if (strategy === 'replace') {
        if (targetProjectId) {
          this.db
            .prepare(`DELETE FROM memories_fts WHERE project_id = ?`)
            .run(targetProjectId)
          this.db
            .prepare(
              `DELETE FROM memory_vectors WHERE memory_id IN (SELECT id FROM memories WHERE project_id = ?)`
            )
            .run(targetProjectId)
          this.db
            .prepare(`DELETE FROM memories WHERE project_id = ?`)
            .run(targetProjectId)
          this.db
            .prepare(`DELETE FROM memory_tombstones WHERE project_id = ?`)
            .run(targetProjectId)
        } else {
          this.db.prepare(`DELETE FROM memories_fts`).run()
          this.db.prepare(`DELETE FROM memory_vectors`).run()
          this.db.prepare(`DELETE FROM memories`).run()
          this.db.prepare(`DELETE FROM memory_tombstones`).run()
          this.db.prepare(`DELETE FROM projects`).run()
        }
      }

      // 1. Import projects
      const projectsToImport = targetProjectId
        ? snapshot.projects.filter((p) => p.id === targetProjectId)
        : snapshot.projects

      const projectUpsertMerge = this.db.prepare(
        `INSERT INTO projects (id, name, root_path, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= projects.updated_at`
      )

      const projectUpsertReplace = this.db.prepare(
        `INSERT INTO projects (id, name, root_path, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           updated_at = excluded.updated_at`
      )

      for (const p of projectsToImport) {
        if (strategy === 'replace') {
          projectUpsertReplace.run(p.id, p.name, p.rootPath, p.updatedAt)
        } else {
          projectUpsertMerge.run(p.id, p.name, p.rootPath, p.updatedAt)
        }
        projectsImported++
      }

      // 2. Process tombstones
      if (includeTombstones) {
        for (const tombstone of snapshot.tombstones) {
          if (targetProjectId && tombstone.projectId !== targetProjectId) {
            continue
          }
          if (!isAllowed(tombstone.memoryId, tombstone.projectId)) {
            continue
          }

          const localTombstone = this.db
            .prepare(
              `SELECT memory_id, deleted_at FROM memory_tombstones
               WHERE memory_id = ? OR (project_id = ? AND content_hash = ?)
               LIMIT 1`
            )
            .get(
              tombstone.memoryId,
              tombstone.projectId,
              tombstone.contentHash
            ) as { memory_id: string; deleted_at: string } | undefined

          if (!localTombstone || tombstone.deletedAt >= localTombstone.deleted_at) {
            if (
              localTombstone &&
              localTombstone.memory_id !== tombstone.memoryId
            ) {
              this.db
                .prepare(`DELETE FROM memory_tombstones WHERE memory_id = ?`)
                .run(localTombstone.memory_id)
            }
            this.db
              .prepare(
                `INSERT INTO memory_tombstones (
                   memory_id, project_id, content_hash, deleted_at, origin_node_id
                 ) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(memory_id) DO UPDATE SET
                   project_id = excluded.project_id,
                   content_hash = excluded.content_hash,
                   deleted_at = excluded.deleted_at,
                   origin_node_id = excluded.origin_node_id`
              )
              .run(
                tombstone.memoryId,
                tombstone.projectId,
                tombstone.contentHash,
                tombstone.deletedAt,
                tombstone.originNodeId ?? null
              )
          }

          const localMem = this.db
            .prepare(
              `SELECT id, updated_at FROM memories
               WHERE id = ? OR (project_id = ? AND content_hash = ?)
               LIMIT 1`
            )
            .get(
              tombstone.memoryId,
              tombstone.projectId,
              tombstone.contentHash
            ) as { id: string; updated_at: string } | undefined

          if (localMem && localMem.updated_at <= tombstone.deletedAt) {
            this.db
              .prepare(`DELETE FROM memories_fts WHERE memory_id = ?`)
              .run(localMem.id)
            this.db
              .prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`)
              .run(localMem.id)
            this.db
              .prepare(`DELETE FROM memories WHERE id = ?`)
              .run(localMem.id)
            tombstonesApplied++
          }
        }
      }

      // 3. Process memories
      for (const memory of snapshot.memories) {
        if (targetProjectId && memory.projectId !== targetProjectId) {
          continue
        }
        if (!isAllowed(memory.id, memory.projectId, memory.category)) {
          memoriesSkipped++
          continue
        }

        const localTombstone = this.db
          .prepare(
            `SELECT deleted_at FROM memory_tombstones
             WHERE memory_id = ? OR (project_id = ? AND content_hash = ?)
             LIMIT 1`
          )
          .get(memory.id, memory.projectId, memory.contentHash) as
          | { deleted_at: string }
          | undefined

        if (localTombstone && localTombstone.deleted_at >= memory.updatedAt) {
          memoriesSkipped++
          continue
        }

        this.db
          .prepare(
            `DELETE FROM memory_tombstones
             WHERE (project_id = ? AND content_hash = ?) OR memory_id = ?`
          )
          .run(memory.projectId, memory.contentHash, memory.id)

        const localMem = this.db
          .prepare(
            `SELECT * FROM memories
             WHERE id = ? OR (project_id = ? AND content_hash = ?)
             LIMIT 1`
          )
          .get(memory.id, memory.projectId, memory.contentHash) as
          | RawMemoryRow
          | undefined

        const ensureProject = (projectId: string) => {
          const projectExists = this.db
            .prepare(`SELECT id FROM projects WHERE id = ?`)
            .get(projectId)
          if (!projectExists) {
            const snapProject = snapshot.projects.find((p) => p.id === projectId)
            const pName = snapProject?.name || projectId
            const pRoot =
              snapProject?.rootPath ||
              (projectId === 'global' ? 'global' : path.resolve(process.cwd()))
            const pUpdated = snapProject?.updatedAt || memory.updatedAt
            this.db
              .prepare(
                `INSERT INTO projects (id, name, root_path, updated_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
              )
              .run(projectId, pName, pRoot, pUpdated)
          }
        }

        if (!localMem) {
          ensureProject(memory.projectId)

          const tagsJson = JSON.stringify(memory.tags ?? [])
          const tagsText = (memory.tags ?? []).join(' ')
          const tokenCount =
            memory.tokenCount ||
            estimateTokens(`${memory.title}\n${memory.content}`)

          this.db
            .prepare(
              `INSERT INTO memories (
                 id, project_id, category, title, content, tags, source_agent,
                 content_hash, token_count, importance, access_count, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              memory.id,
              memory.projectId,
              memory.category,
              memory.title,
              memory.content,
              tagsJson,
              memory.sourceAgent ?? null,
              memory.contentHash,
              tokenCount,
              memory.importance,
              memory.accessCount ?? 0,
              memory.createdAt,
              memory.updatedAt
            )

          this.db
            .prepare(
              `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
               VALUES (?, ?, ?, ?, ?)`
            )
            .run(
              memory.id,
              memory.projectId,
              memory.title,
              memory.content,
              tagsText
            )

          const embeddingText = `${memory.title}\n${memory.content}\n${tagsText}`
          const vector = this.embedder.embed(embeddingText)
          const serializedVector = serializeVector(vector)
          this.db
            .prepare(
              `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(memory_id) DO UPDATE SET
                 dimensions = excluded.dimensions,
                 embedding = excluded.embedding,
                 model = excluded.model`
            )
            .run(
              memory.id,
              this.embedder.dimensions,
              serializedVector,
              this.embedder.model
            )

          memoriesCreated++
        } else {
          const shouldUpdate =
            memory.updatedAt > localMem.updated_at ||
            (memory.updatedAt === localMem.updated_at &&
              (memory.title !== localMem.title ||
                memory.importance !== Number(localMem.importance)))

          if (shouldUpdate) {
            const mergedAccessCount = Math.max(
              Number(localMem.access_count),
              memory.accessCount ?? 0
            )
            const tagsJson = JSON.stringify(memory.tags ?? [])
            const tagsText = (memory.tags ?? []).join(' ')
            const tokenCount =
              memory.tokenCount ||
              estimateTokens(`${memory.title}\n${memory.content}`)

            // Si gana el entrante, la memoria sigue su proyecto y su hash se
            // recalcula. Si el destino ya tiene ese contenido, se queda en su
            // proyecto con el hash recalculado allí; si también choca, se salta.
            // Nunca queda contenido nuevo con un hash viejo.
            const hasConflict = (projectId: string, hash: string) =>
              Boolean(
                this.db
                  .prepare(
                    `SELECT id FROM memories WHERE project_id = ? AND content_hash = ? AND id != ? LIMIT 1`
                  )
                  .get(projectId, hash, localMem.id)
              )
            let nextProjectId = memory.projectId
            let nextContentHash = computeMemoryContentHash(memory.projectId, memory.category, memory.content)
            if (hasConflict(nextProjectId, nextContentHash)) {
              nextProjectId = localMem.project_id
              nextContentHash = computeMemoryContentHash(localMem.project_id, memory.category, memory.content)
              if (hasConflict(nextProjectId, nextContentHash)) {
                memoriesSkipped++
                continue
              }
            }
            ensureProject(nextProjectId)

            this.db
              .prepare(
                `UPDATE memories
                 SET project_id = ?,
                     content_hash = ?,
                     title = ?,
                     category = ?,
                     content = ?,
                     tags = ?,
                     source_agent = ?,
                     importance = ?,
                     token_count = ?,
                     access_count = ?,
                     updated_at = ?
                 WHERE id = ?`
              )
              .run(
                nextProjectId,
                nextContentHash,
                memory.title,
                memory.category,
                memory.content,
                tagsJson,
                memory.sourceAgent ?? null,
                memory.importance,
                tokenCount,
                mergedAccessCount,
                memory.updatedAt,
                localMem.id
              )

            this.db
              .prepare(`DELETE FROM memories_fts WHERE memory_id = ?`)
              .run(localMem.id)
            this.db
              .prepare(
                `INSERT INTO memories_fts (memory_id, project_id, title, content, tags)
                 VALUES (?, ?, ?, ?, ?)`
              )
              .run(
                localMem.id,
                nextProjectId,
                memory.title,
                memory.content,
                tagsText
              )

            const embeddingText = `${memory.title}\n${memory.content}\n${tagsText}`
            const vector = this.embedder.embed(embeddingText)
            const serializedVector = serializeVector(vector)
            this.db
              .prepare(
                `INSERT INTO memory_vectors (memory_id, dimensions, embedding, model)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(memory_id) DO UPDATE SET
                   dimensions = excluded.dimensions,
                   embedding = excluded.embedding,
                   model = excluded.model`
              )
              .run(
                localMem.id,
                this.embedder.dimensions,
                serializedVector,
                this.embedder.model
              )

            memoriesUpdated++
          } else {
            memoriesSkipped++
          }
        }
      }

      this.db.exec('COMMIT;')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;')
      } catch {
        // Ignore secondary rollback errors
      }
      throw err
    }

    return {
      strategy,
      projectsImported,
      memoriesCreated,
      memoriesUpdated,
      memoriesSkipped,
      tombstonesApplied
    }
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
           p.id,
           p.name,
           p.root_path,
           p.updated_at,
           COUNT(m.id) AS memory_count,
           COALESCE(SUM(m.token_count), 0) AS total_tokens
         FROM projects p
         LEFT JOIN memories m ON m.project_id = p.id
         GROUP BY p.id
         ORDER BY p.updated_at DESC`
      )
      .all() as Array<{
      id: string
      name: string
      root_path: string
      updated_at: string
      memory_count: number
      total_tokens: number
    }>

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      rootPath: row.root_path,
      updatedAt: row.updated_at,
      memoryCount: Number(row.memory_count),
      totalTokens: Number(row.total_tokens)
    }))
  }

  getStats(): VaultStats {
    const projectRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM projects`)
      .get() as { cnt: number }
    const memoryRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(token_count), 0) AS tokens FROM memories`
      )
      .get() as { cnt: number; tokens: number }
    const vectorRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM memory_vectors`)
      .get() as { cnt: number }

    return {
      dbPath: this.dbPath,
      projectCount: Number(projectRow.cnt),
      memoryCount: Number(memoryRow.cnt),
      vectorCount: Number(vectorRow.cnt),
      totalTokens: Number(memoryRow.tokens)
    }
  }

  /**
   * PRAGMA data_version: cambia cuando otra conexión (otro proceso de CLI o MCP)
   * confirma escrituras en la base. Las escrituras de esta conexión no lo cambian.
   */
  getDataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as
      | { data_version: number }
      | undefined
    return Number(row?.data_version ?? 0)
  }

  close(): void {
    this.db.close()
  }
}
