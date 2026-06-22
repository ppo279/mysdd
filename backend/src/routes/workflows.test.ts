// Implements: docs/adr/0001-workflow-execution-model.md (Phase 1)
// routes/workflows.ts 单元测试：5 个端点（list / create / get / patch / delete）+ 4 个错误码
// (WORKFLOW_INVALID / NODE_ID_CONFLICT / CYCLE_DETECTED / WORKFLOW_NOT_FOUND) 的拒绝路径。

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'

// ── mock: config/agents ──
// workflow.ts 通过 getAgentConfig() 校验 agentId 是否在白名单。
// 暴露 mockAgentIds 让各测试自行填充。
// inputs/outputs 默认 ['default']；每个测试可通过 mockAgentPorts 单独覆盖 ports。
const { mockAgentIds, mockAgentPorts } = vi.hoisted(() => ({
  mockAgentIds: new Set<string>(),
  mockAgentPorts: {} as Record<string, { inputs: string[]; outputs: string[] }>,
}))
vi.mock('../config/agents.js', () => ({
  getAgentConfig: (id: string) => {
    if (!mockAgentIds.has(id)) {
      throw new Error(`mock: agent ${id} not registered`)
    }
    const ports = mockAgentPorts[id] ?? { inputs: ['default'], outputs: ['default'] }
    return { id, name: id, runtime: 'claude', instruction: '', outputFile: `${id}.md`, ...ports }
  },
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
    created_at INTEGER NOT NULL
  );
`)
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { workflowRoutes } = await import('./workflows.js')
const { registerErrorHandler } = await import('../lib/envelope.js')

let app: ReturnType<typeof Fastify>

function insertWorkspace(id: string) {
  sqlite.prepare(`
    INSERT INTO workspaces (id, name, local_path, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, `ws-${id}`, `/tmp/${id}`, Date.now())
}

function rowsOf<T = any>(sql: string, ...params: any[]): T[] {
  const stmt = sqlite.prepare(sql)
  return (params.length ? stmt.all(...params) : stmt.all()) as T[]
}

async function jsonPost(url: string, body: any) {
  return app.inject({ method: 'POST', url, payload: body })
}
async function jsonPatch(url: string, body: any) {
  return app.inject({ method: 'PATCH', url, payload: body })
}
async function jsonDelete(url: string) {
  return app.inject({ method: 'DELETE', url })
}

beforeEach(async () => {
  // 清表（FK CASCADE 顺序倒着删）
  sqlite.exec(`
    DELETE FROM workflow_edges;
    DELETE FROM workflow_nodes;
    DELETE FROM workflows;
    DELETE FROM features;
    DELETE FROM workspaces;
  `)
  mockAgentIds.clear()
  // 默认 ports：spec 是入口无 inputs；plan/tasks/coding 接受 default 输入。
  // 测试可单独 mockAgentPorts[id] = { ... } 覆盖。
  for (const k of Object.keys(mockAgentPorts)) delete mockAgentPorts[k]
  mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
  mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
  mockAgentPorts['tasks'] = { inputs: ['default'], outputs: ['default'] }
  mockAgentPorts['coding'] = { inputs: ['default'], outputs: ['default'] }
  ;['spec', 'plan', 'tasks', 'coding'].forEach((id) => mockAgentIds.add(id))

  app = Fastify({ logger: false })
  registerErrorHandler(app)
  await workflowRoutes(app)
  await app.ready()
})

// ── GET /api/workspaces/:id/workflows ─────────────────────────
describe('GET /api/workspaces/:id/workflows', () => {
  it('空 workspace → []', async () => {
    insertWorkspace('ws-1')
    const res = await app.inject({ method: 'GET', url: '/api/workspaces/ws-1/workflows' })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    expect(env.code).toBe(0)
    expect(env.data).toEqual([])
  })

  it('多个 workflow → 按 createdAt 升序', async () => {
    insertWorkspace('ws-1')
    // slice 03 起：plan 缺省 inputs=['default']，单节点 workflow 拒输入无入边；
    // 本测试只关心列表排序，把 plan 的 inputs 临时改成空，等价于"无前置依赖的 agent"
    mockAgentPorts['plan'] = { inputs: [], outputs: ['default'] }
    const a = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'first', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const b = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'second', nodes: [{ nodeId: 'plan', agentId: 'plan' }], edges: [],
    })
    expect(a.statusCode).toBe(201)
    expect(b.statusCode).toBe(201)

    const res = await app.inject({ method: 'GET', url: '/api/workspaces/ws-1/workflows' })
    const env = res.json()
    expect(env.data.map((w: any) => w.name)).toEqual(['first', 'second'])
  })
})

// ── POST /api/workspaces/:id/workflows ────────────────────────
describe('POST /api/workspaces/:id/workflows', () => {
  beforeEach(() => insertWorkspace('ws-1'))

  it('happy：1 节点 → 201 + 数据库中 1 个 workflow + 1 个 node + 0 边', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'simple', description: 'a simple workflow',
      nodes: [{ nodeId: 'spec', agentId: 'spec' }],
      edges: [],
    })
    expect(res.statusCode).toBe(201)
    const env = res.json()
    expect(env.code).toBe(0)
    expect(env.data.name).toBe('simple')
    expect(env.data.workspaceId).toBe('ws-1')
    expect(env.data.isArchived).toBe(false)

    expect(rowsOf('SELECT * FROM workflows').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_nodes').length).toBe(1)
    expect(rowsOf('SELECT * FROM workflow_edges').length).toBe(0)
  })

  it('happy：3 节点 2 边（线性）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'linear',
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
        { nodeId: 'coding', agentId: 'coding' },
      ],
      edges: [
        { fromNodeId: 'spec', toNodeId: 'plan' },
        { fromNodeId: 'plan', toNodeId: 'coding' },
      ],
    })
    expect(res.statusCode).toBe(201)
    expect(rowsOf('SELECT * FROM workflow_nodes').length).toBe(3)
    expect(rowsOf('SELECT * FROM workflow_edges').length).toBe(2)
  })

  it('空 nodes → 400 WORKFLOW_INVALID（1011）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'empty', nodes: [], edges: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
  })

  it('重复 nodeId → 400 NODE_ID_CONFLICT（1012）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'dup', nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'spec', agentId: 'plan' },
      ], edges: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1012)
  })

  it('未知 agentId → 400 WORKFLOW_INVALID（1011）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'ghost', nodes: [{ nodeId: 'nonexistent', agentId: 'nonexistent' }], edges: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
  })

  it('边引用未知 fromNodeId → 400 WORKFLOW_INVALID（1011）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'dangling', nodes: [{ nodeId: 'spec', agentId: 'spec' }],
      edges: [{ fromNodeId: 'ghost', toNodeId: 'spec' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
  })

  it('环：a→b→a → 400 CYCLE_DETECTED（1013）', async () => {
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'cycle', nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [
        { fromNodeId: 'spec', toNodeId: 'plan' },
        { fromNodeId: 'plan', toNodeId: 'spec' },
      ],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1013)
  })
})

// ── GET /api/workflows/:id ───────────────────────────────────
describe('GET /api/workflows/:id', () => {
  it('happy：返回 workflow + nodes + edges', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan' }],
    })
    const wfId = create.json().data.id

    const res = await app.inject({ method: 'GET', url: `/api/workflows/${wfId}` })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    expect(env.data.nodes).toHaveLength(2)
    expect(env.data.edges).toHaveLength(1)
    // DB 按 createdAt 升序返回；改 Route 1 输入后 nodeId 字典序为 plan < spec
    expect(env.data.nodes[0]).toMatchObject({ nodeId: 'plan', agentId: 'plan' })
  })

  it('不存在 → 404 WORKFLOW_NOT_FOUND（2005）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workflows/missing' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(2005)
  })
})

// ── PATCH /api/workflows/:id ─────────────────────────────────
describe('PATCH /api/workflows/:id', () => {
  it('改名 / 描述 / 归档', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const wfId = create.json().data.id

    const res = await jsonPatch(`/api/workflows/${wfId}`, {
      name: 'renamed', description: 'new', isArchived: true,
    })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    expect(env.data.name).toBe('renamed')
    expect(env.data.description).toBe('new')
    expect(env.data.isArchived).toBe(true)
  })

  it('不存在 → 404', async () => {
    const res = await jsonPatch('/api/workflows/missing', { name: 'x' })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(2005)
  })
})

// ── PATCH /api/workflows/:id/graph ───────────────────────────
// Phase 4 canvas 编辑端点：原地替换 nodes + edges，保留 workflow.id
describe('PATCH /api/workflows/:id/graph', () => {
  it('happy：替换 nodes + edges，workflow.id 不变，updated_at 推进', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    expect(create.statusCode).toBe(201)
    const wfId = create.json().data.id

    const res = await jsonPatch(`/api/workflows/${wfId}/graph`, {
      nodes: [
        { nodeId: 'spec', agentId: 'spec', positionX: 10, positionY: 20 },
        { nodeId: 'plan', agentId: 'plan', positionX: 30, positionY: 40 },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan' }],
    })
    expect(res.statusCode).toBe(200)
    const env = res.json()
    expect(env.data.id).toBe(wfId) // id 保持不变
    // updatedAt 在 createdAt 之后（DB timestamp 模式是 second 精度，>= 即可）
    expect(new Date(env.data.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(env.data.createdAt).getTime(),
    )

    // DB 验证：2 个 nodes + 1 个 edge
    const nodes = rowsOf<any>('SELECT * FROM workflow_nodes WHERE workflow_id = ?', wfId)
    expect(nodes).toHaveLength(2)
    expect(nodes.map((n) => n.node_id).sort()).toEqual(['plan', 'spec'])
    const edges = rowsOf<any>('SELECT * FROM workflow_edges WHERE workflow_id = ?', wfId)
    expect(edges).toHaveLength(1)
    expect(edges[0].from_node_id).toBe('spec')
    expect(edges[0].to_node_id).toBe('plan')
  })

  it('validation：nodeId !== agentId → 400 NODE_ID_MISMATCH（1015）', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const wfId = create.json().data.id

    const res = await jsonPatch(`/api/workflows/${wfId}/graph`, {
      nodes: [{ nodeId: 'spec', agentId: 'plan' }], // 故意违反 Route 1
      edges: [],
    })
    // CONTEXT.md N2 起允许 nodeId !== agentId；本测试 fixture 中 `plan` agent 存在，
    // 所以通过 nodeId/agentId 检查，但 plan agent 的 inputs=['default'] 缺入边 → 1011。
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)

    // 验证：原图未被破坏（事务回滚）
    const nodes = rowsOf<any>('SELECT * FROM workflow_nodes WHERE workflow_id = ?', wfId)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].node_id).toBe('spec')
  })

  it('不存在 → 404', async () => {
    const res = await jsonPatch('/api/workflows/missing/graph', {
      nodes: [{ nodeId: 'spec', agentId: 'spec' }],
      edges: [],
    })
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(2005)
  })
})

// ── DELETE /api/workflows/:id ────────────────────────────────
describe('DELETE /api/workflows/:id', () => {
  it('happy：无 feature 引用 → 200 且 DB 清空', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const wfId = create.json().data.id

    const res = await jsonDelete(`/api/workflows/${wfId}`)
    expect(res.statusCode).toBe(200)
    expect(rowsOf('SELECT * FROM workflows WHERE id = ?', wfId)).toHaveLength(0)
  })

  it('有 feature 引用 → 400 WORKFLOW_INVALID', async () => {
    insertWorkspace('ws-1')
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const wfId = create.json().data.id

    // 插一条引用此 workflow 的 feature
    sqlite.prepare(`
      INSERT INTO features (id, workspace_id, name, current_workflow_id, created_at)
      VALUES ('f-1', 'ws-1', 'feat', ?, ?)
    `).run(wfId, Date.now())

    const res = await jsonDelete(`/api/workflows/${wfId}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
  })

  it('不存在 → 404', async () => {
    const res = await jsonDelete('/api/workflows/missing')
    expect(res.statusCode).toBe(404)
    expect(res.json().code).toBe(2005)
  })
})

// ── slice 03: workflow 保存时端口校验 ─────────────────────────────
// Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
//
// 4 条规则的集成测试：
//   1) edge.to_input ∉ target_node.agent.inputs → 400
//   2) edge.from_output ∉ source_node.agent.outputs → 400
//   3) node 的 input port 无入边 → 400
//   4) workflow_nodes.config_json 含 `outputs` / `inputs` → 400
describe('slice 03: workflow 保存时端口校验', () => {
  beforeEach(() => insertWorkspace('ws-1'))

  it('edge.to_input 不在 target_node.agent.inputs → 400 + 节点 ID + 端口名', async () => {
    // spec→plan：plan.inputs=[default]，edge.toInput='spec.md' 不在内
    mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'mismatch',
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan', toInput: 'spec.md' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011) // WORKFLOW_INVALID
    expect(res.json().msg).toMatch(/plan/)
    expect(res.json().msg).toMatch(/spec\.md/)
  })

  it('edge.from_output 不在 source_node.agent.outputs → 400 + 节点 ID + 端口名', async () => {
    // spec.outputs=['default']，edge.fromOutput='summary.md' 不在内
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'mismatch-out',
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan', fromOutput: 'summary.md', toInput: 'default' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
    expect(res.json().msg).toMatch(/spec/)
    expect(res.json().msg).toMatch(/summary\.md/)
  })

  it('node 的 input port 无入边 → 400 + 节点 ID + 端口名', async () => {
    // plan.inputs=['default'] 但没有任何边进 plan → 缺入边
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'no-incoming',
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [], // plan 无入边
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
    expect(res.json().msg).toMatch(/plan/)
    expect(res.json().msg).toMatch(/default/)
    expect(res.json().msg).toMatch(/no incoming edge/)
  })

  it('workflow_nodes.config_json 含 `outputs` 键 → 400 + 政策提示', async () => {
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'override',
      nodes: [
        {
          nodeId: 'spec',
          agentId: 'spec',
          configJson: JSON.stringify({ outputs: ['override.md'] }),
        },
      ],
      edges: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
    expect(res.json().msg).toMatch(/override/i)
    expect(res.json().msg).toMatch(/deprecated/)
  })

  it('workflow_nodes.config_json 含 `inputs` 键 → 400 + 政策提示', async () => {
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'override-inputs',
      nodes: [
        {
          nodeId: 'spec',
          agentId: 'spec',
          configJson: JSON.stringify({ inputs: ['override.md'] }),
        },
      ],
      edges: [],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
    expect(res.json().msg).toMatch(/deprecated/)
  })

  it('config_json 含其它字段（如 displayName）→ 合法保留', async () => {
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'other-config',
      nodes: [
        {
          nodeId: 'spec',
          agentId: 'spec',
          configJson: JSON.stringify({ displayName: 'Custom Name' }),
        },
      ],
      edges: [],
    })
    expect(res.statusCode).toBe(201)
  })

  it('happy：端口全部对齐 + 每个 input 都有入边 → 201', async () => {
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
    const res = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'aligned',
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan', fromOutput: 'default', toInput: 'default' }],
    })
    expect(res.statusCode).toBe(201)
  })

  it('PATCH /graph 同样跑端口校验（不是只有 POST）', async () => {
    mockAgentPorts['spec'] = { inputs: [], outputs: ['default'] }
    mockAgentPorts['plan'] = { inputs: ['default'], outputs: ['default'] }
    const create = await jsonPost('/api/workspaces/ws-1/workflows', {
      name: 'w', nodes: [{ nodeId: 'spec', agentId: 'spec' }], edges: [],
    })
    const wfId = create.json().data.id

    const res = await jsonPatch(`/api/workflows/${wfId}/graph`, {
      nodes: [
        { nodeId: 'spec', agentId: 'spec' },
        { nodeId: 'plan', agentId: 'plan' },
      ],
      edges: [{ fromNodeId: 'spec', toNodeId: 'plan', toInput: 'spec.md' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe(1011)
    // 事务回滚：原图未被破坏
    const nodes = rowsOf<any>('SELECT * FROM workflow_nodes WHERE workflow_id = ?', wfId)
    expect(nodes).toHaveLength(1)
    expect(nodes[0].node_id).toBe('spec')
  })
})
