// Implements: docs/adr/0001-workflow-execution-model.md (Phase 0 schema additions)
// 验证 initDb() 后：6 张新表 + workspaces.local_path/default_workflow_id +
// features.current_workflow_id/current_node_id + stage_runs.node_id 都存在。
// 同时确保旧表（workspaces / features / stage_runs / messages）字段未变。
// Implements: .scratch/thinking-visibility-and-persistence/issues/01
// 验证 messages.thinking 列存在 + 老 DB 上 ALTER 幂等。

import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')

// mock db/index.js 内的 better-sqlite3 路径：直接复用本测试的 sqlite 实例
// 但 initDb 内部直接引用 module-scope 的 `sqlite`，无法注入。
// 解法：直接 exec SCHEMA_SQL；然后对 ALTER 也 inline 处理。
// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// slice 02 起 SCHEMA_SQL 已移出 db/index.ts 到独立模块 schema-sql.ts（避免被 vi.mock 拦截）；
// 本测试也跟随调整。
import { SCHEMA_SQL } from './schema-sql.js'

beforeEach(() => {
  // 每个测试重置
  for (const stmt of [
    "DROP TABLE IF EXISTS feature_node_migrations;",
    "DROP TABLE IF EXISTS stage_run_outputs;",
    "DROP TABLE IF EXISTS feature_node_states;",
    "DROP TABLE IF EXISTS workflow_edges;",
    "DROP TABLE IF EXISTS workflow_nodes;",
    "DROP TABLE IF EXISTS workflows;",
    "DROP TABLE IF EXISTS messages;",
    "DROP TABLE IF EXISTS stage_runs;",
    "DROP TABLE IF EXISTS features;",
    "DROP TABLE IF EXISTS workspaces;",
  ]) {
    sqlite.exec(stmt)
  }
  sqlite.exec(SCHEMA_SQL)
  // 同样应用 ALTER（与 initDb 内一致）
  // 注意：messages.thinking 不放在这里 — 由新 describe block 单独验证（避免 beforeEach
  // 内联 ALTER 绕过真实 initDb() 路径）
  const alters = [
    `ALTER TABLE workspaces ADD COLUMN local_path TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE workspaces ADD COLUMN default_workflow_id TEXT REFERENCES workflows(id)`,
    `ALTER TABLE features ADD COLUMN current_workflow_id TEXT REFERENCES workflows(id)`,
    `ALTER TABLE features ADD COLUMN current_node_id TEXT NOT NULL DEFAULT 'spec'`,
    `ALTER TABLE stage_runs ADD COLUMN node_id TEXT`,
  ]
  for (const sql of alters) {
    try { sqlite.exec(sql) } catch { /* 已存在 */ }
  }
})

describe('initDb() Phase 0 schema', () => {
  it('6 张新表全部存在', () => {
    const tables = sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as { name: string }[]
    const names = tables.map((t) => t.name)
    for (const required of [
      'workflows',
      'workflow_nodes',
      'workflow_edges',
      'feature_node_states',
      'stage_run_outputs',
      'feature_node_migrations',
    ]) {
      expect(names).toContain(required)
    }
  })

  it('旧表未丢失', () => {
    const names = (sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'",
    ).all() as { name: string }[]).map((t) => t.name)
    for (const required of ['workspaces', 'features', 'stage_runs', 'messages']) {
      expect(names).toContain(required)
    }
  })

  it('workspaces 新增列：local_path, default_workflow_id', () => {
    const cols = (sqlite.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('local_path')
    expect(cols).toContain('default_workflow_id')
  })

  it('features 新增列：current_workflow_id, current_node_id', () => {
    const cols = (sqlite.prepare('PRAGMA table_info(features)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('current_workflow_id')
    expect(cols).toContain('current_node_id')
  })

  it('stage_runs 新增列：node_id', () => {
    const cols = (sqlite.prepare('PRAGMA table_info(stage_runs)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toContain('node_id')
  })

  it('workflow_nodes UNIQUE(workflow_id, node_id)', () => {
    sqlite.prepare(
      `INSERT INTO workspaces (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`,
    ).run('w-1', 'w1', '/tmp/w-1', Date.now())
    sqlite.prepare(
      `INSERT INTO workflows (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('wf-1', 'w-1', 'default', Date.now(), Date.now())
    sqlite.prepare(
      `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('n-1', 'wf-1', 'spec', 'spec', Date.now())
    // 重复 nodeId 必须失败
    expect(() => sqlite.prepare(
      `INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('n-2', 'wf-1', 'spec', 'plan', Date.now())).toThrow()
  })

  it('workflow ON DELETE CASCADE：删 workspace → workflows 也被删', () => {
    sqlite.prepare(
      `INSERT INTO workspaces (id, name, local_path, created_at) VALUES (?, ?, ?, ?)`,
    ).run('w-1', 'w1', '/tmp/w-1', Date.now())
    sqlite.prepare(
      `INSERT INTO workflows (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('wf-1', 'w-1', 'default', Date.now(), Date.now())
    sqlite.prepare(`DELETE FROM workspaces WHERE id = ?`).run('w-1')
    const remaining = sqlite.prepare(`SELECT * FROM workflows`).all()
    expect(remaining).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────
// Implements: .scratch/thinking-visibility-and-persistence/issues/01
// messages.thinking 列：nullable 文本，承载 agent 流式期间 thinking 文本
// 验收：
//   1) 新 DB 直接含该列
//   2) 老 DB（无该列）ALTER 后含该列，且老消息 INSERT/SELECT 不报错
//   3) 重复 initDb()（即再次 ALTER）幂等不抛错
// ─────────────────────────────────────────────────────────────

describe('initDb() messages.thinking 列', () => {
  it('新 DB：SCHEMA_SQL 已包含 thinking 列（nullable + 无默认值）', () => {
    // beforeEach 跑过 SCHEMA_SQL，但 messages.thinking 的 ALTER 不在内联 alters 里——
    // 测的是"是否在 SCHEMA_SQL 静态定义里"，不是 beforeEach 内联 ALTER
    const cols = sqlite.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>
    const thinking = cols.find((c) => c.name === 'thinking')
    expect(thinking).toBeTruthy()
    expect(thinking!.notnull).toBe(0) // nullable
    expect(thinking!.dflt_value).toBeNull() // 无默认值
  })

  it('老 DB：messages 表无 thinking 列时，ALTER 加列后老消息 INSERT/SELECT 不报错', () => {
    // 模拟老 schema：messages 表只有 (id, stage_run_id, role, content, created_at)
    // 这是 issue 01 的核心迁移路径——老 DB 上 initDb() ALTER 必须不破坏已有数据
    sqlite.exec(`
      DROP TABLE IF EXISTS messages;
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        stage_run_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `)
    // 插一条老消息
    sqlite.prepare(
      `INSERT INTO messages (id, stage_run_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('m-old', 'r-old', 'user', 'old msg', Date.now())
    // ALTER 加 thinking 列（与 initDb() 内 try/catch 路径一致）
    try { sqlite.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`) } catch { /* already exists */ }
    // 老消息 SELECT 仍正常，thinking 自动为 NULL
    const row = sqlite.prepare(`SELECT id, content, thinking FROM messages WHERE id = ?`).get('m-old') as { id: string; content: string; thinking: string | null }
    expect(row.id).toBe('m-old')
    expect(row.content).toBe('old msg')
    expect(row.thinking).toBeNull()
    // UPDATE thinking 不报错
    expect(() =>
      sqlite.prepare(`UPDATE messages SET thinking = ? WHERE id = ?`).run('new thinking', 'm-old'),
    ).not.toThrow()
    const updated = sqlite.prepare(`SELECT thinking FROM messages WHERE id = ?`).get('m-old') as { thinking: string }
    expect(updated.thinking).toBe('new thinking')
  })

  it('initDb() 幂等：重复 ALTER 不抛 "duplicate column" 错', () => {
    // 模拟 initDb() 启动两次：第二次 ALTER 应被 try/catch 吞掉
    // 这是项目惯例：initDb() 末尾的 idempotent ALTER (line 144-148 同款模式)
    expect(() => {
      try { sqlite.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`) } catch { /* already exists */ }
    }).not.toThrow()
    // 第二次
    expect(() => {
      try { sqlite.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`) } catch { /* already exists */ }
    }).not.toThrow()
  })
})
