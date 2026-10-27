---
name: memoseb
description: Gestiona la bóveda de memoria híbrida (vectorial + FTS5) multi-proyecto con presupuesto de tokens mediante memoseb (analyze, context, recall, remember, projects, stats, forget) o su servidor MCP.
---

# Bóveda de Memoria `/memoseb`

Usa `memoseb` para dotar a los agentes de memoria persistente entre sesiones, aislada por proyecto pero capaz de compartir aprendizajes transversales con un presupuesto estricto de tokens.

## 1. Flujo de Trabajo Recomendado

1. **Briefing Inicial (`context`):**
   Al entrar a un proyecto, recupera las decisiones clave, arquitectura y convenciones sin exceder el presupuesto de tokens:
   ```bash
   memoseb context --max-tokens 800
   ```
   Si el proyecto aún no tiene recuerdos registrados, inicializa su contexto base ejecutando `memoseb analyze` (o `memory_analyze` por MCP).
2. **Búsqueda Híbrida (`recall`):**
   Antes de diseñar o depurar un módulo específico, consulta recuerdos semánticos y léxicos (BM25 + similitud coseno + fusión RRF):
   ```bash
   memoseb recall "autenticación JWT y rotación de tokens" --limit 5 --max-tokens 600
   ```
3. **Captura de Aprendizaje (`remember`):**
   Al cerrar una tarea donde identificaste una decisión arquitectónica, convención o causa raíz de un bug, regístrala:
   ```bash
   memoseb remember "Usar SQLite en modo WAL con FTS5 y vectores Float32 serializados" \
     --title "Motor de persistencia híbrido" \
     --category architecture \
     --tags "sqlite,fts5,vectors" \
     --importance 0.9
   ```

## 2. Análisis e Indexación de Proyectos (Flujo Dual)

Cuando necesites indexar un repositorio nuevo o el usuario pida analizar un proyecto para poblar la bóveda de memoria, utiliza el flujo dual:

1. **Bootstrap Automático (`memoseb analyze [path]` / MCP `memory_analyze`):**
   Inspecciona determinísticamente los manifiestos (`package.json`, `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `Dockerfile`), topología de directorios (`src/`), scripts, workflows CI (`.github/workflows/*.yml`) y `README.md`, sintetizando y almacenando 3 recuerdos de alta señal (`architecture`, `convention` y `domain`):
   ```bash
   memoseb analyze .
   # Vista previa sin persistir en SQLite:
   memoseb analyze . --dry-run
   ```
2. **Análisis Profundo Guiado por Agentes (Método 1):**
   Cuando el usuario solicite un análisis profundo de arquitectura o dominio:
   - Ejecuta primero `memoseb analyze` (o `memory_analyze`) para establecer la línea base estructural.
   - A continuación, delega o inspecciona con los especialistas (`researcher`, `architect`, `analyst`) los módulos críticos para extraer decisiones de diseño (`decision`), invariantes de negocio (`domain`) y contratos internos (`architecture`), persistiendo cada hallazgo con `memoseb remember` o `memory_store`.

## 3. Categorías Válidas

- `architecture`: Diseño de componentes, límites de módulos, patrones estructurales.
- `convention`: Estándares de código, nombres, scripts y flujos del repositorio.
- `bugfix`: Causas raíz de defectos no triviales y cómo se previenen.
- `decision`: Acuerdos técnicos o de producto (ADRs ligeros).
- `domain`: Reglas de negocio, glosario e invariantes del dominio.

## 4. Comandos de Inspección y Mantenimiento

- `memoseb analyze [path] [--dry-run]`: Analiza el repositorio y sintetiza memorias base de arquitectura, convenciones y dominio (alias: `index`, `scan`).
- `memoseb projects`: Lista todos los proyectos registrados en la bóveda y su conteo de recuerdos / tokens.
- `memoseb stats`: Muestra métricas globales de la bóveda (memorias totales, tokens, vectores).
- `memoseb forget <id>`: Elimina un recuerdo obsoleto o incorrecto por su ID.
- `memoseb mcp`: Inicia el servidor MCP sobre `stdio` (JSON-RPC 2.0) exponiendo `memory_store`, `memory_recall`, `memory_briefing`, `memory_forget` y `memory_analyze`.
