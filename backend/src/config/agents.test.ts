// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// slice 02 起：loadAgentsConfig 不再读 agents.yaml，改为读 DB。
// 测试用 in-memory SQLite + 完整 SCHEMA_SQL + seedAgentsFromYamlString 注入 fixture。
//
// 保留的覆盖（迁移自 slice 02 之前）：
// - AC-06: memory_sediment 解析（true / false / undefined / 非 boolean 抛错）
// - T008: getSedimentEnabledAgents 返回 memory_sediment: true 的 agent id 列表
// - Phase 3: buildEdgeBasedContext 按 toInput 分组
// - 001: config.disallowedTools 解析（合法 / 缺省 / 缺 config / 非字符串抛错）
// - buildSystemPrompt 三层结构（base_layers + agent.instruction + background）
//
// 新增（slice 02）：
// - loadAgentsConfig 读 DB（不再读 fs）
// - clearCache 后再读会重新从 DB 取（PUT 后缓存失效）

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from '../db/schema-sql.js'

// ── in-memory SQLite + mock db/index.js ──
// 用 getter mock：每次访问 db 都走最新的 __testDb；setUpBeforeEach 重置 SQLite 时不影响 binding。
// 注意：SCHEMA_SQL 必须从 '../db/schema-sql.js' import（独立模块，不被此 mock 拦截）。
vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(SCHEMA_SQL)
// 应用 initDb 的 idempotent ALTER（与 production 一致；保持 ON DELETE RESTRICT 之类生效）
for (const sql of IDEMPOTENT_ALTERS) {
  try { sqlite.exec(sql) } catch { /* already exists */ }
}
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { seedAgentsFromYamlString, clearAgentsTables } = await import('../services/agent-seed.js')
const agentsModule = await import('./agents.js')
const {
  loadAgentsConfig,
  buildSystemPrompt,
  clearCache,
  getSedimentEnabledAgents,
  buildEdgeBasedContext,
} = agentsModule

// ============== Fixtures (as YAML) ==============

// 含 memory_sediment: true / false / 缺失 三种状态
const FIXTURE_VALID = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: constitution, content: "# Project Constitution\\nNo memory refs here." }
    - { name: agents-spec, content: "# AGENTS spec\\nNo memory refs here either." }
agents:
  - { id: spec,  name: Spec Agent,  runtime: claude, instruction: "Spec instruction",  output_file: spec.md }
  - { id: plan,  name: Plan Agent,  runtime: claude, instruction: "Plan instruction",  output_file: plan.md, memory_sediment: true }
  - { id: tasks, name: Task Agent,  runtime: claude, instruction: "Task instruction",  output_file: tasks.md }
`

const FIXTURE_NO_MEMORY_REF = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: layer1, content: "# Pure spec-driven-development rules.\\nWorkflow only." }
    - { name: layer2, content: "# Project execution protocol.\\nRules only." }
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec instruction for SDD workflow", output_file: spec.md }
`

const FIXTURE_WITH_DISALLOWED_TOOLS = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: layer1, content: "Base layer 1" }
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, config: { disallowedTools: "Bash,Edit,MultiEdit" } }
  - { id: plan, name: Plan, runtime: claude, instruction: "Plan", output_file: plan.md }
`

const FIXTURE_CONFIG_WITHOUT_DISALLOWED = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, config: { env: { FOO: bar } } }
`

const FIXTURE_INVALID_DISALLOWED_TOOLS = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, config: { disallowedTools: 123 } }
`

// memory_sediment 非 boolean — seeder 启动期 fail-fast
const FIXTURE_INVALID_BOOL = `
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers: []
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md, memory_sediment: "yes" }
`

// ============== Setup ==============

beforeEach(() => {
  clearCache()
  clearAgentsTables()
})

afterEach(() => {
  clearCache()
  clearAgentsTables()
})

function seed(fixture: string) {
  seedAgentsFromYamlString(fixture)
  clearCache()
}

// ============== AC-06: memory_sediment 字段解析 ==============

describe('AC-06: loadAgentsConfig 解析 memory_sediment', () => {
  it('含 memory_sediment: true 的 agent 解析后字段值为 true', () => {
    seed(FIXTURE_VALID)
    const cfg = loadAgentsConfig()
    const plan = cfg.agents.find((a) => a.id === 'plan')
    expect(plan).toBeDefined()
    expect(plan?.memory_sediment).toBe(true)
  })

  it('缺 memory_sediment 字段时视为 false（DB 默认 0 兜底）', () => {
    seed(FIXTURE_VALID)
    const cfg = loadAgentsConfig()
    const spec = cfg.agents.find((a) => a.id === 'spec')
    expect(spec).toBeDefined()
    expect(spec?.memory_sediment).toBe(false)
  })

  it('显式 memory_sediment: false 解析为 false', () => {
    seed(FIXTURE_VALID)
    const cfg = loadAgentsConfig()
    const tasks = cfg.agents.find((a) => a.id === 'tasks')
    expect(tasks).toBeDefined()
    expect(tasks?.memory_sediment).toBe(false)
  })

  it('非 boolean 的 memory_sediment（string "yes"）→ seeder 抛错（fail-fast）', () => {
    expect(() => seedAgentsFromYamlString(FIXTURE_INVALID_BOOL)).toThrow(/memory_sediment/)
  })
})

// ============== AC-04 / BI-02: buildSystemPrompt 不引用 memory/ ==============

describe('AC-04 / BI-02: buildSystemPrompt 不引用 memory/', () => {
  it('输出文本不匹配 /memory/i（base_layers + instruction + background 三层拼接均不引入）', () => {
    seed(FIXTURE_NO_MEMORY_REF)
    const prompt = buildSystemPrompt('spec', 'ts', 'workspace background with no refs')
    expect(prompt).not.toMatch(/memory/i)
  })

  it('拼接结构（base_layers + agent.instruction + background）完整且不引用 memory', () => {
    seed(FIXTURE_NO_MEMORY_REF)
    const prompt = buildSystemPrompt('spec', 'ts', 'simple background')
    expect(prompt).toContain('# Pure spec-driven-development rules')
    expect(prompt).toContain('Spec instruction for SDD workflow')
    expect(prompt).toContain('## Workspace 背景信息')
    expect(prompt).toContain('simple background')
    expect(prompt).not.toMatch(/memory/i)
  })
})

// ============== T008: getSedimentEnabledAgents ==============

describe('T008: getSedimentEnabledAgents（memory_sediment 钩子）', () => {
  it('返回声明 memory_sediment: true 的 agent id 列表', () => {
    seed(FIXTURE_VALID)
    expect(getSedimentEnabledAgents()).toEqual(['plan'])
  })
})

// ============== Phase 3: buildEdgeBasedContext 按 toInput 分组 ==============

describe('Phase 3: buildEdgeBasedContext 按 toInput 分组', () => {
  it('多个上游全部流向同一 input "context" → 一个 ### 小节，多个 bullet', () => {
    const out = buildEdgeBasedContext([
      { fromNodeId: 'spec', agentId: 'spec', fromOutput: 'default', toInput: 'context', content: 'spec body' },
      { fromNodeId: 'plan', agentId: 'plan', fromOutput: 'plan_default', toInput: 'context', content: 'plan body' },
    ])
    expect(out).toContain('### input `context`')
    expect(out).toMatch(/来自 `spec`/)
    expect(out).toMatch(/来自 `plan`/)
    expect(out.match(/### input/g)?.length).toBe(1)
  })

  it('多个 toInput → 多个 ### 小节', () => {
    const out = buildEdgeBasedContext([
      { fromNodeId: 'spec', agentId: 'spec', fromOutput: 'default', toInput: 'summary', content: 'SPEC' },
      { fromNodeId: 'spec', agentId: 'spec', fromOutput: 'default', toInput: 'code', content: 'CODE' },
    ])
    expect(out).toContain('### input `summary`')
    expect(out).toContain('### input `code`')
    const summaryIdx = out.indexOf('### input `summary`')
    const codeIdx = out.indexOf('### input `code`')
    expect(out.indexOf('SPEC', summaryIdx)).toBeLessThan(codeIdx)
    expect(out.indexOf('CODE', codeIdx)).toBeGreaterThan(codeIdx)
  })

  it('空数组 → 返回空串', () => {
    expect(buildEdgeBasedContext([])).toBe('')
  })
})

// ============== 001: config.disallowedTools 解析 ==============

describe('001: AgentRuntimeConfig.disallowedTools 解析', () => {
  it('config.disallowedTools: "Bash,Edit,MultiEdit" → 字段值被透传', () => {
    seed(FIXTURE_WITH_DISALLOWED_TOOLS)
    const cfg = loadAgentsConfig()
    const spec = cfg.agents.find((a) => a.id === 'spec')
    expect(spec?.config?.disallowedTools).toBe('Bash,Edit,MultiEdit')
  })

  it('yaml 不含 config 字段 → config 为 undefined', () => {
    seed(FIXTURE_VALID)
    const cfg = loadAgentsConfig()
    const plan = cfg.agents.find((a) => a.id === 'plan')
    expect(plan?.config).toBeUndefined()
  })

  it('config 含 env 但无 disallowedTools → 启动不报错', () => {
    seed(FIXTURE_CONFIG_WITHOUT_DISALLOWED)
    const cfg = loadAgentsConfig()
    const spec = cfg.agents.find((a) => a.id === 'spec')
    expect(spec?.config?.disallowedTools).toBeUndefined()
    expect(spec?.config?.env).toEqual({ FOO: 'bar' })
  })

  it('config.disallowedTools: 123（非字符串）→ fail-fast 抛错', () => {
    expect(() => seedAgentsFromYamlString(FIXTURE_INVALID_DISALLOWED_TOOLS)).toThrow()
  })
})

// ============== slice 02: loadAgentsConfig 读 DB 而非 fs ==============

describe('slice 02: loadAgentsConfig 读 DB', () => {
  it('DB 为空 → loadAgentsConfig 返回空 agents + 空 base_layers', () => {
    clearAgentsTables()
    clearCache()
    const cfg = loadAgentsConfig()
    expect(cfg.agents).toEqual([])
    expect(cfg.runtimes).toEqual([])
    expect(cfg.global.base_layers).toEqual([])
  })

  it('从 DB 读出 base_layers 时按 position 升序拼接', () => {
    seed(`
runtimes:
  - { id: claude, type: claude-cli, command: claude }
global:
  base_layers:
    - { name: z-layer, content: "Z content" }
    - { name: a-layer, content: "A content" }
    - { name: m-layer, content: "M content" }
agents:
  - { id: spec, name: Spec, runtime: claude, instruction: "Spec", output_file: spec.md }
`)
    const cfg = loadAgentsConfig()
    // 顺序由写入时的 position 决定（按 yaml 顺序 position++），与 yaml 顺序一致
    expect(cfg.global.base_layers.map((b) => b.name)).toEqual(['z-layer', 'a-layer', 'm-layer'])
    expect(cfg.global.base_layers[0].content).toBe('Z content')
    expect(cfg.global.base_layers[1].content).toBe('A content')
    expect(cfg.global.base_layers[2].content).toBe('M content')
  })

  it('clearCache 后再读会重新从 DB 取（不命中旧缓存）', () => {
    seed(FIXTURE_VALID)
    const before = loadAgentsConfig()
    expect(before.agents).toHaveLength(3)

    // 直接 SQL 改 DB（不经过 loadAgentsConfig / clearCache）
    sqlite.prepare(`UPDATE agents SET name = ? WHERE id = ?`).run('Spec Agent (edited)', 'spec')

    // 不清缓存 → 仍然读到旧值（缓存命中）
    const cached = loadAgentsConfig()
    const cachedSpec = cached.agents.find((a) => a.id === 'spec')
    expect(cachedSpec?.name).toBe('Spec Agent')

    // 清缓存 → 重新从 DB 取
    clearCache()
    const fresh = loadAgentsConfig()
    const freshSpec = fresh.agents.find((a) => a.id === 'spec')
    expect(freshSpec?.name).toBe('Spec Agent (edited)')
  })

  it('agentId 不存在 → getAgentConfig 抛 INTERNAL', () => {
    seed(FIXTURE_VALID)
    expect(() => agentsModule.getAgentConfig('does-not-exist')).toThrow(/not found/i)
  })
})
