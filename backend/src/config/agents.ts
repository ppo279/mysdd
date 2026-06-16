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
  // 单一提示词文件（不区分技术栈）
  prompt?: string
  // 按技术栈分的提示词文件
  prompts?: Record<string, string>
  outputFile: string
  upstream: string[]
}

export interface RuntimeConfig {
  id: string
  type: string
  command?: string
}

export interface AgentsYaml {
  runtimes: RuntimeConfig[]
  agents: AgentConfig[]
}

let _config: AgentsYaml | null = null

export function loadAgentsConfig(): AgentsYaml {
  if (_config) return _config

  const yamlPath = path.resolve(ROOT, 'agents.yaml')
  const raw = fs.readFileSync(yamlPath, 'utf-8')
  const parsed = yaml.load(raw) as Record<string, unknown>

  // 驼峰转换
  _config = {
    runtimes: parsed.runtimes as RuntimeConfig[],
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

// 读取提示词文件内容
export function loadPromptFile(relativePath: string): string {
  const fullPath = path.resolve(ROOT, relativePath)
  return fs.readFileSync(fullPath, 'utf-8')
}

// 拼装系统提示词
export function buildSystemPrompt(agentId: string, techStack: string, workspaceBackground: string): string {
  const agent = getAgentConfig(agentId)

  const constitutionPath = path.resolve(ROOT, 'SDDInAction/0.agents/constitution.md')
  const agentsPath = path.resolve(ROOT, 'SDDInAction/0.agents/AGENTS.md')

  const constitution = fs.readFileSync(constitutionPath, 'utf-8')
  const agentsMd = fs.readFileSync(agentsPath, 'utf-8')

  // 选择阶段提示词
  let stagePrompt = ''
  if (agent.prompt) {
    stagePrompt = loadPromptFile(agent.prompt)
  } else if (agent.prompts) {
    const promptFile = agent.prompts[techStack] ?? Object.values(agent.prompts)[0]
    if (promptFile) stagePrompt = loadPromptFile(promptFile)
  }

  const parts = [constitution, agentsMd, stagePrompt]

  if (workspaceBackground.trim()) {
    parts.push(`\n---\n## Workspace 背景信息\n${workspaceBackground}`)
  }

  return parts.join('\n\n---\n\n')
}

// 拼装上游产物注入
export function buildUpstreamContext(agentId: string, artifacts: Record<string, string>): string {
  const agent = getAgentConfig(agentId)
  if (agent.upstream.length === 0) return ''

  const sections = agent.upstream
    .filter((upId) => artifacts[upId])
    .map((upId) => {
      const config = getAgentConfig(upId)
      return `### 已确认的 ${config.outputFile}\n\n${artifacts[upId]}`
    })

  if (sections.length === 0) return ''
  return `\n---\n## 上游产物\n\n${sections.join('\n\n')}`
}
