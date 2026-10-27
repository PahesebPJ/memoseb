import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { analyzeAndStoreProject } from '../core/analyzer.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from '../core/schema.ts'
import type { MemoryVault } from '../core/vault.ts'
import { BUNDLE_ID, VERSION } from '../version.ts'

const JSONRPC_VERSION = '2.0'
const MCP_PROTOCOL_VERSION = '2024-11-05'

export const MCP_TOOLS = [
  {
    name: 'memory_store',
    description:
      'Store a reusable architectural decision, repo convention, bugfix root cause, or domain insight in the memoseb hybrid vault.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Concise, high-signal knowledge to remember across sessions.',
        },
        title: {
          type: 'string',
          description: 'Optional short summary title for the memory.',
        },
        category: {
          type: 'string',
          enum: [...MEMORY_CATEGORIES],
          description: 'Memory classification category.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional keyword tags for filtering and retrieval.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project identifier override (defaults to active repository).',
        },
        sourceAgent: {
          type: 'string',
          description: 'Optional identifier of the agent or specialist storing the memory.',
        },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Importance weight from 0.0 (low) to 1.0 (critical). Defaults to 0.5.',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'memory_recall',
    description:
      'Search the memoseb hybrid vault (BM25 FTS5 + cosine vector similarity + RRF fusion) within a strict token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language or keyword query to search for.',
        },
        projectId: {
          type: 'string',
          description: 'Optional project identifier to scope memories.',
        },
        category: {
          type: 'string',
          enum: [...MEMORY_CATEGORIES],
          description: 'Optional category filter.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of memories to return (default 5).',
        },
        maxTokens: {
          type: 'number',
          description: 'Strict token budget for returned memories (default 1200).',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_briefing',
    description:
      'Retrieve a token-budgeted project context briefing (architecture, conventions, key decisions, and bugfixes) at the start of a task.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Optional project identifier (defaults to active repository).',
        },
        maxTokens: {
          type: 'number',
          description: 'Maximum token budget for the briefing (default 1200).',
        },
      },
    },
  },
  {
    name: 'memory_forget',
    description: 'Delete an obsolete or inaccurate memory record by its ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Unique identifier of the memory to delete.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'memory_analyze',
    description:
      'Analyze a project repository (manifests, directory topology, scripts, CI workflows, and README) and synthesize high-signal architecture, convention, and domain memories into the vault.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional directory path to analyze (defaults to current working directory).',
        },
        projectId: {
          type: 'string',
          description: 'Optional project identifier override.',
        },
        dryRun: {
          type: 'boolean',
          description: 'If true, synthesizes memory drafts without storing them in the database.',
        },
      },
    },
  },
] as const

function parseTags(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    return raw.map((t) => String(t).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  }
  return undefined
}

function parseCategory(raw: unknown): MemoryCategory | undefined {
  if (typeof raw === 'string' && (MEMORY_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as MemoryCategory
  }
  return undefined
}

export async function handleMcpRequest(
  vault: MemoryVault,
  req: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  const method = typeof req.method === 'string' ? req.method : ''
  const hasId = 'id' in req && req.id !== undefined
  const id = req.id ?? null

  if (!hasId || method.startsWith('notifications/')) {
    return null
  }

  if (method === 'initialize') {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: BUNDLE_ID,
          version: VERSION,
        },
      },
    }
  }

  if (method === 'ping') {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: {},
    }
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: JSONRPC_VERSION,
      id,
      result: {
        tools: MCP_TOOLS,
      },
    }
  }

  if (method === 'tools/call') {
    const params =
      req.params && typeof req.params === 'object' ? (req.params as Record<string, unknown>) : {}
    const toolName = typeof params.name === 'string' ? params.name : ''
    const args =
      params.arguments && typeof params.arguments === 'object'
        ? (params.arguments as Record<string, unknown>)
        : {}

    try {
      if (toolName === 'memory_store') {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (!content) {
          return {
            jsonrpc: JSONRPC_VERSION,
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Missing required argument: content' }],
            },
          }
        }
        const stored = vault.storeMemory({
          content,
          title: typeof args.title === 'string' ? args.title : undefined,
          category: parseCategory(args.category),
          tags: parseTags(args.tags),
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          sourceAgent: typeof args.sourceAgent === 'string' ? args.sourceAgent : undefined,
          importance: typeof args.importance === 'number' ? args.importance : undefined,
        })
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(stored, null, 2) }],
          },
        }
      }

      if (toolName === 'memory_recall') {
        const query = typeof args.query === 'string' ? args.query : ''
        const res = vault.recallMemories(query, {
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          category: parseCategory(args.category),
          limit: typeof args.limit === 'number' ? args.limit : undefined,
          maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        })
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          },
        }
      }

      if (toolName === 'memory_briefing') {
        const res = vault.getProjectBriefing({
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          maxTokens: typeof args.maxTokens === 'number' ? args.maxTokens : undefined,
        })
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(res, null, 2) }],
          },
        }
      }

      if (toolName === 'memory_forget') {
        const targetId = typeof args.id === 'string' ? args.id.trim() : ''
        if (!targetId) {
          return {
            jsonrpc: JSONRPC_VERSION,
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Missing required argument: id' }],
            },
          }
        }
        const deleted = vault.forgetMemory(targetId)
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify({ id: targetId, deleted }, null, 2) }],
          },
        }
      }

      if (toolName === 'memory_analyze') {
        const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined
        const resolvedPath = rawPath ? path.resolve(rawPath) : undefined
        if (resolvedPath && (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isDirectory())) {
          return {
            jsonrpc: JSONRPC_VERSION,
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: `Target directory does not exist: ${resolvedPath}` }],
            },
          }
        }
        const report = analyzeAndStoreProject(vault, {
          targetDir: resolvedPath,
          projectId: typeof args.projectId === 'string' ? args.projectId : undefined,
          dryRun: Boolean(args.dryRun),
          sourceAgent: 'mcp-analyzer',
        })
        return {
          jsonrpc: JSONRPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
          },
        }
      }

      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        error: {
          code: -32601,
          message: `Unknown tool: ${toolName}`,
        },
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        jsonrpc: JSONRPC_VERSION,
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: message }],
        },
      }
    }
  }

  return {
    jsonrpc: JSONRPC_VERSION,
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  }
}

export function startMcpServer(
  vault: MemoryVault,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  const rl = readline.createInterface({
    input,
    crlfDelay: Number.POSITIVE_INFINITY,
  })

  rl.on('line', async (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      const parseError = {
        jsonrpc: JSONRPC_VERSION,
        id: null,
        error: { code: -32700, message: 'Parse error' },
      }
      output.write(`${JSON.stringify(parseError)}\n`)
      return
    }

    const response = await handleMcpRequest(vault, parsed)
    if (response) {
      output.write(`${JSON.stringify(response)}\n`)
    }
  })
}
