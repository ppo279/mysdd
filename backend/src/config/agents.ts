import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { fileURLToPath } from 'url'
import { BizError, Code } from '../lib/envelope.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

// Implements: docs/adr/0001-workflow-execution-model.md
// Phase 2 起：每个 agent 可声明 per-agent 的 runtime config（YAML 级默认）；
// workflow_nodes.config_json（per-node 覆盖）在 services/agent.ts 中优先。
export interface AgentRuntimeConfig {
  // 覆盖 agents.yaml 中 agent.runtime 字段；用于"同一个 agent 偶尔切到不同 CLI"
  runtimeId?: string
  // 透传给 spawn 的环境变量。Phase 2 不做去重 / 优先级——直接 merge 到 process.env
  env?: Record<string, string>
  // 覆盖自动计算的 <localPath>/repo 工作目录；必须落在 workspace base 内（routes/workspaces.ts 守卫）
  cwd?: string
  // 子进程超时（ms）；超时触发后由 runtime adapter 调 proc.kill()
  timeoutMs?: number
}

export interface AgentConfig {
  id: string
  name: string
  runtime: string
  instruction: string
  outputFile: string
  // Implements: spec.md#BI-07 / plan.md#D-03 / tasks.md#T008
  // agents.yaml 中显式声明的"记忆沉淀"职责；缺省 false，仅 true 允许写 memory/.draft/
  memory_sediment?: boolean
  // Phase 2: per-agent runtime config（YAML 级默认；workflow_nodes.config_json 覆盖之）
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

// Implements: spec.md#AC-06 / plan.md#D-03 / tasks.md#T008
// memory_sediment 字段类型校验：仅 boolean | undefined；非此抛错（启动期 fail-fast）
const MemorySedimentSchema = z.boolean().optional()

// Phase 2: per-agent runtime config 的 zod schema。
// - runtimeId: 字符串（解析期校验是否在 runtimes[] 中；此处只查类型，避免启动期与 config/routes/config.ts 形成循环依赖）
// - env: 字符串 k/v map
// - cwd: 字符串（路径合法性由 routes 层 assertWithinWorkspaceBase 守卫，配置层不重复）
// - timeoutMs: 正整数
const AgentRuntimeConfigSchema = z.object({
  runtimeId: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
}).optional()

let _config: AgentsYaml | null = null

export function clearCache() {
  _config = null
}

export function loadAgentsConfig(): AgentsYaml {
  if (_config) return _config

  const yamlPath = path.resolve(ROOT, 'agents.yaml')
  const raw = fs.readFileSync(yamlPath, 'utf-8')
  const parsed = yaml.load(raw) as Record<string, unknown>

  const globalRaw = (parsed.global ?? {}) as Record<string, unknown>

  const agentsRaw = (parsed.agents as Array<Record<string, unknown>>) ?? []
  // 启动期 fail-fast：校验每个 agent 的 memory_sediment 类型 + Phase 2 的 config 字段类型
  for (const a of agentsRaw) {
    if (!MemorySedimentSchema.safeParse(a.memory_sediment).success) {
      throw new BizError(
        Code.YAML_INVALID,
        `Invalid memory_sediment in agent "${String(a.id)}": must be boolean or undefined ` +
        `(got ${typeof a.memory_sediment})`,
        500,
      )
    }
    const cfgRes = AgentRuntimeConfigSchema.safeParse(a.config)
    if (!cfgRes.success) {
      throw new BizError(
        Code.YAML_INVALID,
        `Invalid config in agent "${String(a.id)}": ${cfgRes.error.issues.map((i) => i.message).join('; ')}`,
        500,
      )
    }
  }

  _config = {
    runtimes: (parsed.runtimes as RuntimeConfig[]) ?? [],
    global: {
      base_layers: (globalRaw.base_layers as BaseLayer[]) ?? [],
    },
    agents: agentsRaw.map((a) => {
      const cfg = AgentRuntimeConfigSchema.parse(a.config) as AgentRuntimeConfig | undefined
      return {
        id: a.id as string,
        name: a.name as string,
        runtime: a.runtime as string,
        instruction: (a.instruction as string) ?? '',
        outputFile: a.output_file as string,
        memory_sediment: (a.memory_sediment as boolean | undefined) ?? false,
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
      `Agent "${agentId}" not found in agents.yaml`,
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
// Layer 1: global.base_layers（所有 Agent 共享，inline 内容）
// Layer 2: agent instruction（inline 内容）- 占位符 [项目名称] [想法描述] [任务模式] 被替换
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
