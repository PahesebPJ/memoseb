import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { serializeWire, wireFailure, wireSuccess } from 'hubseb'
import {
  findModelSpec,
  findRerankerSpec,
  isSemanticModel,
  LEXICAL_MODEL_ID,
  MODEL_CATALOG,
  RECOMMENDED_MODEL_ID,
  RECOMMENDED_RERANKER_ID,
  RERANKER_CATALOG,
  vectorModelTag,
  type EmbedderModelSpec,
  type RerankerModelSpec
} from '../core/model-catalog.ts'
import { purgeMlDir } from '../core/ml-runtime.ts'
import {
  defaultMlBackend,
  reindexVault,
  resolveActiveEmbedder,
  resolveActiveReranker,
  type MlBackend
} from '../core/semantic.ts'
import {
  directorySizeBytes,
  MODEL_READY_MARKER,
  modelCacheDir,
  type DownloadProgress,
  type MlPaths
} from '../core/transformers-embedder.ts'
import type { MemoryVault } from '../core/vault.ts'

/** Measured size of the pruned ML runtime (transformers.js + onnxruntime CPU for one platform). */
const RUNTIME_DISK_MB = 85

export interface ModelCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ModelCommandIo {
  /** Live progress output (downloads, reindex); defaults to process.stderr. */
  progress?: (text: string) => void
  /** Whether menus and confirmations can be shown; defaults to a TTY check. */
  interactive?: boolean
  /** Asks a question and returns the answer; defaults to readline on stdin/stderr. */
  ask?: (question: string) => Promise<string>
  backend?: MlBackend
}

export interface ModelCommandInput {
  subcommand: string | undefined
  modelArg: string | undefined
  /** Third positional: the reranker id in "model reranker enable <id>". */
  rerankerArg?: string | undefined
  jsonMode: boolean
  yes: boolean
  purge: boolean
  openVault: () => MemoryVault
  io?: ModelCommandIo
}

const mb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)} MB`

async function defaultAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

function ok(command: string, data: unknown, text: string, jsonMode: boolean): ModelCommandResult {
  return jsonMode
    ? { exitCode: 0, stdout: serializeWire(wireSuccess(command, data)), stderr: '' }
    : { exitCode: 0, stdout: text.endsWith('\n') ? text : `${text}\n`, stderr: '' }
}

function fail(
  command: string,
  code: string,
  message: string,
  jsonMode: boolean,
  hint?: string
): ModelCommandResult {
  return jsonMode
    ? { exitCode: 2, stdout: serializeWire(wireFailure(command, code, message, hint)), stderr: '' }
    : { exitCode: 2, stdout: '', stderr: `${message}${hint ? `\n${hint}` : ''}\n` }
}

interface CatalogEntryView {
  id: string
  label: string
  hfModel: string | null
  dimensions: number
  diskMb: number
  ramMb: number
  languages: string
  note: string
  active: boolean
  recommended: boolean
  downloaded: boolean
}

function catalogView(vault: MemoryVault, backend: MlBackend): CatalogEntryView[] {
  const activeId = vault.getActiveEmbedder().spec.id
  const paths = vault.mlPaths
  return MODEL_CATALOG.map((spec) => ({
    id: spec.id,
    label: spec.label,
    hfModel: spec.hfModel,
    dimensions: spec.dimensions,
    diskMb: spec.diskMb,
    ramMb: spec.ramMb,
    languages: spec.languages,
    note: spec.note,
    active: spec.id === activeId,
    recommended: spec.id === RECOMMENDED_MODEL_ID,
    downloaded: isSemanticModel(spec)
      ? backend.isRuntimeInstalled(paths) && backend.isModelDownloaded(paths, spec)
      : true
  }))
}

function formatCatalog(entries: CatalogEntryView[]): string {
  const rows = entries.map((e, i) => {
    const marker = e.active ? '*' : ' '
    const disk = e.diskMb === 0 ? '0' : `~${e.diskMb} MB`
    const ram = e.ramMb === 0 ? '~0' : `~${e.ramMb} MB`
    const state = e.active
      ? 'active'
      : e.hfModel === null
        ? 'built-in'
        : e.downloaded
          ? 'downloaded'
          : 'not downloaded'
    const star = e.recommended ? ' (recommended)' : ''
    return `${marker} ${String(i + 1).padStart(2)}. ${e.id.padEnd(13)} ${disk.padEnd(9)} RAM ${ram.padEnd(8)} ${e.languages.padEnd(28)} ${state}${star}\n        ${e.label}: ${e.note}`
  })
  return [
    'Embedding models (disk = download size, RAM = extra memory while loaded):',
    ...rows,
    '',
    'Enable one with: memoseb model enable <id>   ·   back to no ML: memoseb model disable'
  ].join('\n')
}

async function chooseModel(io: Required<Pick<ModelCommandIo, 'ask'>>, entries: CatalogEntryView[]): Promise<EmbedderModelSpec | undefined> {
  const answer = (
    await io.ask(`${formatCatalog(entries)}\n\nChoose a model [number or id, Enter = ${RECOMMENDED_MODEL_ID}]: `)
  ).trim()
  if (answer.length === 0) return findModelSpec(RECOMMENDED_MODEL_ID)
  const index = Number(answer)
  if (Number.isInteger(index) && index >= 1 && index <= MODEL_CATALOG.length) {
    return MODEL_CATALOG[index - 1]
  }
  return findModelSpec(answer)
}

function envOverrideNote(vault: MemoryVault): string {
  const info = vault.getActiveEmbedder()
  return info.source === 'env'
    ? `\nNote: MEMOSEB_EMBEDDER=${info.invalidValue ?? info.spec.id} overrides this setting in the current environment.`
    : ''
}

export async function runModelCommand(input: ModelCommandInput): Promise<ModelCommandResult> {
  const command = `model ${input.subcommand ?? 'status'}`
  const io = input.io ?? {}
  const backend = io.backend ?? defaultMlBackend
  const progress = io.progress ?? ((text: string) => process.stderr.write(text))
  const interactive = io.interactive ?? Boolean(process.stdin.isTTY && process.stderr.isTTY)
  const ask = io.ask ?? defaultAsk
  const subcommand = input.subcommand ?? 'status'

  const vault = input.openVault()
  try {
    if (subcommand === 'list') {
      const entries = catalogView(vault, backend)
      return ok(command, { models: entries }, formatCatalog(entries), input.jsonMode)
    }

    if (subcommand === 'status') {
      const info = vault.getActiveEmbedder()
      const paths = vault.mlPaths
      const activeTag = vectorModelTag(info.spec)
      const memoryCount = vault.getStats().memoryCount
      const pending = vault.countMemoriesNeedingVectors(activeTag)
      const runtimeInstalled = backend.isRuntimeInstalled(paths)
      const resolution = resolveActiveEmbedder(vault, backend)
      const data = {
        active: info.spec.id,
        source: info.source,
        vectorModel: activeTag,
        semantic: isSemanticModel(info.spec),
        inUse: resolution.embedder ? info.spec.id : LEXICAL_MODEL_ID,
        warning: resolution.warning ?? null,
        memories: memoryCount,
        pendingReindex: pending,
        vectorModels: vault.vectorModelCounts(),
        mlDir: paths.root,
        runtimeInstalled,
        runtimeBytes: directorySizeBytes(paths.runtimeDir),
        modelsBytes: directorySizeBytes(paths.modelsDir),
        reranker: rerankerStatus(vault, backend)
      }
      const lines = [
        `Active embedder: ${info.spec.id} (${info.spec.label}) — source: ${info.source}`,
        `  Search mode:   ${data.semantic ? 'semantic (meaning) + FTS5 keywords' : 'lexical (spelling overlap) + FTS5 keywords'}`,
        `  Vectors:       ${memoryCount - pending}/${memoryCount} memories indexed with ${activeTag}${pending > 0 ? ` (${pending} pending: run "memoseb model reindex")` : ''}`,
        `  ML directory:  ${paths.root}`,
        `  ML runtime:    ${runtimeInstalled ? `installed (${mb(data.runtimeBytes)})` : 'not installed'}`,
        `  Model weights: ${mb(data.modelsBytes)} downloaded`
      ]
      lines.push(
        `  Reranker:      ${data.reranker.active ? `${data.reranker.active} (source: ${data.reranker.source}${data.reranker.inUse ? '' : ', not installed'})` : 'off'}`
      )
      if (resolution.warning) lines.push(`  Warning:       ${resolution.warning}`)
      if (data.reranker.warning) lines.push(`  Warning:       ${data.reranker.warning}`)
      return ok(command, data, lines.join('\n'), input.jsonMode)
    }

    if (subcommand === 'enable' || subcommand === 'use') {
      let spec: EmbedderModelSpec | undefined
      if (input.modelArg) {
        spec = findModelSpec(input.modelArg)
      } else if (interactive && !input.jsonMode) {
        spec = await chooseModel({ ask }, catalogView(vault, backend))
      } else {
        spec = findModelSpec(RECOMMENDED_MODEL_ID)
      }
      if (!spec) {
        return fail(
          command,
          'UNKNOWN_MODEL',
          `Unknown model "${input.modelArg ?? ''}".`,
          input.jsonMode,
          `Available: ${MODEL_CATALOG.map((m) => m.id).join(', ')} (see "memoseb model list")`
        )
      }

      if (!isSemanticModel(spec)) {
        return await disable(vault, command, input, false)
      }

      const paths = vault.mlPaths
      const needRuntime = !backend.isRuntimeInstalled(paths)
      const needWeights = needRuntime || !backend.isModelDownloaded(paths, spec)
      if (needRuntime || needWeights) {
        const downloadMb = (needRuntime ? RUNTIME_DISK_MB : 0) + (needWeights ? spec.diskMb : 0)
        const plan = [
          `Enabling "${spec.id}" (${spec.label}) needs ~${downloadMb} MB of disk in ${paths.root}:`,
          ...(needRuntime ? [`  - ML runtime (transformers.js + ONNX for ${process.platform}-${process.arch}): ~${RUNTIME_DISK_MB} MB after removing other platforms' binaries (npm downloads more, once)`] : []),
          ...(needWeights ? [`  - Model weights: ~${spec.diskMb} MB`] : []),
          `While loaded it uses ~${spec.ramMb} MB of RAM. After the download no network is used.`
        ].join('\n')
        if (!input.yes) {
          if (!interactive || input.jsonMode) {
            return fail(command, 'CONFIRMATION_REQUIRED', plan, input.jsonMode, 'Re-run with --yes to confirm.')
          }
          const answer = (await ask(`${plan}\nContinue? [y/N] `)).trim().toLowerCase()
          if (answer !== 'y' && answer !== 'yes' && answer !== 's' && answer !== 'si' && answer !== 'sí') {
            return ok(command, { enabled: false, cancelled: true }, 'Cancelled. Nothing was downloaded.', input.jsonMode)
          }
        }
      }

      if (needRuntime) {
        progress('Installing ML runtime (npm)...\n')
        const installed = await backend.installRuntime(paths)
        if (!installed.installed) {
          return fail(
            command,
            'RUNTIME_INSTALL_FAILED',
            `Could not install the ML runtime:\n${installed.log.trim().split('\n').slice(-15).join('\n')}`,
            input.jsonMode
          )
        }
        progress(`ML runtime installed (${mb(installed.sizeBytes)}, pruned ${mb(installed.prunedBytes)} of unused binaries).\n`)
      }

      let lastPct = -1
      const embedder = backend.createEmbedder(spec, paths, {
        allowRemote: true,
        onProgress: ({ file, loaded, total }) => {
          if (total <= 0 || !file.endsWith('.onnx')) return
          const pct = Math.floor((loaded / total) * 100)
          if (pct >= lastPct + 10 || (pct === 100 && lastPct !== 100)) {
            lastPct = pct
            progress(`Downloading ${file}: ${pct}% (${mb(loaded)}/${mb(total)})\n`)
          }
        }
      })
      try {
        const started = performance.now()
        progress(`Loading ${spec.hfModel}...\n`)
        const probe = await embedder.embedQuery('memoseb semantic search check')
        if (probe.length !== spec.dimensions) {
          throw new Error(`Model returned ${probe.length} dimensions, expected ${spec.dimensions}.`)
        }
        const loadMs = performance.now() - started
        const result = await reindexVault(vault, embedder, {
          onProgress: ({ done, total }) => progress(`Reindexing memories: ${done}/${total}\n`)
        })
        vault.setConfiguredEmbedderId(spec.id)
        const data = {
          enabled: true,
          model: spec.id,
          vectorModel: embedder.model,
          reindexed: result.reindexed,
          loadMs: Math.round(loadMs),
          mlDir: paths.root
        }
        return ok(
          command,
          data,
          `Semantic search ENABLED with ${spec.id} (${spec.label}). Reindexed ${result.reindexed} memories; model ready in ${Math.round(loadMs)} ms.${envOverrideNote(vault)}`,
          input.jsonMode
        )
      } catch (err) {
        return fail(
          command,
          'MODEL_LOAD_FAILED',
          `Could not load model "${spec.id}": ${err instanceof Error ? err.message : String(err)}`,
          input.jsonMode,
          'The previous embedder is still active.'
        )
      } finally {
        await embedder.dispose()
      }
    }

    if (subcommand === 'disable') {
      return await disable(vault, command, input, input.purge)
    }

    if (subcommand === 'reranker' || subcommand === 'rerankers') {
      return await runRerankerCommand(vault, input, { backend, progress, interactive, ask })
    }

    if (subcommand === 'reindex') {
      const resolution = resolveActiveEmbedder(vault, backend)
      if (resolution.warning && isSemanticModel(resolution.info.spec)) {
        return fail(command, 'MODEL_NOT_INSTALLED', resolution.warning, input.jsonMode)
      }
      try {
        const result = await reindexVault(vault, resolution.embedder, {
          onProgress: ({ done, total }) => {
            if (resolution.embedder) progress(`Reindexing memories: ${done}/${total}\n`)
          }
        })
        return ok(
          command,
          result,
          `Reindexed ${result.reindexed} memories with ${result.model}.`,
          input.jsonMode
        )
      } finally {
        await resolution.embedder?.dispose()
      }
    }

    return fail(
      command,
      'UNKNOWN_SUBCOMMAND',
      `Unknown subcommand "model ${subcommand}".`,
      input.jsonMode,
      'Usage: memoseb model <list|status|enable [id] [--yes]|disable [--purge]|reindex|reranker <list|enable [id] [--yes]|disable [--purge]>>'
    )
  } finally {
    vault.close()
  }
}

async function disable(
  vault: MemoryVault,
  command: string,
  input: ModelCommandInput,
  purge: boolean
): Promise<ModelCommandResult> {
  vault.setConfiguredEmbedderId(LEXICAL_MODEL_ID)
  const reindexed = vault.reindexLexicalVectors({ includeSemantic: true })
  let freedBytes = 0
  let purgeNote = ' Downloaded models are kept; use --purge to delete them.'
  if (purge) {
    const paths = vault.mlPaths
    try {
      const result = purgeMlDir(paths)
      freedBytes = result.freedBytes
      purgeNote = result.skipped
        ? ` Nothing purged: ${paths.root} was not created by memoseb (missing marker file).`
        : ` Removed ML runtime and models (${mb(freedBytes)} freed).`
    } catch (err) {
      // Typically EBUSY on Windows while an MCP server still has the model loaded.
      purgeNote = ` Could not delete ${paths.root}: ${err instanceof Error ? err.message : String(err)}. Stop running memoseb processes and retry.`
    }
  }
  const data = { enabled: false, model: LEXICAL_MODEL_ID, reindexed, purged: purge && freedBytes > 0, freedBytes }
  return ok(
    command,
    data,
    `Semantic search DISABLED: using the built-in lexical hash. Reindexed ${reindexed} memories.${purgeNote}${envOverrideNote(vault)}`,
    input.jsonMode
  )
}

function rerankerStatus(
  vault: MemoryVault,
  backend: MlBackend
): { active: string | null; source: string; inUse: boolean; warning: string | null } {
  const resolution = resolveActiveReranker(vault, backend)
  // Only checks the install state; the reranker is never loaded here.
  return {
    active: resolution.info.spec?.id ?? null,
    source: resolution.info.source,
    inUse: resolution.reranker !== null,
    warning: resolution.warning ?? null
  }
}

interface RerankerEntryView {
  id: string
  label: string
  hfModel: string
  diskMb: number
  ramMb: number
  languages: string
  license: string
  note: string
  active: boolean
  recommended: boolean
  downloaded: boolean
}

function rerankerCatalogView(vault: MemoryVault, backend: MlBackend): RerankerEntryView[] {
  const activeId = vault.getActiveReranker().spec?.id
  const paths = vault.mlPaths
  return RERANKER_CATALOG.map((spec) => ({
    id: spec.id,
    label: spec.label,
    hfModel: spec.hfModel,
    diskMb: spec.diskMb,
    ramMb: spec.ramMb,
    languages: spec.languages,
    license: spec.license,
    note: spec.note,
    active: spec.id === activeId,
    recommended: spec.id === RECOMMENDED_RERANKER_ID,
    downloaded: backend.isRuntimeInstalled(paths) && backend.isModelDownloaded(paths, spec)
  }))
}

function formatRerankerCatalog(entries: RerankerEntryView[]): string {
  const rows = entries.map((e, i) => {
    const marker = e.active ? '*' : ' '
    const state = e.active ? 'active' : e.downloaded ? 'downloaded' : 'not downloaded'
    const star = e.recommended ? ' (recommended)' : ''
    return `${marker} ${String(i + 1).padStart(2)}. ${e.id.padEnd(19)} ~${String(e.diskMb).padEnd(4)} MB  RAM ~${String(e.ramMb).padEnd(5)} MB  ${e.languages.padEnd(25)} ${e.license.padEnd(11)} ${state}${star}\n        ${e.note}`
  })
  return [
    'Rerankers rescore the top results with a cross-encoder (better order, ~0.5 s per query on CPU):',
    ...rows,
    '',
    'Enable one with: memoseb model reranker enable <id>   ·   turn it off: memoseb model reranker disable'
  ].join('\n')
}

interface RerankerIo {
  backend: MlBackend
  progress: (text: string) => void
  interactive: boolean
  ask: (question: string) => Promise<string>
}

function downloadProgress(progress: (text: string) => void): (p: DownloadProgress) => void {
  let lastPct = -1
  return ({ file, loaded, total }) => {
    if (total <= 0 || !file.endsWith('.onnx')) return
    const pct = Math.floor((loaded / total) * 100)
    if (pct >= lastPct + 10 || (pct === 100 && lastPct !== 100)) {
      lastPct = pct
      progress(`Downloading ${file}: ${pct}% (${mb(loaded)}/${mb(total)})\n`)
    }
  }
}

/** Deletes one reranker's weights, only if memoseb downloaded them (ready marker present). */
function purgeRerankerWeights(paths: MlPaths, spec: RerankerModelSpec): number {
  const dir = modelCacheDir(paths, spec)
  if (!dir || !fs.existsSync(path.join(dir, MODEL_READY_MARKER))) return 0
  // A symlinked <org> or <model> segment must not redirect the delete outside modelsDir.
  const realModels = fs.realpathSync(paths.modelsDir)
  if (!fs.realpathSync(dir).startsWith(realModels + path.sep)) return 0
  const bytes = directorySizeBytes(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return bytes
}

async function runRerankerCommand(
  vault: MemoryVault,
  input: ModelCommandInput,
  io: RerankerIo
): Promise<ModelCommandResult> {
  const action = input.modelArg ?? 'list'
  const command = `model reranker ${action}`
  const { backend, progress } = io

  if (action === 'list' || action === 'status') {
    const entries = rerankerCatalogView(vault, backend)
    const status = rerankerStatus(vault, backend)
    const text = `${formatRerankerCatalog(entries)}${status.warning ? `\nWarning: ${status.warning}` : ''}`
    return ok(command, { rerankers: entries, ...status }, text, input.jsonMode)
  }

  if (action === 'disable' || action === 'off') {
    const previous = vault.getActiveReranker().spec
    vault.setConfiguredRerankerId(null)
    let freedBytes = 0
    let note = ''
    if (input.purge) {
      for (const spec of RERANKER_CATALOG) {
        try {
          freedBytes += purgeRerankerWeights(vault.mlPaths, spec)
        } catch (err) {
          note += ` Could not delete ${spec.id}: ${err instanceof Error ? err.message : String(err)}.`
        }
      }
      note = ` Removed reranker weights (${mb(freedBytes)} freed).${note}`
    }
    const envNote =
      vault.getActiveReranker().source === 'env'
        ? `\nNote: MEMOSEB_RERANKER overrides this setting in the current environment.`
        : ''
    return ok(
      command,
      { enabled: false, previous: previous?.id ?? null, freedBytes },
      `Reranker DISABLED.${note}${envNote}`,
      input.jsonMode
    )
  }

  if (action !== 'enable' && action !== 'use') {
    return fail(
      command,
      'UNKNOWN_SUBCOMMAND',
      `Unknown subcommand "model reranker ${action}".`,
      input.jsonMode,
      'Usage: memoseb model reranker <list|enable [id] [--yes]|disable [--purge]>'
    )
  }

  const spec = findRerankerSpec(input.rerankerArg ?? RECOMMENDED_RERANKER_ID)
  if (!spec) {
    return fail(
      command,
      'UNKNOWN_RERANKER',
      `Unknown reranker "${input.rerankerArg ?? ''}".`,
      input.jsonMode,
      `Available: ${RERANKER_CATALOG.map((m) => m.id).join(', ')} (see "memoseb model reranker list")`
    )
  }

  const paths = vault.mlPaths
  const needRuntime = !backend.isRuntimeInstalled(paths)
  const needWeights = needRuntime || !backend.isModelDownloaded(paths, spec)
  if (needWeights) {
    const downloadMb = (needRuntime ? RUNTIME_DISK_MB : 0) + spec.diskMb
    const plan = [
      `Enabling reranker "${spec.id}" (${spec.license}) needs ~${downloadMb} MB of disk in ${paths.root}:`,
      ...(needRuntime ? [`  - ML runtime (transformers.js + ONNX for ${process.platform}-${process.arch}): ~${RUNTIME_DISK_MB} MB`] : []),
      `  - Reranker weights: ~${spec.diskMb} MB`,
      `While loaded it uses ~${spec.ramMb} MB of RAM and adds ~0.5 s per search. After the download no network is used.`
    ].join('\n')
    if (!input.yes) {
      if (!io.interactive || input.jsonMode) {
        return fail(command, 'CONFIRMATION_REQUIRED', plan, input.jsonMode, 'Re-run with --yes to confirm.')
      }
      const answer = (await io.ask(`${plan}\nContinue? [y/N] `)).trim().toLowerCase()
      if (!['y', 'yes', 's', 'si', 'sí'].includes(answer)) {
        return ok(command, { enabled: false, cancelled: true }, 'Cancelled. Nothing was downloaded.', input.jsonMode)
      }
    }
  }

  if (needRuntime) {
    progress('Installing ML runtime (npm)...\n')
    const installed = await backend.installRuntime(paths)
    if (!installed.installed) {
      return fail(
        command,
        'RUNTIME_INSTALL_FAILED',
        `Could not install the ML runtime:\n${installed.log.trim().split('\n').slice(-15).join('\n')}`,
        input.jsonMode
      )
    }
    progress(`ML runtime installed (${mb(installed.sizeBytes)}, pruned ${mb(installed.prunedBytes)} of unused binaries).\n`)
  }

  const reranker = backend.createReranker(spec, paths, {
    allowRemote: true,
    onProgress: downloadProgress(progress)
  })
  try {
    const started = performance.now()
    progress(`Loading ${spec.hfModel}...\n`)
    const [relevant, unrelated] = await reranker.score('how are memories synchronized between machines?', [
      'Memories sync between peer nodes over HTTP.',
      'A pizza recipe with basil.'
    ])
    if (!(Number.isFinite(relevant) && Number.isFinite(unrelated))) {
      throw new Error('Reranker returned non-numeric scores.')
    }
    const loadMs = Math.round(performance.now() - started)
    vault.setConfiguredRerankerId(spec.id)
    const envNote =
      vault.getActiveReranker().source === 'env'
        ? `\nNote: MEMOSEB_RERANKER overrides this setting in the current environment.`
        : ''
    return ok(
      command,
      { enabled: true, reranker: spec.id, loadMs, mlDir: paths.root },
      `Reranker ENABLED: ${spec.id}. Ready in ${loadMs} ms.${envNote}`,
      input.jsonMode
    )
  } catch (err) {
    return fail(
      command,
      'MODEL_LOAD_FAILED',
      `Could not load reranker "${spec.id}": ${err instanceof Error ? err.message : String(err)}`,
      input.jsonMode,
      'The previous reranker setting is unchanged.'
    )
  } finally {
    await reranker.dispose()
  }
}
