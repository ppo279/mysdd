// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// 改读 DB 后行为说明：
// - loadAgentsConfig() 不再读 agents.yaml；改为读 runtimes / base_layers / agents 三张表。
// - 返回的对象形状仍是 AgentsYaml（runtimes / global.base_layers / agents），与之前一致；
//   ConfigView GET 拿到的 data 直接就是 yaml 形状，前端无感。
// - clearCache() 清掉 in-memory 缓存；调用方（routes/config.ts PUT）须额外 clearRuntimeCache()。
// - 启动期：index.ts 先 initDb() 再 seedAgentsFromYaml()（seed 在 agents 表为空时把 yaml 写入）；
//   loadAgentsConfig 永远在 seed 之后被调用，读到的是 DB 里的最新数据。

import { asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { runtimes, baseLayers, agents } from '../db/schema.js'
import { BizError, Code } from '../lib/envelope.js'

// Implements: docs/adr/0001-workflow-execution-model.md
// Phase 2 起：每个 agent 可声明 per-agent 的 runtime config（DB 级默认）；
// workflow_nodes.config_json（per-node 覆盖）在 services/agent.ts 中优先。
export interface AgentRuntimeConfig {
  // 覆盖 agents 表中 agent.runtime_id 字段；用于"同一个 agent 偶尔切到不同 CLI"
  runtimeId?: string
  // 透传给 spawn 的环境变量。Phase 2 不做去重 / 优先级——直接 merge 到 process.env
  env?: Record<string, string>
  // 覆盖自动计算的 <localPath>/repo 工作目录；必须落在 workspace base 内（routes/workspaces.ts 守卫）
  cwd?: string
  // 子进程超时（ms）；超时触发后由 runtime adapter 调 proc.kill()
  timeoutMs?: number
  // Implements: docs/prds/per-agent-tool-restriction.md / docs/issues/002
  // 逗号分隔字符串，透传给 CLI 的 --disallowedTools（当前仅 Claude 支持）。
  // 空串等价于 undefined（normalizeCsv 归一化）；CLI 偶发 " Bash " 等前后空白由调用方 trim。
  disallowedTools?: string
}

// Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
// slice 03 起：`AgentConfig` 接口新增 `inputs` / `outputs` 字段。
// - 形状固定 `string[]`；DB 存为 JSON 文本（agents.inputs_json / outputs_json）。
// - 缺省 `[]`（slice 07 起；之前是 `['default']`，但与端口契约语义冲突——
//   缺省应当表示"agent 没声明任何 port"，而不是"agent 有一个 default port"）。
// - 这两个字段是 workflow 端口校验的真相之源（routes/workflows.ts 的 PATCH /:id/graph
//   用 `target_node.agent.inputs` 校验 `edge.to_input`、用 `source_node.agent.outputs`
//   校验 `edge.from_output`）。
export interface AgentConfig {
  id: string
  name: string
  runtime: string
  instruction: string
  outputFile: string
  // Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
  /** 声明的输入 handle 名字列表。运行时通过 workflow_edges.to_input 对齐。 */
  inputs: string[]
  /** 声明的输出 handle 名字列表。运行时通过 workflow_edges.from_output 对齐。 */
  outputs: string[]
  // Implements: spec.md#BI-07 / plan.md#D-03 / tasks.md#T008
  // DB agents.memory_sediment（0/1）；缺省 false，仅 true 允许写 memory/.draft/
  memory_sediment?: boolean
  // Phase 2: per-agent runtime config（DB 级默认；workflow_nodes.config_json 覆盖之）
  config?: AgentRuntimeConfig
}

export interface RuntimeConfig {
  id: string
  type: string
  command?: string
}

export interface BaseLayer {
  name: string
  content: string
}

export interface GlobalConfig {
  base_layers: BaseLayer[]
}

export interface AgentsYaml {
  runtimes: RuntimeConfig[]
  global: GlobalConfig
  agents: AgentConfig[]
}

let _config: AgentsYaml | null = null

// Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
// (slice 07: 缺省归一化从 ['default'] 改为 []，理由见 issue 07 顶部)
// 严格解析：JSON.parse 失败、非数组、或含任何非字符串元素都返回 null，
// 让调用方归一化为 []。这与 routes/config.ts PUT 写的形状对齐
// （PUT 写入 JSON.stringify([]) 或 JSON.stringify(string[])）。
// 这里不用 zod 是因为单测时希望解析失败静默归一化，而不是抛错把 loadAgentsConfig 整个搞挂。
function parseStringArray(raw: string): string[] | null {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!Array.isArray(parsed)) return null
  for (const x of parsed) if (typeof x !== 'string') return null
  return parsed as string[]
}

export function clearCache() {
  _config = null
}

/**
 * 把 DB 当前内容序列化为 yaml 形状的 AgentsYaml。
 * - runtimes 按 id 升序（确定性顺序，PUT 写回后形状不变）
 * - base_layers 按 position 升序（保持拼接顺序）
 * - agents 按 id 升序
 *
 * 字段缺失/JSON 解析失败时静默归一化为空值（db 已是 source of truth，不应抛错）。
 */
export function loadAgentsConfig(): AgentsYaml {
  if (_config) return _config

  const rts = db.select().from(runtimes).orderBy(asc(runtimes.id)).all()
  const bls = db.select().from(baseLayers).orderBy(asc(baseLayers.position)).all()
  const ags = db.select().from(agents).orderBy(asc(agents.id)).all()

  _config = {
    runtimes: rts.map((r) => ({ id: r.id, type: r.type, command: r.command || undefined })),
    global: {
      base_layers: bls.map((b) => ({ name: b.name, content: b.content })),
    },
    agents: ags.map((a) => {
      let cfg: AgentRuntimeConfig | undefined
      try {
        const parsed = JSON.parse(a.configJson)
        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
          cfg = parsed as AgentRuntimeConfig
        }
      } catch { /* malformed json → leave cfg undefined */ }
      // Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
      // (slice 07: 缺省归一化从 ['default'] 改为 [])
      // DB 存的 inputs_json / outputs_json 是 JSON 文本；解析失败或非字符串数组时
      // 归一化为 []——"缺省 = agent 没声明任何 port" 的语义。
      const inputs = parseStringArray(a.inputsJson) ?? []
      const outputs = parseStringArray(a.outputsJson) ?? []
      return {
        id: a.id,
        name: a.name,
        runtime: a.runtimeId,
        instruction: a.instruction,
        // outputFile 字段：DB 不存——保留旧 yaml 形状，置空串。
        // 已有调用方（services/agent.ts 等）通过 agent.id 拿产物，不依赖此字段。
        outputFile: '',
        inputs,
        outputs,
        memory_sediment: a.memorySediment === 1,
        config: cfg,
      }
    }),
  }

  return _config
}

export function getAgentConfig(agentId: string): AgentConfig {
  const config = loadAgentsConfig()
  const agent = config.agents.find((a) => a.id === agentId)
  if (!agent) {
    throw new BizError(
      Code.INTERNAL,
      `Agent "${agentId}" not found in agents table`,
      500,
    )
  }
  return agent
}

export interface FeatureContext {
  /** Feature 名称 → 替换 [项目名称] */
  name: string
  /** 首条用户消息 → 替换 [想法描述] */
  description: string
  /** 任务模式（来自 feature.description 字段）→ 替换 [任务模式] */
  mode?: string
}

// ── 系统提示拼装（三层）────────────────────────────────────────
// Layer 1: global.base_layers（所有 Agent 共享，DB 里顺序由 position 决定）
// Layer 2: agent instruction（DB agents.instruction）- 占位符 [项目名称] [想法描述] [任务模式] 被替换
// Layer 3: workspace 背景（运行时注入）
export function buildSystemPrompt(
  agentId: string,
  _techStack: string,
  workspaceBackground: string,
  featureCtx?: FeatureContext,
): string {
  const { global: globalCfg } = loadAgentsConfig()
  const agent = getAgentConfig(agentId)

  const parts: string[] = []

  // Layer 1: 基础层
  for (const layer of globalCfg.base_layers) {
    if (layer.content?.trim()) parts.push(layer.content)
  }

  // Layer 2: 角色层（替换占位符）
  if (agent.instruction.trim()) {
    let instruction = agent.instruction
    if (featureCtx) {
      instruction = instruction
        .replaceAll('[项目名称]', featureCtx.name)
        .replaceAll('[想法描述]', featureCtx.description || featureCtx.name)
        .replaceAll('[任务模式]', featureCtx.mode ?? '')
    }
    parts.push(instruction)
  }

  // Layer 3: 运行时背景
  if (workspaceBackground.trim()) {
    parts.push(`## Workspace 背景信息\n\n${workspaceBackground}`)
  }

  return parts.join('\n\n---\n\n')
}

/**
 * 上游产物注入（按 workflow_edges 的 toInput 聚合）。
 * 输入：AgentService.collectUpstreamArtifacts 的返回。
 * 每个上游产物以 ## 上游产物 (fromNodeId · fromOutput) 为标题，
 * 内容置于三反引号代码块中。
 *
 * Phase 3 起：分组按 `toInput` 渲染——一个 input 名字一个 ### 小节，
 * 内部列出所有 (fromNodeId · fromOutput) → content 的贡献。
 * 之前用 fromNodeId 单一标题的方式已被替换：现在下游看到的是"我
 * 的 input X 收到了什么"，而不是"哪些 node 给我东西"——这更贴近
 * I/O 3 决策里 input 作为命名插槽的语义。
 */
export interface UpstreamArtifact {
  fromNodeId: string
  agentId: string
  fromOutput: string
  toInput: string
  content: string
}

export function buildEdgeBasedContext(artifacts: UpstreamArtifact[]): string {
  if (artifacts.length === 0) return ''
  // 按 toInput 分组（保持 artifacts 的原始顺序作为 input 内顺序）
  const groups = new Map<string, UpstreamArtifact[]>()
  for (const a of artifacts) {
    const list = groups.get(a.toInput) ?? []
    list.push(a)
    groups.set(a.toInput, list)
  }
  const sections: string[] = []
  for (const [toInput, items] of groups) {
    const inner = items.map((a) => {
      const subtitle = `- 来自 \`${a.fromNodeId}\` / output \`${a.fromOutput}\``
      return `${subtitle}\n\n\`\`\`\n${a.content}\n\`\`\``
    })
    sections.push(`### input \`${toInput}\`\n\n${inner.join('\n\n')}`)
  }
  return `\n---\n## 上游产物\n\n${sections.join('\n\n')}`
}

// Implements: spec.md#BI-07 / plan.md#D-03 / tasks.md#T008
// 返回声明 memory_sediment: true 的 agent id 列表。
// 供 agent.ts 在 sendMessage 末尾判定是否沉淀记忆以及沉淀到哪个文件。
export function getSedimentEnabledAgents(): string[] {
  return loadAgentsConfig()
    .agents
    .filter((a) => a.memory_sediment === true)
    .map((a) => a.id)
}
