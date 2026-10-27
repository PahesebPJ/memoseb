---
trigger: always_on
---

# Reglas activas de memoseb en Antigravity

- Al iniciar trabajo en un proyecto, consulta el contexto acumulado con `memoseb context` o las herramientas MCP `memory_briefing` y `memory_recall`. Si el proyecto no tiene memorias previas o el usuario pide analizarlo, inicializa su contexto con `memoseb analyze` o `memory_analyze`.
- Al descubrir decisiones de arquitectura, convenciones del repositorio o causas raíz de bugs, persiste el aprendizaje con `memoseb remember "<aprendizaje>" --category <architecture|convention|bugfix|decision|domain>` o la herramienta MCP `memory_store`.
- Mantén los recuerdos concisos y elimina entradas obsoletas con `memoseb forget <id>` o `memory_forget`.
