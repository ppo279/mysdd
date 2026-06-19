const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

// 统一响应外壳：{ code, msg, data, traceId? }
// Implements: M0 统一 JSON 响应格式（envelope）
export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T | null
  traceId?: string
}

// 业务码表（与后端 backend/src/lib/envelope.ts:Code 镜像）
// 前端只需要关心的 code 子集 + INTERNAL 兜底
export const ApiCode = {
  OK: 0,
  BAD_REQUEST: 1000,
  ZOD_INVALID: 1001,
  MISSING_CONFIRM: 1002,
  PATH_TRAVERSAL: 1003,
  WORKFLOW_INVALID: 1011,
  NODE_ID_CONFLICT: 1012,
  CYCLE_DETECTED: 1013,
  RUNTIME_NOT_REGISTERED: 1201,

  WORKSPACE_NOT_FOUND: 2001,
  FEATURE_NOT_FOUND: 2002,
  STAGERUN_NOT_FOUND: 2003,
  STAGERUN_NO_SESSION: 2004,
  WORKFLOW_NOT_FOUND: 2005,
  REPO_DIR_EXISTS: 2101,
  REPO_DIR_NOT_EMPTY: 2102,
  REPO_MISSING_FOR_RUN: 2110,

  CLI_SPAWN_FAILED: 3101,
  CLI_EXIT_NONZERO: 3102,
  CLI_NO_SESSION_ID: 3103,
  GIT_CLONE_FAILED: 3201,
  GIT_SPAWN_FAILED: 3202,

  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,

  INTERNAL: 5000,
  DB_ERROR: 5001,
  FS_WRITE_FAILED: 5002,
  YAML_INVALID: 5101,
} as const
export type ApiCodeValue = (typeof ApiCode)[keyof typeof ApiCode]

// 业务异常：request 抛出；view 层可用 e.code / e.traceId 做精细处理
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiCodeValue,
    msg: string,
    public traceId?: string,
  ) {
    super(msg)
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })

  // 204 No Content / 空 body 保持原"无 body 即 undefined"语义
  if (res.status === 204) return undefined as T
  const text = await res.text()
  if (text === '') return undefined as T

  let env: ApiEnvelope<T> | null = null
  try { env = JSON.parse(text) } catch { /* 非 JSON：SSE 等 */ }

  if (!env || typeof env.code !== 'number') {
    // 非 envelope：可能后端还没迁完，保守抛通用错
    throw new ApiError(res.status, ApiCode.INTERNAL, `bad response: ${text.slice(0, 200)}`)
  }

  if (env.code === 0) return env.data as T

  throw new ApiError(res.status, env.code as ApiCodeValue, env.msg, env.traceId)
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
    init: (id: string, onChunk: (text: string) => void) =>
      streamInit(id, onChunk),
    reinit: (id: string, onChunk: (chunk: ReinitChunk) => void) =>
      streamReinit(id, onChunk),
  },

  features: {
    list: (workspaceId: string) =>
      request<Feature[]>(`/api/workspaces/${workspaceId}/features`),
    create: (
      workspaceId: string,
      data: {
        name: string
        description?: string
        intent?: 'bug_fix' | 'spec_change' | 'new_feature' | 'refactor'
        workflowId?: string
        inputs?: Record<string, string>
      },
    ) =>
      request<Feature>(`/api/workspaces/${workspaceId}/features`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (featureId: string) => request<FeatureDetail>(`/api/features/${featureId}`),
    advance: (featureId: string) =>
      request<{ currentNodeId: string; status: string }>(`/api/features/${featureId}/advance`, {
        method: 'POST',
      }),
    delete: (featureId: string) =>
      request<void>(`/api/features/${featureId}`, { method: 'DELETE' }),
    // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
    // 切换 feature 的工作流。body 形状：{ toWorkflowId, mapping }
    // mapping[oldNodeId] = { newNodeId, outputRename?, inputRename? }
    switchWorkflow: (featureId: string, data: SwitchWorkflowInput) =>
      request<{ currentWorkflowId: string; currentNodeId: string; applied: boolean }>(
        `/api/features/${featureId}/switch-workflow`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04)
    // 取最新一次 quality-gatekeeper 审核报告（结构化字段 + 3 阶段表 + diff）
    auditReport: (featureId: string) =>
      request<AuditReport>(`/api/features/${featureId}/audit-report`),
    // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04) + CONTEXT.md FB2/TF1
    // 把 fix + reproduction test 合并成单条带 TF1 trailers 的 commit 落在
    // bugfix/<featId>；返回分支名 + commit sha。后端不会自动合到 main。
    merge: (featureId: string) =>
      request<MergeResult>(`/api/features/${featureId}/merge`, { method: 'POST' }),
  },

  stages: {
    // 启动阶段 —— 返回 EventSource URL（调用方自己处理 SSE）
    startUrl: (featureId: string) => `${BASE}/api/features/${featureId}/stages/start`,
    messageUrl: (stageRunId: string) => `${BASE}/api/stage-runs/${stageRunId}/messages`,
    messages: (stageRunId: string) =>
      request<Message[]>(`/api/stage-runs/${stageRunId}/messages`),
    // approve 接受 Record<outputName, content>。Phase 0 默认仅 'default'。
    approve: (stageRunId: string, outputs: Record<string, string>) =>
      request<{ nodeId: string; outputNames: string[] }>(`/api/stage-runs/${stageRunId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ outputs }),
      }),
    get: (stageRunId: string) => request<StageRun>(`/api/stage-runs/${stageRunId}`),
    abort: (stageRunId: string) =>
      request<{ aborted: boolean }>(`/api/stage-runs/${stageRunId}/abort`, { method: 'POST' }),
  },

  config: {
    agents: () => request<AgentsYamlRaw>('/api/config/agents'),
    saveAgents: (data: AgentsYamlRaw) =>
      request<{ ok: boolean }>('/api/config/agents', { method: 'PUT', body: JSON.stringify(data) }),
    detectRuntimes: () => request<DetectedRuntime[]>('/api/config/detect-runtimes'),
  },

  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 1 + Phase 4)
  // 工作流 CRUD：list(workspaceId) / create(workspaceId, dto) / get(id) / update(id, dto) /
  //              updateGraph(id, dto) / remove(id)
  // DTO 与 backend/src/routes/workflows.ts 的 zod schemas 镜像
  workflows: {
    list: (workspaceId: string) =>
      request<Workflow[]>(`/api/workspaces/${workspaceId}/workflows`),
    create: (workspaceId: string, data: WorkflowCreateInput) =>
      request<Workflow>(`/api/workspaces/${workspaceId}/workflows`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    get: (id: string) => request<WorkflowDetail>(`/api/workflows/${id}`),
    update: (id: string, data: WorkflowUpdateInput) =>
      request<Workflow>(`/api/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    // Phase 4: 原地替换图（nodes + edges），保留 workflow.id
    // 避免 DELETE+POST 路径触发 features.current_workflow_id 引用守卫的 400
    updateGraph: (id: string, data: WorkflowGraphInput) =>
      request<Workflow>(`/api/workflows/${id}/graph`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    remove: (id: string) =>
      request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),
  },
}

// SSE 流式调用封装（POST + SSE）
// stageRunId 从第一个 SSE 事件中读取（不再从 HTTP header 读）
// 通过 handlers 回调把 text / thinking / tool / error 四类事件分桶
export interface QuestionOption {
  label: string
  description?: string
}
export interface QuestionItem {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export interface StreamHandlers {
  onText: (text: string) => void
  onThinking?: (info: {
    text?: string
    tokensDelta?: number
    tokensTotal?: number
  }) => void
  onTool?: (info: {
    phase: 'start' | 'end'
    name: string
    toolUseId?: string
    input?: unknown
  }) => void
  onQuestion?: (questions: QuestionItem[]) => void
  onError?: (msg: string) => void
}

export async function streamPost(
  url: string,
  body: Record<string, unknown>,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<{ stageRunId?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
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
      if (typeof data.text === 'string') handlers.onText(data.text)
      if (data.thinking && handlers.onThinking) handlers.onThinking(data.thinking)
      if (data.tool && handlers.onTool) handlers.onTool(data.tool)
      if (data.question && handlers.onQuestion) handlers.onQuestion(data.question)
      if (data.error) {
        const msg = data.error as string
        if (handlers.onError) handlers.onError(msg)
        else throw new Error(msg)
      }
    }
  }

  return { stageRunId }
}

// SSE 初始化 workspace（git clone）
export async function streamInit(
  workspaceId: string,
  onChunk: (text: string) => void,
): Promise<{ error: boolean }> {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/init`, { method: 'POST' })
  if (!res.ok || !res.body) throw new Error('Init request failed')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let hasError = false

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
      if (data.text) onChunk(data.text)
      if (data.error) hasError = true
    }
  }
  return { error: hasError }
}

// reinit SSE 帧的回调形状：复用后端 {text, done, error?, code?} 协议
// M0 envelope 化后 error 由 boolean 改为消息字符串（兼容旧 boolean truthy 判等）
export interface ReinitChunk {
  text?: string
  done?: boolean
  error?: string | boolean
  code?: number
}

// Implements: tasks.md#T020 / plan.md#D-04
// 存量工作区按新结构迁移的 SSE 客户端：POST /api/workspaces/:id/reinit + body {confirm:true}，
// 复用 streamInit 的 getReader+TextDecoder+按 \n 分行 解析模式，每帧 data: 解析后整对象透传给 onChunk。
export async function streamReinit(
  workspaceId: string,
  onChunk: (chunk: ReinitChunk) => void,
): Promise<void> {
  const res = await fetch(`${BASE}/api/workspaces/${workspaceId}/reinit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  })
  if (!res.ok || !res.body) throw new Error('Reinit request failed')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      let data: ReinitChunk
      try { data = JSON.parse(line.slice(6)) } catch { continue }
      onChunk(data)
    }
  }
}

// ─── Types ───────────────────────────────────────────────────
// Implements: tasks.md#T021 / plan.md#D-05
// isLegacy 由后端实时计算（isLegacyWorkspace），前端只读不写、不重算
export interface Workspace {
  id: string
  name: string
  description: string
  repoUrl: string
  techStack: string
  background: string
  localPath: string
  createdAt: string
  isLegacy?: boolean
  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
  // workspace 的默认 workflow；feature 创建时取它作为 currentWorkflowId
  defaultWorkflowId?: string | null
}

export interface WorkspaceInput {
  name: string
  description: string
  repoUrl: string
  techStack?: string
  background: string
  defaultWorkflowId?: string | null
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
  currentWorkflowId: string | null
  currentNodeId: string
  status: string
  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01 / CONTEXT.md IW1)
  intent: 'bug_fix' | 'spec_change' | 'new_feature' | 'refactor'
  lockedFiles: string[] | null
  looksLike: 'true_bug' | 'spec_gap' | 'missing_feature' | 'design_flaw' | null
  createdAt: string
  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 05)
  // Only set for status='queued' features: in-flight bug_fix siblings whose
  // locked_files overlap this feature's claim. Used for the "waiting on X"
  // tooltip in the workspace list.
  blockedBy?: Array<{ id: string; status: string }>
}

// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04)
export interface AuditReport {
  verdict: 'APPROVED' | 'REJECTED'
  rejectionReason: string | null
  /** 完整 audit_report.md 内容，供"查看完整报告"折叠面板用 */
  auditReportMd: string
  /** 3 阶段反向验证（forward / reverse / reapply） */
  reverseValidationPhases: Array<{
    phase: 'forward' | 'reverse' | 'reapply'
    passed: boolean | null
    expected: 'pass' | 'fail' | 'skip'
    exitCode: number | null
    durationMs: number
  }>
  /** 0–1 之间的突变测试分数；框架不支持时为 null */
  mutationScore: number | null
  mutationSkipped: boolean
  coverageDelta: { entries: unknown[]; toolDetected: boolean } | null
  filesModified: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
  /** fix.patch 文件原文（前端用纯文本 + 行染色渲染 diff） */
  fixPatch: string
  /** reproduction test 文件原文 */
  reproductionTest: string
  bugAnalysis: { symptom: string } | null
}

export interface MergeResult {
  branch: string
  commit: string
  message: string
  status: 'merged'
  hint: string
}

export interface FeatureDetail extends Feature {
  stageRuns: StageRun[]
  nodeStates: Record<string, { status: string; lastStageRunId: string | null }>
  workflow: {
    id: string | null
    nodes: WorkflowNodeView[]
    edges: WorkflowEdgeView[]
  }
}

// ── Workflow 视图模型（与 backend/src/services/workflow.ts 的 WorkflowNodeRow/EdgeRow 镜像） ──
export interface WorkflowNodeView {
  nodeId: string
  agentId: string
  displayName: string
  positionX: number
  positionY: number
  /** 从 configJson 解析出的输出 handle 名列表，后端已展开，默认 ['default'] */
  outputs: string[]
}

export interface WorkflowEdgeView {
  fromNodeId: string
  fromOutput: string
  toNodeId: string
  toInput: string
}

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 1)
// Workflow 资源 + DTO；shapeWorkflow / route 端 zod 镜像
export interface Workflow {
  id: string
  workspaceId: string
  name: string
  description: string
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkflowDetail extends Workflow {
  // 拉取单个 workflow 时附带的图
  nodes: Array<{
    nodeId: string
    agentId: string
    positionX: number
    positionY: number
    configJson: string
    displayName: string
  }>
  edges: WorkflowEdgeView[]
}

export interface WorkflowCreateInput {
  name: string
  description?: string
  nodes: Array<{
    nodeId: string
    agentId: string
    positionX?: number
    positionY?: number
    displayName?: string
    configJson?: string
  }>
  edges: Array<{
    fromNodeId: string
    fromOutput?: string
    toNodeId: string
    toInput?: string
  }>
}

export interface WorkflowUpdateInput {
  name?: string
  description?: string
  isArchived?: boolean
}

// Phase 4: PATCH /api/workflows/:id/graph 入参——只含 nodes + edges
export type WorkflowGraphInput = Pick<WorkflowCreateInput, 'nodes' | 'edges'>

// Phase 4: switch-workflow 入参
export interface SwitchWorkflowMapping {
  newNodeId: string
  outputRename?: string
  inputRename?: string
}
export interface SwitchWorkflowInput {
  toWorkflowId: string
  mapping: Record<string, SwitchWorkflowMapping>
}

export interface StageRun {
  id: string
  featureId: string
  stage: string        // 兼容：仍存 agentId
  nodeId: string | null  // workflow-scoped
  runtimeId: string
  cliSessionId: string | null
  status: string
  artifactContent: string
  artifactPath: string
  createdAt: string
  approvedAt: string | null
  // Phase 3: 多 output。键是 outputName（默认 'default'）。后端从 stage_run_outputs 拼出。
  // artifactContent 仍保留在 stage_runs 旧列（兼容），但不再是真相之源。
  outputs?: Record<string, string>
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
  agents: { id: string; name: string; runtime: string; outputFile: string }[]
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
  /** workflow 图中对外暴露的输出 handle 名列表。默认来自 output_file。 */
  outputs?: string[]
  /** workflow 图中期望的输入 handle 名列表。默认 ['default']。 */
  inputs?: string[]
  // Implements: tasks.md#T028 / plan.md#D-03
  // 是否允许该 Agent 在执行结束时把状态摘要沉淀到 memory/MEMORY.md
  memory_sediment?: boolean
  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
  // per-agent runtime config（YAML 级默认；workflow_nodes.config_json 覆盖之）
  config?: {
    runtimeId?: string
    env?: Record<string, string>
    cwd?: string
    timeoutMs?: number
  }
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
