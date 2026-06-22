// Implements: docs/adr/0001-workflow-execution-model.md
// 纯函数：工作流 / 节点 / 边的图论操作。
// 不直接访问 DB；调用方传入从 workflow_nodes / workflow_edges 取出的 plain objects。
// 节点拓扑顺序以"workflow_nodes 行顺序"为稳定排序（外层 SELECT 时按 id 字典序即可，
// 但本模块只接受 plain input，不做 DB 排序假设）。
import { BizError, Code } from '../lib/envelope.js'
import { getAgentConfig } from '../config/agents.js'

export interface WorkflowNodeRow {
  nodeId: string
  agentId: string
  positionX: number
  positionY: number
}

export interface WorkflowEdgeRow {
  fromNodeId: string
  fromOutput: string
  toNodeId: string
  toInput: string
}

export interface WorkflowGraph {
  nodes: WorkflowNodeRow[]
  edges: WorkflowEdgeRow[]
}

/**
 * 深度优先找环：返回从哪个节点出发走回了自己，或 [null] 表示无环。
 * 用邻接表 + color 标记（white/gray/black）；gray 命中即环。
 */
export function detectCycles(graph: WorkflowGraph): string[] | null {
  const adj = buildAdjacency(graph)
  const color = new Map<string, 0 | 1 | 2>()
  const parent = new Map<string, string | null>()
  for (const n of graph.nodes) color.set(n.nodeId, 0)

  for (const n of graph.nodes) {
    if (color.get(n.nodeId) === 0) {
      const cycle = dfs(n.nodeId, adj, color, parent)
      if (cycle) return cycle
    }
  }
  return null
}

function buildAdjacency(graph: WorkflowGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) adj.set(n.nodeId, [])
  for (const e of graph.edges) {
    if (adj.has(e.fromNodeId)) {
      adj.get(e.fromNodeId)!.push(e.toNodeId)
    }
  }
  return adj
}

function dfs(
  start: string,
  adj: Map<string, string[]>,
  color: Map<string, 0 | 1 | 2>,
  parent: Map<string, string | null>,
): string[] | null {
  const stack: Array<{ node: string; iter: Iterator<string> }> = []
  color.set(start, 1)
  parent.set(start, null)
  stack.push({ node: start, iter: (adj.get(start) ?? [])[Symbol.iterator]() })

  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    const next = top.iter.next()
    if (next.done) {
      color.set(top.node, 2)
      stack.pop()
      continue
    }
    const v = next.value
    const c = color.get(v) ?? 0
    if (c === 1) {
      // 回边：构造环路
      const cycle: string[] = [v]
      let cur: string | null = top.node
      while (cur !== null && cur !== v) {
        cycle.push(cur)
        cur = parent.get(cur) ?? null
      }
      cycle.push(v)
      return cycle.reverse()
    }
    if (c === 0) {
      color.set(v, 1)
      parent.set(v, top.node)
      stack.push({ node: v, iter: (adj.get(v) ?? [])[Symbol.iterator]() })
    }
    // c === 2 已访问完的节点，跳过
  }
  return null
}

/** Implements: docs/prd/0001-bug-fix-workflow.md + CONTEXT.md decision 15 (BI1)
 * 工作流保留节点 id：用于虚拟节点，无需 workflow_nodes 行。
 *  __intake__ —— 接收工作流级 inputs（side outputs 来自用户/上游）
 *  __terminal__ —— 工作流终点，不接受边指向它后做任何事
 *  调用方在 toposort 之前应把这些保留节点从 graph.nodes 中过滤掉，否则会出现在顺序里。
 */
export const RESERVED_NODE_IDS = ['__intake__', '__terminal__'] as const
export type ReservedNodeId = (typeof RESERVED_NODE_IDS)[number]

export function isReservedNodeId(id: string): id is ReservedNodeId {
  return (RESERVED_NODE_IDS as readonly string[]).includes(id)
}

/** 从图中剥离保留节点（虚拟节点不参与 toposort）。 */
export function stripReservedNodes(graph: WorkflowGraph): WorkflowGraph {
  return {
    nodes: graph.nodes.filter((n) => !isReservedNodeId(n.nodeId)),
    edges: graph.edges.filter((e) => !isReservedNodeId(e.fromNodeId) && !isReservedNodeId(e.toNodeId)),
  }
}

/**
 * 拓扑排序：返回节点 nodeId 数组。
 * 顺序：若 DAG 有唯一排序，按之；否则按"入度消除"算法，tie-break 用入边 fromNodeId 字典序。
 * 抛出 BizError(CYCLE_DETECTED) 若存在环。
 */
export function toposort(graph: WorkflowGraph): string[] {
  const cycle = detectCycles(graph)
  if (cycle) {
    throw new BizError(
      Code.CYCLE_DETECTED,
      `Workflow has cycle: ${cycle.join(' -> ')}`,
      400,
    )
  }

  const inDegree = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) {
    inDegree.set(n.nodeId, 0)
    adj.set(n.nodeId, [])
  }
  for (const e of graph.edges) {
    if (!adj.has(e.fromNodeId) || !inDegree.has(e.toNodeId)) continue
    adj.get(e.fromNodeId)!.push(e.toNodeId)
    inDegree.set(e.toNodeId, (inDegree.get(e.toNodeId) ?? 0) + 1)
  }

  // 入度为 0 的节点按 nodeId 升序加入（确定性）
  const ready: string[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) ready.push(id)
  }
  ready.sort()

  const out: string[] = []
  while (ready.length > 0) {
    const id = ready.shift()!
    out.push(id)
    const neighbors = (adj.get(id) ?? []).slice().sort()
    for (const v of neighbors) {
      const d = (inDegree.get(v) ?? 0) - 1
      inDegree.set(v, d)
      if (d === 0) {
        // 维持 ready 的字典序有序
        const idx = ready.findIndex((x) => x > v)
        if (idx === -1) ready.push(v)
        else ready.splice(idx, 0, v)
      }
    }
  }
  return out
}

/**
 * 校验 workflow 整体合法性。
 * 失败抛 BizError；通过则静默返回。
 *  - 至少一个节点
 *  - 节点 nodeId 在 workflow 内唯一
 *  - 所有 agentId 在 agents 表中存在
 *  - 所有边引用的 fromNodeId / toNodeId 必须存在
 *  - 无环
 * Implements: docs/prd/0001-bug-fix-workflow.md
 * CONTEXT.md decision 9 (N2) 允许 workflow-scoped nodeId 与 agentId 不同
 * （bug-fix workflow 用 analyze/design-test/fix/audit，agent 是 bug-analyst/test-architect/code-surgeon/quality-gatekeeper）。
 * 因此取消 "nodeId === agentId" 的强制约束；保留 agentId 在 agents 表中存在的校验。
 */
export function validateWorkflow(graph: WorkflowGraph): void {
  if (graph.nodes.length === 0) {
    throw new BizError(Code.WORKFLOW_INVALID, 'Workflow must have at least one node', 400)
  }

  const seen = new Set<string>()
  for (const n of graph.nodes) {
    if (seen.has(n.nodeId)) {
      throw new BizError(
        Code.NODE_ID_CONFLICT,
        `Duplicate nodeId in workflow: "${n.nodeId}"`,
        400,
      )
    }
    seen.add(n.nodeId)
  }

  for (const n of graph.nodes) {
    try {
      getAgentConfig(n.agentId)
    } catch {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Agent "${n.agentId}" not found in agents table`,
        400,
      )
    }
  }

  for (const e of graph.edges) {
    if (!seen.has(e.fromNodeId) && !isReservedNodeId(e.fromNodeId)) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge references unknown fromNodeId: "${e.fromNodeId}"`,
        400,
      )
    }
    if (!seen.has(e.toNodeId) && !isReservedNodeId(e.toNodeId)) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge references unknown toNodeId: "${e.toNodeId}"`,
        400,
      )
    }
  }

  const cycle = detectCycles(graph)
  if (cycle) {
    throw new BizError(
      Code.CYCLE_DETECTED,
      `Workflow has cycle: ${cycle.join(' -> ')}`,
      400,
    )
  }
}

/**
 * Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
 * 端口校验：edge 的 from_output / to_input 必须分别 ∈ source/target agent 的
 * declared outputs/inputs；每个 input port 都必须至少有 1 条入边。
 *
 * 失败抛 BizError(WORKFLOW_INVALID)；通过则静默返回。
 *
 * 这是路线 1 之外加的第二层校验：路线 1 锁死 nodeId === agentId，因此每个 node
 * 唯一对应一个 agent；校验每个 node 的 agent.inputs / agent.outputs 即可。
 *
 * 注意：本函数不查 node 拓扑，只查"端口名集合 ⊆ 声明集合"和"每个 input 有入边"。
 * 已用 validateWorkflow 检查过基本结构（节点唯一、agentId 存在、无环）。
 */
export function validateWorkflowPorts(
  graph: WorkflowGraph,
  // 节点 → agent 端口列表的查表函数。接收 nodeId 而不是 agentId 是为了避免
  // 再次查 getAgentConfig 时多走一层（节点已 unique，无需再取 agent）。
  getPorts: (nodeId: string) => { inputs: string[]; outputs: string[] },
): void {
  const nodeIds = new Set(graph.nodes.map((n) => n.nodeId))

  for (const e of graph.edges) {
    if (!nodeIds.has(e.fromNodeId) || !nodeIds.has(e.toNodeId)) {
      // 这条路径在 validateWorkflow 已被拦截——若走到这里说明调用方漏了基础校验
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge references unknown endpoint: "${e.fromNodeId}" -> "${e.toNodeId}"`,
        400,
      )
    }
    const src = getPorts(e.fromNodeId)
    if (!src.outputs.includes(e.fromOutput)) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge from "${e.fromNodeId}" uses output "${e.fromOutput}" not declared by agent (declared: [${src.outputs.join(', ')}])`,
        400,
      )
    }
    const tgt = getPorts(e.toNodeId)
    if (!tgt.inputs.includes(e.toInput)) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge to "${e.toNodeId}" uses input "${e.toInput}" not declared by agent (declared: [${tgt.inputs.join(', ')}])`,
        400,
      )
    }
  }

  // Input coverage：每个 node 的每个 input port 都必须有 ≥1 条入边
  // 隐含假设：node 自身没法自行产出自己的 input 内容——必须有上游喂进来。
  for (const n of graph.nodes) {
    const ports = getPorts(n.nodeId)
    const incomingByInput = new Map<string, number>()
    for (const e of graph.edges) {
      if (e.toNodeId !== n.nodeId) continue
      incomingByInput.set(e.toInput, (incomingByInput.get(e.toInput) ?? 0) + 1)
    }
    for (const input of ports.inputs) {
      if ((incomingByInput.get(input) ?? 0) === 0) {
        throw new BizError(
          Code.WORKFLOW_INVALID,
          `Node "${n.nodeId}" input "${input}" has no incoming edge`,
          400,
        )
      }
    }
  }
}

/**
 * Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
 * configJson override 守卫：workflow_nodes.config_json 是 workflow 级覆盖，
 * 但 ports（outputs/inputs）的覆盖已被废弃——agent.config 是唯一真相之源。
 *
 * 校验：传入 configJson 字符串里若含 `outputs` 或 `inputs` 键 → 抛 BizError。
 * 其它字段（如 displayName、position 等）合法保留。
 */
export function rejectPortOverrideInConfigJson(
  configJson: string,
  nodeId: string,
): void {
  let parsed: unknown
  try { parsed = JSON.parse(configJson) } catch { return /* 非 JSON 不在本守卫范围 */ }
  if (!parsed || typeof parsed !== 'object') return
  const obj = parsed as Record<string, unknown>
  if ('outputs' in obj || 'inputs' in obj) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Node "${nodeId}" config_json contains "outputs" or "inputs" override; per-node port overrides are deprecated. Edit the agent's ports instead.`,
      400,
    )
  }
}

/** 返回进入 nodeId 的所有边（包含 fromOutput / toInput 信息）。 */
export function getIncomingEdges(graph: WorkflowGraph, nodeId: string): WorkflowEdgeRow[] {
  return graph.edges.filter((e) => e.toNodeId === nodeId)
}

/** 返回从 nodeId 出发的所有边。 */
export function getOutgoingEdges(graph: WorkflowGraph, nodeId: string): WorkflowEdgeRow[] {
  return graph.edges.filter((e) => e.fromNodeId === nodeId)
}

/** 找一条边的对端上游节点 nodeId（按 toInput 过滤；toInput='*' 表示任意）。 */
export function getUpstreamNodes(graph: WorkflowGraph, nodeId: string, toInput?: string): string[] {
  return getIncomingEdges(graph, nodeId)
    .filter((e) => !toInput || toInput === '*' || e.toInput === toInput)
    .map((e) => e.fromNodeId)
}

/** 找一条边的对端下游节点 nodeId。 */
export function getDownstreamNodes(graph: WorkflowGraph, nodeId: string, fromOutput?: string): string[] {
  return getOutgoingEdges(graph, nodeId)
    .filter((e) => !fromOutput || fromOutput === '*' || e.fromOutput === fromOutput)
    .map((e) => e.toNodeId)
}

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// suggestMapping(oldNodes, newNodes) — 把旧工作流的节点对到新工作流。
//   - 第一遍：按 agentId 配对；同一个 agentId 在两边都唯一时直接配上（confidence=high）
//   - 同一 agentId 在任意一边出现多次时，按 (positionX, positionY) 的 Manhattan 距离贪心匹配（confidence=low）
//   - 配不上的（agentId 缺失）以 null 留下，等用户在前端覆盖
//
// 返回 { oldNodeId: { newNodeId: string, confidence: 'high' | 'low' } }，未匹配的 oldNodeId 不出现在返回中。
//
// 注意：纯函数，不读 DB；调用方传 plain rows。

export type MappingConfidence = 'high' | 'low'
export interface MappingSuggestion {
  newNodeId: string
  confidence: MappingConfidence
}

function manhattan(a: { positionX: number; positionY: number }, b: { positionX: number; positionY: number }): number {
  return Math.abs(a.positionX - b.positionX) + Math.abs(a.positionY - b.positionY)
}

export function suggestMapping(
  oldNodes: WorkflowNodeRow[],
  newNodes: WorkflowNodeRow[],
): Record<string, MappingSuggestion> {
  // 1. 按 agentId 分桶
  const newByAgent = new Map<string, WorkflowNodeRow[]>()
  for (const n of newNodes) {
    const list = newByAgent.get(n.agentId) ?? []
    list.push(n)
    newByAgent.set(n.agentId, list)
  }
  const consumed = new Set<string>()

  const result: Record<string, MappingSuggestion> = {}

  // 2. 第一遍：唯一 agentId 直接配
  const ambigOld: WorkflowNodeRow[] = []
  for (const o of oldNodes) {
    const candidates = newByAgent.get(o.agentId)
    if (!candidates || candidates.length === 0) continue
    if (candidates.length === 1) {
      result[o.nodeId] = { newNodeId: candidates[0].nodeId, confidence: 'high' }
      consumed.add(candidates[0].nodeId)
    } else {
      ambigOld.push(o)
    }
  }

  // 3. 第二遍：歧义时按 Manhattan 距离贪心
  for (const o of ambigOld) {
    const candidates = (newByAgent.get(o.agentId) ?? []).filter((c) => !consumed.has(c.nodeId))
    if (candidates.length === 0) continue
    // 取最近一个
    let best = candidates[0]
    let bestD = manhattan(o, best)
    for (let i = 1; i < candidates.length; i++) {
      const d = manhattan(o, candidates[i])
      if (d < bestD) { best = candidates[i]; bestD = d }
    }
    result[o.nodeId] = { newNodeId: best.nodeId, confidence: 'low' }
    consumed.add(best.nodeId)
  }

  return result
}
