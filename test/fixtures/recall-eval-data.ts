import type { MemoryCategory } from '../../src/core/schema.ts'

export type EvalLanguage = 'es' | 'en' | 'mixed'
export type EvalQueryKind = 'lexical' | 'paraphrase'

export interface EvalMemory {
  key: string
  category: MemoryCategory
  title: string
  content: string
  tags?: string[]
  /** Questions this memory answers, as an agent would write them when storing it. */
  aliases?: string[]
}

export interface EvalQuery {
  query: string
  expected: string
  kind: EvalQueryKind
  lang: EvalLanguage
}

export interface UnrelatedQuery {
  query: string
  lang: EvalLanguage
}

// Memories are grouped so that each group holds several look-alike distractors
// (sync, auth, tokens, tests...): a query must pick the right one among them.
export const EVAL_MEMORIES: readonly EvalMemory[] = [
  // --- Sync and replication (distractor group) ---
  { key: 'sync-p2p', category: 'architecture', title: 'Sincronización P2P dual', content: 'memoseb soporta sincronización jerárquica (parent/child) y P2P entre nodos peer con los endpoints /api/v1/p2p/exchange.', tags: ['sync', 'p2p'], aliases: ['¿cómo se replican las memorias entre equipos?', 'how do two machines share memories?'] },
  { key: 'sync-two-pass', category: 'architecture', title: 'Sync en dos pasadas', content: 'memoseb sync hace primero push de los cambios locales y después pull de los remotos, usando updated_at como cursor incremental.', tags: ['sync'], aliases: ['¿en qué orden se envían y reciben los cambios?', 'is sync incremental?'] },
  { key: 'sync-lww', category: 'decision', title: 'Resolución de conflictos LWW', content: 'Cuando dos nodos editan la misma memoria gana la de updated_at más reciente (last-writer-wins); no hay merge de texto.', tags: ['sync', 'conflicts'], aliases: ['¿qué pasa si dos nodos editan la misma memoria?', 'how are conflicting edits resolved?'] },
  { key: 'tombstones', category: 'architecture', title: 'Tombstones de borrado', content: 'Al olvidar una memoria se guarda un tombstone para que la eliminación se propague en la siguiente sincronización.', aliases: ['¿cómo se propagan los borrados?', 'why does a deleted memory come back?'] },
  { key: 'auto-sync', category: 'architecture', title: 'Auto-sync periódico', content: 'Un servicio systemd de usuario ejecuta la sincronización cada N minutos (1-1440).', tags: ['sync', 'systemd'], aliases: ['¿cada cuánto se sincroniza solo?', 'can sync run in the background on a schedule?'] },
  { key: 'sync-gaze', category: 'architecture', title: 'Contrato de interoperabilidad con Gaze', content: 'El contrato p2p-memory-contract v1 traduce memorias a nodos, aristas y atributos compatibles con gaze.', tags: ['p2p', 'gaze'], aliases: ['¿qué formato usa el intercambio con gaze?', 'graph format for exchanging memories'] },
  { key: 'sync-batch', category: 'convention', title: 'Tamaño de lote del sync', content: 'Cada petición de sync envía como máximo 500 memorias; los lotes mayores se paginan con un cursor.', tags: ['sync'], aliases: ['¿cuántas memorias viajan por petición?', 'pagination of large syncs'] },
  { key: 'sync-dry-run', category: 'convention', title: 'Sync en modo simulación', content: 'memoseb sync --dry-run muestra qué memorias se enviarían y recibirían sin escribir en la bóveda.', tags: ['sync', 'cli'], aliases: ['¿puedo ver qué cambiaría antes de sincronizar?', 'preview a sync without applying it'] },

  // --- Discovery and networking ---
  { key: 'tailscale', category: 'architecture', title: 'Descubrimiento vía Tailscale', content: 'Los peers se descubren con tailscale status --json y se conectan por la IP 100.x de la tailnet.', tags: ['network'], aliases: ['¿cómo encuentra nodos fuera de la red local?', 'find peers over a VPN mesh'] },
  { key: 'udp-discovery', category: 'architecture', title: 'Descubrimiento LAN por UDP', content: 'memoseb node discover envía un broadcast UDP MEMOSEB_DISCOVER_V1 y espera anuncios de otros nodos.', tags: ['network'], aliases: ['¿cómo se detectan nodos en la misma red?', 'local network peer discovery'] },
  { key: 'sync-port', category: 'convention', title: 'Puerto por defecto del nodo', content: 'memoseb node serve escucha en el puerto 7077 y el anuncio UDP usa el 7432.', tags: ['network'], aliases: ['¿qué puertos hay que abrir en el firewall?', 'default listening port'] },
  { key: 'tailscale-dedup', category: 'bugfix', title: 'Bug: sondeos duplicados de tailscale', content: 'El bucle de auto-sync lanzaba tailscale status en cada ciclo y abría ventanas de consola en Windows; ahora el sondeo se deduplica y cachea.', tags: ['windows', 'tailscale'], aliases: ['¿por qué parpadean consolas en Windows?', 'tailscale.exe flashing windows'] },
  { key: 'windows-service', category: 'bugfix', title: 'Reiniciar el servicio tras actualizar en Windows', content: 'En Windows npm install -g no reinicia el demonio memoseb node serve; hay que desinstalar e instalar el servicio de nuevo.', tags: ['windows'], aliases: ['¿por qué sigue corriendo la versión vieja después de actualizar?', 'upgrade does not take effect on Windows'] },

  // --- Auth, tokens and permissions (distractor group) ---
  { key: 'token-security', category: 'decision', title: 'Token de sincronización', content: 'El servidor de sync exige un bearer token (MEMOSEB_SYNC_TOKEN) salvo cuando escucha en 127.0.0.1.', tags: ['auth', 'sync'], aliases: ['¿cómo se protege el servidor de sync?', 'do I need a password for sync?'] },
  { key: 'timing-safe', category: 'decision', title: 'Comparación de tokens en tiempo constante', content: 'Los tokens se comparan con crypto.timingSafeEqual sobre su hash SHA-256 para evitar ataques de temporización.', tags: ['auth', 'security'], aliases: ['¿por qué no se compara el token con ===?', 'timing attack protection'] },
  { key: 'acl-groups', category: 'architecture', title: 'Grupos y permisos ACL', content: 'Las tablas sync_groups y sync_group_members restringen qué nodos pueden leer o escribir por proyecto y categoría.', tags: ['acl'], aliases: ['¿cómo limito qué puede ver cada nodo?', 'per-node read/write restrictions'] },
  { key: 'acl-default-policy', category: 'decision', title: 'Política para nodos sin grupo', content: 'unassignedGroupPolicy decide si un nodo sin grupo ve todo (all) o nada (none); por defecto es all para no romper instalaciones previas.', tags: ['acl'], aliases: ['¿qué ve un nodo que no está en ningún grupo?', 'default access for unassigned nodes'] },
  { key: 'group-token', category: 'architecture', title: 'Auto-enrolamiento con groupToken', content: 'Un nodo que presenta el groupToken de un grupo se une solo a ese grupo; el token no concede acceso a otros grupos.', tags: ['acl', 'auth'], aliases: ['¿cómo se une un nodo nuevo a un grupo?', 'join a group automatically'] },
  { key: 'en-auth', category: 'architecture', title: 'Authentication flow', content: 'Login uses OAuth2 with PKCE; refresh tokens are rotated on every use and stored in httpOnly cookies.', tags: ['auth'], aliases: ['how do users sign in?', 'where are session tokens kept?'] },
  { key: 'en-jwt-expiry', category: 'convention', title: 'Access token lifetime', content: 'Access JWTs expire after 15 minutes and carry only the user id and roles; never put emails in claims.', tags: ['auth', 'jwt'], aliases: ['how long is an access token valid?', 'what goes inside the JWT?'] },
  { key: 'en-api-keys', category: 'convention', title: 'API keys for integrations', content: 'Partner integrations authenticate with API keys hashed with argon2 in the api_keys table; keys are shown once at creation.', tags: ['auth'], aliases: ['how do third parties call our API?', 'can I see an API key again?'] },
  { key: 'en-rbac', category: 'architecture', title: 'Role-based permissions', content: 'Permissions are checked by a requireRole middleware; admins, editors and viewers map to fixed scopes.', tags: ['auth', 'rbac'], aliases: ['how do we check what a user may do?', 'which roles exist?'] },
  { key: 'en-2fa', category: 'decision', title: 'Two-factor authentication', content: 'TOTP second factor is mandatory for admin accounts and optional for everyone else; SMS codes were rejected.', tags: ['auth', 'security'], aliases: ['is 2FA required?', 'why no SMS codes?'] },
  { key: 'secrets-env', category: 'convention', title: 'Secretos en variables de entorno', content: 'Las credenciales se leen de .env (nunca se commitean) y en CI de los secrets del repositorio.', tags: ['security'], aliases: ['¿dónde guardo las contraseñas?', 'where do credentials live?'] },

  // --- Token budget and context (distractor with auth tokens) ---
  { key: 'token-budget', category: 'convention', title: 'Presupuesto de tokens', content: 'Las respuestas de recall y context se recortan según --max-tokens estimando 4 caracteres por token.', tags: ['tokens'], aliases: ['¿cómo evito llenar la ventana de contexto del agente?', 'limit how much text recall returns'] },
  { key: 'token-estimate', category: 'convention', title: 'Estimación de tokens', content: 'estimateTokens divide la longitud del texto entre 4 y redondea hacia arriba; no se usa un tokenizador real.', tags: ['tokens'], aliases: ['¿cómo se cuentan los tokens?', 'is there a real tokenizer?'] },
  { key: 'briefing', category: 'architecture', title: 'Briefing de contexto', content: 'memoseb context resume las memorias más importantes del proyecto actual para inyectarlas al iniciar una sesión.', tags: ['context'], aliases: ['¿qué debo leer al empezar una sesión?', 'project summary for a new agent session'] },
  { key: 'importance', category: 'convention', title: 'Importancia de memorias', content: 'Cada memoria tiene una importancia 0-1 que ordena el briefing y suma un pequeño peso al recall.', aliases: ['¿cómo priorizo una memoria?', 'what does the importance field do?'] },
  { key: 'access-count', category: 'convention', title: 'Contador de accesos', content: 'Cada vez que recall devuelve una memoria incrementa access_count, que se usa como desempate en el briefing.', aliases: ['¿se registra cuántas veces se usa una memoria?', 'usage statistics per memory'] },

  // --- Search engine internals ---
  { key: 'fts-hybrid', category: 'architecture', title: 'Búsqueda híbrida', content: 'El recall combina FTS5 (BM25) con similitud de coseno y las fusiona con Reciprocal Rank Fusion.', tags: ['search'], aliases: ['¿cómo se ordenan los resultados de búsqueda?', 'how is relevance computed?'] },
  { key: 'text-normalize', category: 'convention', title: 'Normalización de texto', content: 'Consultas y vectores léxicos quitan acentos, pasan a minúsculas y eliminan stopwords en español e inglés.', tags: ['search'], aliases: ['¿importan las tildes al buscar?', 'are accents ignored in queries?'] },
  { key: 'min-similarity', category: 'decision', title: 'Umbral mínimo de similitud', content: 'Los candidatos que solo llegan por vector se descartan si su coseno queda bajo minSimilarity del modelo, para no devolver ruido.', tags: ['search'], aliases: ['¿por qué una búsqueda sin relación no devuelve nada?', 'cosine floor per model'] },
  { key: 'hash-embedder', category: 'architecture', title: 'Embedder léxico por hashing', content: 'El embedder por defecto proyecta trigramas y palabras a 384 dimensiones con hashing; no necesita descargar modelos.', tags: ['embeddings'], aliases: ['¿qué embeddings se usan sin ML?', 'default vectors without a model'] },
  { key: 'ml-optional', category: 'decision', title: 'Modelos ML opcionales', content: 'transformers.js se instala bajo demanda con memoseb model enable; no es dependencia del paquete porque onnxruntime pesa ~550 MB.', tags: ['embeddings', 'ml'], aliases: ['¿cómo activo la búsqueda semántica?', 'why is the package so small without ML?'] },
  { key: 'model-revision', category: 'decision', title: 'Revisiones de modelo fijadas', content: 'Cada modelo del catálogo se descarga en un commit fijo de Hugging Face para que los pesos sean reproducibles.', tags: ['ml', 'security'], aliases: ['¿puede cambiar el modelo descargado si actualizan el repo?', 'reproducible model weights'] },
  { key: 'vector-model-tag', category: 'architecture', title: 'Etiqueta de modelo en vectores', content: 'memory_vectors.model guarda qué embedder produjo cada vector; recall solo compara vectores del modelo activo.', tags: ['embeddings'], aliases: ['¿qué pasa con los vectores al cambiar de modelo?', 'mixing vectors from different models'] },
  { key: 'decision-no-vectordb', category: 'decision', title: 'Decisión: sin base vectorial externa', content: 'Se descartó usar una base de datos vectorial externa; los vectores Float32Array se guardan como BLOB en SQLite.', tags: ['embeddings'], aliases: ['¿por qué no usamos pgvector o Pinecone?', 'where are embeddings stored?'] },
  { key: 'duplicate-detect', category: 'convention', title: 'Aviso de memorias casi duplicadas', content: 'Al guardar, si otra memoria del mismo proyecto supera duplicateSimilarity se informa en el campo similar.', tags: ['dedup'], aliases: ['¿me avisa si guardo algo repetido?', 'near-duplicate warning'] },
  { key: 'content-hash', category: 'convention', title: 'Deduplicación por hash', content: 'Cada memoria se identifica por sha256(project:category:content); contenido idéntico actualiza en vez de duplicar.', tags: ['dedup'], aliases: ['¿qué pasa si guardo exactamente lo mismo dos veces?', 'identical content handling'] },

  // --- Storage ---
  { key: 'wal', category: 'architecture', title: 'SQLite en modo WAL', content: 'La base vault.sqlite se abre con journal_mode=WAL para permitir lecturas concurrentes del servidor MCP y la CLI.', tags: ['sqlite'], aliases: ['¿pueden la CLI y el MCP abrir la bóveda a la vez?', 'concurrent database access'] },
  { key: 'vault-path', category: 'convention', title: 'Ubicación de la bóveda', content: 'La bóveda vive en ~/.local/share/memoseb/vault.sqlite salvo que MEMOSEB_DB_PATH indique otra ruta.', tags: ['sqlite'], aliases: ['¿dónde está el archivo de la base de datos?', 'change the database location'] },
  { key: 'node22', category: 'convention', title: 'Requisito Node 22', content: 'Se usa node:sqlite integrado, que exige Node.js 22 o superior; no hay dependencias nativas.', aliases: ['¿qué versión de Node necesito?', 'why no better-sqlite3?'] },
  { key: 'schema-migrations', category: 'convention', title: 'Migraciones del esquema de la bóveda', content: 'Las columnas nuevas se añaden con PRAGMA table_info y ALTER TABLE idempotentes al abrir la bóveda; nunca se borran columnas.', tags: ['sqlite'], aliases: ['¿cómo se actualiza el esquema de una bóveda vieja?', 'adding a column safely'] },
  { key: 'snapshot', category: 'architecture', title: 'Snapshots portables', content: 'export genera un JSON con checksum que import verifica antes de fusionar o reemplazar la bóveda.', tags: ['backup'], aliases: ['¿cómo hago una copia de seguridad?', 'move memories to another computer'] },
  { key: 'import-replace', category: 'convention', title: 'Import con reemplazo', content: 'memoseb import --replace borra las memorias del proyecto antes de cargar el snapshot; sin la opción se fusiona por LWW.', tags: ['backup'], aliases: ['¿import sobrescribe lo que ya tengo?', 'restore exactly from a file'] },
  { key: 'multi-project', category: 'architecture', title: 'Bóveda multi-proyecto', content: 'Una sola bóveda guarda memorias de muchos proyectos separadas por project_id; las globales usan el proyecto global.', aliases: ['¿cada repo tiene su propia base?', 'memories shared across projects'] },

  // --- MCP and agents ---
  { key: 'mcp-stdio', category: 'architecture', title: 'Servidor MCP por stdio', content: 'memoseb mcp expone memory_recall, memory_store y memory_briefing a los agentes mediante stdio.', tags: ['mcp'], aliases: ['¿cómo usa un agente la memoria?', 'tools available to Claude Code'] },
  { key: 'mcp-restart', category: 'convention', title: 'Reiniciar sesiones tras actualizar', content: 'Las sesiones de agente con memoseb mcp abierto siguen ejecutando el código viejo hasta reiniciarlas.', tags: ['mcp'], aliases: ['¿por qué el agente no ve la versión nueva?', 'reload the MCP server'] },
  { key: 'mcp-model-cache', category: 'architecture', title: 'Modelo cacheado en el MCP', content: 'El servidor MCP mantiene cargado el modelo semántico entre llamadas y lo recarga si cambia la configuración.', tags: ['mcp', 'ml'], aliases: ['¿se carga el modelo en cada búsqueda?', 'model warm between calls'] },
  { key: 'hubseb', category: 'architecture', title: 'Integración con hubseb', content: 'memoseb se registra en hubseb como proveedor de la capacidad memory.vault.', aliases: ['¿cómo descubren otras herramientas la memoria?', 'capability registry'] },
  { key: 'setup-agents', category: 'convention', title: 'Instalación para agentes', content: 'memoseb setup copia skills y reglas para Claude Code, Codex, OpenCode y Antigravity y registra el servidor MCP.', tags: ['agents'], aliases: ['¿cómo conecto memoseb a mi agente?', 'install rules for Codex'] },
  { key: 'analyzer', category: 'domain', title: 'Analizador de proyecto', content: 'memoseb analyze lee README, package.json y tsconfig para crear memorias base del dominio.', aliases: ['¿cómo genero memorias iniciales de un repo?', 'bootstrap knowledge for a new project'] },
  { key: 'project-detect', category: 'convention', title: 'Detección de proyecto', content: 'El proyecto se deduce de la raíz git o del package.json del directorio actual.', aliases: ['¿cómo sabe en qué proyecto estoy?', 'project id from the working directory'] },

  // --- Tests (distractor group) ---
  { key: 'tests', category: 'convention', title: 'Convención de tests', content: 'Los tests usan node --test con archivos *.spec.ts y una bóveda temporal en os.tmpdir().', tags: ['tests'], aliases: ['¿con qué framework se prueba?', 'where do test files go?'] },
  { key: 'tests-fake-ml', category: 'convention', title: 'Backend ML falso en tests', content: 'Los tests nunca descargan modelos: inyectan un MlBackend falso con embeddings deterministas.', tags: ['tests', 'ml'], aliases: ['¿los tests necesitan internet?', 'mock the embedding model'] },
  { key: 'recall-eval', category: 'convention', title: 'Evaluación de precisión de recall', content: 'scripts/recall-eval.ts mide recall@1, recall@3, MRR y ruido sobre una bóveda de prueba con consultas etiquetadas.', tags: ['tests', 'search'], aliases: ['¿cómo sé si la búsqueda mejoró?', 'measure search quality'] },
  { key: 'tests-ci-matrix', category: 'convention', title: 'Matriz de CI', content: 'CI ejecuta typecheck, build y tests en Ubuntu, macOS y Windows con Node 22 y 24.', tags: ['tests', 'ci'], aliases: ['¿en qué sistemas operativos se prueba?', 'which Node versions are supported?'] },
  { key: 'en-e2e', category: 'convention', title: 'End-to-end tests', content: 'Playwright e2e tests run against a seeded staging database nightly; they are too slow for every pull request.', tags: ['tests'], aliases: ['when do browser tests run?', 'why are e2e tests not on every PR?'] },
  { key: 'en-coverage', category: 'convention', title: 'Coverage threshold', content: 'Unit test coverage must stay above 80% lines; c8 fails the build below that.', tags: ['tests'], aliases: ['minimum test coverage', 'why did the build fail on coverage?'] },
  { key: 'en-flaky', category: 'bugfix', title: 'Flaky test: clock dependent', content: 'The invoices test failed around midnight UTC because it used the real clock; it now uses fake timers.', tags: ['tests'], aliases: ['why did a test fail only at night?', 'intermittent failure in invoices'] },
  { key: 'en-test-db', category: 'convention', title: 'Test database isolation', content: 'Each integration test runs inside a transaction that is rolled back, so tests never see each other’s rows.', tags: ['tests', 'database'], aliases: ['do tests share data?', 'clean database between tests'] },

  // --- Release and tooling ---
  { key: 'commits', category: 'convention', title: 'Commits convencionales', content: 'Los mensajes de commit siguen Conventional Commits en inglés.', aliases: ['¿cómo escribo el mensaje de commit?', 'commit message format'] },
  { key: 'release-flow', category: 'convention', title: 'Publicación en npm', content: 'Crear un GitHub Release vX.Y.Z dispara publish.yml, que valida la versión y publica en npm con provenance.', tags: ['release'], aliases: ['¿cómo saco una versión nueva?', 'how is the package published?'] },
  { key: 'version-bump', category: 'convention', title: 'Bump de versión', content: 'El bump toca package.json, package-lock.json y src/version.ts en una rama chore/release-* con su PR.', tags: ['release'], aliases: ['¿qué archivos cambio al subir versión?', 'where is the version number?'] },
  { key: 'worktrees', category: 'convention', title: 'Trabajo en worktrees', content: 'Cada tarea se hace en una rama propia dentro de .claude/worktrees para no ensuciar el checkout principal.', tags: ['git'], aliases: ['¿dónde trabajo en una feature?', 'isolate work from the main checkout'] },
  { key: 'i18n', category: 'convention', title: 'Comunicación en español', content: 'La documentación y los mensajes al usuario se redactan en español; el código en inglés.', aliases: ['¿en qué idioma escribo la documentación?', 'language for code identifiers'] },

  // --- Bugs ---
  { key: 'bug-fts-crash', category: 'bugfix', title: 'Bug: consulta FTS con comillas', content: 'Las comillas en la consulta rompían MATCH de FTS5; se sanitiza cada término entre comillas dobles.', tags: ['search'], aliases: ['¿por qué fallaba la búsqueda con caracteres especiales?', 'search crashes on punctuation'] },
  { key: 'bug-port', category: 'bugfix', title: 'Bug: puerto ocupado', content: 'memoseb node serve fallaba con EADDRINUSE si otro proceso usaba el puerto 7077; ahora reporta el PID.', tags: ['network'], aliases: ['¿por qué no arranca el nodo?', 'address already in use'] },
  { key: 'bug-help-flag', category: 'bugfix', title: 'Bug: --help guardado como memoria', content: 'memoseb remember --help guardaba el texto --help como memoria; ahora --help imprime la ayuda y se rechaza contenido con forma de opción.', tags: ['cli'], aliases: ['¿por qué apareció una memoria llamada --help?', 'remember stored a flag'] },
  { key: 'bug-accents', category: 'bugfix', title: 'Bug: búsquedas con tilde sin resultados', content: 'Consultas como sincronización daban 0 resultados FTS porque el índice no quitaba diacríticos; se normaliza igual en consulta e índice.', tags: ['search'], aliases: ['¿por qué buscar con acento no encontraba nada?', 'accented query returned nothing'] },
  { key: 'bug-wal-lock', category: 'bugfix', title: 'Bug: database is locked', content: 'Escrituras simultáneas de la CLI y el MCP daban SQLITE_BUSY; se añadió busy_timeout de 5 segundos.', tags: ['sqlite'], aliases: ['¿por qué sale database is locked?', 'SQLITE_BUSY errors'] },
  { key: 'bug-clock-skew', category: 'bugfix', title: 'Bug: relojes desfasados en sync', content: 'Un nodo con el reloj adelantado ganaba siempre en LWW; ahora el servidor ajusta updated_at si viene del futuro.', tags: ['sync'], aliases: ['¿por qué un equipo pisaba siempre los cambios?', 'wrong system time breaks sync'] },
  { key: 'bug-ml-prune', category: 'bugfix', title: 'Bug: runtime ML de 550 MB', content: 'npm instalaba onnxruntime para todas las plataformas; tras instalar se eliminan binarios ajenos y de GPU (~81 MB finales).', tags: ['ml'], aliases: ['¿por qué ocupaba tanto disco el modo semántico?', 'shrink the onnx install'] },

  // --- Generic English app project (cross-project noise) ---
  { key: 'en-react', category: 'decision', title: 'React state management', content: 'The dashboard uses Zustand for global state instead of Redux to reduce boilerplate.', tags: ['frontend'], aliases: ['which store library does the frontend use?', 'why not Redux?'] },
  { key: 'en-forms', category: 'convention', title: 'Form validation', content: 'Forms use react-hook-form with zod schemas shared between client and server.', tags: ['frontend'], aliases: ['how do we validate user input?', 'shared schemas for forms'] },
  { key: 'en-css', category: 'convention', title: 'Styling with Tailwind', content: 'Components are styled with Tailwind utility classes; custom CSS files are only allowed for third-party overrides.', tags: ['frontend'], aliases: ['can I write a CSS file?', 'how do we style components?'] },
  { key: 'en-i18n-front', category: 'convention', title: 'Frontend translations', content: 'UI strings live in locales/*.json and are loaded with i18next; never hardcode visible text.', tags: ['frontend'], aliases: ['where do translated strings go?', 'add a new language to the UI'] },
  { key: 'en-db-migrations', category: 'convention', title: 'Database migrations', content: 'Schema migrations run with Drizzle Kit before each deploy; never edit an applied migration.', tags: ['database'], aliases: ['how do I change a table?', 'can I modify an old migration?'] },
  { key: 'en-db-indexes', category: 'decision', title: 'Composite index on orders', content: 'orders has a composite index on (customer_id, created_at) because listing a customer history was a full scan.', tags: ['database', 'performance'], aliases: ['why is the order history query fast?', 'slow customer listing'] },
  { key: 'en-db-softdelete', category: 'decision', title: 'Soft deletes', content: 'Rows are never physically deleted; a deleted_at timestamp hides them and a monthly job purges them after 90 days.', tags: ['database'], aliases: ['what happens when a user deletes a record?', 'data retention for removed rows'] },
  { key: 'en-ci', category: 'convention', title: 'CI pipeline', content: 'GitHub Actions runs typecheck, lint and tests on every pull request; main is protected.', tags: ['ci'], aliases: ['what checks run before merging?', 'can I push directly to main?'] },
  { key: 'en-deploy', category: 'convention', title: 'Deployment', content: 'Merges to main deploy to staging automatically; production deploys are a manual approval in the pipeline.', tags: ['ci', 'deploy'], aliases: ['how does code reach production?', 'who approves a release?'] },
  { key: 'en-docker', category: 'convention', title: 'Docker images', content: 'Images are built from a distroless base with a multi-stage Dockerfile and tagged with the git SHA.', tags: ['deploy'], aliases: ['what base image do we use?', 'how are containers tagged?'] },
  { key: 'en-k8s-limits', category: 'decision', title: 'Kubernetes resource limits', content: 'Every deployment sets CPU and memory requests and limits; pods without them are rejected by an admission policy.', tags: ['deploy', 'kubernetes'], aliases: ['why was my pod rejected?', 'required container quotas'] },
  { key: 'en-logging', category: 'convention', title: 'Structured logging', content: 'Logs are emitted as JSON with pino, including request id and user id for tracing.', tags: ['observability'], aliases: ['what log format do we use?', 'trace a request across services'] },
  { key: 'en-metrics', category: 'architecture', title: 'Metrics and alerts', content: 'Services expose Prometheus metrics on /metrics; Grafana alerts page on-call when p99 latency exceeds 800 ms.', tags: ['observability'], aliases: ['when does on-call get paged?', 'where are dashboards?'] },
  { key: 'en-tracing', category: 'architecture', title: 'Distributed tracing', content: 'OpenTelemetry spans are exported to Tempo; every outgoing HTTP call propagates the traceparent header.', tags: ['observability'], aliases: ['how do we follow a request through services?', 'trace context propagation'] },
  { key: 'en-cache', category: 'architecture', title: 'Redis cache invalidation', content: 'Product pages are cached in Redis for 5 minutes and invalidated on update events.', tags: ['performance'], aliases: ['why do I see stale product data?', 'how long are pages cached?'] },
  { key: 'en-rate-limit', category: 'decision', title: 'API rate limiting', content: 'The public API allows 100 requests per minute per key using a sliding window in Redis; excess calls get HTTP 429.', tags: ['api'], aliases: ['why am I getting 429 errors?', 'how many calls can a client make?'] },
  { key: 'en-pagination', category: 'convention', title: 'Cursor pagination', content: 'List endpoints use opaque cursor pagination instead of offset, because offsets drift when rows are inserted.', tags: ['api'], aliases: ['how do I page through results?', 'why not page numbers?'] },
  { key: 'en-api-versioning', category: 'decision', title: 'API versioning', content: 'Breaking API changes ship under a new /v2 prefix; /v1 stays supported for twelve months.', tags: ['api'], aliases: ['how do we introduce breaking changes?', 'how long is the old API kept?'] },
  { key: 'en-webhooks', category: 'architecture', title: 'Webhook delivery', content: 'Webhooks are signed with HMAC-SHA256 and retried with exponential backoff for up to 24 hours.', tags: ['api'], aliases: ['how can a receiver verify our callbacks?', 'what if the endpoint is down?'] },
  { key: 'en-queue', category: 'architecture', title: 'Background jobs', content: 'Slow work like PDF generation runs in BullMQ workers; the HTTP handler only enqueues the job.', tags: ['jobs'], aliases: ['where do long-running tasks happen?', 'why is the request returning before the PDF exists?'] },
  { key: 'en-email', category: 'convention', title: 'Transactional email', content: 'Emails are sent through Postmark with MJML templates stored in emails/; never send from request handlers directly.', tags: ['email'], aliases: ['how do we send notifications to users?', 'where are mail templates?'] },
  { key: 'en-payments', category: 'architecture', title: 'Payments', content: 'Stripe Checkout handles card data; the backend only stores the customer and subscription ids.', tags: ['payments'], aliases: ['do we store credit cards?', 'how are subscriptions billed?'] },
  { key: 'en-uploads', category: 'architecture', title: 'File uploads', content: 'Browsers upload directly to S3 with presigned URLs; the API never proxies file bytes.', tags: ['storage'], aliases: ['how are images uploaded?', 'why does the API not receive files?'] },
  { key: 'en-feature-flags', category: 'convention', title: 'Feature flags', content: 'Unfinished features hide behind flags in Unleash; flags older than three months must be removed.', tags: ['release'], aliases: ['how do we ship half-done work?', 'cleanup of old toggles'] },
  { key: 'en-timezones', category: 'convention', title: 'Dates and time zones', content: 'Timestamps are stored in UTC and converted to the user time zone only in the UI with date-fns-tz.', tags: ['dates'], aliases: ['what time zone does the database use?', 'show local times to users'] },
  { key: 'en-search-service', category: 'architecture', title: 'Product search', content: 'Catalog search is served by Meilisearch, reindexed by a worker on every product change.', tags: ['search'], aliases: ['what powers the shop search box?', 'why is a new product not searchable yet?'] },
  { key: 'en-monorepo', category: 'convention', title: 'Monorepo layout', content: 'The repo is a pnpm workspace: apps/ for deployables and packages/ for shared libraries.', tags: ['tooling'], aliases: ['where does a shared library go?', 'how is the repository organized?'] },
  { key: 'en-lint', category: 'convention', title: 'Linting and formatting', content: 'Biome formats and lints the code; the pre-commit hook rejects unformatted files.', tags: ['tooling'], aliases: ['why was my commit rejected?', 'which formatter do we use?'] },
  { key: 'en-perf-images', category: 'bugfix', title: 'Slow landing page images', content: 'The landing page loaded 8 MB of PNGs; images are now served as AVIF through the CDN with width hints.', tags: ['performance'], aliases: ['why was the home page slow?', 'image optimization'] },
  { key: 'en-memory-leak', category: 'bugfix', title: 'Memory leak in websocket server', content: 'Disconnected sockets stayed in a Map and leaked memory; listeners are now removed on close.', tags: ['performance'], aliases: ['why did the realtime server run out of RAM?', 'growing heap over days'] },
  { key: 'en-n-plus-one', category: 'bugfix', title: 'N+1 queries on dashboard', content: 'The dashboard ran one query per widget owner; it now batches lookups with a DataLoader.', tags: ['database', 'performance'], aliases: ['why does the dashboard hit the database so much?', 'batch loading of related rows'] },
  { key: 'en-cors', category: 'bugfix', title: 'CORS errors from the mobile app', content: 'The API rejected requests from the Capacitor origin; it was added to the allowed origins list.', tags: ['api'], aliases: ['why does the phone app get blocked by the browser policy?', 'allowed origins'] },
  { key: 'en-accessibility', category: 'convention', title: 'Accessibility', content: 'Every interactive element needs a visible focus ring and an accessible name; axe runs in CI.', tags: ['frontend'], aliases: ['what are our a11y rules?', 'keyboard navigation requirements'] },
  { key: 'en-onboarding', category: 'domain', title: 'Customer onboarding', content: 'New customers go through a three-step wizard: company data, invite teammates, connect billing.', tags: ['product'], aliases: ['what does a new client see first?', 'signup steps'] },
  { key: 'en-tenancy', category: 'architecture', title: 'Multi-tenancy', content: 'Each customer is a tenant isolated by a tenant_id column enforced with Postgres row-level security.', tags: ['database', 'security'], aliases: ['how is customer data kept apart?', 'row level security'] }
]

/** Queries sharing key words with the answer (accents, stopwords, inflections). */
export const LEXICAL_QUERIES: readonly EvalQuery[] = [
  { query: 'como funciona la sincronización p2p', expected: 'sync-p2p', kind: 'lexical', lang: 'es' },
  { query: 'permisos de los grupos ACL', expected: 'acl-groups', kind: 'lexical', lang: 'es' },
  { query: 'la eliminación de memorias se propaga con tombstones', expected: 'tombstones', kind: 'lexical', lang: 'es' },
  { query: 'max-tokens recorte de recall', expected: 'token-budget', kind: 'lexical', lang: 'es' },
  { query: 'descubrimiento de peers en tailscale', expected: 'tailscale', kind: 'lexical', lang: 'es' },
  { query: 'broadcast UDP para descubrir nodos', expected: 'udp-discovery', kind: 'lexical', lang: 'es' },
  { query: 'snapshot JSON con checksum', expected: 'snapshot', kind: 'lexical', lang: 'es' },
  { query: 'versión de Node.js requerida para node:sqlite', expected: 'node22', kind: 'lexical', lang: 'es' },
  { query: 'tests con node --test y spec.ts', expected: 'tests', kind: 'lexical', lang: 'es' },
  { query: 'error EADDRINUSE puerto', expected: 'bug-port', kind: 'lexical', lang: 'es' },
  { query: 'base de datos vectorial externa', expected: 'decision-no-vectordb', kind: 'lexical', lang: 'es' },
  { query: 'comillas en MATCH de FTS5', expected: 'bug-fts-crash', kind: 'lexical', lang: 'es' },
  { query: 'bearer token MEMOSEB_SYNC_TOKEN', expected: 'token-security', kind: 'lexical', lang: 'es' },
  { query: 'importancia de las memorias en el briefing', expected: 'importance', kind: 'lexical', lang: 'es' },
  { query: 'conflictos last-writer-wins', expected: 'sync-lww', kind: 'lexical', lang: 'es' },
  { query: 'timingSafeEqual para comparar tokens', expected: 'timing-safe', kind: 'lexical', lang: 'es' },
  { query: 'estimar tokens dividiendo entre 4', expected: 'token-estimate', kind: 'lexical', lang: 'es' },
  { query: 'database is locked SQLITE_BUSY', expected: 'bug-wal-lock', kind: 'lexical', lang: 'mixed' },
  { query: 'sync --dry-run simulación', expected: 'sync-dry-run', kind: 'lexical', lang: 'mixed' },
  { query: 'groupToken auto-enrolamiento', expected: 'group-token', kind: 'lexical', lang: 'mixed' },
  { query: 'unassignedGroupPolicy nodos sin grupo', expected: 'acl-default-policy', kind: 'lexical', lang: 'mixed' },
  { query: 'refresh token rotation', expected: 'en-auth', kind: 'lexical', lang: 'en' },
  { query: 'redis cache invalidation', expected: 'en-cache', kind: 'lexical', lang: 'en' },
  { query: 'drizzle migrations deploy', expected: 'en-db-migrations', kind: 'lexical', lang: 'en' },
  { query: 'access JWT expire minutes', expected: 'en-jwt-expiry', kind: 'lexical', lang: 'en' },
  { query: 'API keys argon2', expected: 'en-api-keys', kind: 'lexical', lang: 'en' },
  { query: 'playwright e2e nightly', expected: 'en-e2e', kind: 'lexical', lang: 'en' },
  { query: 'coverage threshold 80%', expected: 'en-coverage', kind: 'lexical', lang: 'en' },
  { query: 'webhook HMAC retries', expected: 'en-webhooks', kind: 'lexical', lang: 'en' },
  { query: 'stripe checkout subscription', expected: 'en-payments', kind: 'lexical', lang: 'en' }
]

/** Paraphrases with little or no word overlap: they need semantics (or aliases). */
export const PARAPHRASE_QUERIES: readonly EvalQuery[] = [
  { query: 'replicar datos entre máquinas', expected: 'sync-p2p', kind: 'paraphrase', lang: 'es' },
  { query: 'control de acceso por nodo', expected: 'acl-groups', kind: 'paraphrase', lang: 'es' },
  { query: 'qué ocurre cuando dos equipos modifican lo mismo', expected: 'sync-lww', kind: 'paraphrase', lang: 'es' },
  { query: 'lo que borro en un equipo desaparece en los otros', expected: 'tombstones', kind: 'paraphrase', lang: 'es' },
  { query: 'que se actualice solo cada rato', expected: 'auto-sync', kind: 'paraphrase', lang: 'es' },
  { query: 'encontrar otros equipos en la misma wifi', expected: 'udp-discovery', kind: 'paraphrase', lang: 'es' },
  { query: 'conectar computadoras remotas por la VPN', expected: 'tailscale', kind: 'paraphrase', lang: 'es' },
  { query: 'proteger con contraseña el servidor de réplica', expected: 'token-security', kind: 'paraphrase', lang: 'es' },
  { query: 'evitar saturar la ventana de contexto del modelo', expected: 'token-budget', kind: 'paraphrase', lang: 'es' },
  { query: 'resumen inicial al abrir una sesión', expected: 'briefing', kind: 'paraphrase', lang: 'es' },
  { query: 'las tildes no deberían importar al buscar', expected: 'text-normalize', kind: 'paraphrase', lang: 'es' },
  { query: 'por qué una búsqueda absurda no devuelve resultados', expected: 'min-similarity', kind: 'paraphrase', lang: 'es' },
  { query: 'activar comprensión de significado en las búsquedas', expected: 'ml-optional', kind: 'paraphrase', lang: 'es' },
  { query: 'guardar dos veces lo mismo', expected: 'content-hash', kind: 'paraphrase', lang: 'es' },
  { query: 'leer y escribir a la vez desde dos procesos', expected: 'wal', kind: 'paraphrase', lang: 'es' },
  { query: 'respaldar mis recuerdos en un archivo', expected: 'snapshot', kind: 'paraphrase', lang: 'es' },
  { query: 'el agente sigue usando el programa antiguo', expected: 'mcp-restart', kind: 'paraphrase', lang: 'es' },
  { query: 'conectar mi asistente de programación a la memoria', expected: 'setup-agents', kind: 'paraphrase', lang: 'es' },
  { query: 'las pruebas no deben bajar nada de internet', expected: 'tests-fake-ml', kind: 'paraphrase', lang: 'es' },
  { query: 'medir si la búsqueda es buena', expected: 'recall-eval', kind: 'paraphrase', lang: 'es' },
  { query: 'cómo sacar una versión nueva del paquete', expected: 'release-flow', kind: 'paraphrase', lang: 'es' },
  { query: 'el equipo con la hora mal pisa los cambios de los demás', expected: 'bug-clock-skew', kind: 'paraphrase', lang: 'es' },
  { query: 'el modo inteligente ocupaba muchísimo espacio', expected: 'bug-ml-prune', kind: 'paraphrase', lang: 'es' },
  { query: 'aparecen ventanas negras parpadeando en Windows', expected: 'tailscale-dedup', kind: 'paraphrase', lang: 'es' },
  { query: 'qué ve un equipo que nadie asignó', expected: 'acl-default-policy', kind: 'paraphrase', lang: 'es' },
  { query: 'how do I log in users securely', expected: 'en-auth', kind: 'paraphrase', lang: 'en' },
  { query: 'global state library for the frontend', expected: 'en-react', kind: 'paraphrase', lang: 'en' },
  { query: 'what checks run on pull requests', expected: 'en-ci', kind: 'paraphrase', lang: 'en' },
  { query: 'backup of all memories to a file', expected: 'snapshot', kind: 'paraphrase', lang: 'en' },
  { query: 'how long until a session credential stops working', expected: 'en-jwt-expiry', kind: 'paraphrase', lang: 'en' },
  { query: 'do we keep credit card numbers', expected: 'en-payments', kind: 'paraphrase', lang: 'en' },
  { query: 'clients hitting the API too often', expected: 'en-rate-limit', kind: 'paraphrase', lang: 'en' },
  { query: 'stop customers from seeing each other data', expected: 'en-tenancy', kind: 'paraphrase', lang: 'en' },
  { query: 'test broke only around midnight', expected: 'en-flaky', kind: 'paraphrase', lang: 'en' },
  { query: 'realtime server keeps eating RAM', expected: 'en-memory-leak', kind: 'paraphrase', lang: 'en' },
  { query: 'home page takes forever to load pictures', expected: 'en-perf-images', kind: 'paraphrase', lang: 'en' },
  { query: 'too many database calls when rendering widgets', expected: 'en-n-plus-one', kind: 'paraphrase', lang: 'en' },
  { query: 'how does code get to production', expected: 'en-deploy', kind: 'paraphrase', lang: 'en' },
  { query: 'removing records without losing them immediately', expected: 'en-db-softdelete', kind: 'paraphrase', lang: 'en' },
  { query: 'notify a partner system when something changes', expected: 'en-webhooks', kind: 'paraphrase', lang: 'en' },
  { query: 'long running work outside the request', expected: 'en-queue', kind: 'paraphrase', lang: 'en' },
  { query: 'second login step for administrators', expected: 'en-2fa', kind: 'paraphrase', lang: 'en' },
  { query: 'follow one request across all services', expected: 'en-tracing', kind: 'paraphrase', lang: 'en' },
  { query: 'what time zone are dates saved in', expected: 'en-timezones', kind: 'paraphrase', lang: 'en' },
  { query: 'which machines and runtimes does CI cover', expected: 'tests-ci-matrix', kind: 'paraphrase', lang: 'en' },
  { query: 'qué pasa si cambio de embedding model', expected: 'vector-model-tag', kind: 'paraphrase', lang: 'mixed' },
  { query: 'avisar de duplicates al hacer store', expected: 'duplicate-detect', kind: 'paraphrase', lang: 'mixed' },
  { query: 'where vive el archivo de la database', expected: 'vault-path', kind: 'paraphrase', lang: 'mixed' },
  { query: 'tests que comparten rows entre sí', expected: 'en-test-db', kind: 'paraphrase', lang: 'mixed' },
  { query: 'ship features a medio terminar', expected: 'en-feature-flags', kind: 'paraphrase', lang: 'mixed' }
]

/** Queries with no relevant memory: every returned result is noise. */
export const UNRELATED_QUERIES: readonly UnrelatedQuery[] = [
  { query: 'receta de pizza margarita', lang: 'es' },
  { query: 'mejor película de ciencia ficción', lang: 'es' },
  { query: 'cuándo florecen los cerezos en Japón', lang: 'es' },
  { query: 'horario del dentista el lunes', lang: 'es' },
  { query: 'weather forecast for tomorrow', lang: 'en' },
  { query: 'how to train a puppy to sit', lang: 'en' },
  { query: 'best hiking trails near the lake', lang: 'en' },
  { query: 'lyrics of a happy birthday song', lang: 'en' },
  { query: 'resultados del partido de fútbol last night', lang: 'mixed' },
  { query: 'comprar zapatos running baratos', lang: 'mixed' }
]
