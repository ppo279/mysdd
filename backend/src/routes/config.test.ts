// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// slice 02 起：routes/config.ts 不再读写 agents.yaml；
//   - GET /api/config/agents → 读 DB 拼 yaml 形状
//   - PUT /api/config/agents → 写 DB 三表，事务包住；FK 失败时整体回滚
//
// 覆盖：
// - GET envelope：{code:0, data:{runtimes,global,agents}}
// - GET shape：DB 当前内容以 yaml 形状返回
// - PUT shape：PUT 写入内容以 GET 读出，deep-equal
// - PUT atomicity：PUT 时 agent.runtime_id 引用不存在的 runtime → 整 PUT 回滚（三表恢复原状）
// - PUT cache invalidation：PUT 后 loadAgentsConfig 必须重新读 DB（不返旧缓存）

import { describe, it, expect, beforeEach, vi } from 'vitest'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from '../db/schema-sql.js'

// mock db/index.js：所有访问 db 的代码都走 in-memory SQLite
vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

// mock detect service：避免依赖 child_process 探测本机 CLI
const { mockDetectRuntimes } = vi.hoisted(() => ({ mockDetectRuntimes: vi.fn() }))
vi.mock('../services/detect.js', () => ({
  detectRuntimes: mockDetectRuntimes,
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(SCHEMA_SQL)
for (const sql of IDEMPOTENT_ALTERS) {
  try { sqlite.exec(sql) } catch { /* already exists */ }
}
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { seedAgentsFromYamlString, clearAgentsTables } = await import('../services/agent-seed.js')
const { configRoutes } = await import('./config.js')
const { clearCache, loadAgentsConfig } = await import('../config/agents.js')

async function buildApp() {
  const app = Fastify({ logger: false })
  await app.register(configRoutes)
  await app.ready()
  return app
}

const SAMPLE_YAML = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: constitution, content: "# Constitution" }
agents:
  - { id: spec, name: Spec Agent, runtime: claude, instruction: "Spec instr", output_file: spec.md, memory_sediment: true }
  - { id: plan, name: Plan Agent, runtime: claude, instruction: "Plan instr", output_file: plan.md }
`

beforeEach(() => {
  clearAgentsTables()
  clearCache()
  mockDetectRuntimes.mockReset()
  mockDetectRuntimes.mockResolvedValue([
    { id: 'claude', type: 'claude-cli', command: 'claude', version: '1.0.0', available: true, source: 'cli' },
  ])
})

describe('routes/config.ts envelope 契约（slice 02）', () => {
  it('GET /api/config/agents 返回 envelope（code=0, data 包含 runtimes/global/agents）', async () => {
    seedAgentsFromYamlString(SAMPLE_YAML)
    clearCache()
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/config/agents' })
    const body = res.json()

    expect(body).toHaveProperty('code', 0)
    expect(body).toHaveProperty('data')
    expect(body.data).toHaveProperty('runtimes')
    expect(body.data).toHaveProperty('global')
    expect(body.data).toHaveProperty('agents')

    await app.close()
  })

  it('GET /api/config/agents 空 DB → envelope 含空数组', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/config/agents' })
    const body = res.json()

    expect(body.code).toBe(0)
    expect(body.data.runtimes).toEqual([])
    expect(body.data.global.base_layers).toEqual([])
    expect(body.data.agents).toEqual([])

    await app.close()
  })

  it('GET /api/config/detect-runtimes 返回 envelope（code=0, data=数组）', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/config/detect-runtimes' })
    const body = res.json()

    expect(body.code).toBe(0)
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data[0]).toMatchObject({ id: 'claude', type: 'claude-cli' })

    await app.close()
  })
})

describe('GET shape：从 DB 拼出 yaml 形状', () => {
  it('DB 含数据 → GET 返回的 data 与原 yaml 形状一致', async () => {
    seedAgentsFromYamlString(SAMPLE_YAML)
    clearCache()
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/api/config/agents' })
    const body = res.json()

    expect(body.data.runtimes.map((r: any) => r.id)).toEqual(['claude'])
    expect(body.data.global.base_layers).toHaveLength(1)
    expect(body.data.global.base_layers[0].name).toBe('constitution')
    expect(body.data.agents).toHaveLength(2)
    expect(body.data.agents.find((a: any) => a.id === 'spec').memory_sediment).toBe(true)
    expect(body.data.agents.find((a: any) => a.id === 'plan').memory_sediment).toBe(false)

    await app.close()
  })
})

describe('PUT shape：PUT 写入与 GET 读出 deep-equal', () => {
  it('PUT 一份新内容 → GET 返回相同内容', async () => {
    const app = await buildApp()
    const payload = {
      runtimes: [
        { id: 'claude', type: 'claude-cli', command: 'claude' },
        { id: 'codefree', type: 'codefree-cli', command: 'codefree' },
      ],
      global: {
        base_layers: [
          { name: 'constitution', content: '# Const' },
          { name: 'agents-spec', content: '# Spec' },
        ],
      },
      agents: [
        { id: 'spec', name: 'Spec', runtime: 'claude', instruction: 'Spec instr', output_file: 'spec.md', memory_sediment: true },
        { id: 'plan', name: 'Plan', runtime: 'codefree', instruction: 'Plan instr', output_file: 'plan.md' },
      ],
    }

    const putRes = await app.inject({
      method: 'PUT',
      url: '/api/config/agents',
      payload,
    })
    expect(putRes.json().code).toBe(0)

    const getRes = await app.inject({ method: 'GET', url: '/api/config/agents' })
    const got = getRes.json().data

    // deep-equal 比较：runtimes 顺序按 id 升序（DB 不保证原 yaml 顺序）；agents 同理。
    expect(got.runtimes.map((r: any) => r.id).sort()).toEqual(['claude', 'codefree'])
    expect(got.global.base_layers.map((b: any) => b.name)).toEqual(['constitution', 'agents-spec'])
    expect(got.agents).toHaveLength(2)
    const spec = got.agents.find((a: any) => a.id === 'spec')
    expect(spec.name).toBe('Spec')
    expect(spec.runtime).toBe('claude')
    expect(spec.instruction).toBe('Spec instr')
    expect(spec.memory_sediment).toBe(true)
    const plan = got.agents.find((a: any) => a.id === 'plan')
    expect(plan.runtime).toBe('codefree')
    expect(plan.memory_sediment).toBe(false)

    await app.close()
  })

  it('PUT 覆盖已有内容：先 seed，再 PUT，新内容生效（不留 stale runtimes / agents）', async () => {
    seedAgentsFromYamlString(SAMPLE_YAML)
    clearCache()
    const app = await buildApp()
    const payload = {
      runtimes: [
        { id: 'claude', type: 'claude-cli', command: 'claude' },
      ],
      global: { base_layers: [{ name: 'only-one', content: 'only' }] },
      agents: [
        { id: 'spec', name: 'Spec', runtime: 'claude', instruction: 'Spec instr', output_file: 'spec.md' },
      ],
    }
    const putRes = await app.inject({ method: 'PUT', url: '/api/config/agents', payload })
    expect(putRes.json().code).toBe(0)

    const getRes = await app.inject({ method: 'GET', url: '/api/config/agents' })
    const got = getRes.json().data
    expect(got.runtimes).toHaveLength(1)
    expect(got.global.base_layers).toHaveLength(1)
    expect(got.agents).toHaveLength(1)
    expect(got.agents[0].id).toBe('spec')

    await app.close()
  })
})

describe('PUT atomicity：FK 失败时整 PUT 回滚', () => {
  it('PUT 时 agent.runtime_id 引用不存在的 runtime → 三表都恢复原状', async () => {
    seedAgentsFromYamlString(SAMPLE_YAML)
    clearCache()

    // 取一份原状快照
    const before = {
      runtimes: sqlite.prepare('SELECT * FROM runtimes').all(),
      baseLayers: sqlite.prepare('SELECT * FROM base_layers').all(),
      agents: sqlite.prepare('SELECT * FROM agents').all(),
    }
    expect(before.runtimes).toHaveLength(1)
    expect(before.agents).toHaveLength(2)

    // 故意让 agent.runtime 引用不存在的 runtime
    const app = await buildApp()
    const payload = {
      runtimes: [
        { id: 'claude', type: 'claude-cli', command: 'claude' },
        // 不写 codefree，让 plan.agent.runtime='codefree' FK 失败
      ],
      global: { base_layers: [{ name: 'only-one', content: 'only' }] },
      agents: [
        { id: 'spec', name: 'Spec', runtime: 'claude', instruction: 'Spec', output_file: 'spec.md' },
        { id: 'plan', name: 'Plan', runtime: 'codefree', instruction: 'Plan', output_file: 'plan.md' },
      ],
    }
    const putRes = await app.inject({ method: 'PUT', url: '/api/config/agents', payload })

    // PUT 失败（FK 错误）；HTTP 状态由 error handler 决定
    expect(putRes.statusCode).toBeGreaterThanOrEqual(400)
    expect(putRes.json().code).not.toBe(0)

    // DB 完全恢复原状（无 runtimes.codefree 残留；agents 行未变；base_layers 未变）
    const after = {
      runtimes: sqlite.prepare('SELECT * FROM runtimes').all(),
      baseLayers: sqlite.prepare('SELECT * FROM base_layers').all(),
      agents: sqlite.prepare('SELECT * FROM agents').all(),
    }
    expect(after.runtimes).toHaveLength(1)
    expect((after.runtimes[0] as { id: string }).id).toBe('claude')
    expect(after.agents).toHaveLength(2)
    expect(after.baseLayers).toHaveLength(1)

    await app.close()
  })
})

describe('PUT 后缓存失效', () => {
  it('PUT 修改 agent name → loadAgentsConfig 必须返新值（不命中旧缓存）', async () => {
    seedAgentsFromYamlString(SAMPLE_YAML)
    clearCache()

    // 第一次读：缓存命中
    const before = loadAgentsConfig()
    expect(before.agents.find((a) => a.id === 'spec')?.name).toBe('Spec Agent')

    const app = await buildApp()
    const payload = {
      runtimes: [{ id: 'claude', type: 'claude-cli', command: 'claude' }],
      global: { base_layers: [] },
      agents: [
        { id: 'spec', name: 'Spec Agent (renamed)', runtime: 'claude', instruction: 'Spec', output_file: 'spec.md' },
      ],
    }
    const putRes = await app.inject({ method: 'PUT', url: '/api/config/agents', payload })
    expect(putRes.json().code).toBe(0)

    // PUT 触发了 clearCache → loadAgentsConfig 必须返新值
    const after = loadAgentsConfig()
    expect(after.agents).toHaveLength(1)
    expect(after.agents[0].name).toBe('Spec Agent (renamed)')

    await app.close()
  })
})
