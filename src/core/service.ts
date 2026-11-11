import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { SystemRuntime } from 'hubseb'

export const SERVICE_LABEL = 'io.github.pahesebpj.memoseb.node'
export const SYSTEMD_UNIT = 'memoseb-node.service'
export const WINDOWS_TASK_NAME = 'memoseb-node'
export const FIREWALL_RULE_NAME = 'memoseb-node'
export const TAILNET_CIDR = '100.64.0.0/10'
const SCHTASKS_TR_LIMIT = 261

/** Sufijo estable por bóveda: cada --db tiene su propio servicio. */
export function serviceIdentity(dbPath: string): string {
  return crypto.createHash('sha256').update(path.resolve(dbPath)).digest('hex').slice(0, 10)
}

export interface ServiceNames {
  label: string
  systemdUnit: string
  taskName: string
  launcherName: string
  firewallRule: string
}

/** Archivos de estado de `serve` para una bóveda: llevan el sufijo de serviceIdentity. */
export function serveStateFiles(dbPath: string): {
  logFile: string
  pidFile: string
  serviceMarker: string
  firewallMarker: string
  activeFile: string
} {
  const dir = path.dirname(path.resolve(dbPath))
  const id = serviceIdentity(dbPath)
  return {
    activeFile: path.join(dir, `node-serve-${id}.json`),
    logFile: path.join(dir, `node-serve-${id}.log`),
    pidFile: path.join(dir, `node-serve-${id}.pid`),
    serviceMarker: path.join(dir, `node-service-${id}.json`),
    firewallMarker: path.join(dir, `node-firewall-${id}.json`)
  }
}

export function serviceNames(dbPath: string): ServiceNames {
  const id = serviceIdentity(dbPath)
  return {
    label: `${SERVICE_LABEL}.${id}`,
    systemdUnit: `memoseb-node-${id}.service`,
    taskName: `${WINDOWS_TASK_NAME}-${id}`,
    launcherName: `${WINDOWS_TASK_NAME}-${id}.cmd`,
    firewallRule: `${FIREWALL_RULE_NAME}-${id}`
  }
}

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
  names: ServiceNames
  unitFile: string
  logFile: string
  pidFile: string
  serviceMarker: string
  firewallMarker: string
  launcherFile: string | null
  startupFile: string | null
}

export interface ServiceContext {
  runtime: ServiceRuntime
  dataDir: string
  dbPath: string
  command?: ServiceCommand
  uid?: number
  killProcess?: (pid: number) => void
  /** Confirma que el pid es un `memoseb node serve` antes de detenerlo. */
  isMemosebProcess?: (pid: number) => Promise<boolean>
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
  firewall?: FirewallRemoval
  warnings: string[]
}

export interface FirewallRemoval {
  removed: boolean
  rule: string
  command: string
  error?: string
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
  dataDir: string,
  dbPath: string = path.join(dataDir, 'vault.sqlite')
): ServicePaths | null {
  const manager = serviceManagerFor(runtime.platform)
  if (!manager) return null
  const p = path
  const names = serviceNames(dbPath)
  const { logFile, pidFile, serviceMarker, firewallMarker } = serveStateFiles(dbPath)
  if (manager === 'launchd') {
    return {
      manager,
      names,
      unitFile: p.join(runtime.homeDir, 'Library', 'LaunchAgents', `${names.label}.plist`),
      logFile,
      pidFile,
      serviceMarker,
      firewallMarker,
      launcherFile: null,
      startupFile: null
    }
  }
  if (manager === 'systemd') {
    const configHome =
      runtime.env.XDG_CONFIG_HOME || p.join(runtime.homeDir, '.config')
    return {
      manager,
      names,
      unitFile: p.join(configHome, 'systemd', 'user', names.systemdUnit),
      logFile,
      pidFile,
      serviceMarker,
      firewallMarker,
      launcherFile: null,
      startupFile: null
    }
  }
  const appData =
    runtime.env.APPDATA || p.join(runtime.homeDir, 'AppData', 'Roaming')
  return {
    manager,
    names,
    unitFile: names.taskName,
    logFile,
    pidFile,
    serviceMarker,
    firewallMarker,
    launcherFile: p.join(dataDir, names.launcherName),
    startupFile: p.join(
      appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      names.launcherName
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

export function renderLaunchdPlist(
  command: ServiceCommand,
  logFile: string,
  label: string = SERVICE_LABEL
): string {
  const args = [command.executable, ...command.args]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
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
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%')
    .replace(/\$/g, '$$$$')}"`
}

function systemdPathEscape(value: string): string {
  return value.replace(/%/g, '%%').replace(/\$/g, '$$$$')
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
StandardOutput=append:${systemdPathEscape(logFile)}
StandardError=append:${systemdPathEscape(logFile)}

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
  // En un .cmd, % expande variables: se duplica para que la ruta sea literal
  return `@echo off\r\n${windowsCommandLine(command).replace(/%/g, '%%')}\r\n`
}

/**
 * Regla de entrada del Firewall de Windows para el puerto del nodo, limitada
 * al rango de Tailscale.
 */
export function windowsFirewallRule(
  port: number,
  name: string = FIREWALL_RULE_NAME
): {
  powershell: string
  netshArgs: string[]
} {
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid firewall rule name: ${name}`)
  }
  return {
    powershell: `New-NetFirewallRule -DisplayName ${name} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress ${TAILNET_CIDR} -Profile Any`,
    netshArgs: [
      'advfirewall',
      'firewall',
      'add',
      'rule',
      `name=${name}`,
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
async function runElevatedPowershell(
  runtime: ServiceRuntime,
  command: string
): Promise<{ ok: boolean; error?: string }> {
  const elevated = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait -ArgumentList '-NoProfile','-Command','${command}'`
  try {
    const outcome = await runtime.execProcess(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', elevated],
      { timeoutMs: 120_000 }
    )
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        error: outcome.stderr.trim() || `powershell exited with code ${outcome.exitCode}`
      }
    }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) }
  }
}

export async function applyWindowsFirewallRule(
  runtime: ServiceRuntime,
  port: number,
  options?: { name?: string; marker?: string }
): Promise<{ ok: boolean; command: string; error?: string }> {
  const name = options?.name ?? FIREWALL_RULE_NAME
  const rule = windowsFirewallRule(port, name)
  if (runtime.platform !== 'win32') {
    return { ok: false, command: rule.powershell, error: 'The firewall rule only applies to Windows.' }
  }
  const outcome = await runElevatedPowershell(runtime, rule.powershell)
  if (outcome.ok && options?.marker) {
    // Marca para que uninstall borre solo la regla que creó este servicio
    fs.mkdirSync(path.dirname(options.marker), { recursive: true })
    fs.writeFileSync(
      options.marker,
      JSON.stringify({ rule: name, port }, null, 2),
      'utf-8'
    )
  }
  return { command: rule.powershell, ...outcome }
}

/** Borra la regla del firewall solo si la creó este servicio (marca con su sufijo). */
export async function removeWindowsFirewallRule(
  runtime: ServiceRuntime,
  marker: string
): Promise<FirewallRemoval | undefined> {
  if (runtime.platform !== 'win32') return undefined
  let rule: string
  try {
    rule = String(JSON.parse(fs.readFileSync(marker, 'utf-8')).rule)
  } catch {
    return undefined
  }
  if (!/^[A-Za-z0-9-]+$/.test(rule)) return undefined
  const command = `Remove-NetFirewallRule -DisplayName ${rule}`
  const outcome = await runElevatedPowershell(runtime, command)
  if (outcome.ok) fs.rmSync(marker, { force: true })
  return { removed: outcome.ok, rule, command, ...(outcome.error ? { error: outcome.error } : {}) }
}

export function writeServePidFile(file: string, pid: number = process.pid): string {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${pid}\n`, 'utf-8')
  } catch {
    // Sin archivo de pid el servicio sigue funcionando
  }
  return file
}

export interface ActiveListen {
  pid: number
  hosts: string[]
  port: number
  urls: string[]
  startedAt: string
}

/** Direcciones efectivas del `serve` en curso (distintas de la config guardada). */
export function writeActiveListen(file: string, active: ActiveListen): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(active, null, 2), 'utf-8')
  } catch {
    // Sin el archivo, node status solo muestra la config
  }
}

/** Lee el serve activo; null si no hay archivo o el proceso ya no vive. */
export function readActiveListen(file: string): ActiveListen | null {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as ActiveListen
    if (!Number.isInteger(data.pid) || !isAlive(data.pid)) return null
    return data
  } catch {
    return null
  }
}

export function removeActiveListen(file: string, pid: number = process.pid): void {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as ActiveListen
    if (data.pid === pid) fs.rmSync(file, { force: true })
  } catch {
    // ignore missing file
  }
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

export function looksLikeMemosebServe(commandLine: string): boolean {
  return /memoseb/i.test(commandLine) && /\bnode\b[\s"']+serve\b/.test(commandLine)
}

/** Línea de comandos del proceso (ps en POSIX, Win32_Process en Windows). */
async function processCommandLine(runtime: ServiceRuntime, pid: number): Promise<string> {
  try {
    const outcome =
      runtime.platform === 'win32'
        ? await runtime.execProcess('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`
          ])
        : await runtime.execProcess('ps', ['-p', String(pid), '-o', 'command='])
    return outcome.exitCode === 0 ? outcome.stdout.trim() : ''
  } catch {
    return ''
  }
}

async function stopRecordedServe(paths: ServicePaths, ctx: ServiceContext): Promise<boolean> {
  const pid = readServePid(paths.pidFile)
  if (!pid || pid === process.pid) return false
  // Un pid reciclado por otro programa nunca se mata
  const isMemoseb = ctx.isMemosebProcess
    ? await ctx.isMemosebProcess(pid)
    : looksLikeMemosebServe(await processCommandLine(ctx.runtime, pid))
  if (!isMemoseb) {
    fs.rmSync(paths.pidFile, { force: true })
    return false
  }
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
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir, ctx.dbPath)
  if (!paths) {
    return { manager: null, supported: false, installed: false, unit: null, logFile: null, warnings: [] }
  }
  const pid = readServePid(paths.pidFile)
  const running = pid !== null && isAlive(pid)
  if (paths.manager === 'schtasks') {
    const marker = paths.serviceMarker
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
      unit: mode === 'startup-folder' ? paths.startupFile : paths.names.taskName,
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
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir, ctx.dbPath)
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
    await exec('launchctl', ['bootout', `${domain}/${paths.names.label}`]).catch(() => null)
    fs.writeFileSync(
      paths.unitFile,
      renderLaunchdPlist(ctx.command, paths.logFile, paths.names.label),
      'utf-8'
    )
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
      ['--user', 'enable', paths.names.systemdUnit],
      ['--user', 'restart', paths.names.systemdUnit]
    ]) {
      const outcome = await exec('systemctl', args).catch((err: Error) => ({
        exitCode: 1,
        stdout: '',
        stderr: err.message
      }))
      if (outcome.exitCode !== 0) {
        warnings.push(
          `systemctl ${args.join(' ')} failed: ${outcome.stderr.trim()}. The unit was written to ${paths.unitFile}; activate it from a session with a user bus: systemctl --user enable --now ${paths.names.systemdUnit}`
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
  await stopRecordedServe(paths, ctx)
  let taskRun = windowsCommandLine(ctx.command)
  if (taskRun.length > SCHTASKS_TR_LIMIT - 1) {
    fs.writeFileSync(paths.launcherFile!, renderWindowsLauncher(ctx.command), 'utf-8')
    taskRun = windowsQuote(paths.launcherFile!).replace(/%/g, '%%')
  }
  let mode: 'schtasks' | 'startup-folder' = 'schtasks'
  const created = await exec('schtasks', [
    '/Create',
    '/SC',
    'ONLOGON',
    '/TN',
    paths.names.taskName,
    '/TR',
    taskRun,
    '/RL',
    'LIMITED',
    '/F'
  ]).catch((err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message }))

  if (created.exitCode === 0) {
    const run = await exec('schtasks', ['/Run', '/TN', paths.names.taskName]).catch(
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
    paths.serviceMarker,
    JSON.stringify({ mode, task: paths.names.taskName, startupFile: paths.startupFile }, null, 2),
    'utf-8'
  )
  return {
    manager: 'schtasks',
    supported: true,
    installed: true,
    unit: mode === 'schtasks' ? paths.names.taskName : paths.startupFile,
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
  const paths = resolveServicePaths(ctx.runtime, ctx.dataDir, ctx.dbPath)
  const firewall = paths ? await removeWindowsFirewallRule(ctx.runtime, paths.firewallMarker) : undefined
  if (!paths || !status.installed) {
    return { ...status, removed: false, ...(firewall ? { firewall } : {}) }
  }
  const exec = ctx.runtime.execProcess.bind(ctx.runtime)
  const warnings: string[] = []
  const swallow = (err: Error) => ({ exitCode: 1, stdout: '', stderr: err.message })

  if (paths.manager === 'launchd') {
    await exec('launchctl', ['bootout', `gui/${currentUid(ctx)}/${paths.names.label}`]).catch(swallow)
    fs.rmSync(paths.unitFile, { force: true })
  } else if (paths.manager === 'systemd') {
    const disabled = await exec('systemctl', ['--user', 'disable', '--now', paths.names.systemdUnit]).catch(swallow)
    if (disabled.exitCode !== 0) {
      warnings.push(`systemctl --user disable --now failed: ${disabled.stderr.trim()}`)
    }
    fs.rmSync(paths.unitFile, { force: true })
    await exec('systemctl', ['--user', 'daemon-reload']).catch(swallow)
  } else {
    if (status.mode === 'schtasks') {
      await exec('schtasks', ['/End', '/TN', paths.names.taskName]).catch(swallow)
      const deleted = await exec('schtasks', ['/Delete', '/TN', paths.names.taskName, '/F']).catch(swallow)
      if (deleted.exitCode !== 0) {
        warnings.push(`schtasks /Delete failed: ${deleted.stderr.trim()}`)
      }
    }
    if (paths.startupFile) fs.rmSync(paths.startupFile, { force: true })
    if (paths.launcherFile) fs.rmSync(paths.launcherFile, { force: true })
    fs.rmSync(paths.serviceMarker, { force: true })
    await stopRecordedServe(paths, ctx)
  }

  return {
    manager: paths.manager,
    supported: true,
    installed: false,
    unit: status.unit,
    logFile: paths.logFile,
    mode: status.mode,
    removed: true,
    ...(firewall ? { firewall } : {}),
    warnings
  }
}
