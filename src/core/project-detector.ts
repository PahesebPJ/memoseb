import fs from 'node:fs'
import path from 'node:path'

export interface DetectedProject {
  id: string
  name: string
  rootPath: string
}

export function slugifyProjectId(raw: string): string {
  const withoutScope = raw.trim().replace(/^@[^/]+\//, '')
  const slug = withoutScope
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'default'
}

export function detectProject(cwd?: string): DetectedProject {
  const startDir = path.resolve(cwd ?? process.cwd())
  let current = startDir

  while (true) {
    const pkgPath = path.join(current, 'package.json')
    const gitPath = path.join(current, '.git')
    const hasPkg = fs.existsSync(pkgPath)
    const hasGit = fs.existsSync(gitPath)

    if (hasPkg || hasGit) {
      if (hasPkg) {
        try {
          const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
            name?: unknown
          }
          if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) {
            const rawName = parsed.name.trim()
            return {
              id: slugifyProjectId(rawName),
              name: rawName,
              rootPath: current
            }
          }
        } catch {
          // Fall back to directory basename when package.json cannot be parsed
        }
      }

      const base = path.basename(current) || 'default'
      return {
        id: slugifyProjectId(base),
        name: base,
        rootPath: current
      }
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  const fallbackBase = path.basename(startDir) || 'default'
  return {
    id: slugifyProjectId(fallbackBase),
    name: fallbackBase,
    rootPath: startDir
  }
}
