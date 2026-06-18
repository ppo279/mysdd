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
 *  - 所有 agentId 在 agents.yaml 中存在
 *  - 所有边引用的 fromNodeId / toNodeId 必须存在
 *  - 无环
 */
export function validateWorkflow(graph: WorkflowGraph): void {
  if (graph.nodes.length === 0) {
    throw new BizError(Code.WORKFLOW_INVALID, 'Workflow must have at least one node', 400)
  }

  // Pass 1：结构性唯一性（nodeId / agentId 各扫一遍）——这两个错误码分治互斥的子集：
  //   - NODE_ID_CONFLICT：两个节点共享 nodeId
  //   - AGENT_ID_CONFLICT：两个节点共享 agentId 但 nodeId 不同（路线 1 下不会被 NODE_ID_MISMATCH 抢先）
  const seen = new Set<string>()
  const agentSeen = new Set<string>()
  for (const n of graph.nodes) {
    if (seen.has(n.nodeId)) {
      throw new BizError(
        Code.NODE_ID_CONFLICT,
        `Duplicate nodeId in workflow: "${n.nodeId}"`,
        400,
      )
    }
    seen.add(n.nodeId)
    if (agentSeen.has(n.agentId)) {
      throw new BizError(
        Code.AGENT_ID_CONFLICT,
        `Duplicate agentId in workflow: "${n.agentId}"`,
        400,
      )
    }
    agentSeen.add(n.agentId)
  }

  // Pass 2：语义校验（nodeId === agentId + agent 在 agents.yaml 里）
  for (const n of graph.nodes) {
    if (n.nodeId !== n.agentId) {
      throw new BizError(
        Code.NODE_ID_MISMATCH,
        `Node id "${n.nodeId}" does not match agent id "${n.agentId}" (Route 1 requires they be identical)`,
        400,
      )
    }
    try {
      getAgentConfig(n.agentId)
    } catch {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Agent "${n.agentId}" not found in agents.yaml`,
        400,
      )
    }
  }

  for (const e of graph.edges) {
    if (!seen.has(e.fromNodeId)) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Edge references unknown fromNodeId: "${e.fromNodeId}"`,
        400,
      )
    }
    if (!seen.has(e.toNodeId)) {
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
