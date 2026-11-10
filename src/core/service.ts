import fs from 'node:fs'
import path from 'node:path'
import type { SystemRuntime } from 'hubseb'

export const SERVICE_LABEL = 'io.github.pahesebpj.memoseb.node'
export const SYSTEMD_UNIT = 'memoseb-node.service'
export const WINDOWS_TASK_NAME = 'memoseb-node'
export const FIREWALL_RULE_NAME = 'memoseb-node'
export const TAILNET_CIDR = '100.64.0.0/10'
const SCHTASKS_TR_LIMIT = 261

export type ServiceManager = 'launchd' | 'systemd' | 'schtasks'

export type ServiceRuntime = Pick<
  SystemRuntime,
  'platform' | 'homeDir' | 'env' | 'execProcess'
>

export interface ServiceCommand {
  executable: string
  args: string[]
}

export interface ServicePaths {
  manager: ServiceManager
  unitFile: string
  logFile: string
  pidFile: string
  launcherFile: string | null
  startupFile: string | null
}

export interface ServiceContext {
  runtime: ServiceRuntime
  dataDir: string
  command?: ServiceCommand
  uid?: number
  killProcess?: (pid: number) => void
}

export interface ServiceReport {
  manager: ServiceManager | null
  supported: boolean
  installed: boolean
  running?: boolean
  unit: string | null
  logFile: string | null
  mode?: 'launchd' | 'systemd' | 'schtasks' | 'startup-folder'
  removed?: boolean
  warnings: string[]
}

export function serviceManagerFor(platform: NodeJS.Platform): ServiceManager | null {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'linux') return 'systemd'
  if (platform === 'win32') return 'schtasks'
  return null
}

/**
 * Rutas del servicio de usuario. Ninguna requiere privilegios: LaunchAgents,
 * systemd --user y la carpeta Startup del perfil.
 */
export function resolveServicePaths(
  runtime: Pick<SystemRuntime, 'platform' | 'homeDir' | 'env'>,
  dataDir: string
): ServicePaths | null {
  const manager = serviceManagerFor(runtime.platform)
  if (!manager) return null
  const p = path
  const logFile = p.join(dataDir, 'node-serve.log')
  const pidFile = p.join(dataDir, 'node-serve.pid')
  if (manager === 'launchd') {
    return {
      manager,
      unitFile: p.join(runtime.homeDir, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`),
      logFile,
      pidFile,
      launcherFile: null,
      startupFile: null
    }
  }
  if (manager === 'systemd') {
    const configHome =
      runtime.env.XDG_CONFIG_HOME || p.join(runtime.homeDir, '.config')
    return {
      manager,
      unitFile: p.join(configHome, 'systemd', 'user', SYSTEMD_UNIT),
      logFile,
      pidFile,
      launcherFile: null,
      startupFile: null
    }
  }
  const appData =
    runtime.env.APPDATA || p.join(runtime.homeDir, 'AppData', 'Roaming')
  return {
    manager,
    unitFile: WINDOWS_TASK_NAME,
    logFile,
    pidFile,
    launcherFile: p.join(dataDir, 'memoseb-node.cmd'),
    startupFile: p.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      'memoseb-node.cmd'
    )
  }
}

/**
 * Comando que ejecuta el servicio: el mismo Node y el mismo script de la CLI
 * actual, con la base explícita para no depender del entorno del servicio.
 */
export function resolveServiceCommand(input: {
  execPath: string
  execArgv?: readonly string[]
  entry: string
  dbPath: string
  detach?: boolean
}): ServiceCommand {
  const nodeFlags = input.entry.endsWith('.ts')
    ? (input.execArgv ?? []).filter((a) => a.startsWith('--experimental-'))
    : []
  return {
    executable: input.execPath,
    args: [
      ...nodeFlags,
      input.entry,
      'node',
      'serve',
      '--db',
      input.dbPath,
      ...(input.detach ? ['--detach'] : [])
    ]
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderLaunchdPlist(command: ServiceCommand, logFile: string): string {
  const args = [command.executable, ...command.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
</dict>
</plist>
`
}

function systemdQuote(value: string): string {
  if (/[\u0000-\u001f]/.test(value)) {
    throw new Error(`Cannot write control characters into a systemd unit: ${JSON.stringify(value)}`)
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

export function renderSystemdUnit(command: ServiceCommand, logFile: string): string {
  const exec = [command.executable, ...command.args].map(systemdQuote).join(' ')
  return `[Unit]
Description=memoseb P2P node (serve + auto-sync)
After=network-online.target

[Service]
Type=simple
ExecStart=${exec}
Restart=on-failure
RestartSec=10
StandardOutput=append:${logFile.replace(/%/g, '%%')}
StandardError=append:${logFile.replace(/%/g, '%%')}

[Install]
WantedBy=default.target
`
}

function windowsQuote(value: string): string {
  if (value.includes('"')) {
    throw new Error(`Windows service paths cannot contain double quotes: ${value}`)
  }
  return `"${value}"`
}

/**
 * Línea de comando de Windows (schtasks /TR o lanzador .cmd).
 */
export function windowsCommandLine(command: ServiceCommand): string {
  return [command.executable, ...command.args].map(windowsQuote).join(' ')
}

export function renderWindowsLauncher(command: ServiceCommand): string {
  return `@echo off\r\n${windowsCommandLine(command)}\r\n`
}

/**
 * Regla de entrada del Firewall de Windows para el puerto del nodo, limitada
 * al rango de Tailscale.
 */
export function windowsFirewallRule(port: number): {
  powershell: string
  netshArgs: string[]
} {
  return {
    powershell: `New-NetFirewallRule -DisplayName ${FIREWALL_RULE_NAME} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress ${TAILNET_CIDR} -Profile Any`,
    netshArgs: [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${FIREWALL_RULE_NAME}`,
      'dir=in',
      'action=allow',
      'protocol=TCP',
      `localport=${port}`,
      `remoteip=${TAILNET_CIDR}`,
      'profile=any'
    ]
  }
}

/**
 * Crea la regla del firewall pidiendo elevación (UAC) con Start-Process -Verb RunAs.
 * El diálogo de UAC es la confirmación; si se rechaza, el llamador imprime el comando.
 */
export async function applyWindowsFirewallRule(
  runtime: ServiceRuntime,
  port: number
): Promise<{ ok: boolean; command: string; error?: string }> {
  const rule = windowsFirewallRule(port)
  if (runtime.platform !== 'win32') {
    return { ok: false, command: rule.powershell, error: 'The firewall rule only applies to Windows.' }
  }
  const elevated = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','${rule.powershell}'`
  try {
    const outcome = await runtime.execProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', elevated],
      { timeoutMs: 120_000 }
    )
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        command: rule.powershell,
        error: outcome.stderr.trim() || `powershell exited with code ${outcome.exitCode}`
      }
    }
    return { ok: true, command: rule.powershell }
  } catch (err: any) {
    return { ok: false, command: rule.powershell, error: err?.message ?? String(err) }
  }
}

export function writeServePidFile(dataDir: string, pid: number = process.pid): string {
  const file = path.join(dataDir, 'node-serve.pid')
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(file, `${pid}\n`, 'utf-8')
  } catch {
    // Sin archivo de pid el servicio sigue funcionando
  }
  return file
}

export function removeServePidFile(file: string, pid: number = process.pid): void {
  try {
    const current = Number(fs.readFileSync(file, 'utf-8').trim())
    if (current === pid) fs.rmSync(file, { force: true })
  } catch {
    // ignore missing pid file
  }
}

export function readServePid(pidFile: string): number | null {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf-8').trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function stopRecordedServe(paths: ServicePaths, ctx: ServiceContext): boolean {
  const pid = readServePid(paths.pidFile)
  if (!pid || pid === process.pid) return false
  const kill = ctx.killProcess ?? ((target: number) => {
    if (isAlive(target)) process.kill(target)
  })
  try {
    kill(pid)
    fs.rmSync(paths.pidFile, { force: true })
    return true
  } catch {
    return false
  }
}

function currentUid(ctx: ServiceContext): number {
  return ctx.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501)
}

export function nodeServiceStatus(ctx: ServiceContext): ServiceReport {
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir)
  if (!paths) {
    return { manager: null, supported: false, installed: false, unit: null, logFile: null, warnings: [] }
  }
  const pid = readServePid(paths.pidFile)
  const running = pid !== null && isAlive(pid)
  if (paths.manager === 'schtasks') {
    const marker = path.join(ctx.dataDir, 'node-service.json')
    let mode: ServiceReport['mode']
    try {
      mode = JSON.parse(fs.readFileSync(marker, 'utf-8')).mode
    } catch {
      mode = undefined
    }
    return {
      manager: paths.manager,
      supported: true,
      installed: mode !== undefined,
      running,
      unit: mode === 'startup-folder' ? paths.startupFile : WINDOWS_TASK_NAME,
      logFile: paths.logFile,
      ...(mode ? { mode } : {}),
      warnings: []
    }
  }
  return {
    manager: paths.manager,
    supported: true,
    installed: fs.existsSync(paths.unitFile),
    running,
    unit: paths.unitFile,
    logFile: paths.logFile,
    mode: paths.manager,
    warnings: []
  }
}

/**
 * Instala `memoseb node serve` como servicio de usuario: launchd (macOS),
 * systemd --user (Linux) o tarea programada al iniciar sesión (Windows, con la
 * carpeta Startup como alternativa si schtasks no se deja crear). Sin elevación.
 */
export async function installNodeService(ctx: ServiceContext): Promise<ServiceReport> {
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir)
  if (!paths) {
    return {
      manager: null,
      supported: false,
      installed: false,
      unit: null,
      logFile: null,
      warnings: [`No user service manager is supported on ${ctx.runtime.platform}.`]
    }
  }
  if (!ctx.command) {
    throw new Error('installNodeService requires the service command.')
  }
  const exec = ctx.runtime.execProcess.bind(ctx.runtime)
  const warnings: string[] = []
  fs.mkdirSync(ctx.dataDir, { recursive: true })

  if (paths.manager === 'launchd') {
    const domain = `gui/${currentUid(ctx)}`
    fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true })
    await exec('launchctl', ['bootout', `${domain}/${SERVICE_LABEL}`]).catch(() => null)
    fs.writeFileSync(paths.unitFile, renderLaunchdPlist(ctx.command, paths.logFile), 'utf-8')
    const loaded = await exec('launchctl', ['bootstrap', domain, paths.unitFile])
    if (loaded.exitCode !== 0) {
      throw new Error(
        `launchctl bootstrap failed (${loaded.exitCode}): ${loaded.stderr.trim() || loaded.stdout.trim()}`
      )
    }
    return {
      manager: 'launchd',
      supported: true,
      installed: true,
      unit: paths.unitFile,
      logFile: paths.logFile,
      mode: 'launchd',
      warnings
    }
  }

  if (paths.manager === 'systemd') {
    fs.mkdirSync(path.dirname(paths.unitFile), { recursive: true })
    fs.writeFileSync(paths.unitFile, renderSystemdUnit(ctx.command, paths.logFile), 'utf-8')
    for (const args of [
      ['--user', 'daemon-reload'],
      ['--user', 'enable', SYSTEMD_UNIT],
      ['--user', 'restart', SYSTEMD_UNIT]
    ]) {
      const outcome = await exec('systemctl', args).catch((err: Error) => ({
        exitCode: 1,
        stdout: '',
        stderr: err.message
      }))
      if (outcome.exitCode !== 0) {
        warnings.push(
          `systemctl ${args.join(' ')} failed: ${outcome.stderr.trim()}. The unit was written to ${paths.unitFile}; activate it from a session with a user bus: systemctl --user enable --now ${SYSTEMD_UNIT}`
        )
        break
      }
    }
    return {
      manager: 'systemd',
      supported: true,
      installed: true,
      unit: paths.unitFile,
      logFile: paths.logFile,
      mode: 'systemd',
      warnings
    }
  }

  const winPath = path
  stopRecordedServe(paths, ctx)
  let taskRun = windowsCommandLine(ctx.command)
  if (taskRun.length > SCHTASKS_TR_LIMIT - 1) {
    fs.writeFileSync(paths.launcherFile!, renderWindowsLauncher(ctx.command), 'utf-8')
    taskRun = windowsQuote(paths.launcherFile!)
  }
  let mode: 'schtasks' | 'startup-folder' = 'schtasks'
  const created = await exec('schtasks', [
    '/Create',
    '/SC',
    'ONLOGON',
    '/TN',
    WINDOWS_TASK_NAME,
    '/TR',
    taskRun,
    '/RL',
    'LIMITED',
    '/F'
  ]).catch((err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message }))

  if (created.exitCode === 0) {
    const run = await exec('schtasks', ['/Run', '/TN', WINDOWS_TASK_NAME]).catch(
      (err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message })
    )
    if (run.exitCode !== 0) {
      warnings.push(`schtasks /Run failed: ${run.stderr.trim()}. The task starts at next logon.`)
    }
  } else {
    mode = 'startup-folder'
    warnings.push(
      `schtasks /Create failed (${created.stderr.trim() || created.exitCode}); using the Startup folder instead.`
    )
    fs.mkdirSync(winPath.dirname(paths.startupFile!), { recursive: true })
    fs.writeFileSync(paths.startupFile!, renderWindowsLauncher(ctx.command), 'utf-8')
    const started = await exec(ctx.command.executable, ctx.command.args).catch(
      (err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message })
    )
    if (started.exitCode !== 0) {
      warnings.push(`Could not start memoseb node serve now: ${started.stderr.trim()}`)
    }
  }
  fs.writeFileSync(
    winPath.join(ctx.dataDir, 'node-service.json'),
    JSON.stringify({ mode, task: WINDOWS_TASK_NAME, startupFile: paths.startupFile }, null, 2),
    'utf-8'
  )
  return {
    manager: 'schtasks',
    supported: true,
    installed: true,
    unit: mode === 'schtasks' ? WINDOWS_TASK_NAME : paths.startupFile,
    logFile: paths.logFile,
    mode,
    warnings
  }
}

/**
 * Quita el servicio de usuario y detiene el proceso que registró. No hace nada
 * (ni ejecuta comandos) si no hay servicio instalado.
 */
export async function uninstallNodeService(ctx: ServiceContext): Promise<ServiceReport> {
  const status = nodeServiceStatus(ctx)
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir)
  if (!paths || !status.installed) {
    return { ...status, removed: false }
  }
  const exec = ctx.runtime.execProcess.bind(ctx.runtime)
  const warnings: string[] = []
  const swallow = (err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message })

  if (paths.manager === 'launchd') {
    await exec('launchctl', ['bootout', `gui/${currentUid(ctx)}/${SERVICE_LABEL}`]).catch(swallow)
    fs.rmSync(paths.unitFile, { force: true })
  } else if (paths.manager === 'systemd') {
    const disabled = await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]).catch(swallow)
    if (disabled.exitCode !== 0) {
      warnings.push(`systemctl --user disable --now failed: ${disabled.stderr.trim()}`)
    }
    fs.rmSync(paths.unitFile, { force: true })
    await exec('systemctl', ['--user', 'daemon-reload']).catch(swallow)
  } else {
    const winPath = path
    if (status.mode === 'schtasks') {
      await exec('schtasks', ['/End', '/TN', WINDOWS_TASK_NAME]).catch(swallow)
      const deleted = await exec('schtasks', ['/Delete', '/TN', WINDOWS_TASK_NAME, '/F']).catch(swallow)
      if (deleted.exitCode !== 0) {
        warnings.push(`schtasks /Delete failed: ${deleted.stderr.trim()}`)
      }
    }
    if (paths.startupFile) fs.rmSync(paths.startupFile, { force: true })
    if (paths.launcherFile) fs.rmSync(paths.launcherFile, { force: true })
    fs.rmSync(winPath.join(ctx.dataDir, 'node-service.json'), { force: true })
    stopRecordedServe(paths, ctx)
  }

  return {
    manager: paths.manager,
    supported: true,
    installed: false,
    unit: status.unit,
    logFile: paths.logFile,
    mode: status.mode,
    removed: true,
    warnings
  }
}
