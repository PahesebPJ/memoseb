---
name: memoseb
description: Gestiona la bóveda de memoria híbrida (vectorial + FTS5) multi-proyecto con presupuesto de tokens mediante memoseb (context, recall, remember, projects, stats, forget) o su servidor MCP.
---

# Bóveda de Memoria `/memoseb`

Usa `memoseb` para dotar a los agentes de memoria persistente entre sesiones, aislada por proyecto pero capaz de compartir aprendizajes transversales con un presupuesto estricto de tokens.

## 1. Flujo de Trabajo Recomendado

1. **Briefing Inicial (`context`):**
   Al entrar a un proyecto, recupera las decisiones clave, arquitectura y convenciones sin exceder el presupuesto de tokens:
   ```bash
   memoseb context --max-tokens 800
   ```
2. **Búsqueda Híbrida (`recall`):**
   Antes de diseñar o depurar un módulo específico, consulta recuerdos semánticos y léxicos (BM25 + similitud coseno + decaimiento temporal):
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

## 2. Categorías Válidas

- `architecture`: Diseño de componentes, límites de módulos, patrones estructurales.
- `convention`: Estándares de código, nombres, scripts y flujos del repositorio.
- `bugfix`: Causas raíz de defectos no triviales y cómo se previenen.
- `decision`: Acuerdos técnicos o de producto (ADRs ligeros).
- `domain`: Reglas de negocio, glosario e invariantes del dominio.

## 3. Comandos de Inspección y Mantenimiento

- `memoseb projects`: Lista todos los proyectos registrados en la bóveda y su conteo de recuerdos / tokens.
- `memoseb stats`: Muestra métricas globales de la bóveda (memorias totales, tokens, desglose por categoría).
- `memoseb forget <id>`: Elimina un recuerdo obsoleto o incorrecto por su ID.
- `memoseb mcp`: Inicia el servidor MCP sobre `stdio` (JSON-RPC 2.0) exponiendo `memory_store`, `memory_recall`, `memory_briefing` y `memory_forget`.
