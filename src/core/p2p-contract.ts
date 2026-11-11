import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  isMemoryCategory,
  type MemoryCategory
} from './schema.ts'
import {
  canonicalStringify,
  computeSnapshotChecksum,
  verifySnapshot,
  type ExportedProject,
  type ExportedTombstone,
  type VaultSnapshotV1
} from './snapshot.ts'
import type { MemoryRecord } from './vault.ts'

export const P2P_CONTRACT_FORMAT = 'p2p-memory-contract' as const
export const P2P_CONTRACT_VERSION = 1 as const

export const GAZE_KINDS = [
  'rule',
  'fact',
  'decision',
  'doc',
  'entry',
  'issue',
  'meeting',
  'memory'
] as const

export type GazeKind = (typeof GAZE_KINDS)[number]

export const GAZE_SOURCES = [
  'claude',
  'harvest',
  'inkwell',
  'recap',
  'bita',
  'tally',
  'import',
  'user'
] as const

export type GazeSource = (typeof GAZE_SOURCES)[number]

export const GAZE_EDGE_KINDS = [
  'link',
  'same-issue',
  'same-entry',
  'similar'
] as const

export type GazeEdgeKind = (typeof GAZE_EDGE_KINDS)[number]

export function isGazeKind(value: unknown): value is GazeKind {
  return (
    typeof value === 'string' &&
    (GAZE_KINDS as readonly string[]).includes(value)
  )
}

export function isGazeSource(value: unknown): value is GazeSource {
  return (
    typeof value === 'string' &&
    (GAZE_SOURCES as readonly string[]).includes(value)
  )
}

export function isGazeEdgeKind(value: unknown): value is GazeEdgeKind {
  return (
    typeof value === 'string' &&
    (GAZE_EDGE_KINDS as readonly string[]).includes(value)
  )
}

export interface GazeAttributeV1 {
  key: string
  value: string
}

export interface GazeEdgeV1 {
  id?: string
  sourceId?: string
  src?: string
  targetId?: string
  dst?: string
  kind: GazeEdgeKind
  weight?: number
  data?: Record<string, unknown>
  createdAt?: string
}

export interface GazeNodeV1 {
  id: string
  project?: string
  projectId?: string
  kind: GazeKind
  source: GazeSource
  sourceRef?: string | null
  title: string
  body: string
  pinned?: boolean
  until?: string | null
  createdAt: string
  updatedAt: string
  hits?: number
  contentHash?: string
  attrs?: GazeAttributeV1[]
  edges?: GazeEdgeV1[]
  tags?: string[]
}

export interface P2PProjectV1 {
  id?: string
  slug?: string
  name: string
  rootPath?: string
  bitaId?: number | null
  key?: string | null
  updatedAt: string
}

export interface P2PTombstoneV1 {
  id?: string
  memoryId?: string
  project?: string
  projectId?: string
  contentHash: string
  deletedAt: string
  originNodeId: string | null
}

export interface P2PSyncPayloadV1 {
  format: typeof P2P_CONTRACT_FORMAT
  version: typeof P2P_CONTRACT_VERSION
  app?: 'memoseb' | 'gaze'
  originNodeId: string
  originNodeName?: string
  exportedAt: string
  projectId?: string | null
  projectFilter?: string | null
  projects?: P2PProjectV1[]
  nodes: GazeNodeV1[]
  edges?: GazeEdgeV1[] | null
  tombstones: P2PTombstoneV1[]
  checksum: string
}

export interface P2PContractEnvelopeV1<T = unknown> {
  schemaVersion: 1
  ok: boolean
  command: string
  generatedAt: string
  data: T
  error?: {
    code: string
    message: string
  }
}

/**
 * Mapeo lossless de MemoryRecord a GazeNodeV1
 */
export function memoryToGazeNode(memory: MemoryRecord): GazeNodeV1 {
  const attrs: GazeAttributeV1[] = []
  const userTags: string[] = []
  const edges: GazeEdgeV1[] = []
  let tagKind: GazeKind | null = null
  let tagSource: GazeSource | null = null
  let tagSourceRef: string | null = null
  let tagUntil: string | null = null

  for (const tag of memory.tags ?? []) {
    if (tag.startsWith('gaze:kind:')) {
      const val = tag.slice('gaze:kind:'.length)
      if (isGazeKind(val)) tagKind = val
    } else if (tag.startsWith('gaze:source:')) {
      const val = tag.slice('gaze:source:'.length)
      if (isGazeSource(val)) tagSource = val
    } else if (tag.startsWith('gaze:source_ref:')) {
      tagSourceRef = tag.slice('gaze:source_ref:'.length)
    } else if (tag.startsWith('gaze:until:')) {
      tagUntil = tag.slice('gaze:until:'.length)
    } else if (tag.startsWith('gaze:edge:')) {
      // Formatos soportados:
      // gaze:edge:<dst>:<kind>[:<weight>]
      // gaze:edge:<src>-><dst>:<kind>[:<weight>]
      const rawEdge = tag.slice('gaze:edge:'.length)
      const arrowIdx = rawEdge.indexOf('->')
      let src = memory.id
      let rest = rawEdge
      if (arrowIdx !== -1) {
        src = rawEdge.slice(0, arrowIdx)
        rest = rawEdge.slice(arrowIdx + 2)
      }
      const parts = rest.split(':')
      const dst = parts[0]
      const k = parts[1]
      const weightNum = parts[2] !== undefined ? Number(parts[2]) : undefined
      if (dst && isGazeEdgeKind(k)) {
        edges.push({
          sourceId: src,
          targetId: dst,
          dst,
          kind: k,
          ...(Number.isFinite(weightNum) ? { weight: weightNum } : {})
        })
      }
    } else {
      userTags.push(tag)
    }
  }

  let kind: GazeKind
  if (tagKind) {
    kind = tagKind
  } else {
    switch (memory.category) {
      case 'convention':
        kind = 'rule'
        break
      case 'decision':
        kind = 'decision'
        break
      case 'architecture':
        kind = 'fact'
        attrs.push({ key: 'memoseb:category', value: 'architecture' })
        break
      case 'domain':
        kind = 'fact'
        attrs.push({ key: 'memoseb:category', value: 'domain' })
        break
      case 'bugfix':
        kind = 'memory'
        attrs.push({ key: 'memoseb:category', value: 'bugfix' })
        break
      default:
        kind = 'fact'
        attrs.push({ key: 'memoseb:category', value: String(memory.category) })
    }
  }

  let source: GazeSource
  if (tagSource) {
    source = tagSource
  } else if (memory.sourceAgent && isGazeSource(memory.sourceAgent)) {
    source = memory.sourceAgent
  } else {
    source = 'import'
    if (memory.sourceAgent) {
      attrs.push({ key: 'memoseb:source_agent', value: memory.sourceAgent })
    }
  }

  // Guardar cada user tag como attr además de tags array
  for (const ut of userTags) {
    attrs.push({ key: 'tag', value: ut })
  }

  attrs.push({ key: 'memoseb:token_count', value: String(memory.tokenCount) })
  attrs.push({ key: 'memoseb:importance', value: String(memory.importance) })
  attrs.push({ key: 'memoseb:access_count', value: String(memory.accessCount) })

  return {
    id: memory.id,
    project: memory.projectId,
    projectId: memory.projectId,
    kind,
    source,
    sourceRef: tagSourceRef ?? undefined,
    title: memory.title,
    body: memory.content,
    attrs,
    pinned: memory.importance >= 0.85,
    until: tagUntil ?? undefined,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    hits: memory.accessCount,
    contentHash: memory.contentHash,
    tags: userTags,
    edges: edges.length > 0 ? edges : undefined
  }
}

/**
 * contentHash canónico de memoseb: sha256("<proyecto>:<categoría>:<contenido recortado>").
 * gaze exporta exactamente esta fórmula (ADR-0012 §6.4).
 */
export function computeMemoryContentHash(
  projectId: string,
  category: MemoryCategory | string,
  content: string
): string {
  return crypto
    .createHash('sha256')
    .update(`${projectId}:${category}:${content.trim()}`)
    .digest('hex')
}

/**
 * Serializa una arista como etiqueta gaze:edge:. Si el src de la arista no es el
 * propio nodo se usa la forma gaze:edge:<src>-><dst>:<kind>[:<weight>].
 */
export function gazeEdgeToTag(
  edge: GazeEdgeV1,
  ownerId: string
): string | null {
  const dst = edge.targetId ?? edge.dst
  if (!dst || !isGazeEdgeKind(edge.kind)) return null
  const src = edge.sourceId ?? edge.src ?? ownerId
  const weightStr =
    edge.weight !== undefined && Number.isFinite(edge.weight)
      ? `:${edge.weight}`
      : ''
  const prefix = src === ownerId ? '' : `${src}->`
  return `gaze:edge:${prefix}${dst}:${edge.kind}${weightStr}`
}

/**
 * Conversión de GazeNodeV1 a MemoryRecord
 */
export function gazeNodeToMemory(
  node: GazeNodeV1,
  defaultProjectId = 'global'
): MemoryRecord {
  const attrsMap = new Map<string, string>()
  const tagAttrs: string[] = []
  for (const attr of node.attrs ?? []) {
    attrsMap.set(attr.key, attr.value)
    if (attr.key === 'tag' && attr.value.trim().length > 0) {
      tagAttrs.push(attr.value.trim())
    }
  }

  let category: MemoryCategory
  const explicitCategory = attrsMap.get('memoseb:category')
  if (explicitCategory && isMemoryCategory(explicitCategory)) {
    category = explicitCategory
  } else {
    switch (node.kind) {
      case 'rule':
        category = 'convention'
        break
      case 'decision':
        category = 'decision'
        break
      case 'issue':
        category = 'bugfix'
        break
      case 'doc':
        category = 'architecture'
        break
      case 'meeting':
        category = 'decision'
        break
      case 'fact':
        category = 'domain'
        break
      case 'memory':
        category = 'domain'
        break
      case 'entry':
        category = 'domain'
        break
      default:
        category = 'domain'
    }
  }

  const explicitAgent = attrsMap.get('memoseb:source_agent')
  const sourceAgent = explicitAgent ?? node.source ?? null

  const tags: string[] = []
  const seenTags = new Set<string>()

  const addTag = (t: string) => {
    const trimmed = t.trim()
    if (trimmed.length > 0 && !seenTags.has(trimmed)) {
      seenTags.add(trimmed)
      tags.push(trimmed)
    }
  }

  // 1. Tags nativos del nodo y attrs con key === 'tag'
  if (Array.isArray(node.tags)) {
    for (const t of node.tags) addTag(t)
  }
  for (const t of tagAttrs) addTag(t)

  // 2. Metadatos de preservación de Gaze
  addTag(`gaze:kind:${node.kind}`)
  addTag(`gaze:source:${node.source}`)
  if (node.sourceRef) addTag(`gaze:source_ref:${node.sourceRef}`)
  if (node.until) addTag(`gaze:until:${node.until}`)

  // 3. Aristas de Gaze preservadas como tags (respetando el src de cada arista)
  if (Array.isArray(node.edges)) {
    for (const edge of node.edges) {
      const tag = gazeEdgeToTag(edge, node.id)
      if (tag) addTag(tag)
    }
  }

  let importance = 0.5
  if (attrsMap.has('memoseb:importance')) {
    const rawImp = Number(attrsMap.get('memoseb:importance'))
    if (Number.isFinite(rawImp)) importance = rawImp
  } else if (node.pinned === true) {
    importance = 0.9
  }

  let accessCount = 0
  if (attrsMap.has('memoseb:access_count')) {
    const rawAcc = Number(attrsMap.get('memoseb:access_count'))
    if (Number.isInteger(rawAcc)) accessCount = rawAcc
  } else if (typeof node.hits === 'number' && Number.isInteger(node.hits)) {
    accessCount = node.hits
  }

  const content =
    node.body ?? (node as unknown as { content?: string }).content ?? ''
  const projectId = node.projectId || node.project || defaultProjectId
  // Misma fórmula que storeMemory y que gaze: un hash ausente o con otra
  // fórmula se recalcula para que el emparejamiento por (proyecto, hash) funcione.
  const contentHash = computeMemoryContentHash(projectId, category, content)

  let tokenCount = 1
  if (attrsMap.has('memoseb:token_count')) {
    const rawTok = Number(attrsMap.get('memoseb:token_count'))
    if (Number.isInteger(rawTok) && rawTok > 0) tokenCount = rawTok
    else tokenCount = Math.max(1, Math.ceil(content.length / 4))
  } else {
    tokenCount = Math.max(1, Math.ceil(content.length / 4))
  }

  return {
    id: node.id,
    projectId,
    category,
    title: node.title || 'Untitled',
    content,
    tags,
    sourceAgent,
    contentHash,
    tokenCount,
    importance,
    accessCount,
    createdAt: node.createdAt || new Date().toISOString(),
    updatedAt: node.updatedAt || new Date().toISOString()
  }
}

/**
 * Checksum SHA-256 canónico para P2PSyncPayloadV1
 */
export function computeP2PPayloadChecksum(
  payload: Omit<P2PSyncPayloadV1, 'checksum'>
): string {
  const normalized = {
    format: payload.format,
    version: payload.version,
    originNodeId: payload.originNodeId,
    exportedAt: payload.exportedAt,
    projectId: payload.projectId ?? payload.projectFilter ?? null,
    nodes: payload.nodes,
    edges: payload.edges ?? [],
    tombstones: payload.tombstones
  }
  return crypto
    .createHash('sha256')
    .update(canonicalStringify(normalized))
    .digest('hex')
}

export function isP2PContractPayload(
  input: unknown
): input is P2PSyncPayloadV1 {
  if (!input || typeof input !== 'object') return false
  const p = input as Record<string, unknown>
  return (
    p.format === P2P_CONTRACT_FORMAT &&
    p.version === P2P_CONTRACT_VERSION &&
    Array.isArray(p.nodes) &&
    typeof p.originNodeId === 'string'
  )
}

export function wrapP2PEnvelope<T = unknown>(
  command: string,
  data: T,
  error?: { code: string; message: string }
): P2PContractEnvelopeV1<T> {
  return {
    schemaVersion: 1,
    ok: !error,
    command,
    generatedAt: new Date().toISOString(),
    data,
    ...(error ? { error } : {})
  }
}

export function unwrapP2PEnvelope(raw: unknown): unknown {
  if (
    raw &&
    typeof raw === 'object' &&
    (raw as Record<string, unknown>).schemaVersion === 1 &&
    'data' in (raw as Record<string, unknown>)
  ) {
    return (raw as Record<string, unknown>).data
  }
  return raw
}

export function verifyP2PPayload(raw: unknown): P2PSyncPayloadV1 {
  const unwrapped = unwrapP2PEnvelope(raw)
  if (!unwrapped || typeof unwrapped !== 'object') {
    throw new Error('Invalid P2P payload: expected a non-null JSON object.')
  }
  const p = unwrapped as Record<string, unknown>

  if (p.format !== P2P_CONTRACT_FORMAT) {
    throw new Error(
      `Invalid P2P format: expected "${P2P_CONTRACT_FORMAT}", received "${String(p.format)}".`
    )
  }
  if (p.version !== P2P_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported P2P version: expected ${P2P_CONTRACT_VERSION}, received ${String(p.version)}.`
    )
  }
  if (typeof p.originNodeId !== 'string' || p.originNodeId.trim().length === 0) {
    throw new Error('Invalid P2P payload: originNodeId must be a non-empty string.')
  }
  if (typeof p.exportedAt !== 'string' || p.exportedAt.trim().length === 0) {
    throw new Error('Invalid P2P payload: exportedAt must be a non-empty string.')
  }
  if (!Array.isArray(p.nodes)) {
    throw new Error('Invalid P2P payload: nodes must be an array.')
  }
  if (p.edges !== undefined && p.edges !== null && !Array.isArray(p.edges)) {
    throw new Error('Invalid P2P payload: edges must be an array when provided.')
  }
  if (!Array.isArray(p.tombstones)) {
    throw new Error('Invalid P2P payload: tombstones must be an array.')
  }
  if (typeof p.checksum !== 'string' || p.checksum.trim().length === 0) {
    throw new Error('Invalid P2P payload: checksum must be a non-empty string.')
  }

  const typedPayload = p as unknown as P2PSyncPayloadV1
  const expectedChecksum = computeP2PPayloadChecksum(typedPayload)
  if (p.checksum !== expectedChecksum) {
    throw new Error(
      `P2P payload checksum mismatch: expected ${expectedChecksum}, received ${p.checksum}.`
    )
  }

  return typedPayload
}

export function snapshotToP2PPayload(
  snapshot: VaultSnapshotV1,
  options?: { app?: 'memoseb' | 'gaze'; originNodeName?: string }
): P2PSyncPayloadV1 {
  const verified = verifySnapshot(snapshot)
  const nodes: GazeNodeV1[] = verified.memories.map(memoryToGazeNode)

  const allEdges: GazeEdgeV1[] = []
  for (const n of nodes) {
    if (Array.isArray(n.edges)) {
      for (const e of n.edges) {
        allEdges.push(e)
      }
    }
  }

  const tombstones: P2PTombstoneV1[] = verified.tombstones.map((t) => ({
    id: t.memoryId,
    memoryId: t.memoryId,
    project: t.projectId,
    projectId: t.projectId,
    contentHash: t.contentHash,
    deletedAt: t.deletedAt,
    originNodeId: t.originNodeId
  }))

  const projects: P2PProjectV1[] = verified.projects.map((p) => ({
    id: p.id,
    slug: p.id,
    name: p.name,
    rootPath: p.rootPath,
    updatedAt: p.updatedAt
  }))

  const basePayload: Omit<P2PSyncPayloadV1, 'checksum'> = {
    format: P2P_CONTRACT_FORMAT,
    version: P2P_CONTRACT_VERSION,
    app: options?.app ?? 'memoseb',
    originNodeId: verified.originNodeId,
    originNodeName: options?.originNodeName,
    exportedAt: verified.exportedAt,
    projectId: verified.projectFilter ?? null,
    projectFilter: verified.projectFilter ?? null,
    projects,
    nodes,
    edges: allEdges.length > 0 ? allEdges : undefined,
    tombstones
  }

  const checksum = computeP2PPayloadChecksum(basePayload)
  return {
    ...basePayload,
    checksum
  }
}

export function p2pPayloadToSnapshot(rawPayload: unknown): VaultSnapshotV1 {
  const unwrapped = unwrapP2PEnvelope(rawPayload)
  if (
    unwrapped &&
    typeof unwrapped === 'object' &&
    (unwrapped as Record<string, unknown>).format === 'memoseb-snapshot'
  ) {
    return verifySnapshot(unwrapped)
  }

  const payload = verifyP2PPayload(unwrapped)
  const defaultProjectId =
    payload.projectId || payload.projectFilter || 'global'

  const projectMap = new Map<string, ExportedProject>()
  if (Array.isArray(payload.projects)) {
    for (const p of payload.projects) {
      const pid = p.id || p.slug
      if (pid) {
        projectMap.set(pid, {
          id: pid,
          name: p.name || pid,
          rootPath: p.rootPath || '',
          updatedAt: p.updatedAt || new Date().toISOString()
        })
      }
    }
  }

  // Las aristas de nivel superior se fusionan en el nodo src que viaja en el
  // payload; si el src no viaja, no hay memoria a la cual adjuntarlas.
  const topLevelEdges = new Map<string, GazeEdgeV1[]>()
  if (Array.isArray(payload.edges)) {
    for (const edge of payload.edges) {
      if (!edge || typeof edge !== 'object') continue
      const src = edge.sourceId ?? edge.src
      if (!src) continue
      const list = topLevelEdges.get(src) ?? []
      list.push(edge)
      topLevelEdges.set(src, list)
    }
  }

  const memories: MemoryRecord[] = []
  for (const n of payload.nodes) {
    const extraEdges = topLevelEdges.get(n.id)
    const nodeWithEdges: GazeNodeV1 = extraEdges
      ? { ...n, edges: [...(n.edges ?? []), ...extraEdges] }
      : n
    const mem = gazeNodeToMemory(nodeWithEdges, defaultProjectId)
    memories.push(mem)
    if (!projectMap.has(mem.projectId)) {
      projectMap.set(mem.projectId, {
        id: mem.projectId,
        name: mem.projectId,
        rootPath: '',
        updatedAt: mem.updatedAt
      })
    }
  }

  const tombstones: ExportedTombstone[] = []
  for (const t of payload.tombstones) {
    const memoryId = t.memoryId || t.id || ''
    const projectId = t.projectId || t.project || defaultProjectId
    tombstones.push({
      memoryId,
      projectId,
      contentHash: t.contentHash,
      deletedAt: t.deletedAt,
      originNodeId: t.originNodeId ?? null
    })
    if (!projectMap.has(projectId)) {
      projectMap.set(projectId, {
        id: projectId,
        name: projectId,
        rootPath: '',
        updatedAt: t.deletedAt
      })
    }
  }

  const projects = Array.from(projectMap.values()).sort((a, b) =>
    a.id.localeCompare(b.id)
  )

  const baseSnapshot: Omit<VaultSnapshotV1, 'checksum'> = {
    format: 'memoseb-snapshot',
    version: 1,
    exportedAt: payload.exportedAt,
    originNodeId: payload.originNodeId,
    projectFilter: payload.projectId ?? payload.projectFilter ?? null,
    projects,
    memories,
    tombstones
  }

  const checksum = computeSnapshotChecksum(baseSnapshot)
  return {
    ...baseSnapshot,
    checksum
  }
}

export function writeP2PPayloadFile(
  filePath: string,
  payload: P2PSyncPayloadV1
): string {
  const verified = verifyP2PPayload(payload)
  const resolvedPath = path.resolve(filePath)
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, JSON.stringify(verified, null, 2), 'utf-8')
  return resolvedPath
}

export function readP2PPayloadFile(filePath: string): P2PSyncPayloadV1 {
  const resolvedPath = path.resolve(filePath)
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`P2P payload file does not exist: ${resolvedPath}`)
  }
  const content = fs.readFileSync(resolvedPath, 'utf-8')
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new Error(
      `Failed to parse P2P JSON at ${resolvedPath}: ${(err as Error).message}`
    )
  }
  return verifyP2PPayload(parsed)
}
