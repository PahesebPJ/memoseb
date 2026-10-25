# Directivas Globales de Memoria (`memoseb`)

## 1. Briefing de Contexto al Iniciar
- Al iniciar cualquier sesión o tarea en un repositorio, consulta primero la bóveda de memoria del proyecto ejecutando `memoseb context` (o invocando la herramienta MCP `memory_briefing` / `memory_recall`).
- Revisa las decisiones de arquitectura, convenciones y bugs previos registrados antes de proponer cambios o escribir código.

## 2. Aprendizaje Continuo y Persistencia
- Cuando descubras decisiones de arquitectura, convenciones no obvias del repositorio, contratos de dominio o la causa raíz de un bug complejo, persiste el hallazgo de forma concisa y densa en conocimiento:
  - Por CLI: `memoseb remember "<aprendizaje>" --title "<título corto>" --category <architecture|convention|bugfix|decision|domain>`
  - Por MCP: herramienta `memory_store` con `content`, `title`, `category` y `tags`.
- Evita guardar ruido efímero (logs crudos, diffs temporales o estados de sesión); almacena únicamente conocimiento reutilizable en futuras sesiones.

## 3. Higiene de Presupuesto de Tokens
- Utiliza `--max-tokens` en `memoseb recall` y `memoseb context` (o `maxTokens` en MCP) para mantener el contexto inyectado dentro de un presupuesto estricto y evitar saturar la ventana del agente.
- Cuando una convención o decisión quede obsoleta, elimínala con `memoseb forget <id>` (o `memory_forget`).
