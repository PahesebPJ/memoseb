import type { MemoryCategory } from '../../src/core/schema.ts'
import type { MemoryVault, RecallResult } from '../../src/core/vault.ts'

export const EVAL_PROJECT_ID = 'recall-eval'

interface EvalMemory {
  key: string
  category: MemoryCategory
  title: string
  content: string
  tags?: string[]
}

export interface EvalQuery {
  query: string
  expected: string
}

export const EVAL_MEMORIES: readonly EvalMemory[] = [
  { key: 'sync-p2p', category: 'architecture', title: 'Sincronización P2P dual', content: 'memoseb soporta sincronización jerárquica (parent/child) y P2P entre nodos peer con los endpoints /api/v1/p2p/exchange.', tags: ['sync', 'p2p'] },
  { key: 'acl-groups', category: 'architecture', title: 'Grupos y permisos ACL', content: 'Las tablas sync_groups y sync_group_members restringen qué nodos pueden leer o escribir por proyecto y categoría.', tags: ['acl'] },
  { key: 'fts-hybrid', category: 'architecture', title: 'Búsqueda híbrida', content: 'El recall combina FTS5 (BM25) con similitud de coseno y las fusiona con Reciprocal Rank Fusion.' },
  { key: 'token-budget', category: 'convention', title: 'Presupuesto de tokens', content: 'Las respuestas de recall y context se recortan según --max-tokens estimando 4 caracteres por token.' },
  { key: 'wal', category: 'architecture', title: 'SQLite en modo WAL', content: 'La base vault.sqlite se abre con journal_mode=WAL para permitir lecturas concurrentes del servidor MCP y la CLI.' },
  { key: 'tombstones', category: 'architecture', title: 'Tombstones de borrado', content: 'Al olvidar una memoria se guarda un tombstone para que la eliminación se propague en la siguiente sincronización.' },
  { key: 'content-hash', category: 'convention', title: 'Deduplicación por hash', content: 'Cada memoria se identifica por sha256(project:category:content); contenido idéntico actualiza en vez de duplicar.' },
  { key: 'tailscale', category: 'architecture', title: 'Descubrimiento vía Tailscale', content: 'Los peers se descubren con tailscale status --json y se conectan por la IP 100.x de la tailnet.' },
  { key: 'udp-discovery', category: 'architecture', title: 'Descubrimiento LAN por UDP', content: 'memoseb node discover envía un broadcast UDP MEMOSEB_DISCOVER_V1 y espera anuncios de otros nodos.' },
  { key: 'snapshot', category: 'architecture', title: 'Snapshots portables', content: 'export genera un JSON con checksum que import verifica antes de fusionar o reemplazar la bóveda.' },
  { key: 'mcp-stdio', category: 'architecture', title: 'Servidor MCP por stdio', content: 'memoseb mcp expone memory_recall, memory_store y memory_briefing a los agentes mediante stdio.' },
  { key: 'hubseb', category: 'architecture', title: 'Integración con hubseb', content: 'memoseb se registra en hubseb como proveedor de la capacidad memory.vault.' },
  { key: 'node22', category: 'convention', title: 'Requisito Node 22', content: 'Se usa node:sqlite integrado, que exige Node.js 22 o superior; no hay dependencias nativas.' },
  { key: 'tests', category: 'convention', title: 'Convención de tests', content: 'Los tests usan node --test con archivos *.spec.ts y una bóveda temporal en os.tmpdir().' },
  { key: 'commits', category: 'convention', title: 'Commits convencionales', content: 'Los mensajes de commit siguen Conventional Commits en inglés.' },
  { key: 'token-security', category: 'decision', title: 'Token de sincronización', content: 'El servidor de sync exige un bearer token (MEMOSEB_SYNC_TOKEN) salvo cuando escucha en 127.0.0.1.' },
  { key: 'auto-sync', category: 'architecture', title: 'Auto-sync periódico', content: 'Un servicio systemd de usuario ejecuta la sincronización cada N minutos (1-1440).' },
  { key: 'project-detect', category: 'convention', title: 'Detección de proyecto', content: 'El proyecto se deduce de la raíz git o del package.json del directorio actual.' },
  { key: 'analyzer', category: 'domain', title: 'Analizador de proyecto', content: 'memoseb analyze lee README, package.json y tsconfig para crear memorias base del dominio.' },
  { key: 'importance', category: 'convention', title: 'Importancia de memorias', content: 'Cada memoria tiene una importancia 0-1 que ordena el briefing y suma un pequeño peso al recall.' },
  { key: 'en-react', category: 'decision', title: 'React state management', content: 'The dashboard uses Zustand for global state instead of Redux to reduce boilerplate.' },
  { key: 'en-auth', category: 'architecture', title: 'Authentication flow', content: 'Login uses OAuth2 with PKCE; refresh tokens are rotated on every use and stored in httpOnly cookies.' },
  { key: 'en-db-migrations', category: 'convention', title: 'Database migrations', content: 'Schema migrations run with Drizzle Kit before each deploy; never edit an applied migration.' },
  { key: 'en-ci', category: 'convention', title: 'CI pipeline', content: 'GitHub Actions runs typecheck, lint and tests on every pull request; main is protected.' },
  { key: 'en-logging', category: 'convention', title: 'Structured logging', content: 'Logs are emitted as JSON with pino, including request id and user id for tracing.' },
  { key: 'en-cache', category: 'architecture', title: 'Redis cache invalidation', content: 'Product pages are cached in Redis for 5 minutes and invalidated on update events.' },
  { key: 'bug-fts-crash', category: 'bugfix', title: 'Bug: consulta FTS con comillas', content: 'Las comillas en la consulta rompían MATCH de FTS5; se sanitiza cada término entre comillas dobles.' },
  { key: 'bug-port', category: 'bugfix', title: 'Bug: puerto ocupado', content: 'memoseb node serve fallaba con EADDRINUSE si otro proceso usaba el puerto 7077; ahora reporta el PID.' },
  { key: 'decision-no-vectordb', category: 'decision', title: 'Decisión: sin base vectorial externa', content: 'Se descartó usar una base de datos vectorial externa; los vectores Float32Array se guardan como BLOB en SQLite.' },
  { key: 'i18n', category: 'convention', title: 'Comunicación en español', content: 'La documentación y los mensajes al usuario se redactan en español; el código en inglés.' }
]

/** Queries answerable by lexical overlap (accents, stopwords, inflections). */
export const LEXICAL_QUERIES: readonly EvalQuery[] = [
  { query: 'como funciona la sincronización', expected: 'sync-p2p' },
  { query: 'sincronizacion entre nodos', expected: 'sync-p2p' },
  { query: 'permisos de los grupos', expected: 'acl-groups' },
  { query: 'la eliminación de memorias se propaga', expected: 'tombstones' },
  { query: 'límite de tokens en el contexto', expected: 'token-budget' },
  { query: 'descubrimiento de peers en tailscale', expected: 'tailscale' },
  { query: 'broadcast UDP para descubrir nodos', expected: 'udp-discovery' },
  { query: 'exportar e importar la bóveda', expected: 'snapshot' },
  { query: 'qué versión de Node necesito', expected: 'node22' },
  { query: 'cómo se escriben los tests', expected: 'tests' },
  { query: 'refresh token rotation', expected: 'en-auth' },
  { query: 'redis cache', expected: 'en-cache' },
  { query: 'database migrations deploy', expected: 'en-db-migrations' },
  { query: 'error EADDRINUSE puerto', expected: 'bug-port' },
  { query: 'por qué no usamos una base de datos vectorial', expected: 'decision-no-vectordb' },
  { query: 'comillas en la búsqueda FTS', expected: 'bug-fts-crash' },
  { query: 'token de sincronización bearer', expected: 'token-security' },
  { query: 'importancia de las memorias en el briefing', expected: 'importance' }
]

/** Paraphrases with little or no word overlap: only a semantic embedder can solve them. */
export const SEMANTIC_QUERIES: readonly EvalQuery[] = [
  { query: 'replicar datos entre máquinas', expected: 'sync-p2p' },
  { query: 'how do I log in users securely', expected: 'en-auth' },
  { query: 'global state library for the frontend', expected: 'en-react' },
  { query: 'what checks run on pull requests', expected: 'en-ci' },
  { query: 'control de acceso por nodo', expected: 'acl-groups' },
  { query: 'backup of all memories to a file', expected: 'snapshot' }
]

/** Queries with no relevant memory: every returned result is noise. */
export const UNRELATED_QUERIES: readonly string[] = [
  'receta de pizza margarita',
  'weather forecast for tomorrow',
  'mejor película de ciencia ficción'
]

export function seedEvalVault(vault: MemoryVault): Map<string, string> {
  const idByKey = new Map<string, string>()
  for (const memory of EVAL_MEMORIES) {
    const stored = vault.storeMemory({
      projectId: EVAL_PROJECT_ID,
      category: memory.category,
      title: memory.title,
      content: memory.content,
      tags: memory.tags,
      importance: 0.5
    })
    idByKey.set(memory.key, stored.memory.id)
  }
  return idByKey
}

export interface EvalMetrics {
  recallAt3: number
  mrr: number
  misses: string[]
}

export interface EvalReport {
  lexical: EvalMetrics
  semantic: EvalMetrics
  /** Average number of results returned for unrelated queries (lower is better). */
  noisePerQuery: number
}

type RecallFn = (query: string) => RecallResult | Promise<RecallResult>

async function scoreQueries(
  queries: readonly EvalQuery[],
  idByKey: Map<string, string>,
  recall: RecallFn
): Promise<EvalMetrics> {
  let hits = 0
  let reciprocalSum = 0
  const misses: string[] = []
  for (const { query, expected } of queries) {
    const result = await recall(query)
    const rank = result.memories.findIndex((m) => m.id === idByKey.get(expected)) + 1
    if (rank > 0 && rank <= 3) hits++
    else misses.push(`${query} → ${expected} (rank ${rank || '-'})`)
    if (rank > 0) reciprocalSum += 1 / rank
  }
  return {
    recallAt3: hits / queries.length,
    mrr: reciprocalSum / queries.length,
    misses
  }
}

export async function runRecallEval(
  idByKey: Map<string, string>,
  recall: RecallFn
): Promise<EvalReport> {
  const lexical = await scoreQueries(LEXICAL_QUERIES, idByKey, recall)
  const semantic = await scoreQueries(SEMANTIC_QUERIES, idByKey, recall)
  let noise = 0
  for (const query of UNRELATED_QUERIES) {
    noise += (await recall(query)).memories.length
  }
  return { lexical, semantic, noisePerQuery: noise / UNRELATED_QUERIES.length }
}

export function evalRecallOptions(): { projectId: string; includeGlobal: boolean; limit: number; maxTokens: number } {
  return { projectId: EVAL_PROJECT_ID, includeGlobal: false, limit: 5, maxTokens: 100_000 }
}

export function formatEvalReport(label: string, report: EvalReport): string {
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`
  return [
    `[recall-eval] ${label}`,
    `  lexical : recall@3=${pct(report.lexical.recallAt3)} MRR=${report.lexical.mrr.toFixed(3)}`,
    `  semantic: recall@3=${pct(report.semantic.recallAt3)} MRR=${report.semantic.mrr.toFixed(3)}`,
    `  noise   : ${report.noisePerQuery.toFixed(2)} results per unrelated query`,
    ...report.lexical.misses.map((m) => `  miss(lexical) ${m}`),
    ...report.semantic.misses.map((m) => `  miss(semantic) ${m}`)
  ].join('\n')
}
