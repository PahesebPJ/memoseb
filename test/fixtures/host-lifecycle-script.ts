import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findModelSpec } from '../../src/core/model-catalog.ts'
import { createModelHostBackend, ModelHostClient } from '../../src/core/model-host.ts'
import { defaultMlBackend } from '../../src/core/semantic.ts'

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-model-host.ts')
const host = new ModelHostClient({ entry })
const embedder = createModelHostBackend(defaultMlBackend, host).createEmbedder(findModelSpec('e5-small')!, {} as never)
const vector = await embedder.embedQuery('abc')
console.log('pid', vector[1])
