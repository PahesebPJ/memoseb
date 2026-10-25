import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type MemoryCategory =
  | 'architecture'
  | 'convention'
  | 'bugfix'
  | 'decision'
  | 'domain'

export const MEMORY_CATEGORIES: readonly MemoryCategory[] = [
  'architecture',
  'convention',
  'bugfix',
  'decision',
  'domain'
] as const

export function isMemoryCategory(value: string): value is MemoryCategory {
  return (MEMORY_CATEGORIES as readonly string[]).includes(value)
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source_agent TEXT,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL DEFAULT 1,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE (project_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(project_id, category);
CREATE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_id, content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  memory_id UNINDEXED,
  project_id UNINDEXED,
  title,
  content,
  tags
);

CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY,
  dimensions INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);
`

export function openVaultDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  }
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA_SQL)
  return db
}
