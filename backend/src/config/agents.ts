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
  prompt?: string
  prompts?: Record<string, string>
  outputFile: string
  upstream: string[]
}

export interface RuntimeConfig {
  id: string
  type: string
  command?: string
}

export interface GlobalConfig {
  // 所有 Agent 共享的基础提示词文件列表（按顺序注入）
  base_prompts: string[]
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
      base_prompts: (globalRaw.base_prompts as string[]) ?? [],
    },
    agents: (parsed.agents as Array<Record<string, unknown>>).map((a) => ({
      id: a.id as string,
      name: a.name as string,
      runtime: a.runtime as string,
      prompt: a.prompt as string | undefined,
      prompts: a.prompts as Record<string, string> | undefined,
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

export function loadPromptFile(relativePath: string): string {
  const fullPath = path.resolve(ROOT, relativePath)
  return fs.readFileSync(fullPath, 'utf-8')
}

// ── 系统提示拼装（三层）────────────────────────────────────────
// Layer 1: global.base_prompts（所有 Agent 共享）
// Layer 2: agent 角色提示词（按 techStack 选择）
// Layer 3: workspace 背景（运行时注入）
export function buildSystemPrompt(agentId: string, techStack: string, workspaceBackground: string): string {
  const { global: globalCfg } = loadAgentsConfig()
  const agent = getAgentConfig(agentId)

  const parts: string[] = []

  // Layer 1: 基础层
  for (const filePath of globalCfg.base_prompts) {
    try {
      parts.push(loadPromptFile(filePath))
    } catch {
      console.warn(`[buildSystemPrompt] base_prompt file not found: ${filePath}`)
    }
  }

  // Layer 2: 角色层
  let rolePrompt = ''
  if (agent.prompt) {
    rolePrompt = loadPromptFile(agent.prompt)
  } else if (agent.prompts) {
    const file = agent.prompts[techStack] ?? Object.values(agent.prompts)[0]
    if (file) rolePrompt = loadPromptFile(file)
  }
  if (rolePrompt) parts.push(rolePrompt)

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
