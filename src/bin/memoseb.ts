#!/usr/bin/env node
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import {
  GROUP_PERMISSION_MODES,
  MEMORY_CATEGORIES,
  isGroupPermissionMode,
  isMemoryCategory,
  isUnassignedGroupPolicy,
  normalizeNodeRole,
  normalizePeerRole,
  parseNodeRoleInput,
  parsePeerRoleInput,
  type GroupPermissionMode,
  type MemoryCategory,
  type NodeRole,
  type PeerRole,
  type SyncGroupRecord,
  type UnassignedGroupPolicy,
} from '../core/schema.ts'
import {
  writeP2PPayloadFile,
  type P2PSyncPayloadV1,
} from '../core/p2p-contract.ts'
import { readSnapshotFile, writeSnapshotFile } from '../core/snapshot.ts'
import {
  discoverLanNodes,
  discoverLanParents,
  getLocalLanUrls,
  isLoopbackHost,
  normalizePeerUrl,
  performPeerHandshake,
  resolveCallbackUrl,
  startSyncServer,
  syncAllPeers,
  syncWithPeer,
  triggerAutoSyncIfEnabled,
  type PeerSyncResult,
  type SyncSummaryResult,
} from '../core/sync.ts'
import { MemoryVault } from '../core/vault.ts'
import {
  discoverPeers,
  startAutoSyncLoop,
  type AutoSyncLoopHandle,
} from '../core/auto-sync.ts'
import {
  applyWindowsFirewallRule,
  installNodeService,
  nodeServiceStatus,
  removeServePidFile,
  resolveServiceCommand,
  uninstallNodeService,
  windowsFirewallRule,
  writeServePidFile,
  type ServiceContext,
  type ServiceReport,
} from '../core/service.ts'
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
  serviceEntry?: string
  serviceUid?: number
  killProcess?: (pid: number) => void
}

const CLI_ENTRY = fileURLToPath(import.meta.url)

function peerCallbackUrl(vault: MemoryVault, peerUrl: string): string | undefined {
  const config = vault.getNodeConfig()
  if (config.role !== 'peer') return undefined
  return resolveCallbackUrl(peerUrl, {
    port: config.listenPort,
    listenHost: config.listenHost,
  })
}

function describeService(report: ServiceReport): string {
  if (!report.supported) return 'unsupported on this platform'
  if (!report.installed) return 'not installed'
  return `installed (${report.mode ?? report.manager}${report.running ? ', running' : ''}) ${report.unit ?? ''}`.trim()
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
  '--peer',
  '--format',
  '--contract',
  '--url',
  '--name',
  '--token',
  '--host',
  '--port',
  '--timeout',
  '--projects',
  '--categories',
  '--permissions',
  '--description',
  '--group',
  '--groups',
  '--policy',
  '--interval',
  '--tailscale-bin',
])

const SWITCH_FLAGS = new Set(['--detach', '--firewall', '--apply', '--no-tailscale', '--tailscale'])

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
  switches: Set<string>
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
  const switches = new Set<string>()

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
    if (SWITCH_FLAGS.has(token)) {
      switches.add(token.slice(2))
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
    switches,
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
    switches,
  } = extractFlags(argv)
  const dbPath = options.dbPath ?? flags.db
  const noAutoSyncLoop = autoSyncFlag === false
  const serviceContext = (vault: MemoryVault): ServiceContext => {
    const resolvedDb = path.resolve(vault.dbPath)
    return {
      runtime,
      dataDir: path.dirname(resolvedDb),
      command: resolveServiceCommand({
        execPath: process.execPath,
        execArgv: process.execArgv,
        entry: options.serviceEntry ?? CLI_ENTRY,
        dbPath: resolvedDb,
        detach: runtime.platform === 'win32',
      }),
      uid: options.serviceUid,
      killProcess: options.killProcess,
    }
  }

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
      const format = flags.format ?? 'memoseb'
      const isP2P = format === 'p2p' || format === 'gaze'
      const defaultFileName = isP2P
        ? 'gaze-bundle.json'
        : 'memoseb-snapshot.json'
      const targetFile =
        positional[1] ?? flags.out ?? flags.file ?? path.resolve(cwd, defaultFileName)
      const resolvedPath = path.resolve(cwd, targetFile)

      let checksum: string
      let projectCount: number
      let memoryCount: number
      let tombstoneCount: number

      if (isP2P) {
        const payload = vault.exportP2PPayload({ projectId: flags.project })
        writeP2PPayloadFile(resolvedPath, payload)
        checksum = payload.checksum
        projectCount = payload.projects?.length ?? 0
        memoryCount = payload.nodes.length
        tombstoneCount = payload.tombstones.length
      } else {
        const snapshot = vault.exportSnapshot({ projectId: flags.project })
        writeSnapshotFile(resolvedPath, snapshot)
        checksum = snapshot.checksum
        projectCount = snapshot.projects.length
        memoryCount = snapshot.memories.length
        tombstoneCount = snapshot.tombstones.length
      }

      try {
        const topology = new TopologyStore(runtime)
        await topology.broadcastSignal(BUNDLE_ID, 'memory.exported', {
          filePath: resolvedPath,
          checksum,
          projectCount,
          memoryCount,
          tombstoneCount,
          format: isP2P ? 'p2p-memory-contract' : 'memoseb-snapshot',
        })
      } catch {
        // Ignore topology broadcast errors if hubseb state is read-only
      }

      const payload = {
        filePath: resolvedPath,
        checksum,
        projectCount,
        memoryCount,
        tombstoneCount,
        format: isP2P ? 'p2p' : 'memoseb',
      }

      if (jsonMode) {
        return { exitCode: 0, stdout: serializeWire(wireSuccess('export', payload)), stderr: '' }
      }
      const lines = [
        `Exported ${isP2P ? 'p2p gaze bundle' : 'memoseb snapshot'} to ${resolvedPath}:`,
        `  Format:     ${isP2P ? 'p2p-memory-contract' : 'memoseb-snapshot'}`,
        `  Checksum:   ${checksum}`,
        `  Projects:   ${projectCount}`,
        `  Memories:   ${memoryCount}`,
        `  Tombstones: ${tombstoneCount}`,
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
        const groups = vault.listGroups()
        const lanUrls = getLocalLanUrls(config.listenPort)
        const service = nodeServiceStatus(serviceContext(vault))
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { config, peers, lanUrls, groups, service })),
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
          `  Tailscale:   ${config.tailscaleDiscovery === false ? 'disabled' : 'enabled'}${config.tailscaleBin ? ` (${config.tailscaleBin})` : ''}`,
          `  Interval:    ${config.syncIntervalMinutes} min`,
          `  Service:     ${describeService(service)}`,
          `  Auth token:  ${config.authToken ? 'configured' : 'none'}`,
          `  Default ACL: ${config.unassignedGroupPolicy ?? 'none'}`,
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
        if (groups.length > 0) {
          lines.push(`  Configured groups (${groups.length}):`)
          for (const g of groups) {
            lines.push(
              `    • [${g.name}] permissions=${g.permissions}, projects=[${g.projects.join(', ')}], categories=[${g.categories.join(', ')}], members=${g.memberNodeIds.length}`,
            )
          }
        }
        return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
      }

      if (subcommand === 'enable') {
        let roleInput = flags.role
        if (!roleInput) {
          if (flags.parent) {
            roleInput = 'child'
          } else if (flags.peer) {
            roleInput = 'peer'
          } else if (discoverMode) {
            roleInput = 'child'
          } else {
            if (jsonMode) {
              return {
                exitCode: 2,
                stdout: serializeWire(
                  wireFailure(
                    'node',
                    'INVALID_ROLE',
                    'Node role must be "parent", "child", or "peer"',
                    'Usage: memoseb node enable --role parent|child|peer',
                  ),
                ),
                stderr: '',
              }
            }
            return {
              exitCode: 2,
              stdout: '',
              stderr:
                'Node role must be "parent", "child", or "peer". Usage: memoseb node enable --role parent|child|peer\n',
            }
          }
        }

        const role = parseNodeRoleInput(roleInput)
        if (!role || (role !== 'parent' && role !== 'child' && role !== 'peer')) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'INVALID_ROLE',
                  `Invalid role "${roleInput}". Must be "parent", "child", or "peer"`,
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: `Invalid role "${roleInput}". Must be "parent", "child", or "peer".\n`,
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
          syncIntervalMinutes:
            flags.interval !== undefined && Number(flags.interval) > 0
              ? Number(flags.interval)
              : undefined,
          tailscaleDiscovery: switches.has('no-tailscale')
            ? false
            : switches.has('tailscale')
              ? true
              : undefined,
          tailscaleBin: flags['tailscale-bin'],
        })

        let generatedToken: string | undefined
        if (role === 'peer' && !vault.getNodeConfig().authToken) {
          generatedToken = crypto.randomBytes(32).toString('hex')
          vault.updateNodeConfig({ authToken: generatedToken })
        }

        const groupArg = flags.group ?? flags.groups
        const requestedGroups = groupArg
          ? groupArg
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined

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
                groups: requestedGroups,
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
                groups: requestedGroups,
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
        } else if (role === 'peer') {
          if (discoverMode && !flags.peer) {
            const nodes = await discoverLanNodes({
              port: Number(flags.port) || undefined,
              timeoutMs: Number(flags.timeout) || 800,
              token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
            })
            if (nodes.length > 0) {
              const first = nodes[0]!
              const peerUrl = first.urls[0] ?? `http://${first.address}:${first.port}`
              const normalized = normalizePeerUrl(peerUrl)
              vault.upsertPeer({
                role: 'peer',
                url: normalized,
                name: first.nodeName,
                peerNodeId: first.nodeId,
                authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
                lastStatus: 'configured',
              })
              try {
                await performPeerHandshake(vault, {
                  peerUrl: normalized,
                  peerRole: 'peer',
                  callbackUrl: peerCallbackUrl(vault, normalized),
                  token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
                  groups: requestedGroups,
                })
              } catch {
                // Tolerated
              }
            }
          } else if (flags.peer) {
            const normalized = normalizePeerUrl(flags.peer)
            vault.upsertPeer({
              role: 'peer',
              url: normalized,
              name: flags.name,
              authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
              lastStatus: 'configured',
            })
            try {
              await performPeerHandshake(vault, {
                peerUrl: normalized,
                peerRole: 'peer',
                callbackUrl: peerCallbackUrl(vault, normalized),
                token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
                groups: requestedGroups,
              })
            } catch {
              // Tolerated
            }
          }
        }

        const config = vault.getNodeConfig()
        const peers = vault.listPeers()
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(
              wireSuccess('node', {
                config,
                peers,
                ...(generatedToken ? { generatedToken } : {}),
              }),
            ),
            stderr: '',
          }
        }
        const enableLines = [
          `Node mode ENABLED as role=${config.role} (nodeId: ${config.nodeId}). Registered peers: ${peers.length}.`,
        ]
        if (generatedToken) {
          enableLines.push(
            `Generated sync token (shown once; use the same token on every node): ${generatedToken}`,
          )
        }
        if (config.role === 'peer') {
          enableLines.push(
            'Auto-sync runs while "memoseb node serve" is open. To keep it running in the background, opt in with "memoseb node service install".',
          )
        }
        return { exitCode: 0, stdout: `${enableLines.join('\n')}\n`, stderr: '' }
      }

      if (subcommand === 'disable') {
        vault.disableNodeMode({ purgePeers })
        const service = await uninstallNodeService(serviceContext(vault))
        const config = vault.getNodeConfig()
        const peers = vault.listPeers()
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { config, peers, service })),
            stderr: '',
          }
        }
        const serviceNote = service.removed ? ' Background service removed.' : ''
        return {
          exitCode: 0,
          stdout: `Node networking DISABLED (standalone). Registered peers: ${peers.length}.${serviceNote}\n`,
          stderr: '',
        }
      }

      if (subcommand === 'service') {
        const action = positional[2] ?? 'status'
        const ctx = serviceContext(vault)
        const firewallPort = vault.getNodeConfig().listenPort
        const firewall = windowsFirewallRule(firewallPort)
        const applyFirewall = async (): Promise<{
          applied: boolean
          command: string
          error?: string
        }> => {
          if (runtime.platform !== 'win32') {
            return {
              applied: false,
              command: firewall.powershell,
              error: 'The Windows Firewall rule is not needed on this platform.',
            }
          }
          const res = await applyWindowsFirewallRule(runtime, firewallPort)
          return { applied: res.ok, command: res.command, ...(res.error ? { error: res.error } : {}) }
        }

        if (action === 'install') {
          const config = vault.getNodeConfig()
          if (!config.enabled) {
            const message =
              'Node networking is disabled. Enable it first with "memoseb node enable --role peer".'
            if (jsonMode) {
              return {
                exitCode: 2,
                stdout: serializeWire(wireFailure('node', 'NODE_DISABLED', message)),
                stderr: '',
              }
            }
            return { exitCode: 2, stdout: '', stderr: `${message}\n` }
          }
          let service: ServiceReport
          try {
            service = await installNodeService(ctx)
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            if (jsonMode) {
              return {
                exitCode: 1,
                stdout: serializeWire(wireFailure('node', 'SERVICE_INSTALL_FAILED', message)),
                stderr: '',
              }
            }
            return { exitCode: 1, stdout: '', stderr: `Service install failed: ${message}\n` }
          }
          const firewallResult = switches.has('firewall') ? await applyFirewall() : undefined
          const installExit = service.supported ? 0 : 1
          if (jsonMode) {
            return {
              exitCode: installExit,
              stdout: serializeWire(
                wireSuccess('node', {
                  service,
                  ...(firewallResult ? { firewall: firewallResult } : {}),
                }),
              ),
              stderr: '',
            }
          }
          const lines = [`memoseb node service: ${describeService(service)}`]
          if (service.logFile) lines.push(`  Log: ${service.logFile}`)
          for (const w of service.warnings) lines.push(`  Warning: ${w}`)
          if (firewallResult) {
            lines.push(
              firewallResult.applied
                ? '  Windows Firewall rule memoseb-node created.'
                : `  Firewall rule not created (${firewallResult.error ?? 'cancelled'}). Run in an elevated PowerShell: ${firewallResult.command}`,
            )
          } else if (runtime.platform === 'win32') {
            lines.push(
              '  To accept peers over Tailscale, allow the port in Windows Firewall (opt-in): memoseb node service firewall --apply',
            )
          }
          return { exitCode: installExit, stdout: `${lines.join('\n')}\n`, stderr: '' }
        }

        if (action === 'uninstall' || action === 'remove') {
          const service = await uninstallNodeService(ctx)
          if (jsonMode) {
            return { exitCode: 0, stdout: serializeWire(wireSuccess('node', { service })), stderr: '' }
          }
          return {
            exitCode: 0,
            stdout: service.removed
              ? `memoseb node service removed (${service.mode ?? service.manager}).\n`
              : 'memoseb node service was not installed.\n',
            stderr: '',
          }
        }

        if (action === 'firewall') {
          if (switches.has('apply')) {
            const result = await applyFirewall()
            const firewallExit = result.applied || runtime.platform !== 'win32' ? 0 : 1
            if (jsonMode) {
              return {
                exitCode: firewallExit,
                stdout: serializeWire(wireSuccess('node', { firewall: result })),
                stderr: '',
              }
            }
            return {
              exitCode: firewallExit,
              stdout: result.applied
                ? `Windows Firewall rule created: ${result.command}\n`
                : `Firewall rule not created (${result.error ?? 'cancelled'}). Run in an elevated PowerShell:\n  ${result.command}\n`,
              stderr: '',
            }
          }
          if (jsonMode) {
            return {
              exitCode: 0,
              stdout: serializeWire(
                wireSuccess('node', {
                  firewall: { applied: false, command: firewall.powershell, netsh: firewall.netshArgs },
                }),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 0,
            stdout: `Allow inbound TCP ${firewallPort} from Tailscale (100.64.0.0/10) in an elevated PowerShell:\n  ${firewall.powershell}\nOr let memoseb request elevation (UAC): memoseb node service firewall --apply\n`,
            stderr: '',
          }
        }

        if (action === 'status') {
          const service = nodeServiceStatus(ctx)
          if (jsonMode) {
            return { exitCode: 0, stdout: serializeWire(wireSuccess('node', { service })), stderr: '' }
          }
          return {
            exitCode: 0,
            stdout: `memoseb node service: ${describeService(service)}\n`,
            stderr: '',
          }
        }

        const usage =
          'Usage: memoseb node service <install [--firewall]|uninstall|status|firewall [--apply]>'
        if (jsonMode) {
          return {
            exitCode: 2,
            stdout: serializeWire(
              wireFailure('node', 'UNKNOWN_SUBCOMMAND', `Unknown service action "${action}"`, usage),
            ),
            stderr: '',
          }
        }
        return { exitCode: 2, stdout: '', stderr: `Unknown service action "${action}". ${usage}\n` }
      }

      if (subcommand === 'discover') {
        const lanNodes = await discoverLanNodes({
          port: Number(flags.port) || undefined,
          timeoutMs: Number(flags.timeout) || 1200,
          token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
        })
        const discoverConfig = vault.getNodeConfig()
        const tailnet =
          switches.has('no-tailscale') || discoverConfig.tailscaleDiscovery === false
            ? null
            : await discoverPeers(vault, runtime, {
                port: Number(flags.port) || discoverConfig.listenPort,
                lan: false,
              })
        const nodes = [...lanNodes]
        for (const n of tailnet?.tailnet ?? []) {
          if (!nodes.some((existing) => existing.nodeId === n.nodeId)) nodes.push(n)
        }
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(
              wireSuccess('node', {
                nodes,
                parents: nodes,
                tailscale: tailnet?.tailscale ?? 'disabled',
              }),
            ),
            stderr: '',
          }
        }
        if (nodes.length === 0) {
          return {
            exitCode: 0,
            stdout: `No memoseb nodes discovered on LAN or tailnet (tailscale: ${tailnet?.tailscale ?? 'disabled'}).\n`,
            stderr: '',
          }
        }
        const lines = [`Discovered ${nodes.length} nodes on LAN:`]
        for (const p of nodes) {
          lines.push(`  • [${p.role}] ${p.nodeName} (${p.nodeId}) at ${p.urls.join(', ')} [requiresAuth: ${p.requiresAuth}]`)
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
        const groupArg = flags.group ?? flags.groups
        const requestedGroups = groupArg
          ? groupArg
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined
        try {
          await performPeerHandshake(vault, {
            peerUrl: normalizedUrl,
            peerRole: 'parent',
            token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
            groups: requestedGroups,
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
        const groupFlag = flags.group ?? flags.groups
        if (groupFlag && peer) {
          const groupNames = groupFlag
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          for (const g of groupNames) {
            if (!vault.getGroup(g)) {
              vault.upsertGroup({ name: g })
            }
            vault.addNodeToGroup(g, peer.url)
            if (peer.peerNodeId) {
              vault.addNodeToGroup(g, peer.peerNodeId)
            }
            if (peer.id) {
              vault.addNodeToGroup(g, peer.id)
            }
          }
        }
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

      if (subcommand === 'add-peer' || subcommand === 'connect' || subcommand === 'pair') {
        const targetUrl = positional[2] ?? flags.url ?? flags.peer
        if (!targetUrl) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'node',
                  'MISSING_URL',
                  'Peer URL is required',
                  'Usage: memoseb node add-peer <url> [--name <n>] [--token <t>] [--group <g>]',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Peer URL is required. Usage: memoseb node add-peer <url>\n',
          }
        }
        const currentConfig = vault.getNodeConfig()
        if (!currentConfig.enabled || currentConfig.role === 'standalone') {
          vault.enableNodeMode({ role: 'peer' })
        }
        const normalizedUrl = normalizePeerUrl(targetUrl)
        vault.upsertPeer({
          role: 'peer',
          url: normalizedUrl,
          name: flags.name,
          authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
          lastStatus: 'configured',
        })
        const groupFlag = flags.group ?? flags.groups
        const requestedGroups = groupFlag
          ? groupFlag
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined
        try {
          await performPeerHandshake(vault, {
            peerUrl: normalizedUrl,
            peerRole: 'peer',
            callbackUrl: peerCallbackUrl(vault, normalizedUrl),
            token: flags.token ?? vault.getNodeConfig().authToken ?? undefined,
            groups: requestedGroups,
          })
        } catch {
          vault.upsertPeer({
            role: 'peer',
            url: normalizedUrl,
            name: flags.name,
            authToken: flags.token ?? vault.getNodeConfig().authToken ?? null,
            lastStatus: 'configured',
          })
        }
        const peer = vault.listPeers().find((p) => p.url === normalizedUrl)
        if (groupFlag && peer) {
          const groupNames = groupFlag
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
          for (const g of groupNames) {
            if (!vault.getGroup(g)) {
              vault.upsertGroup({ name: g })
            }
            vault.addNodeToGroup(g, peer.url)
            if (peer.peerNodeId) {
              vault.addNodeToGroup(g, peer.peerNodeId)
            }
            if (peer.id) {
              vault.addNodeToGroup(g, peer.id)
            }
          }
        }
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('node', { peer, config: vault.getNodeConfig() })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Added peer ${normalizedUrl} (status: ${peer?.lastStatus ?? 'configured'}).\n`,
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

      if (subcommand === 'serve' && switches.has('detach')) {
        const dataDir = path.dirname(path.resolve(vault.dbPath))
        fs.mkdirSync(dataDir, { recursive: true })
        const logFile = path.join(dataDir, 'node-serve.log')
        const childArgs = argv.filter((a) => a !== '--detach')
        if (!childArgs.includes('--db')) {
          childArgs.push('--db', path.resolve(vault.dbPath))
        }
        const out = fs.openSync(logFile, 'a')
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv.filter((a) => a.startsWith('--experimental-')),
            options.serviceEntry ?? CLI_ENTRY,
            ...childArgs,
          ],
          { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: runtime.env },
        )
        child.unref()
        fs.closeSync(out)
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(
              wireSuccess('node', { detached: true, pid: child.pid ?? null, logFile }),
            ),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `memoseb node serve started in background (pid ${child.pid ?? 'unknown'}); log: ${logFile}\n`,
          stderr: '',
        }
      }

      if (subcommand === 'serve') {
        const config = vault.getNodeConfig()
        const roleToUse: PeerRole =
          flags.role === 'child' || flags.role === 'parent' || flags.role === 'peer' || flags.role === 'p2p'
            ? normalizePeerRole(flags.role)
            : config.role === 'standalone'
              ? 'parent'
              : (config.role as PeerRole)
        if (!config.enabled) {
          vault.enableNodeMode({
            role: roleToUse,
            listenHost: flags.host,
            listenPort: flags.port !== undefined ? Number(flags.port) : undefined,
            authToken: flags.token,
            lanDiscovery: noLanFlag ? false : undefined,
          })
        }
        const serveConfig = vault.getNodeConfig()
        const serveHost = flags.host ?? serveConfig.listenHost
        const serveToken = flags.token ?? serveConfig.authToken
        if (serveConfig.role === 'peer' && !serveToken && !isLoopbackHost(serveHost)) {
          const message = `Refusing to serve peer node on ${serveHost} without a sync token.`
          const hint =
            'Run "memoseb node enable --role peer" (generates a token) or pass --token <t>, or bind to 127.0.0.1 with --host.'
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(wireFailure('node', 'TOKEN_REQUIRED', message, hint)),
              stderr: '',
            }
          }
          return { exitCode: 2, stdout: '', stderr: `${message} ${hint}\n` }
        }

        let loop: AutoSyncLoopHandle | null = null
        const handle = await startSyncServer(vault, {
          host: flags.host,
          port: flags.port !== undefined ? Number(flags.port) : undefined,
          token: flags.token,
          enableUdpDiscovery: !noLanFlag,
          onImported: (result) => {
            if (result.memoriesCreated + result.memoriesUpdated + result.tombstonesApplied > 0) {
              loop?.notifyChange('remote-import')
            }
          },
        })

        if (!noAutoSyncLoop) {
          loop = startAutoSyncLoop(vault, {
            intervalMs:
              flags.interval !== undefined && Number(flags.interval) > 0
                ? Number(flags.interval) * 60_000
                : undefined,
            discover: () =>
              discoverPeers(vault, runtime, {
                port: handle.port,
                lan: !noLanFlag && vault.getNodeConfig().lanDiscovery,
              }).then((r) => r.nodes),
            callbackUrl: (peerUrl) =>
              resolveCallbackUrl(peerUrl, { port: handle.port, listenHost: handle.host }),
            onEvent: (event) => {
              if (event.error) {
                process.stderr.write(`memoseb auto-sync [${event.reason}] error: ${event.error}\n`)
                return
              }
              if (event.discovered && event.discovered.length > 0) {
                process.stderr.write(
                  `memoseb auto-sync discovered peers: ${event.discovered.join(', ')}\n`,
                )
              }
              if (event.summary) {
                const pulled = event.summary.results.reduce(
                  (n, r) => n + r.pulled.memoriesCreated + r.pulled.memoriesUpdated,
                  0,
                )
                process.stderr.write(
                  `memoseb auto-sync [${event.reason}] peers=${event.summary.results.length} errors=${event.summary.errors.length} pulled=${pulled}\n`,
                )
              }
            },
          })
        }
        const pidFile = writeServePidFile(path.dirname(vault.dbPath))

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
            await loop?.close()
            await handle.close()
            removeServePidFile(pidFile)
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
              'Usage: memoseb node <status|enable|disable|discover|set-parent|add-child|add-peer|remove|serve|service>',
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Unknown node subcommand "${subcommand}". Usage: memoseb node <status|enable|disable|discover|set-parent|add-child|add-peer|remove|serve|service>\n`,
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'group' || command === 'groups') {
    const subcommand = positional[1] ?? 'list'
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      if (subcommand === 'list') {
        const groups = vault.listGroups()
        const unassignedGroupPolicy = vault.getNodeConfig().unassignedGroupPolicy ?? 'none'
        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('group', { groups, unassignedGroupPolicy })),
            stderr: '',
          }
        }
        const lines = [
          `memoseb group list (default policy for unassigned nodes: ${unassignedGroupPolicy}):`,
        ]
        if (groups.length === 0) {
          lines.push('  (no groups configured)')
        } else {
          for (const g of groups) {
            lines.push(
              `  • [${g.name}] permissions=${g.permissions}, projects=[${g.projects.join(', ')}], categories=[${g.categories.join(', ')}], hasToken=${Boolean(g.groupToken)}, members=[${g.memberNodeIds.join(', ') || 'none'}]`,
            )
            if (g.description) {
              lines.push(`      description: ${g.description}`)
            }
          }
        }
        return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
      }

      if (subcommand === 'create' || subcommand === 'upsert' || subcommand === 'set') {
        const groupName = positional[2]
        if (!groupName) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'group',
                  'MISSING_GROUP_NAME',
                  'Group name is required',
                  'Usage: memoseb group create <name> [options]',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Group name is required. Usage: memoseb group create <name> [options]\n',
          }
        }

        const rawProjects = flags.projects ?? flags.project
        const projects =
          rawProjects !== undefined
            ? rawProjects.split(',').map((p) => p.trim()).filter(Boolean)
            : undefined

        const rawCategories = flags.categories ?? flags.category
        let categories: string[] | undefined = undefined
        if (rawCategories !== undefined) {
          categories = rawCategories.split(',').map((c) => c.trim()).filter(Boolean)
          for (const cat of categories) {
            if (cat !== '*' && !isMemoryCategory(cat)) {
              if (jsonMode) {
                return {
                  exitCode: 2,
                  stdout: serializeWire(
                    wireFailure(
                      'group',
                      'INVALID_CATEGORY',
                      `Invalid category "${cat}". Must be one of: ${MEMORY_CATEGORIES.join(', ')}, *`,
                    ),
                  ),
                  stderr: '',
                }
              }
              return {
                exitCode: 2,
                stdout: '',
                stderr: `Invalid category "${cat}". Must be one of: ${MEMORY_CATEGORIES.join(', ')}, *\n`,
              }
            }
          }
        }

        let permissions: GroupPermissionMode | undefined = undefined
        if (flags.permissions !== undefined) {
          if (!isGroupPermissionMode(flags.permissions)) {
            if (jsonMode) {
              return {
                exitCode: 2,
                stdout: serializeWire(
                  wireFailure(
                    'group',
                    'INVALID_PERMISSIONS',
                    `Invalid permissions "${flags.permissions}". Must be readwrite, readonly, or writeonly`,
                  ),
                ),
                stderr: '',
              }
            }
            return {
              exitCode: 2,
              stdout: '',
              stderr: `Invalid permissions "${flags.permissions}". Must be readwrite, readonly, or writeonly.\n`,
            }
          }
          permissions = flags.permissions
        }

        const group = vault.upsertGroup({
          name: groupName,
          description: flags.description,
          projects,
          categories,
          permissions,
          groupToken: flags.token,
        })

        try {
          const topology = new TopologyStore(runtime)
          await topology.broadcastSignal(BUNDLE_ID, 'memory.group.updated', {
            action: 'upsert',
            group: group.name,
          })
        } catch {
          // ignore
        }

        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('group', { group })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Created/updated group "${group.name}" (permissions: ${group.permissions}, projects: [${group.projects.join(', ')}], categories: [${group.categories.join(', ')}]).\n`,
          stderr: '',
        }
      }

      if (subcommand === 'add-node' || subcommand === 'assign') {
        const groupName = positional[2]
        const nodeIdentifier = positional[3]
        if (!groupName || !nodeIdentifier) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'group',
                  'MISSING_ARGUMENTS',
                  'Group name and node identifier are required',
                  'Usage: memoseb group add-node <group-name> <node-identifier>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr:
              'Group name and node identifier are required. Usage: memoseb group add-node <group-name> <node-identifier>\n',
          }
        }

        const group = vault.addNodeToGroup(groupName, nodeIdentifier)

        try {
          const topology = new TopologyStore(runtime)
          await topology.broadcastSignal(BUNDLE_ID, 'memory.group.updated', {
            action: 'add_node',
            group: group.name,
            node: nodeIdentifier,
          })
        } catch {
          // ignore
        }

        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('group', { group, addedNode: nodeIdentifier })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Added node "${nodeIdentifier}" to group "${group.name}".\n`,
          stderr: '',
        }
      }

      if (subcommand === 'remove-node' || subcommand === 'unassign') {
        const groupName = positional[2]
        const nodeIdentifier = positional[3]
        if (!groupName || !nodeIdentifier) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'group',
                  'MISSING_ARGUMENTS',
                  'Group name and node identifier are required',
                  'Usage: memoseb group remove-node <group-name> <node-identifier>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr:
              'Group name and node identifier are required. Usage: memoseb group remove-node <group-name> <node-identifier>\n',
          }
        }

        const group = vault.removeNodeFromGroup(groupName, nodeIdentifier)

        try {
          const topology = new TopologyStore(runtime)
          await topology.broadcastSignal(BUNDLE_ID, 'memory.group.updated', {
            action: 'remove_node',
            group: group.name,
            node: nodeIdentifier,
          })
        } catch {
          // ignore
        }

        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(wireSuccess('group', { group, removedNode: nodeIdentifier })),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Removed node "${nodeIdentifier}" from group "${group.name}".\n`,
          stderr: '',
        }
      }

      if (subcommand === 'delete' || subcommand === 'remove' || subcommand === 'rm') {
        const groupName = positional[2]
        if (!groupName) {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'group',
                  'MISSING_GROUP_NAME',
                  'Group name is required',
                  'Usage: memoseb group delete <group-name>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr: 'Group name is required. Usage: memoseb group delete <group-name>\n',
          }
        }

        const deleted = vault.deleteGroup(groupName)

        if (deleted) {
          try {
            const topology = new TopologyStore(runtime)
            await topology.broadcastSignal(BUNDLE_ID, 'memory.group.updated', {
              action: 'delete',
              group: groupName,
            })
          } catch {
            // ignore
          }
        }

        if (jsonMode) {
          return {
            exitCode: deleted ? 0 : 1,
            stdout: serializeWire(
              deleted
                ? wireSuccess('group', { name: groupName, deleted })
                : wireFailure('group', 'GROUP_NOT_FOUND', `Group "${groupName}" not found`),
            ),
            stderr: '',
          }
        }
        return {
          exitCode: deleted ? 0 : 1,
          stdout: deleted ? `Deleted group "${groupName}".\n` : '',
          stderr: deleted ? '' : `Group "${groupName}" not found.\n`,
        }
      }

      if (subcommand === 'default-policy') {
        const policyArg = positional[2] ?? flags.policy
        if (policyArg !== 'none' && policyArg !== 'all') {
          if (jsonMode) {
            return {
              exitCode: 2,
              stdout: serializeWire(
                wireFailure(
                  'group',
                  'INVALID_POLICY',
                  `Invalid policy "${policyArg}". Must be "none" or "all"`,
                  'Usage: memoseb group default-policy <none|all>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 2,
            stdout: '',
            stderr:
              'Invalid policy. Must be "none" or "all". Usage: memoseb group default-policy <none|all>\n',
          }
        }

        const config = vault.setUnassignedGroupPolicy(policyArg)

        try {
          const topology = new TopologyStore(runtime)
          await topology.broadcastSignal(BUNDLE_ID, 'memory.group.updated', {
            action: 'default_policy',
            policy: config.unassignedGroupPolicy,
          })
        } catch {
          // ignore
        }

        if (jsonMode) {
          return {
            exitCode: 0,
            stdout: serializeWire(
              wireSuccess('group', { unassignedGroupPolicy: config.unassignedGroupPolicy, config }),
            ),
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          stdout: `Default unassigned group policy set to "${config.unassignedGroupPolicy}".\n`,
          stderr: '',
        }
      }

      if (jsonMode) {
        return {
          exitCode: 2,
          stdout: serializeWire(
            wireFailure(
              'group',
              'UNKNOWN_SUBCOMMAND',
              `Unknown group subcommand "${subcommand}"`,
              'Run "memoseb help"',
            ),
          ),
          stderr: '',
        }
      }
      return {
        exitCode: 2,
        stdout: '',
        stderr: `Unknown group subcommand "${subcommand}". Run "memoseb help".\n`,
      }
    } catch (err: any) {
      const message = err instanceof Error ? err.message : String(err)
      if (jsonMode) {
        return {
          exitCode: 1,
          stdout: serializeWire(wireFailure('group', 'ERROR', message)),
          stderr: '',
        }
      }
      return {
        exitCode: 1,
        stdout: '',
        stderr: `Group operation failed: ${message}\n`,
      }
    } finally {
      vault.close()
    }
  }

  if (command === 'sync') {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      const contractArg = flags.contract ?? flags.format
      const contract: 'memoseb' | 'p2p' | 'gaze' | undefined =
        contractArg === 'p2p' || contractArg === 'gaze'
          ? (contractArg as 'p2p' | 'gaze')
          : undefined

      let syncResult
      if (flags.url) {
        syncResult = await syncWithPeer(vault, {
          peerUrl: flags.url,
          token: flags.token,
          projectId: flags.project,
          full: fullSync,
          forceWhenDisabled: true,
          contract,
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
                  'Run "memoseb node enable --role parent|child|peer" to enable networking or pass --url <peer-url>',
                ),
              ),
              stderr: '',
            }
          }
          return {
            exitCode: 1,
            stdout: '',
            stderr:
              'Node networking is disabled. Run "memoseb node enable --role parent|child|peer" or pass --url <peer-url>.\n',
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
      'group',
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
      '  memoseb node serve [--detach]                Serve the node with the auto-sync loop (LAN + Tailscale discovery)',
      '  memoseb node service <install|uninstall|status|firewall> Opt-in background service (launchd/systemd --user/schtasks)',
      '  memoseb group <list|create|add-node|delete|...> Manage peer permission groups and ACLs',
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
