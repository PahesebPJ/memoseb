import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SystemRuntime } from 'hubseb'

export interface TailnetPeer {
  hostName: string
  dnsName: string
  os: string
  ips: string[]
  online: boolean
}

export interface TailscaleStatus {
  backendState: string
  selfIps: string[]
  selfHostName: string
  peers: TailnetPeer[]
}

export type TailscaleProbeResult =
  | { state: 'running'; binary: string; status: TailscaleStatus }
  | { state: 'absent'; binary: null }
  | { state: 'not-running'; binary: string; backendState: string }
  | { state: 'error'; binary: string; error: string }

const MACOS_APP_BINARY = '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
const WINDOWS_DEFAULT_BINARY = 'C:\\Program Files\\Tailscale\\tailscale.exe'

/**
 * Rutas fijas donde suele vivir el CLI de Tailscale cuando no está en el PATH,
 * en el orden en que se prueban (mismo orden que el descubrimiento de gaze).
 */
export function tailscaleFallbackPaths(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = {}
): string[] {
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles || env.PROGRAMFILES
    const candidates = [WINDOWS_DEFAULT_BINARY]
    if (programFiles) {
      const fromEnv = path.win32.join(programFiles, 'Tailscale', 'tailscale.exe')
      if (!candidates.includes(fromEnv)) candidates.push(fromEnv)
    }
    return candidates
  }
  const candidates = ['/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
  if (platform === 'darwin') {
    candidates.push(MACOS_APP_BINARY)
  } else {
    candidates.push('/usr/bin/tailscale')
  }
  return candidates
}

function isExecutableFile(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return false
    if (platform === 'win32') return true
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Busca el binario de Tailscale: ruta configurada, PATH (tailscale o
 * tailscale.exe) y luego las rutas fijas de cada plataforma.
 */
export function locateTailscaleBinary(
  runtime: Pick<SystemRuntime, 'platform' | 'env'>,
  configured?: string | null,
  isExecutable: (filePath: string) => boolean = (p) =>
    isExecutableFile(p, runtime.platform)
): string | null {
  const explicit =
    configured?.trim() || runtime.env.MEMOSEB_TAILSCALE_BIN?.trim() || ''
  if (explicit.length > 0) {
    return isExecutable(explicit) ? explicit : null
  }

  // Las entradas relativas de PATH (".", "bin") resolverían contra el cwd: se ignoran
  const isAbsolute = runtime.platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute
  const pathDirs = (runtime.env.PATH ?? runtime.env.Path ?? '')
    .split(runtime.platform === 'win32' ? ';' : ':')
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0 && isAbsolute(d) && !(runtime.platform === 'win32' && /^[\\/](?![\\/])/.test(d)))
  const names = runtime.platform === 'win32' ? ['tailscale.exe'] : ['tailscale']
  const join = runtime.platform === 'win32' ? path.win32.join : path.posix.join
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) return candidate
    }
  }

  for (const candidate of tailscaleFallbackPaths(runtime.platform, runtime.env)) {
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : []
}

/**
 * Parsea la salida de `tailscale status --json`.
 */
export function parseTailscaleStatus(raw: unknown): TailscaleStatus {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid tailscale status: expected a JSON object.')
  }
  const data = raw as Record<string, any>
  const self = (data.Self ?? {}) as Record<string, unknown>
  const selfIps = asStringArray(data.TailscaleIPs).length
    ? asStringArray(data.TailscaleIPs)
    : asStringArray(self.TailscaleIPs)

  const peers: TailnetPeer[] = []
  const rawPeers =
    data.Peer && typeof data.Peer === 'object' ? Object.values(data.Peer) : []
  for (const entry of rawPeers) {
    if (!entry || typeof entry !== 'object') continue
    const peer = entry as Record<string, unknown>
    peers.push({
      hostName: typeof peer.HostName === 'string' ? peer.HostName : '',
      dnsName:
        typeof peer.DNSName === 'string' ? peer.DNSName.replace(/\.$/, '') : '',
      os: typeof peer.OS === 'string' ? peer.OS : '',
      ips: asStringArray(peer.TailscaleIPs),
      online: peer.Online === true
    })
  }

  return {
    backendState:
      typeof data.BackendState === 'string' ? data.BackendState : 'Unknown',
    selfIps,
    selfHostName: typeof self.HostName === 'string' ? self.HostName : '',
    peers
  }
}

/**
 * Ejecuta `tailscale status --json`. Nunca lanza: sin binario, con error o con
 * un BackendState distinto de Running devuelve el estado para que el llamador
 * siga sin Tailscale.
 */
export async function probeTailscale(
  runtime: Pick<SystemRuntime, 'platform' | 'env' | 'execProcess'>,
  options?: {
    binary?: string | null
    timeoutMs?: number
    isExecutable?: (filePath: string) => boolean
  }
): Promise<TailscaleProbeResult> {
  const binary = locateTailscaleBinary(runtime, options?.binary, options?.isExecutable)
  if (!binary) {
    return { state: 'absent', binary: null }
  }
  try {
    const outcome = await runtime.execProcess(binary, ['status', '--json'], {
      timeoutMs: options?.timeoutMs ?? 5000
    })
    let parsed: TailscaleStatus | null = null
    try {
      parsed = parseTailscaleStatus(JSON.parse(outcome.stdout))
    } catch {
      parsed = null
    }
    if (!parsed) {
      return {
        state: 'error',
        binary,
        error:
          outcome.stderr.trim() ||
          `tailscale status exited with code ${outcome.exitCode}`
      }
    }
    if (parsed.backendState !== 'Running') {
      return { state: 'not-running', binary, backendState: parsed.backendState }
    }
    return { state: 'running', binary, status: parsed }
  } catch (err: any) {
    return { state: 'error', binary, error: err?.message ?? String(err) }
  }
}

/**
 * IPv4 del rango CGNAT que asigna Tailscale (100.64.0.0/10).
 */
export function isTailscaleIpv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  return nums[0] === 100 && nums[1]! >= 64 && nums[1]! <= 127
}

export function firstIpv4(ips: readonly string[]): string | null {
  return ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)) ?? null
}

/**
 * Primera IPv4 de Tailscale presente en las interfaces locales.
 */
export function localTailscaleIpv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | null {
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && isTailscaleIpv4(info.address)) {
        return info.address
      }
    }
  }
  return null
}
