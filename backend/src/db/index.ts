import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.resolve(__dirname, '../../../data/sdd.db')

// Ensure the data directory exists before opening the database
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

// 建表（简单 migration）
export function initDb() {
  // Add columns that may not exist in older databases
  try { sqlite.exec(`ALTER TABLE workspaces ADD COLUMN local_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      repo_url TEXT NOT NULL DEFAULT '',
      tech_stack TEXT NOT NULL DEFAULT 'ts',
      background TEXT NOT NULL DEFAULT '',
      local_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS features (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      current_stage TEXT NOT NULL DEFAULT 'spec',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stage_runs (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id),
      stage TEXT NOT NULL,
      runtime_id TEXT NOT NULL DEFAULT 'claude',
      cli_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      artifact_content TEXT NOT NULL DEFAULT '',
      artifact_path TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      approved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `)
}
