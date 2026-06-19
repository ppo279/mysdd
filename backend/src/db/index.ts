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
// Implements: docs/adr/0001-workflow-execution-model.md
// Phase 0: 引入工作流 + 节点状态表 + 边 + 产物表。strict MG1：
// 老 DB 不会自动迁移到新 schema，调用方需要在启动前 `rm data/sdd.db data/sdd.db-*`。

// 导出供测试复用：initDb() 实际执行的 CREATE TABLE 串
export const SCHEMA_SQL = `
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
      intent TEXT NOT NULL DEFAULT 'new_feature',
      locked_files TEXT,
      looks_like TEXT,
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

    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      is_archived INTEGER NOT NULL DEFAULT 0,
      inputs_json TEXT NOT NULL DEFAULT '[]',
      rejection_edges_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflows_workspace ON workflows(workspace_id);

    CREATE TABLE IF NOT EXISTS workflow_nodes (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      position_x REAL NOT NULL DEFAULT 0,
      position_y REAL NOT NULL DEFAULT 0,
      config_json TEXT NOT NULL DEFAULT '{}',
      display_name TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      UNIQUE(workflow_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_nodes_workflow ON workflow_nodes(workflow_id);

    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      from_node_id TEXT NOT NULL,
      from_output TEXT NOT NULL DEFAULT 'default',
      to_node_id TEXT NOT NULL,
      to_input TEXT NOT NULL DEFAULT 'default',
      created_at INTEGER NOT NULL,
      UNIQUE(workflow_id, from_node_id, from_output, to_node_id, to_input)
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_edges_workflow ON workflow_edges(workflow_id);

    CREATE TABLE IF NOT EXISTS feature_node_states (
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      last_stage_run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (feature_id, node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_fns_feature ON feature_node_states(feature_id);

    CREATE TABLE IF NOT EXISTS stage_run_outputs (
      id TEXT PRIMARY KEY,
      stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
      output_name TEXT NOT NULL DEFAULT 'default',
      content TEXT NOT NULL DEFAULT '',
      approved_at INTEGER,
      UNIQUE(stage_run_id, output_name)
    );
    CREATE INDEX IF NOT EXISTS idx_sro_run ON stage_run_outputs(stage_run_id);

    CREATE TABLE IF NOT EXISTS feature_node_migrations (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
      from_workflow_id TEXT NOT NULL,
      to_workflow_id TEXT NOT NULL,
      mapping_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      applied_at INTEGER
    );
  `

export function initDb() {
  // Order matters: all CREATE TABLEs run first, then ALTER TABLEs that add
  // nullable/FK columns referencing tables that didn't exist on first init.
  sqlite.exec(SCHEMA_SQL)

  // Idempotent column adds for older DBs. Each ALTER is wrapped in try/catch
  // because the column may already exist (caught) or the table is new (succeeds).
  try { sqlite.exec(`ALTER TABLE workspaces ADD COLUMN local_path TEXT NOT NULL DEFAULT ''`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE workspaces ADD COLUMN default_workflow_id TEXT REFERENCES workflows(id)`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE features ADD COLUMN current_workflow_id TEXT REFERENCES workflows(id)`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE features ADD COLUMN current_node_id TEXT NOT NULL DEFAULT 'spec'`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE features ADD COLUMN intent TEXT NOT NULL DEFAULT 'new_feature'`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE features ADD COLUMN locked_files TEXT`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE features ADD COLUMN looks_like TEXT`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE stage_runs ADD COLUMN node_id TEXT`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE workflows ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
  try { sqlite.exec(`ALTER TABLE workflows ADD COLUMN rejection_edges_json TEXT NOT NULL DEFAULT '[]'`) } catch { /* already exists */ }
}
