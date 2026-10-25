import crypto from 'node:crypto'
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
  isMemoryCategory,
  openVaultDatabase,
  type MemoryCategory
} from './schema.ts'

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

export class MemoryVault {
  readonly dbPath: string
  private readonly db: DatabaseSync
  private readonly embedder: EmbeddingProvider

  constructor(options?: {
    dbPath?: string
    runtime?: SystemRuntime
    embedder?: EmbeddingProvider
  }) {
    const runtime = options?.runtime ?? new SystemRuntime()
    this.dbPath =
      options?.dbPath ??
      runtime.env.MEMOSEB_DB_PATH ??
      path.join(runtime.stateRoot, '..', 'memoseb', 'vault.sqlite')
    this.db = openVaultDatabase(this.dbPath)
    this.embedder = options?.embedder ?? new LocalFeatureHashEmbedder()
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
      .prepare(`SELECT id FROM memories WHERE id = ?`)
      .get(id) as { id: string } | undefined
    if (!existing) {
      return false
    }
    this.db.prepare(`DELETE FROM memories_fts WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(id)
    this.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id)
    return true
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

  close(): void {
    this.db.close()
  }
}
