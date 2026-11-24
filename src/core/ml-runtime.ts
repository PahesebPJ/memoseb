import { spawn as nodeSpawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  directorySizeBytes,
  runtimePackageDir,
  type MlPaths
} from './transformers-embedder.ts'

/** Marks a directory as created by memoseb; --purge refuses to delete anything without it. */
export const ML_DIR_MARKER = '.memoseb-ml'

/**
 * Pinned manifest + lockfile (exact versions and integrity hashes for every
 * transitive package), installed with `npm ci`. Bump them in a dedicated PR.
 */
const RUNTIME_TEMPLATE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'resources',
  'ml-runtime'
)

export interface MlRuntimeInstallResult {
  installed: boolean
  sizeBytes: number
  prunedBytes: number
  log: string
}

type SpawnFn = typeof nodeSpawn

function run(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  options: { cwd: string; shell?: boolean; env?: NodeJS.ProcessEnv; onOutput?: (chunk: string) => void }
): Promise<{ code: number; output: string }> {
  const onOutput = options.onOutput
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: options.shell ?? false,
      ...(options.env ? { env: options.env } : {})
    })
    let output = ''
    const collect = (data: Buffer): void => {
      const text = data.toString()
      output += text
      onOutput?.(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

/**
 * Installs @huggingface/transformers into a private npm prefix next to the vault.
 * It is not a package dependency: onnxruntime ships ~550 MB of binaries for every
 * platform, so only users who opt into semantic search pay for it.
 */
export async function installMlRuntime(
  paths: MlPaths,
  options?: { spawnProcess?: SpawnFn; onOutput?: (chunk: string) => void }
): Promise<MlRuntimeInstallResult> {
  const spawnFn = options?.spawnProcess ?? nodeSpawn
  const markerPath = path.join(paths.root, ML_DIR_MARKER)
  if (
    fs.existsSync(paths.root) &&
    !fs.existsSync(markerPath) &&
    fs.readdirSync(paths.root).length > 0
  ) {
    // Claiming a populated directory would let --purge delete pre-existing runtime/ or models/.
    return {
      installed: false,
      sizeBytes: 0,
      prunedBytes: 0,
      log: `${paths.root} already exists and was not created by memoseb. Point MEMOSEB_ML_DIR at a new or empty directory.`
    }
  }
  fs.mkdirSync(paths.runtimeDir, { recursive: true })
  fs.writeFileSync(markerPath, 'Created by memoseb. Safe to delete with "memoseb model disable --purge".\n')
  for (const file of ['package.json', 'package-lock.json']) {
    fs.copyFileSync(path.join(RUNTIME_TEMPLATE_DIR, file), path.join(paths.runtimeDir, file))
  }
  // onnxruntime-node's postinstall only fetches optional CUDA libraries; CPU inference
  // works without it, so install scripts stay disabled. `npm ci` verifies every
  // tarball against the integrity hashes in the shipped lockfile.
  // npm is a .cmd shim on Windows and needs a shell there; all arguments are constants.
  const { code, output } = await run(
    spawnFn,
    'npm',
    ['ci', '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev'],
    { cwd: paths.runtimeDir, shell: process.platform === 'win32', onOutput: options?.onOutput }
  )
  if (code !== 0) {
    return { installed: false, sizeBytes: 0, prunedBytes: 0, log: output }
  }
  const prunedBytes = await pruneMlRuntime(paths, { spawnProcess: spawnFn })
  return {
    installed: true,
    sizeBytes: directorySizeBytes(path.join(paths.runtimeDir, 'node_modules')),
    prunedBytes,
    log: output
  }
}

function removeAndMeasure(target: string): number {
  if (!fs.existsSync(target)) return 0
  const size = fs.statSync(target).isDirectory() ? directorySizeBytes(target) : fs.statSync(target).size
  fs.rmSync(target, { recursive: true, force: true })
  return size
}

/**
 * Deletes ONNX binaries this machine can never load: other operating systems,
 * other CPU architectures and GPU execution providers (memoseb runs on CPU).
 * onnxruntime-web is only removed when the runtime still imports without it.
 */
export async function pruneMlRuntime(
  paths: MlPaths,
  options?: { spawnProcess?: SpawnFn }
): Promise<number> {
  const modules = path.join(paths.runtimeDir, 'node_modules')
  let pruned = 0
  const binRoot = path.join(modules, 'onnxruntime-node', 'bin')
  if (fs.existsSync(binRoot)) {
    for (const napi of fs.readdirSync(binRoot)) {
      const napiDir = path.join(binRoot, napi)
      if (!fs.statSync(napiDir).isDirectory()) continue
      for (const platform of fs.readdirSync(napiDir)) {
        const platformDir = path.join(napiDir, platform)
        if (platform !== process.platform) {
          pruned += removeAndMeasure(platformDir)
          continue
        }
        for (const arch of fs.readdirSync(platformDir)) {
          const archDir = path.join(platformDir, arch)
          if (arch !== process.arch) {
            pruned += removeAndMeasure(archDir)
            continue
          }
          for (const file of fs.readdirSync(archDir)) {
            if (/providers_(cuda|tensorrt)/i.test(file)) {
              pruned += removeAndMeasure(path.join(archDir, file))
            }
          }
        }
      }
    }
  }

  const webDir = path.join(modules, 'onnxruntime-web')
  if (fs.existsSync(webDir)) {
    const parked = path.join(paths.runtimeDir, '.onnxruntime-web.pruned')
    fs.rmSync(parked, { recursive: true, force: true })
    fs.renameSync(webDir, parked)
    const entry = path.join(runtimePackageDir(paths), 'package.json')
    // No shell (paths stay single argv entries) and a minimal env: this runs
    // third-party code, so it must not see secrets such as MEMOSEB_SYNC_TOKEN.
    const probe = await run(
      options?.spawnProcess ?? nodeSpawn,
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { createRequire } from 'node:module'; import { pathToFileURL } from 'node:url';` +
          `const pkg = ${JSON.stringify(entry)};` +
          `const p = createRequire(pkg)(pkg); const dir = pkg.slice(0, -'package.json'.length);` +
          `await import(pathToFileURL(dir + p.exports.node.import.default).href)`
      ],
      {
        cwd: paths.runtimeDir,
        env: {
          PATH: process.env.PATH ?? '',
          ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {})
        }
      }
    ).catch(() => ({ code: 1, output: '' }))
    if (probe.code === 0) {
      pruned += removeAndMeasure(parked)
    } else {
      fs.renameSync(parked, webDir)
    }
  }
  return pruned
}

export function isMemosebMlDir(paths: MlPaths): boolean {
  return fs.existsSync(path.join(paths.root, ML_DIR_MARKER))
}

/** Deletes runtime/ and models/ only when the ML root carries the memoseb marker. */
export function purgeMlDir(paths: MlPaths): { freedBytes: number; skipped: boolean } {
  if (!isMemosebMlDir(paths)) {
    return { freedBytes: 0, skipped: true }
  }
  const freedBytes = removeAndMeasure(paths.runtimeDir) + removeAndMeasure(paths.modelsDir)
  return { freedBytes, skipped: false }
}
