const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error ?? 'Request failed')
  }
  return res.json()
}

// ─── Workspace ───────────────────────────────────────────────
export const api = {
  workspaces: {
    list: () => request<Workspace[]>('/api/workspaces'),
    get: (id: string) => request<WorkspaceDetail>(`/api/workspaces/${id}`),
    create: (data: WorkspaceInput) =>
      request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<WorkspaceInput>) =>
      request<Workspace>(`/api/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) =>
      request<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),
  },

  features: {
    list: (workspaceId: string) =>
      request<Feature[]>(`/api/workspaces/${workspaceId}/features`),
    create: (workspaceId: string, data: { name: string; description: string }) =>
      request<Feature>(`/api/workspaces/${workspaceId}/features`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (featureId: string) => request<FeatureDetail>(`/api/features/${featureId}`),
    advance: (featureId: string) =>
      request<{ currentStage: string; status: string }>(`/api/features/${featureId}/advance`, {
        method: 'POST',
      }),
  },

  stages: {
    // 启动阶段 —— 返回 EventSource URL（调用方自己处理 SSE）
    startUrl: (featureId: string) => `${BASE}/api/features/${featureId}/stages/start`,
    messageUrl: (stageRunId: string) => `${BASE}/api/stage-runs/${stageRunId}/messages`,
    messages: (stageRunId: string) =>
      request<Message[]>(`/api/stage-runs/${stageRunId}/messages`),
    approve: (stageRunId: string, artifactContent: string) =>
      request<{ ok: boolean }>(`/api/stage-runs/${stageRunId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ artifactContent }),
      }),
    get: (stageRunId: string) => request<StageRun>(`/api/stage-runs/${stageRunId}`),
  },

  config: {
    agents: () => request<AgentsYamlRaw>('/api/config/agents'),
    saveAgents: (data: AgentsYamlRaw) =>
      request<{ ok: boolean }>('/api/config/agents', { method: 'PUT', body: JSON.stringify(data) }),
    detectRuntimes: () => request<DetectedRuntime[]>('/api/config/detect-runtimes'),
  },
}

// SSE 流式调用封装（POST + SSE）
// stageRunId 从第一个 SSE 事件中读取（不再从 HTTP header 读）
export async function streamPost(
  url: string,
  body: Record<string, unknown>,
  onChunk: (text: string) => void,
): Promise<{ stageRunId?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok || !res.body) throw new Error('Stream request failed')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let stageRunId: string | undefined

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let data: any
      try { data = JSON.parse(line.slice(6)) } catch { continue }
      if (data.stageRunId) stageRunId = data.stageRunId
      if (data.text) onChunk(data.text)
      if (data.error) throw new Error(data.error as string)
    }
  }

  return { stageRunId }
}

// ─── Types ───────────────────────────────────────────────────
export interface Workspace {
  id: string
  name: string
  description: string
  repoUrl: string
  techStack: string
  background: string
  localPath: string
  createdAt: string
}

export interface WorkspaceInput {
  name: string
  description: string
  repoUrl: string
  techStack: string
  background: string
}

export interface WorkspaceDetail extends Workspace {
  features: Feature[]
}

export interface Feature {
  id: string
  workspaceId: string
  name: string
  description: string
  currentStage: string
  status: string
  createdAt: string
}

export interface FeatureDetail extends Feature {
  stageRuns: StageRun[]
  agentOrder: string[]
}

export interface StageRun {
  id: string
  featureId: string
  stage: string
  runtimeId: string
  cliSessionId: string | null
  status: string
  artifactContent: string
  artifactPath: string
  createdAt: string
  approvedAt: string | null
}

export interface Message {
  id: string
  stageRunId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

// 旧类型保留兼容
export interface AgentsConfig {
  runtimes: { id: string; type: string }[]
  agents: { id: string; name: string; runtime: string; outputFile: string; upstream: string[] }[]
}

// agents.yaml 的原始结构（与文件保持一致）
export interface RuntimeRaw {
  id: string
  type: string
  command: string
}

export interface AgentRaw {
  id: string
  name: string
  runtime: string
  instruction: string
  output_file: string
  upstream: string[]
}

export interface BaseLayer {
  name: string
  content: string
}

export interface GlobalConfig {
  base_layers: BaseLayer[]
}

export interface AgentsYamlRaw {
  runtimes: RuntimeRaw[]
  global: GlobalConfig
  agents: AgentRaw[]
}

export interface DetectedRuntime {
  id: string
  type: string
  command: string
  version: string | null
  available: boolean
  daemonPort?: number
  daemonRunning?: boolean
  source: 'cli' | 'daemon'
}
