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
import { readSnapshotFile, writeSnapshotFile } from '../core/snapshot.ts'
import {
  discoverLanParents,
  getLocalLanUrls,
  normalizePeerUrl,
  performPeerHandshake,
  startSyncServer,
  syncAllPeers,
  syncWithPeer,
  triggerAutoSyncIfEnabled,
  type PeerSyncResult,
  type SyncSummaryResult,
} from '../core/sync.ts'
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
  signal?: AbortSignal
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
  '--out',
  '--file',
  '--strategy',
  '--role',
  '--parent',
  '--url',
  '--name',
  '--token',
  '--host',
  '--port',
  '--timeout',
])

function extractFlags(argv: readonly string[]): {
  positional: string[]
  flags: Record<string, string>
  jsonMode: boolean
  dryRun: boolean
  replaceMode: boolean
  discoverMode: boolean
  fullSync: boolean
  purgePeers: boolean
  autoSyncFlag: boolean | undefined
  noLanFlag: boolean
} {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  let jsonMode = false
  let dryRun = false
  let replaceMode = false
  let discoverMode = false
  let fullSync = false
  let purgePeers = false
  let autoSyncFlag: boolean | undefined = undefined
  let noLanFlag = false

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
    if (token === '--replace') {
      replaceMode = true
      continue
    }
    if (token === '--discover') {
      discoverMode = true
      continue
    }
    if (token === '--full') {
      fullSync = true
      continue
    }
    if (token === '--purge-peers') {
      purgePeers = true
      continue
    }
    if (token === '--auto-sync') {
      autoSyncFlag = true
      continue
    }
    if (token === '--no-auto-sync') {
      autoSyncFlag = false
      continue
    }
    if (token === '--no-lan') {
      noLanFlag = true
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

  return {
    positional,
    flags,
    jsonMode,
    dryRun,
    replaceMode,
    discoverMode,
    fullSync,
    purgePeers,
    autoSyncFlag,
    noLanFlag,
  }
}

export async function executeMemoCli(
  argv: readonly string[],
  options: ExecuteMemoCliOptions = {},
): Promise<CliResult> {
  const runtime = options.runtime ?? new SystemRuntime()
  const cwd = options.cwd ?? process.cwd()
  const selectedHosts = parseHostsOption(argv)
  const {
    positional,
    flags,
    jsonMode,
    dryRun,
    replaceMode,
    discoverMode,
    fullSync,
    purgePeers,
    autoSyncFlag,
    noLanFlag,
  } = extractFlags(argv)
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

      await triggerAutoSyncIfEnabled(vault, { projectId: stored.memory.projectId })

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
        await triggerAutoSyncIfEnabled(vault)
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
        await triggerAutoSyncIfEnabled(vault, { projectId: report.project.id })
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

  if (command === 'export') {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const snapshot = vault.exportSnapshot({ projectId: flags.project })
      const targetFile =
        positional[1] ?? flags.out ?? flags.file ?? path.resolve(cwd, 'memoseb-snapshot.json')
      const resolvedPath = path.resolve(cwd, targetFile)
      writeSnapshotFile(resolvedPath, snapshot)

      try {
        const topology = new TopologyStore(runtime)
        await topology.broadcastSignal(BUNDLE_ID, 'memory.exported', {
          filePath: resolvedPath,
          checksum: snapshot.checksum,
          projectCount: snapshot.projects.length,
          memoryCount: snapshot.memories.length,
          tombstoneCount: snapshot.tombstones.length,
        })
      } catch {
        // Ignore topology broadcast errors if hubseb state is read-only
      }

      const payload = {
        filePath: resolvedPath,
        checksum: snapshot.checksum,
        projectCount: snapshot.projects.length,
        memoryCount: snapshot.memories.length,
        tombstoneCount: snapshot.tombstones.length,
      }

      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('export', payload)), stderr: '' }
      }
      const lines = [
        `Exported memoseb snapshot to ${resolvedPath}:`,
        `  Checksum:   ${snapshot.checksum}`,
        `  Projects:   ${snapshot.projects.length}`,
        `  Memories:   ${snapshot.memories.length}`,
        `  Tombstones: ${snapshot.tombstones.length}`,
      ]
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        return {
          exitCode: 1,
          stdout: serializeWire(wireFailure('export', 'EXPORT_FAILED', message)),
          stderr: '',
        }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Export failed: ${message}\n`,
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'import') {
    const rawFile = positional[1] ?? flags.file
    if (!rawFile) {
      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              'import',
              'MISSING_FILE',
              'Snapshot file path is required',
              'Usage: memoseb import <file> [--replace] [--strategy merge|replace] [--project <id>]',
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: 'Snapshot file path is required. Usage: memoseb import <file>\n',
      }
    }

    const resolvedFile = path.resolve(cwd, rawFile)
    let snapshot
    try {
      snapshot = readSnapshotFile(resolvedFile)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        return {
          exitCode: 1,
          stdout: serializeWire(wireFailure('import', 'INVALID_SNAPSHOT', message)),
          stderr: '',
        }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Import failed: ${message}\n`,
      }
    }

    const strategy: 'merge' | 'replace' =
      replaceMode || flags.strategy === 'replace' ? 'replace' : 'merge'

    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const result = vault.importSnapshot(snapshot, {
        strategy,
        projectId: flags.project,
      })

      try {
        const topology = new TopologyStore(runtime)
        await topology.broadcastSignal(BUNDLE_ID, 'memory.imported', {
          filePath: resolvedFile,
          checksum: snapshot.checksum,
          ...result,
        })
      } catch {
        // Ignore topology broadcast errors if hubseb state is read-only
      }

      const payload = { filePath: resolvedFile, ...result }
      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('import', payload)), stderr: '' }
      }
      const lines = [
        `Imported snapshot from ${resolvedFile} (strategy: ${result.strategy}):`,
        `  Projects imported:  ${result.projectsImported}`,
        `  Memories created:   ${result.memoriesCreated}`,
        `  Memories updated:   ${result.memoriesUpdated}`,
        `  Memories skipped:   ${result.memoriesSkipped}`,
        `  Tombstones applied: ${result.tombstonesApplied}`,
      ]
      return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        return {
          exitCode: 1,
          stdout: serializeWire(wireFailure('import', 'IMPORT_FAILED', message)),
          stderr: '',
        }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Import failed: ${message}\n`,
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'node') {
    const subcommand = positional[1] ?? 'status'
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      if (subcommand === 'status') {
        const config = vault.getNodeConfig()
        const peers = vault.listPeers()
        const lanUrls = getLocalLanUrls(config.listenPort)
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { config, peers, lanUrls })),
            stderr: '',
          }
        }
        const lines = [
          `memoseb node status:`,
          `  Status:      ${config.enabled ? `ENABLED (role=${config.role})` : 'DISABLED (standalone)'}`,
          `  Node ID:     ${config.nodeId}`,
          `  Node Name:   ${config.nodeName}`,
          `  Listen:      ${config.listenHost}:${config.listenPort}`,
          `  Auto-sync:   ${config.autoSync ? 'enabled' : 'disabled'}`,
          `  LAN discov.: ${config.lanDiscovery ? 'enabled' : 'disabled'}`,
          `  Auth token:  ${config.authToken ? 'configured' : 'none'}`,
          `  LAN URLs:    ${lanUrls.join(', ') || 'none'}`,
          `  Registered peers (${peers.length}):`,
        ]
        if (peers.length === 0) {
          lines.push('    (no peers registered)')
        } else {
          for (const p of peers) {
            lines.push(
              `    • [${p.role}] ${p.name ?? 'unnamed'} (${p.url}) [status: ${p.lastStatus ?? 'unknown'}, lastSync: ${p.lastSyncAt ?? 'never'}]`,
            )
          }
        }
        return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
      }

      if (subcommand === 'enable') {
        let role = flags.role as 'parent' | 'child' | undefined
        if (!role) {
          if (flags.parent || discoverMode) {
            role = 'child'
          } else {
            if (jsonMode) {
              return {
                exitCode: 2,
                stdout: serializeWire(
                  wireFailure(
                    'node',
                    'INVALID_ROLE',
                    'Node role must be "parent" or "child"',
                    'Usage: memoseb node enable --role parent|child',
                  ),
                ),
                stderr: '',
              }
            }
            return {
              exitCode: 2,
              stdout: '',
              stderr:
                'Node role must be "parent" or "child". Usage: memoseb node enable --role parent|child\n',
            }
          }
        }
        if (role !== 'parent' && role !== 'child') {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'INVALID_ROLE',
                  `Invalid role "${role}". Must be "parent" or "child"`,
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: `Invalid role "${role}". Must be "parent" or "child".\n`,
          }
        }

        vault.enableNodeMode({
          role,
          nodeName: flags.name,
          listenHost: flags.host,
          listenPort: flags.port !== undefined ? Number(flags.port) : undefined,
          authToken: flags.token !== undefined ? flags.token : undefined,
          autoSync: autoSyncFlag !== undefined ? autoSyncFlag : undefined,
          lanDiscovery: noLanFlag ? false : undefined,
        })

        if (role === 'child') {
          if (discoverMode && !flags.parent) {
            const parents = await discoverLanParents({
              port: Number(flags.port) || undefined,
              timeoutMs: Number(flags.timeout) || 800,
              token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
            })
            if (parents.length === 0) {
              if (jsonMode) {
                return {
                  exitCode: 1,
                  stdout: serializeWire(
                    wireFailure(
                      'node',
                      'NO_PARENT_DISCOVERED',
                      'No memoseb parent node was discovered on the local network',
                    ),
                  ),
                  stderr: '',
                }
              }
              return {
                exitCode: 1,
                stdout: '',
                stderr: 'No memoseb parent node was discovered on the local network.\n',
              }
            }
            const first = parents[0]!
            const parentUrl = first.urls[0] ?? `http://${first.address}:${first.port}`
            const normalized = normalizePeerUrl(parentUrl)
            vault.upsertPeer({
              role: 'parent',
              url: normalized,
              name: first.nodeName,
              peerNodeId: first.nodeId,
              authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
              lastStatus: 'configured',
            })
            try {
              await performPeerHandshake(vault, {
                peerUrl: normalized,
                peerRole: 'parent',
                token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
              })
            } catch {
              // Tolerated
            }
          } else if (flags.parent) {
            const normalized = normalizePeerUrl(flags.parent)
            vault.upsertPeer({
              role: 'parent',
              url: normalized,
              name: flags.name,
              authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
              lastStatus: 'configured',
            })
            try {
              await performPeerHandshake(vault, {
                peerUrl: normalized,
                peerRole: 'parent',
                token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
              })
            } catch {
              vault.upsertPeer({
                role: 'parent',
                url: normalized,
                name: flags.name,
                authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
                lastStatus: 'configured',
              })
            }
          }
        }

        const config = vault.getNodeConfig()
        const peers = vault.listPeers()
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { config, peers })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Node mode ENABLED as role=${config.role} (nodeId: ${config.nodeId}). Registered peers: ${peers.length}.\n`,
          stderr: '',
        }
      }

      if (subcommand === 'disable') {
        vault.disableNodeMode({ purgePeers })
        const config = vault.getNodeConfig()
        const peers = vault.listPeers()
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { config, peers })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Node networking DISABLED (standalone). Registered peers: ${peers.length}.\n`,
          stderr: '',
        }
      }

      if (subcommand === 'discover') {
        const parents = await discoverLanParents({
          port: Number(flags.port) || undefined,
          timeoutMs: Number(flags.timeout) || 1200,
          token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
        })
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { parents })),
            stderr: '',
          }
        }
        if (parents.length === 0) {
          return { exitCode: 0, stdout: 'No memoseb parent nodes discovered on LAN.\n', stderr: '' }
        }
        const lines = [`Discovered ${parents.length} parent nodes on LAN:`]
        for (const p of parents) {
          lines.push(`  • ${p.nodeName} (${p.nodeId}) at ${p.urls.join(', ')} [requiresAuth: ${p.requiresAuth}]`)
        }
        return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
      }

      if (subcommand === 'set-parent') {
        const targetUrl = positional[2] ?? flags.url ?? flags.parent
        if (!targetUrl) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'MISSING_URL',
                  'Parent URL is required',
                  'Usage: memoseb node set-parent <url>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Parent URL is required. Usage: memoseb node set-parent <url>\n',
          }
        }
        const currentConfig = vault.getNodeConfig()
        if (!currentConfig.enabled || currentConfig.role !== 'child') {
          vault.enableNodeMode({ role: 'child' })
        }
        const normalizedUrl = normalizePeerUrl(targetUrl)
        vault.upsertPeer({
          role: 'parent',
          url: normalizedUrl,
          name: flags.name,
          authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
          lastStatus: 'configured',
        })
        try {
          await performPeerHandshake(vault, {
            peerUrl: normalizedUrl,
            peerRole: 'parent',
            token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
          })
        } catch {
          vault.upsertPeer({
            role: 'parent',
            url: normalizedUrl,
            name: flags.name,
            authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
            lastStatus: 'configured',
          })
        }
        const peer = vault.listPeers().find((p) => p.url === normalizedUrl)
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { peer, config: vault.getNodeConfig() })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Set parent peer to ${normalizedUrl} (status: ${peer?.lastStatus ?? 'configured'}).\n`,
          stderr: '',
        }
      }

      if (subcommand === 'add-child') {
        const targetUrl = positional[2] ?? flags.url
        if (!targetUrl) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'MISSING_URL',
                  'Child URL is required',
                  'Usage: memoseb node add-child <url>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Child URL is required. Usage: memoseb node add-child <url>\n',
          }
        }
        const currentConfig = vault.getNodeConfig()
        if (!currentConfig.enabled || currentConfig.role !== 'parent') {
          vault.enableNodeMode({ role: 'parent' })
        }
        const normalizedUrl = normalizePeerUrl(targetUrl)
        vault.upsertPeer({
          role: 'child',
          url: normalizedUrl,
          name: flags.name,
          authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
          lastStatus: 'configured',
        })
        try {
          await performPeerHandshake(vault, {
            peerUrl: normalizedUrl,
            peerRole: 'child',
            token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
          })
        } catch {
          vault.upsertPeer({
            role: 'child',
            url: normalizedUrl,
            name: flags.name,
            authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
            lastStatus: 'configured',
          })
        }
        const peer = vault.listPeers().find((p) => p.url === normalizedUrl)
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { peer, config: vault.getNodeConfig() })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Added child peer ${normalizedUrl} (status: ${peer?.lastStatus ?? 'configured'}).\n`,
          stderr: '',
        }
      }

      if (subcommand === 'remove') {
        const target = positional[2] ?? flags.url
        if (!target) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'MISSING_TARGET',
                  'Target peer URL or ID is required',
                  'Usage: memoseb node remove <url-or-id>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Target peer URL or ID is required. Usage: memoseb node remove <url-or-id>\n',
          }
        }
        const removed = vault.removePeer(target)
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { target, removed })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: removed ? `Removed peer ${target}.\n` : `Peer ${target} not found.\n`,
          stderr: '',
        }
      }

      if (subcommand === 'serve') {
        const config = vault.getNodeConfig()
        const roleToUse: 'parent' | 'child' =
          flags.role === 'child' || flags.role === 'parent'
            ? (flags.role as 'parent' | 'child')
            : config.role === 'child'
              ? 'child'
              : 'parent'
        if (!config.enabled) {
          vault.enableNodeMode({
            role: roleToUse,
            listenHost: flags.host,
            listenPort: flags.port !== undefined ? Number(flags.port) : undefined,
            authToken: flags.token,
            lanDiscovery: noLanFlag ? false : undefined,
          })
        }
        const handle = await startSyncServer(vault, {
          host: flags.host,
          port: flags.port !== undefined ? Number(flags.port) : undefined,
          token: flags.token,
          enableUdpDiscovery: !noLanFlag,
        })

        const primaryUrl = handle.urls[0] ?? `http://${handle.host}:${handle.port}`
        if (jsonMode) {
          process.stdout.write(
            serializeWire(
              wireSuccess('node', {
                serving: true,
                url: primaryUrl,
                urls: handle.urls,
                port: handle.port,
                host: handle.host,
                role: vault.getNodeConfig().role,
              }),
            ) + '\n',
          )
        } else {
          process.stdout.write(
            `memoseb sync node serving on ${primaryUrl} (role=${vault.getNodeConfig().role})\nPress Ctrl+C to stop.\n`,
          )
        }

        await new Promise<void>((resolve) => {
          const cleanup = async () => {
            process.off('SIGINT', cleanup)
            process.off('SIGTERM', cleanup)
            if (options.signal) {
              options.signal.removeEventListener('abort', cleanup)
            }
            await handle.close()
            resolve()
          }
          process.on('SIGINT', cleanup)
          process.on('SIGTERM', cleanup)
          if (options.signal) {
            if (options.signal.aborted) {
              void cleanup()
            } else {
              options.signal.addEventListener('abort', cleanup, { once: true })
            }
          }
        })
        return { exitCode: 0, stdout: '', stderr: '' }
      }

      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              'node',
              'UNKNOWN_SUBCOMMAND',
              `Unknown node subcommand "${subcommand}"`,
              'Usage: memoseb node <status|enable|disable|discover|set-parent|add-child|remove|serve>',
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Unknown node subcommand "${subcommand}". Usage: memoseb node <status|enable|disable|discover|set-parent|add-child|remove|serve>\n`,
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'sync') {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      let syncResult
      if (flags.url) {
        syncResult = await syncWithPeer(vault, {
          peerUrl: flags.url,
          token: flags.token,
          projectId: flags.project,
          full: fullSync,
          forceWhenDisabled: true,
        })
      } else {
        const config = vault.getNodeConfig()
        if (!config.enabled) {
          if (jsonMode) {
            return {
              exitCode: 1,
              stdout: serializeWire(
                wireFailure(
                  'sync',
                  'NODE_DISABLED',
                  'Node networking is disabled',
                  'Run "memoseb node enable --role parent|child" to enable networking or pass --url <peer-url>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 1,
            stdout: '',
            stderr:
              'Node networking is disabled. Run "memoseb node enable --role parent|child" or pass --url <peer-url>.\n',
          }
        }
        syncResult = await syncAllPeers(vault, {
          projectId: flags.project,
          full: fullSync,
          token: flags.token,
        })
      }

      try {
        const topology = new TopologyStore(runtime)
        await topology.broadcastSignal(BUNDLE_ID, 'memory.synced', {
          url: flags.url ?? 'all',
          projectId: flags.project,
          full: fullSync,
        })
      } catch {
        // Ignore topology broadcast errors if hubseb state is read-only
      }

      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('sync', syncResult)), stderr: '' }
      }

      if (flags.url) {
        const r = syncResult as PeerSyncResult
        const lines = [
          `Synchronized with peer ${r.peerUrl} (${r.peerRole}) [${r.syncedAt}]:`,
          `  Memories pushed:    ${r.pushed.memoriesCreated + r.pushed.memoriesUpdated} (skipped: ${r.pushed.memoriesSkipped})`,
          `  Memories pulled:    ${r.pulled.memoriesCreated + r.pulled.memoriesUpdated} (skipped: ${r.pulled.memoriesSkipped})`,
          `  Tombstones pushed:  ${r.pushed.tombstonesApplied}`,
          `  Tombstones pulled:  ${r.pulled.tombstonesApplied}`,
        ]
        return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
      }

      const summary = syncResult as SyncSummaryResult
      const total = summary.results.length + summary.errors.length
      const successful = summary.results.length
      const failed = summary.errors.length
      const lines = [
        `Synchronized ${successful}/${total} peers (${failed} failed):`,
      ]
      for (const res of summary.results) {
        lines.push(
          `  ✓ [${res.peerRole}] ${res.peerUrl} — +${res.pulled.memoriesCreated + res.pulled.memoriesUpdated}/-${res.pushed.memoriesCreated + res.pushed.memoriesUpdated} memories`,
        )
      }
      for (const err of summary.errors) {
        lines.push(`  ✗ ${err.peerUrl} — ${err.error}`)
      }
      return {
        exitCode: failed > 0 && successful === 0 ? 1 : 0,
        stdout: `${lines.join('\n')}\n`,
        stderr: '',
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        return {
          exitCode: 1,
          stdout: serializeWire(wireFailure('sync', 'SYNC_FAILED', message)),
          stderr: '',
        }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Sync failed: ${message}\n`,
      }
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
      'export',
      'import',
      'node',
      'sync',
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
      '  memoseb export [file] [--out <f>] [--json]   Export vault snapshot to JSON file',
      '  memoseb import <file> [--replace] [--json]   Import snapshot JSON into vault',
      '  memoseb node <status|enable|disable|...>     Manage peer-to-peer network node & sync service',
      '  memoseb sync [--url <peer>] [--full] [--json] Synchronize memories with peers',
      '  memoseb mcp                                  Start stdio JSON-RPC 2.0 MCP server',
      '  memoseb capabilities [--json]                Display provider, consumer and signal metadata',
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
