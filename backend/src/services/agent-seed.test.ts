// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// seeder 单元测试：
// - fresh in-memory DB + yaml → seed（agents / runtimes / base_layers 三表都非空）
// - 再跑 seed → no-op（行数未变）
// - agents.yaml 不存在 → no-op（不抛错）
// - 字段类型错误（memory_sediment 非 boolean） → fail-fast 抛错
// - 字段类型错误（config.disallowedTools 非字符串） → fail-fast 抛错

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from '../db/schema-sql.js'
import path from 'path'
import os from 'os'
import fs from 'fs'

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

const { seedAgentsFromYamlString, clearAgentsTables, loadAgentsFromDb, seedAgentsFromYaml } = await import('./agent-seed.js')

const VALID_YAML = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
  - { id: codefree, type: codefree-cli, command: codefree }
global:
  base_layers:
    - { name: constitution, content: "C1" }
    - { name: agents-spec, content: "A1" }
agents:
  - { id: spec, name: Spec Agent, runtime: claude, instruction: "Spec instr", output_file: spec.md, memory_sediment: true }
  - { id: plan, name: Plan Agent, runtime: claude, instruction: "Plan instr", output_file: plan.md }
`

beforeEach(() => {
  clearAgentsTables()
})

function rowCount(table: string): number {
  const r = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  return r.n
}

describe('slice 02: seedAgentsFromYamlString（test seam）', () => {
  it('seed 后：runtimes / base_layers / agents 三表都有行', () => {
    seedAgentsFromYamlString(VALID_YAML)
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('base_layers')).toBe(2)
    expect(rowCount('agents')).toBe(2)
  })

  it('seed 两次 → 三表行数未变（覆盖写、不重复）', () => {
    seedAgentsFromYamlString(VALID_YAML)
    seedAgentsFromYamlString(VALID_YAML)
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('base_layers')).toBe(2)
    expect(rowCount('agents')).toBe(2)
  })

  it('半成品 DB（仅 runtimes 有行）→ seed 后三表都填齐；agents 行被覆盖', () => {
    sqlite.prepare(`INSERT INTO runtimes (id, type, command) VALUES (?, ?, ?)`)
      .run('orphan-rt', 'claude-cli', 'claude')
    expect(rowCount('runtimes')).toBe(1)
    expect(rowCount('agents')).toBe(0)
    seedAgentsFromYamlString(VALID_YAML)
    // orphan runtime 被 DELETE 掉；新 runtimes 全量写入
    expect(rowCount('runtimes')).toBe(2)
    expect(rowCount('agents')).toBe(2)
    const ids = sqlite.prepare(`SELECT id FROM runtimes ORDER BY id`).all() as { id: string }[]
    expect(ids.map((r) => r.id)).toEqual(['claude', 'codefree'])
  })

  it('loadAgentsFromDb 返回 yaml 形状：runtimes / global.base_layers / agents[*].{id,name,runtime,instruction,memory_sediment}', () => {
    seedAgentsFromYamlString(VALID_YAML)
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
    seedAgentsFromYamlString(`
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: z-layer, content: "Z" }
    - { name: a-layer, content: "A" }
    - { name: m-layer, content: "M" }
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md }
`)
    const data = loadAgentsFromDb()
    expect(data.global.base_layers.map((b) => b.name)).toEqual(['z-layer', 'a-layer', 'm-layer'])
  })

  it('memory_sediment 非 boolean → fail-fast', () => {
    expect(() => seedAgentsFromYamlString(`
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, memory_sediment: "yes" }
`)).toThrow(/memory_sediment/)
  })

  it('config.disallowedTools 非字符串 → fail-fast', () => {
    expect(() => seedAgentsFromYamlString(`
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, config: { disallowedTools: 123 } }
`)).toThrow(/config/)
  })

  it('agent.runtime 不在 runtimes 中 → INSERT 失败（FK RESTRICT），整个 transaction 回滚', () => {
    expect(() => seedAgentsFromYamlString(`
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: nonexistent, instruction: "Spec", output_file: spec.md }
`)).toThrow()
    // 失败回滚：runtimes 也应保持原状（不应留下 half-baked 数据）
    expect(rowCount('runtimes')).toBe(0)
    expect(rowCount('agents')).toBe(0)
  })
})

describe('slice 02: seedAgentsFromYaml（生产路径：哨兵 + yaml 文件存在性）', () => {
  it('agents 表非空 → 直接返回 false（幂等 no-op）', () => {
    seedAgentsFromYamlString(VALID_YAML)
    const wroteBefore = rowCount('agents')

    // 哨兵测试：agents 非空时，无论 yaml 内容如何，seeder 必须 no-op。
    const wrote = seedAgentsFromYaml('/this/path/does/not/exist.yaml')
    expect(wrote).toBe(false)
    expect(rowCount('agents')).toBe(wroteBefore)
    expect(rowCount('runtimes')).toBe(2)
  })

  it('agents 表为空 + yaml 路径不存在 → 返回 false（不抛错）', () => {
    const wrote = seedAgentsFromYaml('/this/path/does/not/exist.yaml')
    expect(wrote).toBe(false)
    expect(rowCount('agents')).toBe(0)
    expect(rowCount('runtimes')).toBe(0)
  })

  it('agents 表为空 + yaml 存在 → 返回 true 且写入 DB', () => {
    const tmpFile = path.join(os.tmpdir(), `seed-${Date.now()}.yaml`)
    fs.writeFileSync(tmpFile, VALID_YAML)
    try {
      const wrote = seedAgentsFromYaml(tmpFile)
      expect(wrote).toBe(true)
      expect(rowCount('agents')).toBe(2)
      expect(rowCount('runtimes')).toBe(2)
    } finally {
      fs.unlinkSync(tmpFile)
    }
  })
})
