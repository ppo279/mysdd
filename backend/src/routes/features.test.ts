// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
// routes/features.ts switch-workflow 单元测试
//
// 用 in-memory sqlite + 完整 schema 装配覆盖以下路径：
//  - approved node 未出现在 mapping → 400 WORKFLOW_INVALID
//  - mapping 引用不在新 workflow 的 newNodeId → 400 WORKFLOW_INVALID
//  - 当前 workflow 即目标 → 400 WORKFLOW_INVALID
//  - happy：重映射 feature_node_states，写 feature_node_migrations，
//    更新 feature.current_workflow_id / current_node_id

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'

// mock config/agents: workflow validateWorkflow → getAgentConfig
const { mockAgentIds } = vi.hoisted(() => ({ mockAgentIds: new Set<string>() }))
vi.mock('../config/agents.js', () => ({
  getAgentConfig: (id: string) => {
    if (!mockAgentIds.has(id)) throw new Error(`mock: agent ${id} not registered`)
    return { id, name: id, runtime: 'claude', instruction: '', outputFile: `${id}.md`, inputs: ['default'], outputs: ['default'] }
  },
}))

vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(`
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '', tech_stack TEXT NOT NULL DEFAULT 'ts',
    background TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '',
    default_workflow_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE features (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    current_stage TEXT NOT NULL DEFAULT 'spec',
    current_workflow_id TEXT,
    current_node_id TEXT NOT NULL DEFAULT 'spec',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE stage_runs (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL REFERENCES features(id),
    stage TEXT NOT NULL, node_id TEXT, runtime_id TEXT NOT NULL DEFAULT 'claude',
    cli_session_id TEXT, status TEXT NOT NULL DEFAULT 'active',
    artifact_content TEXT NOT NULL DEFAULT '',
    artifact_path TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, approved_at INTEGER
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflow_nodes (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    position_x REAL NOT NULL DEFAULT 0, position_y REAL NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    display_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(workflow_id, node_id)
  );
  CREATE TABLE workflow_edges (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL, from_output TEXT NOT NULL DEFAULT 'default',
    to_node_id TEXT NOT NULL, to_input TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE feature_node_states (
    feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_stage_run_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, node_id)
  );
  CREATE TABLE stage_run_outputs (
    id TEXT PRIMARY KEY,
    stage_run_id TEXT NOT NULL REFERENCES stage_runs(id) ON DELETE CASCADE,
    output_name TEXT NOT NULL DEFAULT 'default',
    content TEXT NOT NULL DEFAULT '',
    approved_at INTEGER,
    UNIQUE(stage_run_id, output_name)
  );
  CREATE TABLE feature_node_migrations (
    id TEXT PRIMARY KEY,
    feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    from_workflow_id TEXT NOT NULL,
    to_workflow_id TEXT NOT NULL,
    mapping_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    applied_at INTEGER
  );
`)
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { featureRoutes } = await import('./features.js')
const { registerErrorHandler } = await import('../lib/envelope.js')

let app: ReturnType<typeof Fastify>

function rowsOf<T = any>(sql: string, ...params: any[]): T[] {
  const stmt = sqlite.prepare(sql)
  return (params.length ? stmt.all(...params) : stmt.all()) as T[]
}
function exec(sql: string, ...params: any[]) {
  if (params.length) sqlite.prepare(sql).run(...params)
  else sqlite.exec(sql)
}

function setupTwoWorkflows() {
  exec(
    `INSERT INTO workspaces (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`,
    'ws-1', 'ws-1', '/tmp/ws-1', Date.now(),
  )
  // 旧 workflow: a → b
  exec(
    `INSERT INTO workflows (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'wf-old', 'ws-1', 'old', Date.now(), Date.now(),
  )
  exec(
    `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, position_x, position_y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'wn-1', 'wf-old', 'a', 'spec', 0, 0, Date.now(),
  )
  exec(
    `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, position_x, position_y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'wn-2', 'wf-old', 'b', 'plan', 200, 0, Date.now(),
  )
  exec(
    `INSERT INTO workflow_edges (id, workflow_id, from_node_id, from_output, to_node_id, to_input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'we-1', 'wf-old', 'a', 'default', 'b', 'default', Date.now(),
  )
  // 新 workflow: x → y
  exec(
    `INSERT INTO workflows (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    'wf-new', 'ws-1', 'new', Date.now(), Date.now(),
  )
  exec(
    `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, position_x, position_y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'wn-3', 'wf-new', 'x', 'spec', 0, 0, Date.now(),
  )
  exec(
    `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, position_x, position_y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'wn-4', 'wf-new', 'y', 'plan', 200, 0, Date.now(),
  )
  exec(
    `INSERT INTO workflow_edges (id, workflow_id, from_node_id, from_output, to_node_id, to_input, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'we-2', 'wf-new', 'x', 'default', 'y', 'default', Date.now(),
  )
}

function insertFeature(id: string, opts: { currentWorkflowId: string; currentNodeId: string; status?: string }) {
  exec(
    `INSERT INTO features (id, workspace_id, name, current_stage, current_workflow_id, current_node_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id, 'ws-1', `feat-${id}`, opts.currentNodeId, opts.currentWorkflowId, opts.currentNodeId,
    opts.status ?? 'active', Date.now(),
  )
}

function setNodeState(featureId: string, nodeId: string, status: string, lastStageRunId: string | null = null) {
  exec(
    `INSERT OR REPLACE INTO feature_node_states (feature_id, node_id, status, last_stage_run_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    featureId, nodeId, status, lastStageRunId, Date.now(),
  )
}

beforeEach(async () => {
  sqlite.exec(`
    DELETE FROM feature_node_migrations;
    DELETE FROM stage_run_outputs;
    DELETE FROM messages;
    DELETE FROM stage_runs;
    DELETE FROM feature_node_states;
    DELETE FROM workflow_edges;
    DELETE FROM workflow_nodes;
    DELETE FROM workflows;
    DELETE FROM features;
    DELETE FROM workspaces;
  `)
  mockAgentIds.clear()
  ;['spec', 'plan', 'tasks', 'coding'].forEach((id) => mockAgentIds.add(id))

  app = Fastify({ logger: false })
  registerErrorHandler(app)
  await featureRoutes(app)
  await app.ready()
})

// ── 拒绝路径 ─────────────────────────────────────────────────
describe('POST /api/features/:featureId/switch-workflow — 拒绝路径', () => {
  it('approved node 没出现在 mapping → 400 WORKFLOW_INVALID', async () => {
    setupTwoWorkflows()
    insertFeature('f-1', { currentWorkflowId: 'wf-old', currentNodeId: 'a' })
    setNodeState('f-1', 'a', 'approved', 'sr-1')
    setNodeState('f-1', 'b', 'pending')

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/f-1/switch-workflow',
      payload: {
        toWorkflowId: 'wf-new',
        mapping: {
          // b 被映射；a（已 approved）缺失
          b: { newNodeId: 'y' },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    const env = res.json()
    expect(env.code).toBe(1011) // WORKFLOW_INVALID
    expect(env.msg).toMatch(/approved node "a"/i)
  })

  it('mapping 中的 newNodeId 不在新 workflow → 400 WORKFLOW_INVALID', async () => {
    setupTwoWorkflows()
    insertFeature('f-1', { currentWorkflowId: 'wf-old', currentNodeId: 'a' })
    setNodeState('f-1', 'a', 'approved', 'sr-1')

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/f-1/switch-workflow',
      payload: {
        toWorkflowId: 'wf-new',
        mapping: {
          a: { newNodeId: 'ghost' },
        },
      },
    })
    expect(res.statusCode).toBe(400)
    const env = res.json()
    expect(env.code).toBe(1011)
    expect(env.msg).toMatch(/unknown newNodeId/i)
  })

  it('目标 = 当前 workflow → 400 WORKFLOW_INVALID', async () => {
    setupTwoWorkflows()
    insertFeature('f-1', { currentWorkflowId: 'wf-old', currentNodeId: 'a' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/f-1/switch-workflow',
      payload: {
        toWorkflowId: 'wf-old',
        mapping: {},
      },
    })
    expect(res.statusCode).toBe(400)
    const env = res.json()
    expect(env.code).toBe(1011)
    expect(env.msg).toMatch(/same as the current/i)
  })
})

// ── Happy path ───────────────────────────────────────────────
describe('POST /api/features/:featureId/switch-workflow — happy', () => {
  it('重映射 feature_node_states + 写 feature_node_migrations + 更新 feature', async () => {
    setupTwoWorkflows()
    insertFeature('f-1', { currentWorkflowId: 'wf-old', currentNodeId: 'a' })
    setNodeState('f-1', 'a', 'approved', 'sr-1')

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/f-1/switch-workflow',
      payload: {
        toWorkflowId: 'wf-new',
        mapping: {
          a: { newNodeId: 'x' },
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    expect(env.code).toBe(0)
    expect(env.data.currentWorkflowId).toBe('wf-new')
    // a → x，旧 current 节点被映射到 x，所以新 current 是 x
    expect(env.data.currentNodeId).toBe('x')

    // feature_node_migrations 一行
    const migrations = rowsOf<{ from_workflow_id: string; to_workflow_id: string; mapping_json: string; applied_at: number | null }>(
      `SELECT * FROM feature_node_migrations WHERE feature_id = ?`,
      'f-1',
    )
    expect(migrations).toHaveLength(1)
    expect(migrations[0].from_workflow_id).toBe('wf-old')
    expect(migrations[0].to_workflow_id).toBe('wf-new')
    expect(migrations[0].applied_at).toBeTruthy()
    expect(JSON.parse(migrations[0].mapping_json)).toEqual({ a: { newNodeId: 'x' } })

    // feature_node_states：旧 'a' → 新 'x'，状态保持 approved
    const states = rowsOf<{ node_id: string; status: string; last_stage_run_id: string | null }>(
      `SELECT * FROM feature_node_states WHERE feature_id = ?`,
      'f-1',
    )
    expect(states).toHaveLength(1)
    expect(states[0].node_id).toBe('x')
    expect(states[0].status).toBe('approved')
    expect(states[0].last_stage_run_id).toBe('sr-1')

    // features 行已更新
    const feat = rowsOf<{ current_workflow_id: string; current_node_id: string; current_stage: string }>(
      `SELECT current_workflow_id, current_node_id, current_stage FROM features WHERE id = ?`,
      'f-1',
    )[0]
    expect(feat.current_workflow_id).toBe('wf-new')
    expect(feat.current_node_id).toBe('x')
    expect(feat.current_stage).toBe('spec') // x 的 agentId
  })

  it('旧 current_node_id 不在 mapping → 落到新 workflow 的首个节点', async () => {
    setupTwoWorkflows()
    insertFeature('f-1', { currentWorkflowId: 'wf-old', currentNodeId: 'a' })
    setNodeState('f-1', 'a', 'pending') // 没 approved，mapping 可空

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/f-1/switch-workflow',
      payload: {
        toWorkflowId: 'wf-new',
        mapping: {},
      },
    })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    // 新 workflow toposort 第一个节点是 x
    expect(env.data.currentNodeId).toBe('x')
  })
})
