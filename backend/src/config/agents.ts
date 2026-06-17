import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

export interface AgentConfig {
  id: string
  name: string
  runtime: string
  instruction: string
  outputFile: string
  upstream: string[]
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

export function clearCache() {
  _config = null
}

export function loadAgentsConfig(): AgentsYaml {
  if (_config) return _config

  const yamlPath = path.resolve(ROOT, 'agents.yaml')
  const raw = fs.readFileSync(yamlPath, 'utf-8')
  const parsed = yaml.load(raw) as Record<string, unknown>

  const globalRaw = (parsed.global ?? {}) as Record<string, unknown>

  _config = {
    runtimes: (parsed.runtimes as RuntimeConfig[]) ?? [],
    global: {
      base_layers: (globalRaw.base_layers as BaseLayer[]) ?? [],
    },
    agents: (parsed.agents as Array<Record<string, unknown>>).map((a) => ({
      id: a.id as string,
      name: a.name as string,
      runtime: a.runtime as string,
      instruction: (a.instruction as string) ?? '',
      outputFile: a.output_file as string,
      upstream: (a.upstream as string[]) ?? [],
    })),
  }

  return _config
}

export function getAgentConfig(agentId: string): AgentConfig {
  const config = loadAgentsConfig()
  const agent = config.agents.find((a) => a.id === agentId)
  if (!agent) throw new Error(`Agent "${agentId}" not found in agents.yaml`)
  return agent
}

export interface FeatureContext {
  name: string
  description: string
}

// ── 系统提示拼装（三层）────────────────────────────────────────
// Layer 1: global.base_layers（所有 Agent 共享，inline 内容）
// Layer 2: agent instruction（inline 内容）- 占位符 [项目名称] [想法描述] 被替换
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
    }
    parts.push(instruction)
  }

  // Layer 3: 运行时背景
  if (workspaceBackground.trim()) {
    parts.push(`## Workspace 背景信息\n\n${workspaceBackground}`)
  }

  return parts.join('\n\n---\n\n')
}

// 上游产物注入（在 Layer 3 之后追加）
export function buildUpstreamContext(agentId: string, artifacts: Record<string, string>): string {
  const agent = getAgentConfig(agentId)
  if (agent.upstream.length === 0) return ''

  const sections = agent.upstream
    .filter((upId) => artifacts[upId])
    .map((upId) => {
      const cfg = getAgentConfig(upId)
      return `### 已确认的 ${cfg.outputFile}\n\n${artifacts[upId]}`
    })

  if (sections.length === 0) return ''
  return `\n---\n## 上游产物\n\n${sections.join('\n\n')}`
}
