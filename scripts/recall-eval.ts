// Prints recall@3 / MRR / noise for the bundled evaluation fixture.
// Usage: node scripts/recall-eval.ts [label]
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-eval-'))
const vault = new MemoryVault({ dbPath: path.join(dir, 'vault.sqlite') })
try {
  const ids = seedEvalVault(vault)
  const report = await runRecallEval(ids, (query) =>
    vault.recallMemories(query, evalRecallOptions())
  )
  console.log(formatEvalReport(process.argv[2] ?? 'current', report))
} finally {
  vault.close()
  fs.rmSync(dir, { recursive: true, force: true })
}
