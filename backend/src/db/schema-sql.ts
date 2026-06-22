// Implements: docs/adr/0001-workflow-execution-model.md
// 集中导出 CREATE TABLE 串；与 db/index.ts 共享；测试通过 mock db/index.js 也能 import。

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
      approved_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      parent_stage_run_id TEXT,
      rejection_reason TEXT
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
      settings_json TEXT NOT NULL DEFAULT '{}',
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

    -- Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md, .scratch/agent-contract-db/issues/05-yaml-cleanup.md
    -- （历史）slice 02 把 agents.yaml 的 runtimes / global.base_layers / agents 三段搬到 DB；
    -- slice 05 删除启动期 yaml 读取路径，DB 是唯一真相之源（agent-seed.ts 仅保留 test seam）。
    -- 写入路径只有 PUT /api/config/agents（或手工 INSERT）。
    CREATE TABLE IF NOT EXISTS base_layers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      content     TEXT NOT NULL,
      position    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      UNIQUE(position)
    );

    CREATE TABLE IF NOT EXISTS runtimes (
      id        TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      command   TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      runtime_id      TEXT NOT NULL REFERENCES runtimes(id) ON DELETE RESTRICT,
      instruction     TEXT NOT NULL,
      inputs_json     TEXT NOT NULL DEFAULT '["default"]',
      outputs_json    TEXT NOT NULL DEFAULT '["default"]',
      memory_sediment INTEGER NOT NULL DEFAULT 0,
      config_json     TEXT NOT NULL DEFAULT '{}',
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_runtime ON agents(runtime_id);
  `

// 与 initDb() 末尾的 ALTER 列表保持一致；测试运行时手动应用以模拟 production 启动路径。
export const IDEMPOTENT_ALTERS: string[] = [
  `ALTER TABLE workspaces ADD COLUMN local_path TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE workspaces ADD COLUMN default_workflow_id TEXT REFERENCES workflows(id)`,
  `ALTER TABLE features ADD COLUMN current_workflow_id TEXT REFERENCES workflows(id)`,
  `ALTER TABLE features ADD COLUMN current_node_id TEXT NOT NULL DEFAULT 'spec'`,
  `ALTER TABLE features ADD COLUMN intent TEXT NOT NULL DEFAULT 'new_feature'`,
  `ALTER TABLE features ADD COLUMN locked_files TEXT`,
  `ALTER TABLE features ADD COLUMN looks_like TEXT`,
  `ALTER TABLE stage_runs ADD COLUMN node_id TEXT`,
  `ALTER TABLE stage_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE stage_runs ADD COLUMN parent_stage_run_id TEXT`,
  `ALTER TABLE stage_runs ADD COLUMN rejection_reason TEXT`,
  `ALTER TABLE stage_runs ADD COLUMN instruction_snapshot TEXT`,
  `ALTER TABLE workflows ADD COLUMN inputs_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE workflows ADD COLUMN rejection_edges_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE workflows ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'`,
]
