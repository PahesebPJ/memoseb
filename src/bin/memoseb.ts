#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import {
  type HostId,
  serializeWire,
  SUPPORTED_HOSTS,
  SystemRuntime,
  TopologyStore,
  wireFailure,
  wireSuccess,
} from 'hubseb'
import { analyzeAndStoreProject } from '../core/analyzer.ts'
import { MEMORY_CATEGORIES, type MemoryCategory } from '../core/schema.ts'
import { MemoryVault } from '../core/vault.ts'
import { startMcpServer } from '../mcp/server.ts'
import {
  auditMemosebDirectives,
  BUNDLE_ID,
  CONSUMES,
  deployMemoseb,
  PROVIDES,
  purgeMemoseb,
  SIGNALS,
} from '../setup.ts'
import { VERSION } from '../version.ts'

export interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ExecuteMemoCliOptions {
  runtime?: SystemRuntime
  dbPath?: string
  cwd?: string
}

function parseHostsOption(args: readonly string[]): HostId[] | undefined {
  const idx = args.indexOf('--agents')
  if (idx === -1) return undefined
  const val = args[idx + 1]
  if (!val || val === 'detected') return undefined
  if (val === 'all') return [...SUPPORTED_HOSTS]
  return val
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is HostId => (SUPPORTED_HOSTS as readonly string[]).includes(s))
}

const VALUE_FLAGS = new Set([
  '--agents',
  '--db',
  '--project',
  '--title',
  '--category',
  '--tags',
  '--agent',
  '--importance',
  '--limit',
  '--max-tokens',
])

function extractFlags(argv: readonly string[]): {
  positional: string[]
  flags: Record<string, string>
  jsonMode: boolean
  dryRun: boolean
} {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  let jsonMode = false
  let dryRun = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--json') {
      jsonMode = true
      continue
    }
    if (token === '--dry-run') {
      dryRun = true
      continue
    }
    if (VALUE_FLAGS.has(token)) {
      const next = argv[i + 1]
      if (next !== undefined) {
        flags[token.slice(2)] = next
        i++
      }
      continue
    }
    if (token.startsWith('--') && token.includes('=')) {
      const eq = token.indexOf('=')
      const k = token.slice(2, eq)
      const v = token.slice(eq + 1)
      flags[k] = v
      continue
    }
    positional.push(token)
  }

  return { positional, flags, jsonMode, dryRun }
}

export async function executeMemoCli(
  argv: readonly string[],
  options: ExecuteMemoCliOptions = {},
): Promise<CliResult> {
  const runtime = options.runtime ?? new SystemRuntime()
  const cwd = options.cwd ?? process.cwd()
  const selectedHosts = parseHostsOption(argv)
  const { positional, flags, jsonMode, dryRun } = extractFlags(argv)
  const dbPath = options.dbPath ?? flags.db

  const command = positional[0] ?? 'help'

  if (command === 'capabilities') {
    const payload = {
      id: BUNDLE_ID,
      version: VERSION,
      provides: PROVIDES,
      consumes: CONSUMES,
      signals: SIGNALS,
    }
    if (jsonMode) {
      return {
        exitCode: 0,
        stdout: serializeWire(wireSuccess('capabilities', payload)),
        stderr: '',
      }
    }
    return {
      exitCode: 0,
      stdout: `${BUNDLE_ID} v${VERSION}\nprovides: ${PROVIDES.join(', ')}\nconsumes: ${CONSUMES.join(', ') || 'none'}\nsignals: ${SIGNALS.join(', ')}\n`,
      stderr: '',
    }
  }

  if (command === 'setup') {
    const res = await deployMemoseb({ runtime, hosts: selectedHosts })
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('setup', res)), stderr: '' }
    }
    const lines = [
      `Attached memoseb node to hubseb topology: ${res.topologyFile}`,
      'Host driver deployments:',
    ]
    for (const r of res.receipts) {
      lines.push(
        `  ✓ [${r.hostId}] sha256=${r.directivesHash ?? 'none'} (${r.writtenPaths.length} assets deployed)`,
      )
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'check') {
    const reports = await auditMemosebDirectives({ runtime, hosts: selectedHosts })
    const allVerified = reports.every((r) => r.status === 'verified')
    if (jsonMode) {
      return {
        exitCode: allVerified ? 0 : 1,
        stdout: serializeWire(wireSuccess('check', { allVerified, reports })),
        stderr: '',
      }
    }
    const lines = ['memoseb SHA-256 directive integrity check:']
    for (const r of reports) {
      lines.push(
        `  [${r.hostId}] ${r.status} (expected=${r.expectedHash}, actual=${r.actualHash ?? 'none'}) — ${r.directivesFile}`,
      )
    }
    return { exitCode: allVerified ? 0 : 1, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'uninstall') {
    const res = await purgeMemoseb({ runtime, hosts: selectedHosts })
    if (jsonMode) {
      return { exitCode: 0, stdout: serializeWire(wireSuccess('uninstall', res)), stderr: '' }
    }
    const lines = [`Detached from hubseb topology: ${res.detachedFromTopology}`]
    for (const p of res.purged) {
      lines.push(
        `  [${p.hostId}] removed ${p.removedPaths.length} lock-tracked paths (directivesRemoved=${p.directivesRemoved})`,
      )
    }
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
  }

  if (command === 'mcp') {
    const vault = new MemoryVault({ dbPath, runtime })
    startMcpServer(vault)
    return { exitCode: 0, stdout: '', stderr: '' }
  }

  if (command === 'remember' || command === 'store') {
    const content = positional.slice(1).join(' ').trim()
    if (!content) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              command,
              'MISSING_CONTENT',
              'Memory content is required',
              'Usage: memoseb remember "<content>" [--category <cat>] [--title "<title>"]',
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'Memory content is required. Usage: memoseb remember "<content>"\n',
      }
    }

    const rawCategory = flags.category
    if (rawCategory && !(MEMORY_CATEGORIES as readonly string[]).includes(rawCategory)) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              command,
              'INVALID_CATEGORY',
              `Invalid category "${rawCategory}". Valid categories: ${MEMORY_CATEGORIES.join(', ')}`,
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Invalid category "${rawCategory}". Valid categories: ${MEMORY_CATEGORIES.join(', ')}\n`,
      }
    }

    const tags = flags.tags
      ? flags.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined
    const importance = flags.importance !== undefined ? Number(flags.importance) : undefined

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const stored = vault.storeMemory({
        content,
        title: flags.title,
        category: rawCategory as MemoryCategory | undefined,
        tags,
        projectId: flags.project,
        sourceAgent: flags.agent,
        importance,
        cwd,
      })

      try {
        const topology = new TopologyStore(runtime)
        await topology.broadcastSignal(BUNDLE_ID, 'memory.stored', {
          id: stored.memory.id,
          projectId: stored.memory.projectId,
          category: stored.memory.category,
          created: stored.created,
        })
      } catch {
        // Ignore topology broadcast errors if hubseb state is read-only
      }

      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess(command, stored)), stderr: '' }
      }
      return {
        exitCode: 0,
        stdout: `${stored.created ? 'Stored' : 'Updated existing'} memory [${stored.memory.id}] (${stored.memory.category}, ~${stored.memory.tokenCount} tokens) in project ${stored.memory.projectId}: ${stored.memory.title}\n`,
        stderr: '',
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'recall' || command === 'search') {
    const query = positional.slice(1).join(' ').trim()
    if (!query) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(command, 'MISSING_QUERY', 'Search query is required'),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'Search query is required. Usage: memoseb recall "<query>"\n',
      }
    }

    const limit = flags.limit !== undefined ? Number(flags.limit) : undefined
    const maxTokens = flags['max-tokens'] !== undefined ? Number(flags['max-tokens']) : undefined
    const category =
      flags.category && (MEMORY_CATEGORIES as readonly string[]).includes(flags.category)
        ? (flags.category as MemoryCategory)
        : undefined
    const tags = flags.tags
      ? flags.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const res = vault.recallMemories(query, {
        projectId: flags.project,
        category,
        tags,
        limit,
        maxTokens,
        cwd,
      })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess(command, res)), stderr: '' }
      }
      if (res.memories.length === 0) {
        return { exitCode: 0, stdout: 'No matching memories found.\n', stderr: '' }
      }
      const lines = [
        `Found ${res.memories.length} memories for project ${res.projectId} (~${res.totalTokens} tokens):`,
      ]
      for (const m of res.memories) {
        lines.push(
          `  • [${m.id}] (${m.category} | score=${m.score.toFixed(3)} | ~${m.tokenCount}t) ${m.title}: ${m.content}`,
        )
      }
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } finally {
      vault.close()
    }
  }

  if (command === 'context' || command === 'briefing') {
    const maxTokens = flags['max-tokens'] !== undefined ? Number(flags['max-tokens']) : undefined
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const res = vault.getProjectBriefing({
        projectId: flags.project,
        maxTokens,
        cwd,
      })
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess(command, res)), stderr: '' }
      }
      if (res.memories.length === 0) {
        return {
          exitCode: 0,
          stdout: `No memories stored yet for project ${res.projectId}.\n`,
          stderr: '',
        }
      }
      const lines = [
        `Briefing for project ${res.projectId} — ${res.memories.length} memories (~${res.totalTokens} tokens):`,
      ]
      for (const m of res.memories) {
        lines.push(`  • [${m.category}] ${m.title}: ${m.content}`)
      }
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } finally {
      vault.close()
    }
  }

  if (command === 'projects') {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const projects = vault.listProjects()
      if (jsonMode) {
        return {
          exitCode: 0,
          stdout: serializeWire(wireSuccess('projects', { projects })),
          stderr: '',
        }
      }
      if (projects.length === 0) {
        return { exitCode: 0, stdout: 'No projects registered in vault.\n', stderr: '' }
      }
      const lines = ['Projects in memoseb vault:']
      for (const p of projects) {
        lines.push(
          `  • ${p.name} (${p.id}) — ${p.memoryCount} memories (~${p.totalTokens} tokens) [${p.rootPath}]`,
        )
      }
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } finally {
      vault.close()
    }
  }

  if (command === 'forget') {
    const targetId = positional[1]?.trim()
    if (!targetId) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(wireFailure('forget', 'MISSING_ID', 'Memory ID is required')),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'Memory ID is required. Usage: memoseb forget <id>\n',
      }
    }

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const deleted = vault.forgetMemory(targetId)
      if (deleted) {
        try {
          const topology = new TopologyStore(runtime)
          await topology.broadcastSignal(BUNDLE_ID, 'memory.forgotten', { id: targetId })
        } catch {
          // Ignore topology broadcast errors
        }
      }
      if (jsonMode) {
        return {
          exitCode: deleted ? 0 : 1,
          stdout: serializeWire(wireSuccess('forget', { id: targetId, deleted })),
          stderr: '',
        }
      }
      return {
        exitCode: deleted ? 0 : 1,
        stdout: deleted ? `Deleted memory ${targetId}.\n` : `Memory ${targetId} not found.\n`,
        stderr: '',
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'stats') {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const stats = vault.getStats()
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('stats', stats)), stderr: '' }
      }
      const lines = [
        `memoseb vault statistics (${stats.dbPath}):`,
        `  Total memories: ${stats.memoryCount}`,
        `  Total projects: ${stats.projectCount}`,
        `  Total vectors:  ${stats.vectorCount}`,
        `  Total tokens:   ${stats.totalTokens}`,
      ]
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } finally {
      vault.close()
    }
  }

  if (command === 'analyze' || command === 'index' || command === 'scan') {
    const targetDir = positional[1] ? path.resolve(cwd, positional[1]) : cwd
    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              'analyze',
              'INVALID_PATH',
              `Target directory does not exist: ${targetDir}`,
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Target directory does not exist: ${targetDir}\n`,
      }
    }

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const report = analyzeAndStoreProject(vault, {
        targetDir,
        projectId: flags.project,
        sourceAgent: flags.agent,
        dryRun,
      })

      if (!dryRun) {
        try {
          const topology = new TopologyStore(runtime)
          for (const item of report.stored) {
            await topology.broadcastSignal(BUNDLE_ID, 'memory.stored', {
              id: item.memory.id,
              projectId: item.memory.projectId,
              category: item.memory.category,
              created: item.created,
            })
          }
        } catch {
          // Ignore topology broadcast errors if hubseb state is read-only
        }
      }

      if (jsonMode) {
        return {
          exitCode: 0,
          stdout: serializeWire(wireSuccess('analyze', report)),
          stderr: '',
        }
      }

      const lines = [
        `${dryRun ? '[DRY RUN] Synthesized' : 'Analyzed & stored'} ${report.drafts.length} memories for project ${report.project.name} (${report.project.id}) [~${report.totalTokens} tokens]:`,
      ]
      for (const draft of report.drafts) {
        lines.push(`  • [${draft.category}] (importance=${draft.importance}) ${draft.title}`)
      }
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } finally {
      vault.close()
    }
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    const commands = [
      'setup',
      'check',
      'uninstall',
      'analyze',
      'remember',
      'recall',
      'context',
      'projects',
      'forget',
      'stats',
      'mcp',
      'capabilities',
    ]
    const text = [
      `memoseb v${VERSION} — Multi-Project Hybrid Vector & FTS5 Agent Memory Vault`,
      '',
      'Commands:',
      '  memoseb setup [--agents a,b|all]             Attach to hubseb topology & deploy directives/skills',
      '  memoseb check [--json]                       Verify SHA-256 integrity of directives across hosts',
      '  memoseb uninstall [--json]                   Purge lock-tracked files & detach from hubseb',
      '  memoseb analyze [path] [--dry-run] [--json]  Analyze repository and store architecture, convention & domain memories',
      '  memoseb remember "<text>" [options]          Store a memory (--category, --title, --tags, --importance)',
      '  memoseb recall "<query>" [options]           Hybrid search (--limit, --max-tokens, --category)',
      '  memoseb context [--max-tokens N]             Project briefing within token budget',
      '  memoseb projects [--json]                    List all indexed projects and memory counts',
      '  memoseb forget <id> [--json]                 Remove a memory by ID',
      '  memoseb stats [--json]                       Vault metrics and category breakdown',
      '  memoseb mcp                                  Start stdio JSON-RPC 2.0 MCP server',
      '',
    ].join('\n')
    if (jsonMode) {
      return {
        exitCode: 0,
        stdout: serializeWire(wireSuccess('help', { commands })),
        stderr: '',
      }
    }
    return { exitCode: 0, stdout: text, stderr: '' }
  }

  if (jsonMode) {
    return {
      exitCode: 2,
      stdout: serializeWire(
        wireFailure(
          command,
          'UNKNOWN_COMMAND',
          `Unknown command "${command}"`,
          'Run "memoseb help"',
        ),
      ),
      stderr: '',
    }
  }
  return {
    exitCode: 2,
    stdout: '',
    stderr: `Unknown command "${command}". Run "memoseb help".\n`,
  }
}

const isEntry =
  process.argv[1] &&
  (process.argv[1].endsWith('memoseb.ts') ||
    process.argv[1].endsWith('memoseb.js') ||
    process.argv[1].endsWith('/memoseb'))

if (isEntry) {
  executeMemoCli(process.argv.slice(2)).then((res) => {
    if (res.stdout) process.stdout.write(res.stdout)
    if (res.stderr) process.stderr.write(res.stderr)
    process.exitCode = res.exitCode
  })
}
