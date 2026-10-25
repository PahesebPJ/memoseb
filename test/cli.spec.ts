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
import type {
  ProjectSummary,
  RecallResult,
  StoreMemoryResult,
  VaultStats
} from '../src/core/vault.ts'
import { MemoryVault } from '../src/core/vault.ts'
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
    assert.ok(helpPacket.payload.commands.includes('remember'))
    assert.ok(helpPacket.payload.commands.includes('recall'))
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
        'memory_forget'
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
})
