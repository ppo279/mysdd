// Implements: docs/adr/0001-workflow-execution-model.md
// workflow-bootstrap.ts 单元测试：用 in-memory sqlite + mock config/agents 验证
// createInitialWorkflow(workspaceId) 正确生成 N 节点 + (N-1) 串联边，并把 workflow id 写回 workspace。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'

// ── mock: config/agents ──
// mockAgents 是本次测试使用的"agents 表视图"；每次测试自己填充
const { mockAgents } = vi.hoisted(() => ({ mockAgents: [] as Array<{ id: string; name: string }> }))
vi.mock('../config/agents.js', () => ({
  loadAgentsConfig: () => ({
    runtimes: [],
    global: { base_layers: [] },
    agents: mockAgents,
  }),
  getAgentConfig: (id: string) => {
    const a = mockAgents.find((x) => x.id === id)
    if (!a) throw new Error(`mock: agent ${id} not found`)
    return { ...a, runtime: 'claude', instruction: '', outputFile: `${id}.md`, inputs: ['default'], outputs: ['default'] }
  },
  clearCache: () => {},
}))

// ── mock: db ──
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
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    inputs_json TEXT NOT NULL DEFAULT '[]',
    rejection_edges_json TEXT NOT NULL DEFAULT '[]',
    settings_json TEXT NOT NULL DEFAULT '{}',
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
    created_at INTEGER NOT NULL,
    UNIQUE(workflow_id, from_node_id, from_output, to_node_id, to_input)
  );
  CREATE TABLE feature_node_states (
    feature_id TEXT NOT NULL REFERENCES features(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_stage_run_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (feature_id, node_id)
  );
`)
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { createInitialWorkflow, runAgentSweep } = await import('./workflow-bootstrap.js')

beforeEach(() => {
  mockAgents.length = 0
  sqlite.exec(`
    DELETE FROM feature_node_states;
    DELETE FROM features;
    DELETE FROM workflow_edges;
    DELETE FROM workflow_nodes;
    DELETE FROM workflows;
    DELETE FROM workspaces;
  `)
})

function insertWorkspace(id: string) {
  sqlite.prepare(`
    INSERT INTO workspaces (id, name, local_path, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/tmp/${id}`, Date.now())
}

function rowsOf<T = any>(sql: string): T[] {
  return sqlite.prepare(sql).all() as T[]
}

describe('createInitialWorkflow', () => {
  it('4 agents → 1 workflow + 4 nodes + 3 chained edges', async () => {
    mockAgents.push(
      { id: 'spec', name: 'Spec' },
      { id: 'plan', name: 'Plan' },
      { id: 'tasks', name: 'Tasks' },
      { id: 'coding', name: 'Coding' },
    )
    insertWorkspace('ws-1')

    const wfId = await createInitialWorkflow('ws-1')
    expect(wfId).toBeTruthy()

    expect(rowsOf('SELECT * FROM workflows').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_nodes').length).toBe(4)
    expect(rowsOf('SELECT * FROM workflow_edges').length).toBe(3)

    // 边顺序：spec→plan→tasks→coding
    const edges = rowsOf<{ from_node_id: string; to_node_id: string }>(
      'SELECT from_node_id, to_node_id FROM workflow_edges ORDER BY rowid',
    )
    expect(edges).toEqual([
      { from_node_id: 'spec', to_node_id: 'plan' },
      { from_node_id: 'plan', to_node_id: 'tasks' },
      { from_node_id: 'tasks', to_node_id: 'coding' },
    ])

    // workspaces.default_workflow_id 已写回
    const row = sqlite.prepare('SELECT default_workflow_id FROM workspaces WHERE id = ?').get('ws-1') as { default_workflow_id: string }
    expect(row.default_workflow_id).toBe(wfId)
  })

  it('1 agent → 1 workflow + 1 node + 0 edges（无串联）', async () => {
    mockAgents.push({ id: 'spec', name: 'Spec' })
    insertWorkspace('ws-1')

    const wfId = await createInitialWorkflow('ws-1')
    expect(rowsOf('SELECT * FROM workflows').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_nodes').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_edges').length).toBe(0)
    expect(wfId).toBeTruthy()
  })

  it('0 agents → 1 workflow + 0 nodes + 0 edges（不抛错）', async () => {
    insertWorkspace('ws-1')

    const wfId = await createInitialWorkflow('ws-1')
    expect(rowsOf('SELECT * FROM workflows').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_nodes').length).toBe(0)
    expect(rowsOf('SELECT * FROM workflow_edges').length).toBe(0)
    expect(wfId).toBeTruthy()
  })

  it('幂等：已有 default_workflow_id → 不重复创建', async () => {
    mockAgents.push({ id: 'spec', name: 'Spec' })
    insertWorkspace('ws-1')

    const first = await createInitialWorkflow('ws-1')
    const second = await createInitialWorkflow('ws-1')
    expect(first).toBe(second)
    expect(rowsOf('SELECT * FROM workflows').length).toBe(1)
  })
})

// ── runAgentSweep ──────────────────────────────────────────
// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
// YAML 删除 agent 后，sweep 把引用了已删 agent 的 workflow 归档、对应
// feature_node_states 标 rejected，feature 切到 paused。
describe('runAgentSweep', () => {
  function insertFeature(id: string, opts: { currentWorkflowId: string; status?: string }) {
    sqlite.prepare(
      `INSERT INTO features (id, workspace_id, name, current_stage, current_workflow_id, current_node_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, 'ws-1', `feat-${id}`, 'spec', opts.currentWorkflowId, 'spec', opts.status ?? 'active', Date.now())
  }
  function insertState(featureId: string, nodeId: string, status = 'approved') {
    sqlite.prepare(
      `INSERT INTO feature_node_states (feature_id, node_id, status, last_stage_run_id, updated_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(featureId, nodeId, status, Date.now())
  }

  it('workflow 引用已删 agent → workflow 归档 + 对应 feature_node_states rejected', async () => {
    mockAgents.push({ id: 'spec', name: 'Spec' })
    insertWorkspace('ws-1')
    const wfId = await createInitialWorkflow('ws-1')
    insertFeature('f-1', { currentWorkflowId: wfId })
    insertState('f-1', 'spec', 'approved')

    // 删掉 'spec' agent → 重跑 sweep
    mockAgents.length = 0
    const r = await runAgentSweep()
    expect(r.archivedWorkflows).toBe(1)
    expect(r.rejectedNodeStates).toBe(1)
    expect(r.missingAgentIds).toEqual(['spec'])

    const wf = rowsOf<{ is_archived: number }>(`SELECT is_archived FROM workflows`)
    const wfRow = wf.find((w) => w.is_archived === 1) as { is_archived: number } | undefined
    expect(wfRow).toBeDefined()

    const stRow = sqlite.prepare(
      `SELECT status FROM feature_node_states WHERE feature_id = ? AND node_id = ?`,
    ).get('f-1', 'spec') as { status: string }
    expect(stRow.status).toBe('rejected')

    const featRow = sqlite.prepare(`SELECT status FROM features WHERE id = ?`).get('f-1') as { status: string }
    expect(featRow.status).toBe('paused')
  })

  it('所有 agent 都还在 → sweep 不动数据', async () => {
    mockAgents.push({ id: 'spec', name: 'Spec' }, { id: 'plan', name: 'Plan' })
    insertWorkspace('ws-1')
    await createInitialWorkflow('ws-1')

    const r = await runAgentSweep()
    expect(r.archivedWorkflows).toBe(0)
    expect(r.rejectedNodeStates).toBe(0)
    expect(r.missingAgentIds).toEqual([])

    const wfRow = sqlite.prepare(`SELECT is_archived FROM workflows`).all() as Array<{ is_archived: number }>
    expect(wfRow.every((w) => w.is_archived === 0)).toBe(true)
  })

  it('已 rejected 的状态行不再被重复更新', async () => {
    mockAgents.push({ id: 'spec', name: 'Spec' })
    insertWorkspace('ws-1')
    const wfId = await createInitialWorkflow('ws-1')
    insertFeature('f-1', { currentWorkflowId: wfId })
    insertState('f-1', 'spec', 'rejected') // 已经 rejected
    mockAgents.length = 0

    const r = await runAgentSweep()
    expect(r.archivedWorkflows).toBe(1)
    // rejectedNodeStates 应为 0（不再更新已 rejected 的）
    expect(r.rejectedNodeStates).toBe(0)
  })
})
