// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// 启动期 seeder：若 agents 表为空且 agents.yaml 存在 → 一次性把 yaml 三段
//（runtimes / global.base_layers / agents）写入 DB。
//
// 关键设计：
// - 哨兵：仅看 `agents` 表是否为空。runtimes/base_layers 不参与判断——
//   若半成品（runtimes 已写、agents 中途崩）下次启动仍会重新 seed 一遍（清空三表再写）。
// - 事务：DELETE FROM 三表 → INSERT 新数据，全程包在 `db.transaction` 里。
//   失败回滚到 seeder 之前的状态，DB 不留半成品。
// - 幂等：再次调用时 agents 表非空 → 直接返回，不读 yaml、不写 DB。
// - 启动期 fail-fast：yaml 解析失败、写入失败都向外抛，由 index.ts 让进程非零退出。
//
// yaml 文件不存在：no-op（不抛错）—— issue 02 验收 AC「删 yaml 后启动 → DB 数据保留」。

import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { eq, asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { runtimes, baseLayers, agents } from '../db/schema.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const YAML_PATH = path.join(ROOT, 'agents.yaml')

// Implements: spec.md#AC-06 / plan.md#D-03
// memory_sediment 字段类型校验：仅 boolean | undefined；非此抛错（启动期 fail-fast）。
// 与 config/agents.ts 中 MemorySedimentSchema 同步——此处单独写避免跨模块循环依赖。
function isValidMemorySediment(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean'
}

// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02 / Phase 2)
// config 字段类型校验；同 config/agents.ts 内 AgentRuntimeConfigSchema 一致形状。
function isValidConfig(v: unknown): boolean {
  if (v === undefined) return true
  if (!v || typeof v !== 'object') return false
  const obj = v as Record<string, unknown>
  if (obj.runtimeId !== undefined && typeof obj.runtimeId !== 'string') return false
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object') return false
    for (const [k, val] of Object.entries(obj.env)) {
      if (typeof k !== 'string' || typeof val !== 'string') return false
    }
  }
  if (obj.cwd !== undefined && typeof obj.cwd !== 'string') return false
  if (obj.timeoutMs !== undefined && (typeof obj.timeoutMs !== 'number' || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs <= 0)) return false
  // 001: disallowedTools 必须为字符串（空串由调用方归一化）
  if (obj.disallowedTools !== undefined && obj.disallowedTools !== null && typeof obj.disallowedTools !== 'string') return false
  return true
}

/**
 * 把 yaml 内容解析为内部形状；启动期校验失败直接抛错（fail-fast）。
 * 形状：
 *   {
 *     runtimes: Array<{ id, type, command? }>,
 *     base_layers: Array<{ name, content }>,
 *     agents: Array<{
 *       id, name, runtime, instruction, output_file,
 *       memory_sediment?, config?, inputs?, outputs?
 *     }>
 *   }
 */
function parseYaml(raw: string): {
  runtimes: Array<{ id: string; type: string; command: string }>
  base_layers: Array<{ name: string; content: string }>
  agents: Array<{
    id: string
    name: string
    runtime: string
    instruction: string
    output_file: string
    memory_sediment: boolean
    config: Record<string, unknown>
    inputs: string[]
    outputs: string[]
  }>
} {
  const parsed = yaml.load(raw) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('agents.yaml is empty or not an object')
  }

  const runtimesRaw = (parsed.runtimes as Array<Record<string, unknown>>) ?? []
  if (!Array.isArray(runtimesRaw)) throw new Error('agents.yaml: `runtimes` must be an array')

  const globalRaw = (parsed.global ?? {}) as Record<string, unknown>
  const baseLayersRaw = (globalRaw.base_layers as Array<Record<string, unknown>>) ?? []
  if (!Array.isArray(baseLayersRaw)) throw new Error('agents.yaml: `global.base_layers` must be an array')

  const agentsRaw = (parsed.agents as Array<Record<string, unknown>>) ?? []
  if (!Array.isArray(agentsRaw)) throw new Error('agents.yaml: `agents` must be an array')

  // 校验每个 agent 的字段类型（启动期 fail-fast，与 config/agents.ts 同步）
  for (const a of agentsRaw) {
    if (typeof a.id !== 'string' || !a.id) throw new Error('agents.yaml: each agent must have a non-empty `id`')
    if (typeof a.runtime !== 'string' || !a.runtime) throw new Error(`agents.yaml: agent "${String(a.id)}" has missing/empty \`runtime\``)
    if (!isValidMemorySediment(a.memory_sediment)) {
      throw new Error(`agents.yaml: agent "${String(a.id)}" memory_sediment must be boolean or undefined (got ${typeof a.memory_sediment})`)
    }
    if (!isValidConfig(a.config)) {
      throw new Error(`agents.yaml: agent "${String(a.id)}" has invalid \`config\` shape`)
    }
  }
  // 校验 runtimes 字段类型
  for (const r of runtimesRaw) {
    if (typeof r.id !== 'string' || !r.id) throw new Error('agents.yaml: each runtime must have a non-empty `id`')
    if (typeof r.type !== 'string' || !r.type) throw new Error(`agents.yaml: runtime "${String(r.id)}" has missing/empty \`type\``)
  }

  return {
    runtimes: runtimesRaw.map((r) => ({
      id: r.id as string,
      type: r.type as string,
      command: typeof r.command === 'string' ? r.command : '',
    })),
    base_layers: baseLayersRaw.map((b) => ({
      name: typeof b.name === 'string' ? b.name : '',
      content: typeof b.content === 'string' ? b.content : '',
    })),
    agents: agentsRaw.map((a) => ({
      id: a.id as string,
      name: typeof a.name === 'string' ? a.name : a.id as string,
      runtime: a.runtime as string,
      instruction: typeof a.instruction === 'string' ? a.instruction : '',
      output_file: typeof a.output_file === 'string' ? a.output_file : '',
      memory_sediment: a.memory_sediment === true,
      config: (a.config && typeof a.config === 'object' ? a.config : {}) as Record<string, unknown>,
      // slice 07：缺省归一化从 ['default'] 改为 []（"agent 没声明任何 port" 的语义）。
      inputs: Array.isArray(a.inputs) ? (a.inputs as unknown[]).filter((x): x is string => typeof x === 'string') : [],
      outputs: Array.isArray(a.outputs) ? (a.outputs as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    })),
  }
}

/**
 * 把解析后的 yaml 数据写入三张表。
 * 使用 better-sqlite3 同步 transaction：失败回滚到调用前状态。
 *
 * INSERT 顺序：runtimes → base_layers → agents（agents 有 FK runtime_id）。
 * 不写 ON CONFLICT：若半成品存在先 DELETE 三表清场再 INSERT——避免 FK 顺序问题。
 */
function writeAllToDb(data: ReturnType<typeof parseYaml>, now: Date): void {
  db.transaction((tx) => {
    // DELETE 顺序：agents 先（FK 引用 runtimes）→ base_layers → runtimes。
    // 反过来 DELETE FROM runtimes 会被 FK RESTRICT 拦下。
    tx.delete(agents).run()
    tx.delete(baseLayers).run()
    tx.delete(runtimes).run()

    for (const r of data.runtimes) {
      tx.insert(runtimes).values({ id: r.id, type: r.type, command: r.command }).run()
    }

    let pos = 0
    for (const b of data.base_layers) {
      tx.insert(baseLayers).values({
        id: crypto.randomUUID(),
        name: b.name,
        content: b.content,
        position: pos++,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    for (const a of data.agents) {
      tx.insert(agents).values({
        id: a.id,
        name: a.name,
        runtimeId: a.runtime,
        instruction: a.instruction,
        inputsJson: JSON.stringify(a.inputs),
        outputsJson: JSON.stringify(a.outputs),
        memorySediment: a.memory_sediment ? 1 : 0,
        configJson: JSON.stringify(a.config),
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
}

/**
 * 启动期 seeder。返回是否实际写入了数据（true = 已 seed，false = no-op）。
 *
 * - agents 表非空 → 直接返回 false（幂等）。
 * - agents.yaml 不存在 → 直接返回 false（向后兼容：删 yaml 也能跑）。
 * - yaml 解析失败 / DB 写入失败 → 抛错（启动期 fail-fast）。
 *
 * @param yamlPath  可选：覆盖默认 YAML_PATH（用于测试不存在的 yaml 路径）。
 */
export function seedAgentsFromYaml(yamlPath: string = YAML_PATH): boolean {
  const existing = db.select().from(agents).orderBy(asc(agents.id)).all()
  if (existing.length > 0) return false

  if (!fs.existsSync(yamlPath)) return false

  const raw = fs.readFileSync(yamlPath, 'utf-8')
  const data = parseYaml(raw)
  const now = new Date()

  writeAllToDb(data, now)
  return true
}

/**
 * 单元测试 / 集成测试用：注入一段 yaml 文本，走与生产相同的解析与写入路径。
 * 总是强制写（先清空三表）—— 用于 `agent-seed.test.ts` 的 "fresh DB" 用例。
 */
export function seedAgentsFromYamlString(rawYaml: string): boolean {
  const data = parseYaml(rawYaml)
  const now = new Date()
  writeAllToDb(data, now)
  return true
}

/**
 * 单测 / 集成用：清空三张表。便于每个测试重置。
 */
export function clearAgentsTables(): void {
  db.transaction((tx) => {
    tx.delete(agents).run()
    tx.delete(baseLayers).run()
    tx.delete(runtimes).run()
  })
}

/**
 * 单元测试用：暴露 yaml 路径常量。
 */
export const YAML_PATH_FOR_TESTS = YAML_PATH

/**
 * 把 DB 当前内容序列化成 yaml 形状（PUT 校验 / 测试比对）。
 * 形状与原 yaml 严格一致；不持久化文件——仅用于读路径 / 测试。
 */
export function loadAgentsFromDb(): {
  runtimes: Array<{ id: string; type: string; command: string }>
  global: { base_layers: Array<{ name: string; content: string }> }
  agents: Array<{
    id: string
    name: string
    runtime: string
    instruction: string
    output_file: string
    memory_sediment: boolean
    config: Record<string, unknown>
    inputs: string[]
    outputs: string[]
  }>
} {
  const rts = db.select().from(runtimes).orderBy(asc(runtimes.id)).all()
  const bls = db.select().from(baseLayers).orderBy(asc(baseLayers.position)).all()
  const ags = db.select().from(agents).orderBy(asc(agents.id)).all()
  return {
    runtimes: rts.map((r) => ({ id: r.id, type: r.type, command: r.command })),
    global: {
      base_layers: bls.map((b) => ({ name: b.name, content: b.content })),
    },
    agents: ags.map((a) => {
      // slice 07：缺省归一化从 ['default'] 改为 []（"agent 没声明任何 port" 的语义）。
      let inputs: string[] = []
      let outputs: string[] = []
      let config: Record<string, unknown> = {}
      try {
        const parsedInputs = JSON.parse(a.inputsJson)
        if (Array.isArray(parsedInputs)) inputs = parsedInputs.filter((x): x is string => typeof x === 'string')
      } catch { /* fall back to default */ }
      try {
        const parsedOutputs = JSON.parse(a.outputsJson)
        if (Array.isArray(parsedOutputs)) outputs = parsedOutputs.filter((x): x is string => typeof x === 'string')
      } catch { /* fall back to default */ }
      try {
        const parsedConfig = JSON.parse(a.configJson)
        if (parsedConfig && typeof parsedConfig === 'object') config = parsedConfig as Record<string, unknown>
      } catch { /* fall back to default */ }
      return {
        id: a.id,
        name: a.name,
        runtime: a.runtimeId,
        instruction: a.instruction,
        output_file: '',
        memory_sediment: a.memorySediment === 1,
        config,
        inputs,
        outputs,
      }
    }),
  }
}
