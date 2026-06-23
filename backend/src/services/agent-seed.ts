// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md, .scratch/agent-contract-db/issues/05-yaml-cleanup.md
// （历史）slice 02 把 agents.yaml 一次性迁到 DB；slice 05 删除启动期 yaml 读取路径。
// 本模块仅保留 test seam：把 fixture 直接以 TS 对象形式传入，绕开字符串解析。
//
// - seedAgentsFixture(fixture)：单元测试注入 fixture 对象→走与生产相同的写入路径
// - clearAgentsTables()：单元测试重置 DB
//
// 生产路径已彻底切到 DB（config/agents.ts 的 loadAgentsConfig 从 agents 表读）；
// 启动期 index.ts 不再读 agents.yaml；js-yaml 依赖也随之移除。

import { asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { runtimes, baseLayers, artifactTypes, agents } from '../db/schema.js'

/** 测试 fixture 形状（与生产 yaml 形状 1:1 对齐；少了一个 output_file 字段）。 */
export interface AgentsFixture {
  runtimes: Array<{ id: string; type: string; command?: string }>
  global: {
    base_layers: Array<{ name: string; content: string }>
    // Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
    artifact_types?: Array<{ id: string; name?: string; schema_ref?: string }>
  }
  agents: Array<{
    id: string
    name?: string
    runtime: string
    instruction?: string
    output_file?: string
    memory_sediment?: boolean
    config?: Record<string, unknown>
    inputs?: string[]
    outputs?: string[]
    // Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
    tools?: { reads?: string[]; writes?: string[] }
  }>
}

/**
 * 把 fixture 对象写入三张表。
 * 使用 better-sqlite3 同步 transaction：失败回滚到调用前状态。
 *
 * INSERT 顺序：runtimes → base_layers → artifact_types → agents（agents 有 FK runtime_id）。
 * 不写 ON CONFLICT：若半成品存在先 DELETE 三表清场再 INSERT——避免 FK 顺序问题。
 */
function writeAllToDb(data: AgentsFixture, now: Date): void {
  db.transaction((tx) => {
    // DELETE 顺序：agents 先（FK 引用 runtimes）→ artifact_types → base_layers → runtimes。
    // 反过来 DELETE FROM runtimes 会被 FK RESTRICT 拦下。
    tx.delete(agents).run()
    tx.delete(artifactTypes).run()
    tx.delete(baseLayers).run()
    tx.delete(runtimes).run()

    for (const r of data.runtimes) {
      tx.insert(runtimes).values({ id: r.id, type: r.type, command: r.command ?? '' }).run()
    }

    let blPos = 0
    for (const b of data.global.base_layers) {
      tx.insert(baseLayers).values({
        id: crypto.randomUUID(),
        name: b.name,
        content: b.content,
        position: blPos++,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    // Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
    let atPos = 0
    for (const t of data.global.artifact_types ?? []) {
      tx.insert(artifactTypes).values({
        id: t.id,
        name: t.name ?? t.id,
        schemaRef: t.schema_ref ?? null,
        position: atPos++,
        createdAt: now,
        updatedAt: now,
      }).run()
    }

    for (const a of data.agents) {
      // 字段类型校验（fail-fast，与 slice 02 一致）。
      if (typeof a.id !== 'string' || !a.id) throw new Error('fixture: each agent must have a non-empty `id`')
      if (typeof a.runtime !== 'string' || !a.runtime) throw new Error(`fixture: agent "${a.id}" has missing/empty \`runtime\``)
      if (a.memory_sediment !== undefined && typeof a.memory_sediment !== 'boolean') {
        throw new Error(`fixture: agent "${a.id}" memory_sediment must be boolean or undefined (got ${typeof a.memory_sediment})`)
      }
      if (a.config !== undefined) validateAgentConfigShape(a.id, a.config)
      // Slice 1a: tools 形状校验（fail-fast：read/write 必须是字符串数组）
      validateAgentToolsShape(a.id, a.tools)

      tx.insert(agents).values({
        id: a.id,
        name: a.name ?? a.id,
        runtimeId: a.runtime,
        instruction: a.instruction ?? '',
        // slice 07：缺省归一化为 []（"agent 没声明任何 port" 的语义）。
        inputsJson: JSON.stringify(a.inputs ?? []),
        outputsJson: JSON.stringify(a.outputs ?? []),
        memorySediment: a.memory_sediment ? 1 : 0,
        configJson: JSON.stringify(a.config ?? {}),
        // Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
        toolsReadsJson: JSON.stringify(a.tools?.reads ?? []),
        toolsWritesJson: JSON.stringify(a.tools?.writes ?? []),
        createdAt: now,
        updatedAt: now,
      }).run()
    }
  })
}

// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02 / Phase 2) / 001
// 校验 config 形状：runtimeId / env / cwd / timeoutMs / disallowedTools。
// 与 config/agents.ts 内 AgentRuntimeConfigSchema 一致形状。
// 此处单独写避免跨模块循环依赖。
function validateAgentConfigShape(agentId: string, v: unknown): void {
  if (!v || typeof v !== 'object') {
    throw new Error(`fixture: agent "${agentId}" has invalid \`config\` shape`)
  }
  const obj = v as Record<string, unknown>
  if (obj.runtimeId !== undefined && typeof obj.runtimeId !== 'string') {
    throw new Error(`fixture: agent "${agentId}" config.runtimeId must be string`)
  }
  if (obj.env !== undefined) {
    if (!obj.env || typeof obj.env !== 'object') {
      throw new Error(`fixture: agent "${agentId}" config.env must be object`)
    }
    for (const [k, val] of Object.entries(obj.env)) {
      if (typeof k !== 'string' || typeof val !== 'string') {
        throw new Error(`fixture: agent "${agentId}" config.env values must be string`)
      }
    }
  }
  if (obj.cwd !== undefined && typeof obj.cwd !== 'string') {
    throw new Error(`fixture: agent "${agentId}" config.cwd must be string`)
  }
  if (obj.timeoutMs !== undefined && (typeof obj.timeoutMs !== 'number' || !Number.isInteger(obj.timeoutMs) || obj.timeoutMs <= 0)) {
    throw new Error(`fixture: agent "${agentId}" config.timeoutMs must be positive integer`)
  }
  // 001: disallowedTools 必须为字符串
  if (obj.disallowedTools !== undefined && obj.disallowedTools !== null && typeof obj.disallowedTools !== 'string') {
    throw new Error(`fixture: agent "${agentId}" config.disallowedTools must be string`)
  }
}

// Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
// 校验 tools 形状：reads/writes 必须是字符串数组（undefined 视为 []）。
// cross-ref 校验（必须 ∈ global.artifact_types）留给 Slice 1b 的 zod .superRefine()。
function validateAgentToolsShape(agentId: string, v: unknown): void {
  if (v === undefined) return
  if (!v || typeof v !== 'object') {
    throw new Error(`fixture: agent "${agentId}" has invalid \`tools\` shape`)
  }
  const obj = v as Record<string, unknown>
  if (obj.reads !== undefined) {
    if (!Array.isArray(obj.reads) || !obj.reads.every((x) => typeof x === 'string')) {
      throw new Error(`fixture: agent "${agentId}" tools.reads must be string[]`)
    }
  }
  if (obj.writes !== undefined) {
    if (!Array.isArray(obj.writes) || !obj.writes.every((x) => typeof x === 'string')) {
      throw new Error(`fixture: agent "${agentId}" tools.writes must be string[]`)
    }
  }
}

/**
 * 单元测试 / 集成测试用：注入一个 fixture 对象，走与生产相同的写入路径。
 * 总是强制写（先清空三表）。
 */
export function seedAgentsFixture(fixture: AgentsFixture): boolean {
  const now = new Date()
  writeAllToDb(fixture, now)
  return true
}

/**
 * 单测 / 集成用：清空四张表。便于每个测试重置。
 */
export function clearAgentsTables(): void {
  db.transaction((tx) => {
    tx.delete(agents).run()
    tx.delete(artifactTypes).run()
    tx.delete(baseLayers).run()
    tx.delete(runtimes).run()
  })
}

/**
 * 单元测试用：把 DB 当前内容序列化成 yaml 形状（与 ConfigView GET 形状一致）。
 * 不持久化文件——仅用于测试比对。
 *
 * slice 05 起：保留同样的形状签名，让 agent-seed.test.ts / routes/config.test.ts
 * 不必改测试断言。
 */
export function loadAgentsFromDb(): AgentsFixture & {
  agents: Array<AgentsFixture['agents'][number] & { output_file: string }>
} {
  const rts = db.select().from(runtimes).orderBy(asc(runtimes.id)).all()
  const bls = db.select().from(baseLayers).orderBy(asc(baseLayers.position)).all()
  const ats = db.select().from(artifactTypes).orderBy(asc(artifactTypes.position)).all()
  const ags = db.select().from(agents).orderBy(asc(agents.id)).all()
  return {
    runtimes: rts.map((r) => ({ id: r.id, type: r.type, command: r.command })),
    global: {
      base_layers: bls.map((b) => ({ name: b.name, content: b.content })),
      // Implements: docs/prds/agent-side-output-via-mcp.md (Slice 1a)
      artifact_types: ats.map((t) => ({
        id: t.id,
        name: t.name,
        schema_ref: t.schemaRef ?? undefined,
      })),
    },
    agents: ags.map((a) => {
      // slice 07：缺省归一化为 []（"agent 没声明任何 port" 的语义）。
      let inputs: string[] = []
      let outputs: string[] = []
      let config: Record<string, unknown> = {}
      // Slice 1a：tools.reads/writes 同模式归一化。
      let reads: string[] = []
      let writes: string[] = []
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
      try {
        const parsedReads = JSON.parse(a.toolsReadsJson)
        if (Array.isArray(parsedReads)) reads = parsedReads.filter((x): x is string => typeof x === 'string')
      } catch { /* fall back to default */ }
      try {
        const parsedWrites = JSON.parse(a.toolsWritesJson)
        if (Array.isArray(parsedWrites)) writes = parsedWrites.filter((x): x is string => typeof x === 'string')
      } catch { /* fall back to default */ }
      // 仅当非空时返回 tools 字段（与"未声明 = 老语义"对齐）
      const tools = (reads.length > 0 || writes.length > 0)
        ? { reads, writes }
        : undefined
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
        tools,
      }
    }),
  }
}