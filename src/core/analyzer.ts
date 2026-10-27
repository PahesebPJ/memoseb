import fs from 'node:fs'
import path from 'node:path'
import { estimateTokens } from './embedder.ts'
import { type DetectedProject, detectProject, slugifyProjectId } from './project-detector.ts'
import type { MemoryCategory } from './schema.ts'
import type { MemoryVault, StoreMemoryResult } from './vault.ts'

export interface SynthesizedMemoryDraft {
  category: MemoryCategory
  title: string
  content: string
  tags: string[]
  importance: number
}

export interface AnalyzeProjectOptions {
  targetDir?: string
  projectId?: string
  sourceAgent?: string
  dryRun?: boolean
}

export interface ProjectAnalysisReport {
  project: DetectedProject
  drafts: SynthesizedMemoryDraft[]
  stored: StoreMemoryResult[]
  dryRun: boolean
  totalTokens: number
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.worktrees',
  'coverage',
  'target',
  '.next',
  '.turbo',
  'build',
])

interface PackageJsonData {
  name?: string
  version?: string
  description?: string
  type?: string
  main?: string
  bin?: string | Record<string, string>
  exports?: unknown
  engines?: Record<string, string>
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  keywords?: string[]
}

function readJsonSafe<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

function listSubdirsSafe(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return []
  }
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !IGNORED_DIRS.has(entry.name),
      )
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function listFilesSafe(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) {
    return []
  }
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

function buildArchitectureDraft(
  project: DetectedProject,
  pkg: PackageJsonData | null,
): SynthesizedMemoryDraft {
  const rootPath = project.rootPath
  const manifests: string[] = []
  const stackTags = new Set<string>()

  const manifestCandidates: Array<[string, string[]]> = [
    ['package.json', ['nodejs', 'javascript']],
    ['tsconfig.json', ['typescript']],
    ['Cargo.toml', ['rust', 'cargo']],
    ['pyproject.toml', ['python']],
    ['go.mod', ['go', 'golang']],
    ['Dockerfile', ['docker']],
  ]

  for (const [file, tags] of manifestCandidates) {
    if (fs.existsSync(path.join(rootPath, file))) {
      manifests.push(file)
      for (const t of tags) stackTags.add(t)
    }
  }

  const parts: string[] = []
  parts.push(`Proyecto: ${project.name} (${project.id}).`)

  if (manifests.length > 0) {
    parts.push(`Manifiestos detectados: ${manifests.join(', ')}.`)
  }

  if (pkg) {
    const runtimeDetails: string[] = []
    if (pkg.type) {
      runtimeDetails.push(`module=${pkg.type}`)
      if (pkg.type === 'module') stackTags.add('esm')
    }
    if (pkg.engines?.node) {
      runtimeDetails.push(`node=${pkg.engines.node}`)
    }
    if (runtimeDetails.length > 0) {
      parts.push(`Runtime: ${runtimeDetails.join(', ')}.`)
    }

    const entrypoints: string[] = []
    if (typeof pkg.bin === 'string') {
      entrypoints.push(`bin=${pkg.bin}`)
      stackTags.add('cli')
    } else if (pkg.bin && typeof pkg.bin === 'object') {
      const bins = Object.entries(pkg.bin)
        .map(([k, v]) => `${k}->${v}`)
        .join(', ')
      if (bins) {
        entrypoints.push(`bin(${bins})`)
        stackTags.add('cli')
      }
    }
    if (pkg.main) {
      entrypoints.push(`main=${pkg.main}`)
    }
    if (pkg.exports) {
      if (typeof pkg.exports === 'string') {
        entrypoints.push(`exports=${pkg.exports}`)
      } else if (typeof pkg.exports === 'object') {
        entrypoints.push(`exports(${Object.keys(pkg.exports as Record<string, unknown>).join(', ')})`)
      }
    }
    if (entrypoints.length > 0) {
      parts.push(`Puntos de entrada: ${entrypoints.join('; ')}.`)
    }

    const deps = Object.keys(pkg.dependencies ?? {})
    const devDeps = Object.keys(pkg.devDependencies ?? {})
    if (deps.length > 0) {
      parts.push(`Dependencias principales: ${deps.slice(0, 12).join(', ')}.`)
      for (const d of deps.slice(0, 6)) {
        stackTags.add(slugifyProjectId(d))
      }
    }
    if (devDeps.length > 0) {
      parts.push(`DevDependencies clave: ${devDeps.slice(0, 10).join(', ')}.`)
    }
  }

  const topDirs = listSubdirsSafe(rootPath)
  const srcPath = path.join(rootPath, 'src')
  const srcDirs = listSubdirsSafe(srcPath)
  const srcFiles = listFilesSafe(srcPath)

  if (topDirs.length > 0) {
    parts.push(`Directorios raíz: ${topDirs.join(', ')}.`)
  }
  if (srcDirs.length > 0 || srcFiles.length > 0) {
    const srcItems = [...srcDirs.map((d) => `src/${d}/`), ...srcFiles.map((f) => `src/${f}`)]
    parts.push(`Topología src: ${srcItems.slice(0, 15).join(', ')}.`)
  }

  return {
    category: 'architecture',
    title: `Arquitectura y topología de ${project.name}`,
    content: parts.join(' '),
    tags: Array.from(new Set(['architecture', 'topology', ...stackTags])),
    importance: 0.9,
  }
}

function buildConventionDraft(
  project: DetectedProject,
  pkg: PackageJsonData | null,
): SynthesizedMemoryDraft {
  const rootPath = project.rootPath
  const parts: string[] = []

  if (pkg?.scripts && Object.keys(pkg.scripts).length > 0) {
    const scriptPairs = Object.entries(pkg.scripts)
      .slice(0, 10)
      .map(([k, v]) => `${k}: "${v}"`)
    parts.push(`Scripts npm: ${scriptPairs.join('; ')}.`)
  }

  const tsconfig = readJsonSafe<{
    compilerOptions?: {
      strict?: boolean
      target?: string
      module?: string
      moduleResolution?: string
    }
  }>(path.join(rootPath, 'tsconfig.json'))

  if (tsconfig?.compilerOptions) {
    const co = tsconfig.compilerOptions
    const flags: string[] = []
    if (co.strict !== undefined) flags.push(`strict=${String(co.strict)}`)
    if (co.target) flags.push(`target=${co.target}`)
    if (co.module) flags.push(`module=${co.module}`)
    if (co.moduleResolution) flags.push(`moduleResolution=${co.moduleResolution}`)
    if (flags.length > 0) {
      parts.push(`TypeScript config: ${flags.join(', ')}.`)
    }
  }

  const linters: string[] = []
  for (const linterFile of [
    'biome.json',
    'biome.jsonc',
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    'eslint.config.js',
    'eslint.config.mjs',
  ]) {
    if (fs.existsSync(path.join(rootPath, linterFile))) {
      linters.push(linterFile)
    }
  }
  if (linters.length > 0) {
    parts.push(`Linters/formatters: ${linters.join(', ')}.`)
  }

  const workflowsDir = path.join(rootPath, '.github', 'workflows')
  const workflowFiles = listFilesSafe(workflowsDir).filter(
    (f) => f.endsWith('.yml') || f.endsWith('.yaml'),
  )
  if (workflowFiles.length > 0) {
    const wfSummaries: string[] = []
    for (const wf of workflowFiles.slice(0, 5)) {
      try {
        const raw = fs.readFileSync(path.join(workflowsDir, wf), 'utf8')
        const nameMatch = raw.match(/^name:\s*(.+)$/m)
        const wfName = nameMatch?.[1]?.trim()
        wfSummaries.push(wfName ? `${wf} (${wfName})` : wf)
      } catch {
        wfSummaries.push(wf)
      }
    }
    parts.push(`GitHub Workflows CI: ${wfSummaries.join(', ')}.`)
  }

  if (parts.length === 0) {
    parts.push(
      `Repositorio ${project.name}: usa las herramientas estándar del ecosistema en ${project.rootPath}.`,
    )
  }

  return {
    category: 'convention',
    title: `Convenciones, scripts y verificación de ${project.name}`,
    content: parts.join(' '),
    tags: ['convention', 'scripts', 'ci', 'verification'],
    importance: 0.85,
  }
}

function buildDomainDraft(
  project: DetectedProject,
  pkg: PackageJsonData | null,
): SynthesizedMemoryDraft {
  const rootPath = project.rootPath
  const parts: string[] = []
  const keywords = (pkg?.keywords ?? [])
    .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
    .map((k) => slugifyProjectId(k))

  if (pkg?.description && pkg.description.trim().length > 0) {
    parts.push(`Descripción: ${pkg.description.trim()}`)
  }

  const readmeCandidates = ['README.md', 'readme.md', 'Readme.md']
  let readmeRaw = ''
  for (const candidate of readmeCandidates) {
    const p = path.join(rootPath, candidate)
    if (fs.existsSync(p)) {
      try {
        readmeRaw = fs.readFileSync(p, 'utf8')
        break
      } catch {
        // Ignore unreadable README
      }
    }
  }

  if (readmeRaw.trim().length > 0) {
    const lines = readmeRaw.split(/\r?\n/)
    const headings: string[] = []
    const paragraphs: string[] = []
    let inCodeBlock = false
    let currentPara: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('```')) {
        inCodeBlock = !inCodeBlock
        continue
      }
      if (inCodeBlock) continue

      if (trimmed.startsWith('## ')) {
        headings.push(trimmed.slice(3).trim())
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join(' '))
          currentPara = []
        }
        continue
      }
      if (trimmed.startsWith('#')) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join(' '))
          currentPara = []
        }
        continue
      }
      if (trimmed.length === 0) {
        if (currentPara.length > 0) {
          paragraphs.push(currentPara.join(' '))
          currentPara = []
        }
        continue
      }
      if (!trimmed.startsWith('![') && !trimmed.startsWith('<') && !trimmed.startsWith('|')) {
        currentPara.push(trimmed)
      }
    }
    if (currentPara.length > 0) {
      paragraphs.push(currentPara.join(' '))
    }

    const summaryText = paragraphs.slice(0, 2).join(' ').slice(0, 480).trim()
    if (summaryText.length > 0) {
      parts.push(`Resumen README: ${summaryText}`)
    }
    if (headings.length > 0) {
      parts.push(`Secciones documentadas: ${headings.slice(0, 8).join(', ')}.`)
    }
  }

  if (parts.length === 0) {
    parts.push(`Dominio funcional del proyecto ${project.name} (${project.id}).`)
  }

  let content = parts.join(' ')
  if (content.length > 900) {
    content = `${content.slice(0, 897)}...`
  }

  return {
    category: 'domain',
    title: `Propósito funcional y dominio de ${project.name}`,
    content,
    tags: Array.from(new Set(['domain', 'overview', ...keywords])),
    importance: 0.8,
  }
}

export function analyzeProject(options?: AnalyzeProjectOptions): {
  project: DetectedProject
  drafts: SynthesizedMemoryDraft[]
} {
  const detected = detectProject(options?.targetDir)
  const project: DetectedProject =
    options?.projectId && options.projectId.trim().length > 0
      ? {
          id: slugifyProjectId(options.projectId),
          name: detected.name,
          rootPath: detected.rootPath,
        }
      : detected

  const pkg = readJsonSafe<PackageJsonData>(path.join(project.rootPath, 'package.json'))

  const drafts: SynthesizedMemoryDraft[] = [
    buildArchitectureDraft(project, pkg),
    buildConventionDraft(project, pkg),
    buildDomainDraft(project, pkg),
  ]

  return { project, drafts }
}

export function analyzeAndStoreProject(
  vault: MemoryVault,
  options?: AnalyzeProjectOptions,
): ProjectAnalysisReport {
  const { project, drafts } = analyzeProject(options)
  const dryRun = Boolean(options?.dryRun)

  if (dryRun) {
    const totalTokens = drafts.reduce(
      (sum, d) => sum + estimateTokens(`${d.title}\n${d.content}`),
      0,
    )
    return {
      project,
      drafts,
      stored: [],
      dryRun: true,
      totalTokens,
    }
  }

  const stored: StoreMemoryResult[] = []
  let totalTokens = 0
  const sourceAgent = options?.sourceAgent ?? 'memoseb-analyzer'

  for (const draft of drafts) {
    const res = vault.storeMemory({
      projectId: project.id,
      projectName: project.name,
      rootPath: project.rootPath,
      category: draft.category,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      importance: draft.importance,
      sourceAgent,
      cwd: project.rootPath,
    })
    stored.push(res)
    totalTokens += res.memory.tokenCount
  }

  return {
    project,
    drafts,
    stored,
    dryRun: false,
    totalTokens,
  }
}
