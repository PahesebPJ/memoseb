import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  type BundlePayload,
  type DeploymentReceipt,
  DriverHub,
  type HostId,
  type HostIntegrityReport,
  type HostRootOverrides,
  SystemRuntime,
  type ToolNodeRegistration,
  TopologyStore,
} from 'hubseb'
import { BUNDLE_ID as VERSION_BUNDLE_ID, PACKAGE_ROOT, VERSION } from './version.ts'

export const BUNDLE_ID = VERSION_BUNDLE_ID
export const PROVIDES = ['memory.vault']
export const CONSUMES: string[] = []
export const SIGNALS = ['memory.stored', 'memory.forgotten', 'memoseb.deployed']

export const RULES_FILE = path.join(PACKAGE_ROOT, 'rules', 'RULES.md')
export const ANTIGRAVITY_RULES_FILE = path.join(PACKAGE_ROOT, 'rules', 'antigravity.md')
export const SKILL_FILE = path.join(PACKAGE_ROOT, 'skills', 'memoseb', 'SKILL.md')

export function nodeRegistration(): ToolNodeRegistration {
  const distBin = path.join(PACKAGE_ROOT, 'dist', 'bin', 'memoseb.js')
  const srcBin = path.join(PACKAGE_ROOT, 'src', 'bin', 'memoseb.ts')
  const script = existsSync(distBin) ? distBin : srcBin
  return {
    id: BUNDLE_ID,
    version: VERSION,
    summary: 'Multi-project agentic vector and FTS5 hybrid memory vault on SQLite with MCP server',
    command: [path.resolve(process.execPath), path.resolve(script)],
    provides: PROVIDES,
    consumes: CONSUMES,
    signals: SIGNALS,
  }
}

export async function assembleBundlePayload(): Promise<BundlePayload> {
  const globalDirectives = await readFile(RULES_FILE, 'utf8')
  const alwaysOnRules = await readFile(ANTIGRAVITY_RULES_FILE, 'utf8')
  const markdownBody = await readFile(SKILL_FILE, 'utf8')

  return {
    bundleId: BUNDLE_ID,
    version: VERSION,
    summary: 'Multi-project agentic vector and FTS5 hybrid memory vault on SQLite',
    globalDirectives,
    alwaysOnRules,
    specialists: [],
    skills: [
      {
        id: BUNDLE_ID,
        summary:
          'Gestiona la bóveda de memoria híbrida (vectorial + FTS5) multi-proyecto con presupuesto de tokens mediante memoseb o MCP',
        markdownBody,
      },
    ],
  }
}

export interface MemoSetupOptions {
  runtime?: SystemRuntime
  roots?: HostRootOverrides
  hosts?: readonly HostId[]
}

export interface MemoSetupOutcome {
  topologyFile: string
  receipts: DeploymentReceipt[]
}

export async function deployMemoseb(options: MemoSetupOptions = {}): Promise<MemoSetupOutcome> {
  const runtime = options.runtime ?? new SystemRuntime()
  const topology = new TopologyStore(runtime)
  const { file: topologyFile } = await topology.attachNode(nodeRegistration())

  const driverHub = new DriverHub(runtime, options.roots)
  const payload = await assembleBundlePayload()
  const receipts = await driverHub.deployToHosts(payload, options.hosts)

  await topology.broadcastSignal(BUNDLE_ID, 'memoseb.deployed', {
    version: VERSION,
    hosts: receipts.map((r) => r.hostId),
  })

  return {
    topologyFile,
    receipts,
  }
}

export async function purgeMemoseb(options: MemoSetupOptions = {}): Promise<{
  detachedFromTopology: boolean
  purged: Array<{ hostId: HostId; removedPaths: string[]; directivesRemoved: boolean }>
}> {
  const runtime = options.runtime ?? new SystemRuntime()
  const driverHub = new DriverHub(runtime, options.roots)
  const purged = await driverHub.purgeFromHosts(BUNDLE_ID, options.hosts)

  const topology = new TopologyStore(runtime)
  const detachedFromTopology = await topology.detachNode(BUNDLE_ID)

  return {
    detachedFromTopology,
    purged,
  }
}

export async function auditMemosebDirectives(
  options: MemoSetupOptions = {},
): Promise<HostIntegrityReport[]> {
  const runtime = options.runtime ?? new SystemRuntime()
  const driverHub = new DriverHub(runtime, options.roots)
  const rawDirectives = await readFile(RULES_FILE, 'utf8')
  return driverHub.auditHosts(BUNDLE_ID, rawDirectives, options.hosts)
}
