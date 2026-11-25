import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { findModelSpec } from '../src/core/model-catalog.ts'
import { modelSource, resolveMlPaths, type MlPaths } from '../src/core/transformers-embedder.ts'

const E5 = findModelSpec('e5-small')!

describe('Offline model source for pinned downloads', () => {
  let tmpDir: string
  let paths: MlPaths
  let root: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoseb-source-test-'))
    paths = resolveMlPaths('unused.sqlite', { MEMOSEB_ML_DIR: tmpDir })
    root = path.join(paths.modelsDir, ...E5.hfModel!.split('/'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const writeModel = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'config.json'), '{}')
    fs.writeFileSync(path.join(dir, 'tokenizer_config.json'), '{}')
  }

  it('downloads by repo id and pinned revision', () => {
    assert.deepEqual(modelSource(paths, E5, true), { model: E5.hfModel, revision: E5.revision })
  })

  it('keeps the repo id when nothing is on disk', () => {
    assert.deepEqual(modelSource(paths, E5, false), { model: E5.hfModel, revision: E5.revision })
  })

  it('loads the legacy flat layout and prefers the pinned revision directory', () => {
    writeModel(root)
    assert.deepEqual(modelSource(paths, E5, false), { model: root, revision: undefined })
    writeModel(path.join(root, E5.revision!))
    assert.deepEqual(modelSource(paths, E5, false), { model: path.join(root, E5.revision!), revision: undefined })
  })

  it('repairs a fresh pinned download whose config.json was cached outside the revision directory', () => {
    const revisionDir = path.join(root, E5.revision!)
    fs.mkdirSync(revisionDir, { recursive: true })
    fs.writeFileSync(path.join(root, 'config.json'), '{"model_type":"bert"}')
    fs.writeFileSync(path.join(revisionDir, 'tokenizer_config.json'), '{}')
    assert.deepEqual(modelSource(paths, E5, false), { model: revisionDir, revision: undefined })
    assert.equal(fs.readFileSync(path.join(revisionDir, 'config.json'), 'utf8'), '{"model_type":"bert"}')
  })
})
