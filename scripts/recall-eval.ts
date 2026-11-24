// Prints recall@1/@3, MRR and noise (by query type and language) for the bundled fixture.
// Usage: node scripts/recall-eval.ts [label] [--aliases] [--quiet]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryVault } from '../src/core/vault.ts'
import {
  evalRecallOptions,
  formatEvalReport,
  runRecallEval,
  seedEvalVault
} from '../test/fixtures/recall-eval.ts'

const args = process.argv.slice(2)
const withAliases = args.includes('--aliases')
const label = args.find((arg) => !arg.startsWith('--')) ?? 'lexical hash'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-eval-'))
const vault = new MemoryVault({ dbPath: path.join(dir, 'vault.sqlite') })
try {
  const ids = seedEvalVault(vault, { withAliases })
  const report = await runRecallEval(ids, (query) =>
    vault.recallMemories(query, evalRecallOptions())
  )
  console.log(
    formatEvalReport(`${label}${withAliases ? ' + aliases' : ''}`, report, {
      misses: !args.includes('--quiet')
    })
  )
} finally {
  vault.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
