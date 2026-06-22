// Implements: .scratch/agent-contract-db/issues/05-yaml-cleanup.md
// slice 05 起：本测试只覆盖 test seam（seedAgentsFixture + clearAgentsTables +
// loadAgentsFromDb）。原"启动期读 agents.yaml"路径已删除，相关用例一并移除。
//
// 历史：
// - slice 02 把 agents.yaml 一次性迁到 DB
// - slice 05 删启动期 yaml 读取路径与 js-yaml 依赖
//
// 仍保留的覆盖：
// - fresh in-memory DB + fixture → seed（agents / runtimes / base_layers 三表都非空）
// - 再跑 seed → 行数未变（覆盖写、不重复）
// - 半成品 DB（仅 runtimes 有行）→ seed 后三表都填齐
// - loadAgentsFromDb 返回 yaml 形状
// - 字段类型错误（memory_sediment 非 boolean） → fail-fast 抛错
// - FK 失败 → 整个 transaction 回滚

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from '../db/schema-sql.js'

// ── in-memory SQLite + mock db/index.js ──
vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(SCHEMA_SQL)
for (const sql of IDEMPOTENT_ALTERS) {
  try { sqlite.exec(sql) } catch { /* already exists */ }
}
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { seedAgentsFixture, clearAgentsTables, loadAgentsFromDb } = await import('./agent-seed.js')

const VALID_FIXTURE = {
  runtimes: [
    { id: 'claude', type: 'claude-cli', command: 'claude' },
    { id: 'codefree', type: 'codefree-cli', command: 'codefree' },
  ],
  global: {
    base_layers: [
      { name: 'constitution', content: 'C1' },
      { name: 'agents-spec', content: 'A1' },
    ],
  },
  agents: [
    { id: 'spec', name: 'Spec Agent', runtime: 'claude', instruction: 'Spec instr', output_file: 'spec.md', memory_sediment: true },
    { id: 'plan', name: 'Plan Agent', runtime: 'claude', instruction: 'Plan instr', output_file: 'plan.md' },
  ],
}

beforeEach(() => {
  clearAgentsTables()
})

function rowCount(table: string): number {
  const r = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return r.n
}

describe('slice 02/05: seedAgentsFixture（test seam）', () => {
  it('seed 后：runtimes / base_layers / agents 三表都有行', () => {
    seedAgentsFixture(VALID_FIXTURE)
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('base_layers')).toBe(2)
    expect(rowCount('agents')).toBe(2)
  })

  it('seed 两次 → 三表行数未变（覆盖写、不重复）', () => {
    seedAgentsFixture(VALID_FIXTURE)
    seedAgentsFixture(VALID_FIXTURE)
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('base_layers')).toBe(2)
    expect(rowCount('agents')).toBe(2)
  })

  it('半成品 DB（仅 runtimes 有行）→ seed 后三表都填齐；agents 行被覆盖', () => {
    sqlite.prepare(`INSERT INTO runtimes (id, type, command) VALUES (?, ?, ?)`)
      .run('orphan-rt', 'claude-cli', 'claude')
    expect(rowCount('runtimes')).toBe(1)
    expect(rowCount('agents')).toBe(0)
    seedAgentsFixture(VALID_FIXTURE)
    // orphan runtime 被 DELETE 掉；新 runtimes 全量写入
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('agents')).toBe(2)
    const ids = sqlite.prepare(`SELECT id FROM runtimes ORDER BY id`).all() as { id: string }[]
    expect(ids.map((r) => r.id)).toEqual(['claude', 'codefree'])
  })

  it('loadAgentsFromDb 返回 yaml 形状：runtimes / global.base_layers / agents[*].{id,name,runtime,instruction,memory_sediment}', () => {
    seedAgentsFixture(VALID_FIXTURE)
    const data = loadAgentsFromDb()
    expect(data.runtimes.map((r) => r.id).sort()).toEqual(['claude', 'codefree'])
    expect(data.global.base_layers.map((b) => b.name)).toEqual(['constitution', 'agents-spec'])
    const spec = data.agents.find((a) => a.id === 'spec')!
    expect(spec).toBeDefined()
    expect(spec.name).toBe('Spec Agent')
    expect(spec.runtime).toBe('claude')
    expect(spec.instruction).toBe('Spec instr')
    expect(spec.memory_sediment).toBe(true)
    const plan = data.agents.find((a) => a.id === 'plan')!
    expect(plan.memory_sediment).toBe(false)
  })

  it('base_layers 按 position 升序（保持拼接顺序）', () => {
    seedAgentsFixture({
      runtimes: [{ id: 'claude', type: 'claude-cli' }],
      global: {
        base_layers: [
          { name: 'z-layer', content: 'Z' },
          { name: 'a-layer', content: 'A' },
          { name: 'm-layer', content: 'M' },
        ],
      },
      agents: [{ id: 'spec', runtime: 'claude' }],
    })
    const data = loadAgentsFromDb()
    expect(data.global.base_layers.map((b) => b.name)).toEqual(['z-layer', 'a-layer', 'm-layer'])
  })

  it('memory_sediment 非 boolean → fail-fast', () => {
    expect(() => seedAgentsFixture({
      runtimes: [{ id: 'claude', type: 'claude-cli' }],
      global: { base_layers: [] },
      // @ts-expect-error 测试 fixture 故意传入非法 memory_sediment 类型
      agents: [{ id: 'spec', runtime: 'claude', memory_sediment: 'yes' }],
    })).toThrow(/memory_sediment/)
  })

  it('agent.runtime 不在 runtimes 中 → INSERT 失败（FK RESTRICT），整个 transaction 回滚', () => {
    expect(() => seedAgentsFixture({
      runtimes: [{ id: 'claude', type: 'claude-cli' }],
      global: { base_layers: [] },
      agents: [{ id: 'spec', runtime: 'nonexistent' }],
    })).toThrow()
    // 失败回滚：runtimes 也应保持原状（不应留下 half-baked 数据）
    expect(rowCount('runtimes')).toBe(0)
    expect(rowCount('agents')).toBe(0)
  })
})