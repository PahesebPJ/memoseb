import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  decodeWire,
  DriverHub,
  SystemRuntime,
  TopologyStore,
  type WireSuccess
} from 'hubseb'
import { executeMemoCli } from '../src/bin/memoseb.ts'
import type { ProjectAnalysisReport } from '../src/core/analyzer.ts'
import type {
  ProjectSummary,
  RecallResult,
  StoreMemoryResult,
  VaultStats
} from '../src/core/vault.ts'
import { MemoryVault } from '../src/core/vault.ts'
import { startSyncServer } from '../src/core/sync.ts'
import { handleMcpRequest } from '../src/mcp/server.ts'
import { deployMemoseb } from '../src/setup.ts'

describe('CLI hubseb/v1 Wire Contract, MCP JSON-RPC Server, and Topology Integration', () => {
  let tmpDir: string
  let homeDir: string
  let dbPath: string
  let runtime: SystemRuntime

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-cli-test-'))
    homeDir = path.join(tmpDir, 'home')
    fs.mkdirSync(homeDir, { recursive: true })
    dbPath = path.join(tmpDir, 'vault.sqlite')
    runtime = new SystemRuntime({
      homeDir,
      env: {
        HOME: homeDir,
        XDG_CONFIG_HOME: path.join(homeDir, '.config'),
        XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
        MEMOSEB_DB_PATH: dbPath
      }
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('executes all CLI commands in --json mode adhering to the hubseb/v1 wire contract', async () => {
    // 1. capabilities
    const capRes = await executeMemoCli(['capabilities', '--json'], { runtime, dbPath })
    assert.equal(capRes.exitCode, 0)
    const capPacket = decodeWire<{
      id: string
      provides: string[]
      consumes: string[]
      signals: string[]
    }>(capRes.stdout)
    assert.equal(capPacket.protocol, 'hubseb/v1')
    assert.equal(capPacket.status, 'success')
    assert.equal(capPacket.action, 'capabilities')
    assert.equal(capPacket.payload.id, 'memoseb')
    assert.deepEqual(capPacket.payload.provides, ['memory.vault'])

    // 2. remember
    const remRes = await executeMemoCli(
      [
        'remember',
        'Use deterministic FNV-1a feature hashing for offline embeddings.',
        '--project',
        'crew-app',
        '--category',
        'architecture',
        '--title',
        'Offline Embedder',
        '--tags',
        'embeddings,fnv1a',
        '--agent',
        'architect',
        '--importance',
        '0.9',
        '--json'
      ],
      { runtime, dbPath }
    )
    assert.equal(remRes.exitCode, 0)
    const remPacket = decodeWire<StoreMemoryResult>(remRes.stdout) as WireSuccess<StoreMemoryResult>
    assert.equal(remPacket.protocol, 'hubseb/v1')
    assert.equal(remPacket.status, 'success')
    assert.equal(remPacket.action, 'remember')
    assert.equal(remPacket.payload.created, true)
    assert.equal(remPacket.payload.memory.projectId, 'crew-app')
    assert.equal(remPacket.payload.memory.category, 'architecture')
    const memoryId = remPacket.payload.memory.id

    // 3. recall
    const recRes = await executeMemoCli(
      [
        'recall',
        'deterministic feature hashing embeddings',
        '--project',
        'crew-app',
        '--limit',
        '3',
        '--max-tokens',
        '800',
        '--json'
      ],
      { runtime, dbPath }
    )
    assert.equal(recRes.exitCode, 0)
    const recPacket = decodeWire<RecallResult>(recRes.stdout) as WireSuccess<RecallResult>
    assert.equal(recPacket.protocol, 'hubseb/v1')
    assert.equal(recPacket.status, 'success')
    assert.equal(recPacket.action, 'recall')
    assert.equal(recPacket.payload.projectId, 'crew-app')
    assert.equal(recPacket.payload.memories.length, 1)
    assert.equal(recPacket.payload.memories[0]?.id, memoryId)

    // 4. context
    const ctxRes = await executeMemoCli(
      ['context', '--project', 'crew-app', '--max-tokens', '600', '--json'],
      { runtime, dbPath }
    )
    assert.equal(ctxRes.exitCode, 0)
    const ctxPacket = decodeWire<RecallResult>(ctxRes.stdout) as WireSuccess<RecallResult>
    assert.equal(ctxPacket.protocol, 'hubseb/v1')
    assert.equal(ctxPacket.status, 'success')
    assert.equal(ctxPacket.action, 'context')
    assert.equal(ctxPacket.payload.memories.length, 1)

    // 5. projects
    const projRes = await executeMemoCli(['projects', '--json'], { runtime, dbPath })
    assert.equal(projRes.exitCode, 0)
    const projPacket = decodeWire<{ projects: ProjectSummary[] }>(
      projRes.stdout
    ) as WireSuccess<{ projects: ProjectSummary[] }>
    assert.equal(projPacket.protocol, 'hubseb/v1')
    assert.equal(projPacket.status, 'success')
    assert.equal(projPacket.action, 'projects')
    assert.equal(projPacket.payload.projects.length, 1)
    assert.equal(projPacket.payload.projects[0]?.id, 'crew-app')

    // 6. stats
    const statsRes = await executeMemoCli(['stats', '--json'], { runtime, dbPath })
    assert.equal(statsRes.exitCode, 0)
    const statsPacket = decodeWire<VaultStats>(statsRes.stdout) as WireSuccess<VaultStats>
    assert.equal(statsPacket.protocol, 'hubseb/v1')
    assert.equal(statsPacket.status, 'success')
    assert.equal(statsPacket.action, 'stats')
    assert.equal(statsPacket.payload.memoryCount, 1)
    assert.equal(statsPacket.payload.vectorCount, 1)

    // 7. forget
    const forgetRes = await executeMemoCli(['forget', memoryId, '--json'], {
      runtime,
      dbPath
    })
    assert.equal(forgetRes.exitCode, 0)
    const forgetPacket = decodeWire<{ id: string; deleted: boolean }>(
      forgetRes.stdout
    ) as WireSuccess<{ id: string; deleted: boolean }>
    assert.equal(forgetPacket.protocol, 'hubseb/v1')
    assert.equal(forgetPacket.status, 'success')
    assert.equal(forgetPacket.action, 'forget')
    assert.equal(forgetPacket.payload.id, memoryId)
    assert.equal(forgetPacket.payload.deleted, true)

    // 8. help
    const helpRes = await executeMemoCli(['help', '--json'], { runtime, dbPath })
    assert.equal(helpRes.exitCode, 0)
    const helpPacket = decodeWire<{ commands: string[] }>(helpRes.stdout) as WireSuccess<{
      commands: string[]
    }>
    assert.equal(helpPacket.protocol, 'hubseb/v1')
    assert.equal(helpPacket.status, 'success')
    assert.equal(helpPacket.action, 'help')
    assert.ok(helpPacket.payload.commands.includes('analyze'))
    assert.ok(helpPacket.payload.commands.includes('remember'))
    assert.ok(helpPacket.payload.commands.includes('recall'))
  })

  it('analyzes a repository with memoseb analyze (--dry-run and persisted) and populates project briefing', async () => {
    const sampleRepo = path.join(tmpDir, 'sample-service')
    fs.mkdirSync(path.join(sampleRepo, 'src', 'core'), { recursive: true })
    fs.mkdirSync(path.join(sampleRepo, '.github', 'workflows'), { recursive: true })

    fs.writeFileSync(
      path.join(sampleRepo, 'package.json'),
      JSON.stringify(
        {
          name: '@acme/sample-service',
          version: '1.0.0',
          description: 'Event-driven billing reconciler and invoice ledger.',
          type: 'module',
          bin: { 'sample-service': './dist/cli.js' },
          scripts: {
            build: 'tsc -p tsconfig.json',
            test: 'node --test',
            typecheck: 'tsc --noEmit'
          },
          dependencies: {
            hubseb: '^0.2.0'
          },
          keywords: ['billing', 'ledger']
        },
        null,
        2
      )
    )
    fs.writeFileSync(
      path.join(sampleRepo, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2023', module: 'NodeNext' } })
    )
    fs.writeFileSync(
      path.join(sampleRepo, '.github', 'workflows', 'ci.yml'),
      'name: CI Pipeline\non: [push]\n'
    )
    fs.writeFileSync(
      path.join(sampleRepo, 'README.md'),
      '# Sample Service\n\nHigh-throughput ledger reconciliation microservice.\n\n## Architecture\n\nUses hexagonal ports.\n\n## CLI Commands\n\nRun reconciler.\n'
    )

    // 1. Dry-run should synthesize 3 drafts without storing in vault
    const dryRes = await executeMemoCli(['analyze', sampleRepo, '--dry-run', '--json'], {
      runtime,
      dbPath
    })
    assert.equal(dryRes.exitCode, 0)
    const dryPacket = decodeWire<ProjectAnalysisReport>(
      dryRes.stdout
    ) as WireSuccess<ProjectAnalysisReport>
    assert.equal(dryPacket.action, 'analyze')
    assert.equal(dryPacket.payload.dryRun, true)
    assert.equal(dryPacket.payload.project.id, 'sample-service')
    assert.equal(dryPacket.payload.drafts.length, 3)
    assert.equal(dryPacket.payload.stored.length, 0)
    assert.ok(dryPacket.payload.totalTokens > 0)

    const emptyCtxRes = await executeMemoCli(
      ['context', '--project', 'sample-service', '--json'],
      { runtime, dbPath }
    )
    const emptyCtx = decodeWire<RecallResult>(emptyCtxRes.stdout) as WireSuccess<RecallResult>
    assert.equal(emptyCtx.payload.memories.length, 0)

    // 2. Full analyze should persist the 3 memories (architecture, convention, domain)
    const analyzeRes = await executeMemoCli(['analyze', sampleRepo, '--json'], {
      runtime,
      dbPath
    })
    assert.equal(analyzeRes.exitCode, 0)
    const analyzePacket = decodeWire<ProjectAnalysisReport>(
      analyzeRes.stdout
    ) as WireSuccess<ProjectAnalysisReport>
    assert.equal(analyzePacket.action, 'analyze')
    assert.equal(analyzePacket.payload.dryRun, false)
    assert.equal(analyzePacket.payload.stored.length, 3)
    assert.deepEqual(
      analyzePacket.payload.stored.map((s) => s.memory.category),
      ['architecture', 'convention', 'domain']
    )

    // 3. Context briefing now returns all 3 synthesized memories ordered by importance
    const ctxRes = await executeMemoCli(
      ['context', '--project', 'sample-service', '--max-tokens', '1200', '--json'],
      { runtime, dbPath }
    )
    assert.equal(ctxRes.exitCode, 0)
    const ctxPacket = decodeWire<RecallResult>(ctxRes.stdout) as WireSuccess<RecallResult>
    assert.equal(ctxPacket.payload.memories.length, 3)
    assert.equal(ctxPacket.payload.memories[0]?.category, 'architecture')
    assert.equal(ctxPacket.payload.memories[1]?.category, 'convention')
    assert.equal(ctxPacket.payload.memories[2]?.category, 'domain')

    // 4. Invalid path returns INVALID_PATH error with exitCode 2
    const invalidRes = await executeMemoCli(
      ['analyze', path.join(tmpDir, 'non-existent-dir'), '--json'],
      { runtime, dbPath }
    )
    assert.equal(invalidRes.exitCode, 2)
    assert.match(invalidRes.stdout, /INVALID_PATH/)
  })

  it('handles MCP JSON-RPC requests for initialize, tools/list, and tools/call lifecycle', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      // initialize
      const initRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize'
      })) as {
        jsonrpc: string
        id: number
        result: { serverInfo: { name: string }; protocolVersion: string }
      }
      assert.equal(initRes.jsonrpc, '2.0')
      assert.equal(initRes.id, 1)
      assert.equal(initRes.result.serverInfo.name, 'memoseb')

      // tools/list
      const listRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list'
      })) as {
        id: number
        result: { tools: Array<{ name: string }> }
      }
      const toolNames = listRes.result.tools.map((t) => t.name)
      assert.deepEqual(toolNames, [
        'memory_store',
        'memory_recall',
        'memory_briefing',
        'memory_forget',
        'memory_analyze',
        'memory_export',
        'memory_import',
        'memory_sync',
        'memory_group',
      ])

      // tools/call -> memory_store
      const storeRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'memory_store',
          arguments: {
            projectId: 'mcp-proj',
            category: 'bugfix',
            title: 'Wal Checkpoint Fix',
            content: 'Run WAL checkpoint before archiving SQLite vault snapshots.',
            tags: ['sqlite', 'wal'],
            importance: 0.85
          }
        }
      })) as {
        result: { content: Array<{ type: string; text: string }> }
      }
      const storedPayload = JSON.parse(storeRes.result.content[0]!.text) as StoreMemoryResult
      assert.equal(storedPayload.created, true)
      assert.equal(storedPayload.memory.projectId, 'mcp-proj')

      // tools/call -> memory_recall
      const recallRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'memory_recall',
          arguments: {
            projectId: 'mcp-proj',
            query: 'WAL checkpoint SQLite snapshots',
            limit: 5,
            maxTokens: 500
          }
        }
      })) as {
        result: { content: Array<{ type: string; text: string }> }
      }
      const recallPayload = JSON.parse(recallRes.result.content[0]!.text) as RecallResult
      assert.equal(recallPayload.memories.length, 1)
      assert.equal(recallPayload.memories[0]?.id, storedPayload.memory.id)

      // tools/call -> memory_briefing
      const briefingRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'memory_briefing',
          arguments: {
            projectId: 'mcp-proj',
            maxTokens: 500
          }
        }
      })) as {
        result: { content: Array<{ type: string; text: string }> }
      }
      const briefingPayload = JSON.parse(briefingRes.result.content[0]!.text) as RecallResult
      assert.equal(briefingPayload.memories.length, 1)
      assert.equal(briefingPayload.memories[0]?.id, storedPayload.memory.id)

      // tools/call -> memory_forget
      const forgetRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'memory_forget',
          arguments: {
            id: storedPayload.memory.id
          }
        }
      })) as {
        result: { content: Array<{ type: string; text: string }> }
      }
      const forgetPayload = JSON.parse(forgetRes.result.content[0]!.text) as {
        id: string
        deleted: boolean
      }
      assert.equal(forgetPayload.id, storedPayload.memory.id)
      assert.equal(forgetPayload.deleted, true)

      // tools/call -> memory_analyze
      const analyzeMcpRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'memory_analyze',
          arguments: {
            path: process.cwd(),
            projectId: 'mcp-analyzed-proj',
            dryRun: false
          }
        }
      })) as {
        result: { content: Array<{ type: string; text: string }> }
      }
      const analyzePayload = JSON.parse(
        analyzeMcpRes.result.content[0]!.text
      ) as ProjectAnalysisReport
      assert.equal(analyzePayload.project.id, 'mcp-analyzed-proj')
      assert.equal(analyzePayload.drafts.length, 3)
      assert.equal(analyzePayload.stored.length, 3)
    } finally {
      vault.close()
    }
  })

  it('connects crewseb consumer to memoseb provider in hubseb TopologyStore and deploys via DriverHub', async () => {
    const topology = new TopologyStore(runtime)
    const claudeRoot = path.join(homeDir, '.claude')
    fs.mkdirSync(claudeRoot, { recursive: true })
    const roots = { claude: claudeRoot }

    // Register crewseb consuming 'memory.vault'
    await topology.attachNode({
      id: 'crewseb',
      version: '0.3.0',
      summary: 'Multi-agent engineering crew orchestrator',
      command: ['node', 'crewseb.js'],
      provides: ['agent.orchestration'],
      consumes: ['memory.vault'],
      signals: ['task.completed']
    })

    // Before deploying memoseb, link should be unfulfilled
    const initialLinks = await topology.resolveServiceLinks()
    assert.deepEqual(initialLinks, [
      {
        consumer: 'crewseb',
        provider: '(none)',
        capability: 'memory.vault',
        status: 'unfulfilled'
      }
    ])

    // Deploy memoseb into the isolated runtime and host root
    const outcome = await deployMemoseb({
      runtime,
      roots,
      hosts: ['claude']
    })
    assert.equal(outcome.receipts.length, 1)
    assert.equal(outcome.receipts[0]?.hostId, 'claude')

    // Verify DriverHub deployed assets and directives integrity
    const driverHub = new DriverHub(runtime, roots)
    const claudeFile = path.join(claudeRoot, 'CLAUDE.md')
    assert.equal(fs.existsSync(claudeFile), true)
    assert.ok(driverHub.detectedHostIds().includes('claude'))

    // Verify TopologyStore service link is now connected
    const connectedLinks = await topology.resolveServiceLinks()
    assert.deepEqual(connectedLinks, [
      {
        consumer: 'crewseb',
        provider: 'memoseb',
        capability: 'memory.vault',
        status: 'connected'
      }
    ])
  })

  it('executes CLI export and import commands and emits signals', async () => {
    // 1. Store memories in primary vault
    await executeMemoCli(
      [
        'remember',
        'Architecture pattern: hexagonal architecture with dependency injection',
        '--project',
        'proj-export',
        '--category',
        'architecture',
        '--title',
        'Hexagonal Architecture',
        '--json'
      ],
      { runtime, dbPath }
    )
    await executeMemoCli(
      [
        'remember',
        'Convention: always use conventional commits',
        '--project',
        'proj-export',
        '--category',
        'convention',
        '--title',
        'Git Commits',
        '--json'
      ],
      { runtime, dbPath }
    )

    // 2. Export vault snapshot
    const exportPath = path.join(tmpDir, 'test-export.json')
    const expRes = await executeMemoCli(['export', exportPath, '--json'], { runtime, dbPath })
    assert.equal(expRes.exitCode, 0)
    const expPacket = decodeWire<{
      filePath: string
      checksum: string
      projectCount: number
      memoryCount: number
      tombstoneCount: number
    }>(expRes.stdout) as WireSuccess<{
      filePath: string
      checksum: string
      projectCount: number
      memoryCount: number
      tombstoneCount: number
    }>
    assert.equal(expPacket.action, 'export')
    assert.equal(fs.existsSync(exportPath), true)
    assert.ok(expPacket.payload.memoryCount >= 2)

    // Also test text output format for export
    const expTextPath = path.join(tmpDir, 'test-export-text.json')
    const expTextRes = await executeMemoCli(['export', expTextPath], { runtime, dbPath })
    assert.equal(expTextRes.exitCode, 0)
    assert.ok(expTextRes.stdout.includes('Exported memoseb snapshot'))

    // 3. Import snapshot into a second vault
    const dbPath2 = path.join(tmpDir, 'vault2.sqlite')
    const impRes = await executeMemoCli(['import', exportPath, '--db', dbPath2, '--json'], { runtime })
    assert.equal(impRes.exitCode, 0)
    const impPacket = decodeWire<{
      strategy: string
      projectsImported: number
      memoriesCreated: number
    }>(impRes.stdout) as WireSuccess<{
      strategy: string
      projectsImported: number
      memoriesCreated: number
    }>
    assert.equal(impPacket.action, 'import')
    assert.equal(impPacket.payload.strategy, 'merge')
    assert.equal(impPacket.payload.memoriesCreated, expPacket.payload.memoryCount)

    // Test text output format for import
    const impTextRes = await executeMemoCli(['import', exportPath, '--db', dbPath2], { runtime })
    assert.equal(impTextRes.exitCode, 0)
    assert.ok(impTextRes.stdout.includes('Imported snapshot'))

    // 4. Test export with --project
    const projExportPath = path.join(tmpDir, 'proj-export.json')
    const projExpRes = await executeMemoCli(
      ['export', projExportPath, '--project', 'proj-export', '--json'],
      { runtime, dbPath }
    )
    assert.equal(projExpRes.exitCode, 0)
    const projExpPacket = decodeWire<{
      filePath: string
      checksum: string
      projectCount: number
      memoryCount: number
    }>(projExpRes.stdout) as WireSuccess<{
      filePath: string
      checksum: string
      projectCount: number
      memoryCount: number
    }>
    assert.equal(projExpPacket.payload.projectCount, 1)

    // Seed vault2 with another project
    await executeMemoCli(
      [
        'remember',
        'Project beta persistent memory',
        '--project',
        'proj-beta',
        '--title',
        'Beta Memory',
        '--json'
      ],
      { runtime, dbPath: dbPath2 }
    )

    // 5. Test import with --replace and --project
    const impProjReplaceRes = await executeMemoCli(
      ['import', projExportPath, '--db', dbPath2, '--project', 'proj-export', '--replace', '--json'],
      { runtime }
    )
    assert.equal(impProjReplaceRes.exitCode, 0)
    const impProjReplacePacket = decodeWire<{ strategy: string }>(impProjReplaceRes.stdout) as WireSuccess<{ strategy: string }>
    assert.equal(impProjReplacePacket.payload.strategy, 'replace')

    // Confirm proj-beta is still intact in vault2
    const betaRecall = await executeMemoCli(
      ['recall', 'Beta Memory', '--project', 'proj-beta', '--db', dbPath2, '--json'],
      { runtime }
    )
    const betaPacket = decodeWire<RecallResult>(betaRecall.stdout) as WireSuccess<RecallResult>
    assert.equal(betaPacket.payload.memories.length, 1)

    // 6. Test global replace with --replace
    const impGlobalReplaceRes = await executeMemoCli(
      ['import', exportPath, '--db', dbPath2, '--replace', '--json'],
      { runtime }
    )
    assert.equal(impGlobalReplaceRes.exitCode, 0)
    const impGlobalReplacePacket = decodeWire<{ strategy: string }>(impGlobalReplaceRes.stdout) as WireSuccess<{ strategy: string }>
    assert.equal(impGlobalReplacePacket.payload.strategy, 'replace')

    // Confirm proj-beta is now wiped from vault2
    const betaRecallAfter = await executeMemoCli(
      ['recall', 'Beta Memory', '--project', 'proj-beta', '--db', dbPath2, '--json'],
      { runtime }
    )
    const betaPacketAfter = decodeWire<RecallResult>(betaRecallAfter.stdout) as WireSuccess<RecallResult>
    assert.equal(betaPacketAfter.payload.memories.length, 0)

    // 7. Test missing file error
    const missingRes = await executeMemoCli(['import', '--json'], { runtime })
    assert.equal(missingRes.exitCode, 2)
  })

  it('manages node lifecycle with CLI node commands (status, enable, disable, set-parent, add-child, remove)', async () => {
    // 1. Initial node status (disabled / standalone)
    const statusRes = await executeMemoCli(['node', 'status', '--json'], { runtime, dbPath })
    assert.equal(statusRes.exitCode, 0)
    const statusPacket = decodeWire<{
      config: { enabled: boolean; role: string }
      peers: unknown[]
      lanUrls: string[]
    }>(statusRes.stdout) as WireSuccess<{
      config: { enabled: boolean; role: string }
      peers: unknown[]
      lanUrls: string[]
    }>
    assert.equal(statusPacket.payload.config.enabled, false)
    assert.equal(statusPacket.payload.config.role, 'standalone')

    // Test text status output
    const statusTextRes = await executeMemoCli(['node'], { runtime, dbPath })
    assert.equal(statusTextRes.exitCode, 0)
    assert.ok(statusTextRes.stdout.includes('Status:      DISABLED (standalone)'))

    // 2. Enable node mode as parent
    const enableRes = await executeMemoCli(
      ['node', 'enable', '--role', 'parent', '--name', 'test-parent-cli', '--port', '8765', '--json'],
      { runtime, dbPath }
    )
    assert.equal(enableRes.exitCode, 0)
    const enablePacket = decodeWire<{
      config: { enabled: boolean; role: string; nodeName: string; listenPort: number }
    }>(enableRes.stdout) as WireSuccess<{
      config: { enabled: boolean; role: string; nodeName: string; listenPort: number }
    }>
    assert.equal(enablePacket.payload.config.enabled, true)
    assert.equal(enablePacket.payload.config.role, 'parent')
    assert.equal(enablePacket.payload.config.nodeName, 'test-parent-cli')
    assert.equal(enablePacket.payload.config.listenPort, 8765)

    // 3. Add child peer
    const addChildRes = await executeMemoCli(
      ['node', 'add-child', 'http://127.0.0.1:8766', '--name', 'worker-1', '--json'],
      { runtime, dbPath }
    )
    assert.equal(addChildRes.exitCode, 0)
    const addChildPacket = decodeWire<{
      peer: { url: string; role: string; name: string }
    }>(addChildRes.stdout) as WireSuccess<{
      peer: { url: string; role: string; name: string }
    }>
    assert.equal(addChildPacket.payload.peer.url, 'http://127.0.0.1:8766')
    assert.equal(addChildPacket.payload.peer.role, 'child')
    assert.equal(addChildPacket.payload.peer.name, 'worker-1')

    // 4. Set parent peer (switches role to child)
    const setParentRes = await executeMemoCli(
      ['node', 'set-parent', 'http://127.0.0.1:9000', '--name', 'main-cloud', '--json'],
      { runtime, dbPath }
    )
    assert.equal(setParentRes.exitCode, 0)
    const setParentPacket = decodeWire<{
      peer: { url: string; role: string }
      config: { role: string }
    }>(setParentRes.stdout) as WireSuccess<{
      peer: { url: string; role: string }
      config: { role: string }
    }>
    assert.equal(setParentPacket.payload.peer.url, 'http://127.0.0.1:9000')
    assert.equal(setParentPacket.payload.peer.role, 'parent')
    assert.equal(setParentPacket.payload.config.role, 'child')

    // 5. Remove peer
    const removeRes = await executeMemoCli(
      ['node', 'remove', 'http://127.0.0.1:8766', '--json'],
      { runtime, dbPath }
    )
    assert.equal(removeRes.exitCode, 0)
    const removePacket = decodeWire<{ target: string; removed: boolean }>(
      removeRes.stdout
    ) as WireSuccess<{ target: string; removed: boolean }>
    assert.equal(removePacket.payload.removed, true)

    // 6. Disable node mode
    const disableRes = await executeMemoCli(['node', 'disable', '--purge-peers', '--json'], {
      runtime,
      dbPath
    })
    assert.equal(disableRes.exitCode, 0)
    const disablePacket = decodeWire<{
      config: { enabled: boolean }
      peers: unknown[]
    }>(disableRes.stdout) as WireSuccess<{
      config: { enabled: boolean }
      peers: unknown[]
    }>
    assert.equal(disablePacket.payload.config.enabled, false)
    assert.equal(disablePacket.payload.peers.length, 0)
  })

  it('activates child node via UDP discovery with active parent node using memoseb node enable --role child --discover', async () => {
    // 1. Initial state standalone (enabled: false)
    const childDb = path.join(tmpDir, 'child-disc-vault.sqlite')
    const initStatus = await executeMemoCli(['node', 'status', '--json'], { runtime, dbPath: childDb })
    assert.equal(initStatus.exitCode, 0)
    const initPacket = decodeWire<{ config: { enabled: boolean; role: string } }>(initStatus.stdout) as WireSuccess<{ config: { enabled: boolean; role: string } }>
    assert.equal(initPacket.payload.config.enabled, false)
    assert.equal(initPacket.payload.config.role, 'standalone')

    // 2. Start an active parent node with UDP discovery
    const parentDb = path.join(tmpDir, 'parent-disc-vault.sqlite')
    const parentVault = new MemoryVault({ dbPath: parentDb, runtime })
    parentVault.enableNodeMode({ role: 'parent', listenPort: 0, lanDiscovery: true })
    const parentServer = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: true,
      udpPort: 0
    })
    const parentUdpPort = parentServer.udpPort!

    try {
      // 3. Child enables node mode as child with --discover pointing to parent UDP port
      const enableDiscRes = await executeMemoCli(
        ['node', 'enable', '--role', 'child', '--discover', '--port', String(parentUdpPort), '--json'],
        { runtime, dbPath: childDb }
      )
      assert.equal(enableDiscRes.exitCode, 0)
      const enableDiscPacket = decodeWire<{
        config: { enabled: boolean; role: string }
        peers: Array<{ role: string; peerNodeId: string }>
      }>(enableDiscRes.stdout) as WireSuccess<{
        config: { enabled: boolean; role: string }
        peers: Array<{ role: string; peerNodeId: string }>
      }>
      assert.equal(enableDiscPacket.payload.config.enabled, true)
      assert.equal(enableDiscPacket.payload.config.role, 'child')
      assert.ok(enableDiscPacket.payload.peers.length >= 1)
      assert.equal(enableDiscPacket.payload.peers[0]?.role, 'parent')
      assert.equal(enableDiscPacket.payload.peers[0]?.peerNodeId, parentVault.getNodeId())

      // 4. Disable child node
      const disableRes = await executeMemoCli(['node', 'disable', '--purge-peers', '--json'], {
        runtime,
        dbPath: childDb
      })
      assert.equal(disableRes.exitCode, 0)
      const disablePacket = decodeWire<{
        config: { enabled: boolean }
        peers: unknown[]
      }>(disableRes.stdout) as WireSuccess<{
        config: { enabled: boolean }
        peers: unknown[]
      }>
      assert.equal(disablePacket.payload.config.enabled, false)
      assert.equal(disablePacket.payload.peers.length, 0)
    } finally {
      await parentServer.close()
      parentVault.close()
    }
  })

  it('executes CLI sync command against peer and all-peers', async () => {
    // 1. Sync fails when node is disabled and no --url is given
    const syncFailRes = await executeMemoCli(['sync', '--json'], { runtime, dbPath })
    assert.equal(syncFailRes.exitCode, 1)

    // 2. Start an isolated parent node sync server
    const parentDb = path.join(tmpDir, 'parent-vault.sqlite')
    const parentVault = new MemoryVault({ dbPath: parentDb, runtime })
    parentVault.enableNodeMode({ role: 'parent', listenPort: 0 })
    parentVault.storeMemory({
      content: 'Parent node memory to synchronize downstream.',
      category: 'decision',
      title: 'Sync Decision',
      projectId: 'sync-proj'
    })

    const serverHandle = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })
    const parentUrl = `http://127.0.0.1:${serverHandle.port}`

    try {
      // 3. Child vault synchronizes via --url
      const childDb = path.join(tmpDir, 'child-vault.sqlite')
      const syncRes = await executeMemoCli(
        ['sync', '--url', parentUrl, '--project', 'sync-proj', '--json'],
        { runtime, dbPath: childDb }
      )
      assert.equal(syncRes.exitCode, 0)
      const syncPacket = decodeWire<{
        peerUrl: string
        pulled: { memoriesCreated: number }
      }>(syncRes.stdout) as WireSuccess<{
        peerUrl: string
        pulled: { memoriesCreated: number }
      }>
      assert.equal(syncPacket.action, 'sync')
      assert.equal(syncPacket.payload.pulled.memoriesCreated, 1)

      // Verify memory was pulled into child vault
      const childVault = new MemoryVault({ dbPath: childDb, runtime })
      try {
        const briefing = childVault.getProjectBriefing({ projectId: 'sync-proj' })
        assert.equal(briefing.memories.length, 1)
        assert.equal(briefing.memories[0]?.title, 'Sync Decision')
      } finally {
        childVault.close()
      }
    } finally {
      await serverHandle.close()
      parentVault.close()
    }
  })

  it('executes bidirectional CLI sync across a parent and two children with forget/tombstone propagation', async () => {
    const parentDb = path.join(tmpDir, 'mesh-parent.sqlite')
    const child1Db = path.join(tmpDir, 'mesh-child1.sqlite')
    const child2Db = path.join(tmpDir, 'mesh-child2.sqlite')

    // 1. Enable parent node via CLI
    const parentEnable = await executeMemoCli(
      ['node', 'enable', '--role', 'parent', '--port', '0', '--json'],
      { runtime, dbPath: parentDb }
    )
    assert.equal(parentEnable.exitCode, 0)

    // Start parent sync server
    const parentVault = new MemoryVault({ dbPath: parentDb, runtime })
    const parentServer = await startSyncServer(parentVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })
    const parentUrl = `http://127.0.0.1:${parentServer.port}`

    try {
      // 2. Connect Child 1 and Child 2 to Parent via CLI
      await executeMemoCli(
        ['node', 'enable', '--role', 'child', '--parent', parentUrl, '--json'],
        { runtime, dbPath: child1Db }
      )
      await executeMemoCli(
        ['node', 'enable', '--role', 'child', '--parent', parentUrl, '--json'],
        { runtime, dbPath: child2Db }
      )

      // 3. Store initial memories
      await executeMemoCli(
        [
          'remember',
          'Parent mesh configuration knowledge',
          '--project',
          'mesh-proj',
          '--title',
          'Parent Knowledge',
          '--json'
        ],
        { runtime, dbPath: parentDb }
      )

      const rem1 = await executeMemoCli(
        [
          'remember',
          'Child 1 edge node findings',
          '--project',
          'mesh-proj',
          '--title',
          'Child 1 Findings',
          '--json'
        ],
        { runtime, dbPath: child1Db }
      )
      const rem1Packet = decodeWire<StoreMemoryResult>(rem1.stdout) as WireSuccess<StoreMemoryResult>
      const mem1Id = rem1Packet.payload.memory.id

      // 4. Child 1 synchronizes with Parent via CLI (syncs Child 1 <-> Parent)
      const sync1Res = await executeMemoCli(['sync', '--json'], { runtime, dbPath: child1Db })
      assert.equal(sync1Res.exitCode, 0)

      // Allow clock tick so Child 2's timestamp is strictly after Child 1's initial sync
      await new Promise((resolve) => setTimeout(resolve, 20))

      // 5. Child 2 records metrics knowledge chronologically after Child 1's initial sync
      await executeMemoCli(
        [
          'remember',
          'Child 2 telemetry and metrics',
          '--project',
          'mesh-proj',
          '--title',
          'Child 2 Metrics',
          '--json'
        ],
        { runtime, dbPath: child2Db }
      )

      // 6. Child 2 synchronizes with Parent via CLI (pushes Child 2, pulls Child 1 and Parent memories)
      const sync2Res = await executeMemoCli(['sync', '--json'], { runtime, dbPath: child2Db })
      assert.equal(sync2Res.exitCode, 0)

      // 7. Child 1 synchronizes again to pull Child 2's memory from Parent
      const sync1Res2 = await executeMemoCli(['sync', '--json'], { runtime, dbPath: child1Db })
      assert.equal(sync1Res2.exitCode, 0)

      // Verify Child 1 has all memories via CLI recall
      const c1Recall = await executeMemoCli(
        ['recall', 'Child 2 Metrics', '--project', 'mesh-proj', '--json'],
        { runtime, dbPath: child1Db }
      )
      const c1RecallPacket = decodeWire<RecallResult>(c1Recall.stdout) as WireSuccess<RecallResult>
      assert.ok(c1RecallPacket.payload.memories.some((m) => m.title === 'Child 2 Metrics'))

      // Verify Child 2 has all memories via CLI recall
      const c2Recall = await executeMemoCli(
        ['recall', 'Child 1 Findings', '--project', 'mesh-proj', '--json'],
        { runtime, dbPath: child2Db }
      )
      const c2RecallPacket = decodeWire<RecallResult>(c2Recall.stdout) as WireSuccess<RecallResult>
      assert.ok(c2RecallPacket.payload.memories.some((m) => m.title === 'Child 1 Findings'))

      // 8. Test tombstone propagation: Child 1 forgets its memory
      await new Promise((resolve) => setTimeout(resolve, 20))
      const forgetRes = await executeMemoCli(['forget', mem1Id, '--json'], { runtime, dbPath: child1Db })
      assert.equal(forgetRes.exitCode, 0)

      // Child 1 syncs to push tombstone to Parent
      const sync1Forget = await executeMemoCli(['sync', '--json'], { runtime, dbPath: child1Db })
      assert.equal(sync1Forget.exitCode, 0)

      // Child 2 syncs to pull tombstone from Parent
      const sync2Forget = await executeMemoCli(['sync', '--json'], { runtime, dbPath: child2Db })
      assert.equal(sync2Forget.exitCode, 0)

      // Verify Child 2 has forgotten Child 1's memory
      const c2RecallAfter = await executeMemoCli(
        ['recall', 'Child 1 Findings', '--project', 'mesh-proj', '--json'],
        { runtime, dbPath: child2Db }
      )
      const c2RecallAfterPacket = decodeWire<RecallResult>(c2RecallAfter.stdout) as WireSuccess<RecallResult>
      assert.ok(!c2RecallAfterPacket.payload.memories.some((m) => m.title === 'Child 1 Findings'))

      // Verify Parent also has forgotten Child 1's memory
      const parentMemories = parentVault.recallMemories('Child 1 Findings', { projectId: 'mesh-proj' }).memories
      assert.ok(!parentMemories.some((m) => m.title === 'Child 1 Findings'))
    } finally {
      await parentServer.close()
      parentVault.close()
    }
  })

  it('handles MCP memory_export, memory_import, and memory_sync with auto-sync triggers', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      vault.storeMemory({
        content: 'MCP export test memory content.',
        category: 'domain',
        title: 'MCP Export',
        projectId: 'mcp-export-proj'
      })

      // 1. memory_export (in-memory without filePath)
      const expRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'memory_export',
          arguments: {
            projectId: 'mcp-export-proj'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const expPayload = JSON.parse(expRes.result.content[0]!.text) as {
        checksum: string
        memoryCount: number
        snapshot: { format: string }
      }
      assert.ok(expPayload.checksum)
      assert.equal(expPayload.memoryCount, 1)
      assert.equal(expPayload.snapshot.format, 'memoseb-snapshot')

      // 2. memory_export (written to filePath)
      const mcpExportFile = path.join(tmpDir, 'mcp-snapshot.json')
      const expFileRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'memory_export',
          arguments: {
            filePath: mcpExportFile,
            projectId: 'mcp-export-proj'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const expFilePayload = JSON.parse(expFileRes.result.content[0]!.text) as {
        filePath: string
        checksum: string
        memoryCount: number
      }
      assert.equal(fs.existsSync(mcpExportFile), true)
      assert.equal(expFilePayload.memoryCount, 1)

      // 3. memory_import into another vault
      const targetVaultDb = path.join(tmpDir, 'mcp-target-vault.sqlite')
      const targetVault = new MemoryVault({ dbPath: targetVaultDb, runtime })
      try {
        const impRes = (await handleMcpRequest(targetVault, {
          jsonrpc: '2.0',
          id: 103,
          method: 'tools/call',
          params: {
            name: 'memory_import',
            arguments: {
              filePath: mcpExportFile,
              strategy: 'merge'
            }
          }
        })) as { result: { content: Array<{ type: string; text: string }> } }
        const impPayload = JSON.parse(impRes.result.content[0]!.text) as {
          strategy: string
          memoriesCreated: number
        }
        assert.equal(impPayload.strategy, 'merge')
        assert.equal(impPayload.memoriesCreated, 1)
      } finally {
        targetVault.close()
      }

      // 4. memory_sync with disabled node returns error
      const syncDisabledRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 104,
        method: 'tools/call',
        params: {
          name: 'memory_sync',
          arguments: {}
        }
      })) as { result: { isError: boolean } }
      assert.equal(syncDisabledRes.result.isError, true)
    } finally {
      vault.close()
    }
  })

  it('manages groups via CLI group commands and --group flags in node lifecycle', async () => {
    // 1. memoseb group list empty
    const listRes = await executeMemoCli(['group', 'list', '--json'], { runtime, dbPath })
    assert.equal(listRes.exitCode, 0)
    const listPacket = decodeWire<{ groups: any[]; unassignedGroupPolicy: string }>(listRes.stdout) as WireSuccess<{ groups: any[]; unassignedGroupPolicy: string }>
    assert.equal(listPacket.status, 'success')
    assert.equal(listPacket.payload.groups.length, 0)
    assert.equal(listPacket.payload.unassignedGroupPolicy, 'none')

    // 2. memoseb group create frontend-team
    const createRes = await executeMemoCli(
      [
        'group',
        'create',
        'frontend-team',
        '--projects',
        'p1,p2',
        '--categories',
        'architecture,convention',
        '--permissions',
        'readwrite',
        '--token',
        'secret-group-token',
        '--description',
        'Frontend developers group',
        '--json'
      ],
      { runtime, dbPath }
    )
    assert.equal(createRes.exitCode, 0)
    const createPacket = decodeWire<{ group: any }>(createRes.stdout) as WireSuccess<{ group: any }>
    assert.equal(createPacket.status, 'success')
    assert.equal(createPacket.payload.group.name, 'frontend-team')
    assert.deepEqual(createPacket.payload.group.projects, ['p1', 'p2'])
    assert.deepEqual(createPacket.payload.group.categories, ['architecture', 'convention'])
    assert.equal(createPacket.payload.group.permissions, 'readwrite')
    assert.equal(createPacket.payload.group.groupToken, 'secret-group-token')

    // 3. invalid validations
    const noNameRes = await executeMemoCli(['group', 'create', '--json'], { runtime, dbPath })
    assert.equal(noNameRes.exitCode, 2)
    const noNamePacket = decodeWire(noNameRes.stdout)
    assert.equal(noNamePacket.status, 'error')

    const badCatRes = await executeMemoCli(
      ['group', 'create', 'test-group', '--categories', 'unknown-cat', '--json'],
      { runtime, dbPath }
    )
    assert.equal(badCatRes.exitCode, 2)
    const badCatPacket = decodeWire(badCatRes.stdout)
    assert.equal(badCatPacket.status, 'error')

    const badPermRes = await executeMemoCli(
      ['group', 'create', 'test-group', '--permissions', 'invalid-perm', '--json'],
      { runtime, dbPath }
    )
    assert.equal(badPermRes.exitCode, 2)
    const badPermPacket = decodeWire(badPermRes.stdout)
    assert.equal(badPermPacket.status, 'error')

    // 4. add-node
    const addNodeRes = await executeMemoCli(
      ['group', 'add-node', 'frontend-team', 'http://127.0.0.1:4001', '--json'],
      { runtime, dbPath }
    )
    assert.equal(addNodeRes.exitCode, 0)
    const addNodePacket = decodeWire<{ group: any; addedNode: string }>(addNodeRes.stdout) as WireSuccess<{ group: any; addedNode: string }>
    assert.equal(addNodePacket.status, 'success')
    assert.equal(addNodePacket.payload.addedNode, 'http://127.0.0.1:4001')
    assert.ok(addNodePacket.payload.group.memberNodeIds.includes('http://127.0.0.1:4001'))

    // 5. remove-node
    const rmNodeRes = await executeMemoCli(
      ['group', 'remove-node', 'frontend-team', 'http://127.0.0.1:4001', '--json'],
      { runtime, dbPath }
    )
    assert.equal(rmNodeRes.exitCode, 0)
    const rmNodePacket = decodeWire<{ group: any; removedNode: string }>(rmNodeRes.stdout) as WireSuccess<{ group: any; removedNode: string }>
    assert.equal(rmNodePacket.status, 'success')
    assert.equal(rmNodePacket.payload.removedNode, 'http://127.0.0.1:4001')
    assert.ok(!rmNodePacket.payload.group.memberNodeIds.includes('http://127.0.0.1:4001'))

    // 6. default-policy
    const polRes = await executeMemoCli(['group', 'default-policy', 'all', '--json'], { runtime, dbPath })
    assert.equal(polRes.exitCode, 0)
    const polPacket = decodeWire<{ unassignedGroupPolicy: string }>(polRes.stdout) as WireSuccess<{ unassignedGroupPolicy: string }>
    assert.equal(polPacket.payload.unassignedGroupPolicy, 'all')

    const badPolRes = await executeMemoCli(['group', 'default-policy', 'invalid', '--json'], { runtime, dbPath })
    assert.equal(badPolRes.exitCode, 2)

    // 7. text output checks
    const textCreateRes = await executeMemoCli(
      ['group', 'create', 'backend-team', '--permissions', 'readonly'],
      { runtime, dbPath }
    )
    assert.equal(textCreateRes.exitCode, 0)
    assert.match(textCreateRes.stdout, /backend-team/)

    const textListRes = await executeMemoCli(['group', 'list'], { runtime, dbPath })
    assert.equal(textListRes.exitCode, 0)
    assert.match(textListRes.stdout, /frontend-team/)
    assert.match(textListRes.stdout, /backend-team/)

    // 8. node status includes groups
    const nodeStatusRes = await executeMemoCli(['node', 'status', '--json'], { runtime, dbPath })
    assert.equal(nodeStatusRes.exitCode, 0)
    const nodeStatusPacket = decodeWire<{ groups: any[] }>(nodeStatusRes.stdout) as WireSuccess<{ groups: any[] }>
    assert.ok(Array.isArray(nodeStatusPacket.payload.groups))
    assert.equal(nodeStatusPacket.payload.groups.length, 2)

    // 9. node add-child with --group
    const addChildRes = await executeMemoCli(
      ['node', 'add-child', 'http://127.0.0.1:9099', '--group', 'auto-created-group', '--json'],
      { runtime, dbPath }
    )
    assert.equal(addChildRes.exitCode, 0)
    const checkGroupRes = await executeMemoCli(['group', 'list', '--json'], { runtime, dbPath })
    const checkGroupPacket = decodeWire<{ groups: any[] }>(checkGroupRes.stdout) as WireSuccess<{ groups: any[] }>
    const autoGroup = checkGroupPacket.payload.groups.find((g: any) => g.name === 'auto-created-group')
    assert.ok(autoGroup)
    assert.ok(autoGroup.memberNodeIds.includes('http://127.0.0.1:9099'))

    // 10. delete group
    const delRes = await executeMemoCli(['group', 'delete', 'frontend-team', '--json'], { runtime, dbPath })
    assert.equal(delRes.exitCode, 0)
    const delNotFound = await executeMemoCli(['group', 'delete', 'frontend-team', '--json'], { runtime, dbPath })
    assert.equal(delNotFound.exitCode, 1)
  })

  it('handles MCP memory_group actions (list, create, add_node, remove_node, delete, default_policy)', async () => {
    const vault = new MemoryVault({ dbPath, runtime })
    try {
      // 1. list
      const listRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: { action: 'list' }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const listPayload = JSON.parse(listRes.result.content[0]!.text) as {
        groups: any[]
        unassignedGroupPolicy: string
      }
      assert.ok(Array.isArray(listPayload.groups))

      // 2. create
      const createRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'create',
            name: 'mcp-team',
            projects: ['proj-a', 'proj-b'],
            categories: ['architecture', 'domain'],
            permissions: 'readonly',
            description: 'MCP created group'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const createPayload = JSON.parse(createRes.result.content[0]!.text) as {
        group: any
      }
      assert.equal(createPayload.group.name, 'mcp-team')
      assert.equal(createPayload.group.permissions, 'readonly')
      assert.deepEqual(createPayload.group.projects, ['proj-a', 'proj-b'])

      // 3. invalid create
      const badCatRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 203,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'create',
            name: 'bad-group',
            categories: ['not-a-category']
          }
        }
      })) as { result: { isError: boolean } }
      assert.equal(badCatRes.result.isError, true)

      // 4. add_node
      const addNodeRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 204,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'add_node',
            name: 'mcp-team',
            node: 'node-alpha'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const addNodePayload = JSON.parse(addNodeRes.result.content[0]!.text) as {
        group: any
        addedNode: string
      }
      assert.equal(addNodePayload.addedNode, 'node-alpha')
      assert.ok(addNodePayload.group.memberNodeIds.includes('node-alpha'))

      // 5. remove_node
      const rmNodeRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 205,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'remove_node',
            name: 'mcp-team',
            node: 'node-alpha'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const rmNodePayload = JSON.parse(rmNodeRes.result.content[0]!.text) as {
        group: any
        removedNode: string
      }
      assert.equal(rmNodePayload.removedNode, 'node-alpha')
      assert.ok(!rmNodePayload.group.memberNodeIds.includes('node-alpha'))

      // 6. default_policy
      const polRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 206,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'default_policy',
            policy: 'all'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const polPayload = JSON.parse(polRes.result.content[0]!.text) as {
        unassignedGroupPolicy: string
      }
      assert.equal(polPayload.unassignedGroupPolicy, 'all')

      // 7. delete
      const delRes = (await handleMcpRequest(vault, {
        jsonrpc: '2.0',
        id: 207,
        method: 'tools/call',
        params: {
          name: 'memory_group',
          arguments: {
            action: 'delete',
            name: 'mcp-team'
          }
        }
      })) as { result: { content: Array<{ type: string; text: string }> } }
      const delPayload = JSON.parse(delRes.result.content[0]!.text) as {
        name: string
        deleted: boolean
      }
      assert.equal(delPayload.deleted, true)
    } finally {
      vault.close()
    }
  })

  it('manages P2P/Gaze wire contract workflows via CLI and MCP (enable --role p2p, add-peer, export/import gaze, sync --format gaze)', async () => {
    // 1. CLI memoseb node enable --role p2p (JSON and text)
    const enableRes = await executeMemoCli(['node', 'enable', '--role', 'p2p', '--json'], {
      runtime,
      dbPath
    })
    assert.equal(enableRes.exitCode, 0)
    const enablePacket = decodeWire<{
      config: { enabled: boolean; role: string }
    }>(enableRes.stdout) as WireSuccess<{
      config: { enabled: boolean; role: string }
    }>
    assert.equal(enablePacket.payload.config.enabled, true)
    assert.equal(enablePacket.payload.config.role, 'peer')

    const enableTextRes = await executeMemoCli(['node', 'enable', '--role', 'p2p'], {
      runtime,
      dbPath
    })
    assert.equal(enableTextRes.exitCode, 0)
    assert.ok(enableTextRes.stdout.includes('Node mode ENABLED as role=peer'))

    // 2. CLI memoseb node add-peer <url> (JSON and text)
    const addPeerRes = await executeMemoCli(
      ['node', 'add-peer', 'http://127.0.0.1:9444', '--name', 'peer-node-cli', '--json'],
      { runtime, dbPath }
    )
    assert.equal(addPeerRes.exitCode, 0)
    const addPeerPacket = decodeWire<{
      peer: { url: string; role: string; name: string }
    }>(addPeerRes.stdout) as WireSuccess<{
      peer: { url: string; role: string; name: string }
    }>
    assert.equal(addPeerPacket.payload.peer.url, 'http://127.0.0.1:9444')
    assert.equal(addPeerPacket.payload.peer.name, 'peer-node-cli')
    // Mapped role from SQLite sync_peers row
    assert.ok(
      addPeerPacket.payload.peer.role === 'peer' || addPeerPacket.payload.peer.role === 'child'
    )

    const addPeerTextRes = await executeMemoCli(
      ['node', 'add-peer', 'http://127.0.0.1:9445'],
      { runtime, dbPath }
    )
    assert.equal(addPeerTextRes.exitCode, 0)
    assert.ok(addPeerTextRes.stdout.includes('Added peer http://127.0.0.1:9445'))

    // Seed primary vault with memories to export
    await executeMemoCli(
      [
        'remember',
        'Architecture specification for Gaze interoperability protocol.',
        '--project',
        'proj-gaze-cli',
        '--category',
        'architecture',
        '--title',
        'Gaze Interop Spec',
        '--json'
      ],
      { runtime, dbPath }
    )

    // 3. CLI memoseb export <file> --format gaze (JSON and text)
    const gazeFile = path.join(tmpDir, 'exported-gaze.json')
    const expGazeRes = await executeMemoCli(
      ['export', gazeFile, '--format', 'gaze', '--project', 'proj-gaze-cli', '--json'],
      { runtime, dbPath }
    )
    assert.equal(expGazeRes.exitCode, 0)
    const expGazePacket = decodeWire<{
      filePath: string
      checksum: string
      memoryCount: number
      format: string
    }>(expGazeRes.stdout) as WireSuccess<{
      filePath: string
      checksum: string
      memoryCount: number
      format: string
    }>
    assert.equal(expGazePacket.payload.format, 'p2p')
    assert.ok(expGazePacket.payload.checksum)
    assert.equal(expGazePacket.payload.memoryCount, 1)

    // Verify written file structure matches Gaze P2P contract
    assert.ok(fs.existsSync(gazeFile))
    const rawGaze = JSON.parse(fs.readFileSync(gazeFile, 'utf-8'))
    assert.equal(rawGaze.format, 'p2p-memory-contract')
    assert.equal(rawGaze.version, 1)
    assert.ok(Array.isArray(rawGaze.nodes))
    assert.equal(rawGaze.nodes.length, 1)
    assert.equal(rawGaze.nodes[0]?.title, 'Gaze Interop Spec')

    // Test text output format for export with --format gaze
    const gazeTextFile = path.join(tmpDir, 'exported-gaze-text.json')
    const expGazeTextRes = await executeMemoCli(
      ['export', gazeTextFile, '--format', 'gaze', '--project', 'proj-gaze-cli'],
      { runtime, dbPath }
    )
    assert.equal(expGazeTextRes.exitCode, 0)
    assert.ok(expGazeTextRes.stdout.includes('Exported p2p gaze bundle'))
    assert.ok(expGazeTextRes.stdout.includes('p2p-memory-contract'))

    // 4. CLI memoseb import <file> of a Gaze P2P package into another vault
    const dbPath2 = path.join(tmpDir, 'vault-imported-gaze.sqlite')
    const impGazeRes = await executeMemoCli(
      ['import', gazeFile, '--db', dbPath2, '--json'],
      { runtime }
    )
    assert.equal(impGazeRes.exitCode, 0)
    const impGazePacket = decodeWire<{
      strategy: string
      memoriesCreated: number
    }>(impGazeRes.stdout) as WireSuccess<{
      strategy: string
      memoriesCreated: number
    }>
    assert.equal(impGazePacket.payload.strategy, 'merge')
    assert.equal(impGazePacket.payload.memoriesCreated, 1)

    // Recall from imported vault to confirm memory was restored
    const recallImported = await executeMemoCli(
      ['recall', 'Gaze Interop', '--project', 'proj-gaze-cli', '--db', dbPath2, '--json'],
      { runtime }
    )
    assert.equal(recallImported.exitCode, 0)
    const recallImportedPacket = decodeWire<RecallResult>(
      recallImported.stdout
    ) as WireSuccess<RecallResult>
    assert.equal(recallImportedPacket.payload.memories.length, 1)
    assert.equal(recallImportedPacket.payload.memories[0]?.title, 'Gaze Interop Spec')

    // 5. CLI memoseb sync --url <url> --format gaze
    const remoteServerDb = path.join(tmpDir, 'remote-server.sqlite')
    const remoteVault = new MemoryVault({ dbPath: remoteServerDb, runtime })
    remoteVault.enableNodeMode({ role: 'peer', listenPort: 0 })
    remoteVault.storeMemory({
      projectId: 'proj-sync-gaze',
      category: 'decision',
      title: 'Decided on Gaze P2P Wire Protocol',
      content: 'Consensus on canonical Gaze contract envelope.'
    })

    const remoteServer = await startSyncServer(remoteVault, {
      host: '127.0.0.1',
      port: 0,
      enableUdpDiscovery: false
    })
    const remoteUrl = `http://127.0.0.1:${remoteServer.port}`

    try {
      const clientDb = path.join(tmpDir, 'client-sync.sqlite')
      const syncGazeRes = await executeMemoCli(
        ['sync', '--url', remoteUrl, '--format', 'gaze', '--project', 'proj-sync-gaze', '--json'],
        { runtime, dbPath: clientDb }
      )
      assert.equal(syncGazeRes.exitCode, 0)
      const syncGazePacket = decodeWire<{
        pulled: { memoriesCreated: number }
      }>(syncGazeRes.stdout) as WireSuccess<{
        pulled: { memoriesCreated: number }
      }>
      assert.equal(syncGazePacket.payload.pulled.memoriesCreated, 1)

      // 6. MCP memory_export with format: 'gaze' (in-memory and to file)
      const mcpVault = new MemoryVault({ dbPath: remoteServerDb, runtime })
      try {
        // In-memory MCP memory_export with format: 'gaze'
        const mcpExportRes = (await handleMcpRequest(mcpVault, {
          jsonrpc: '2.0',
          id: 501,
          method: 'tools/call',
          params: {
            name: 'memory_export',
            arguments: {
              projectId: 'proj-sync-gaze',
              format: 'gaze'
            }
          }
        })) as { result: { content: Array<{ type: string; text: string }> } }

        const mcpExpPayload = JSON.parse(mcpExportRes.result.content[0]!.text) as {
          format: string
          checksum: string
          memoryCount: number
          payload: { format: string; nodes: any[] }
        }
        assert.equal(mcpExpPayload.format, 'p2p-memory-contract')
        assert.equal(mcpExpPayload.payload.format, 'p2p-memory-contract')
        assert.equal(mcpExpPayload.memoryCount, 1)

        // File-based MCP memory_export with format: 'gaze'
        const mcpGazeFile = path.join(tmpDir, 'mcp-gaze-bundle.json')
        const mcpFileExportRes = (await handleMcpRequest(mcpVault, {
          jsonrpc: '2.0',
          id: 502,
          method: 'tools/call',
          params: {
            name: 'memory_export',
            arguments: {
              filePath: mcpGazeFile,
              projectId: 'proj-sync-gaze',
              format: 'gaze'
            }
          }
        })) as { result: { content: Array<{ type: string; text: string }> } }

        assert.ok(fs.existsSync(mcpGazeFile))
        const mcpSavedGaze = JSON.parse(fs.readFileSync(mcpGazeFile, 'utf-8'))
        assert.equal(mcpSavedGaze.format, 'p2p-memory-contract')

        // 7. MCP memory_sync with format: 'gaze'
        const clientVault = new MemoryVault({ dbPath: clientDb, runtime })
        try {
          const mcpSyncRes = (await handleMcpRequest(clientVault, {
            jsonrpc: '2.0',
            id: 503,
            method: 'tools/call',
            params: {
              name: 'memory_sync',
              arguments: {
                peerUrl: remoteUrl,
                format: 'gaze'
              }
            }
          })) as { result: { content: Array<{ type: string; text: string }> } }

          const mcpSyncPayload = JSON.parse(mcpSyncRes.result.content[0]!.text) as {
            peerUrl: string
            pushed: any
            pulled: any
          }
          assert.equal(mcpSyncPayload.peerUrl, remoteUrl)
          assert.ok(mcpSyncPayload.pulled)
        } finally {
          clientVault.close()
        }
      } finally {
        mcpVault.close()
      }
    } finally {
      await remoteServer.close()
      remoteVault.close()
    }
  })
})
