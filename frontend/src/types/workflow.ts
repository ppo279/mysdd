// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// 前端纯类型 + 工具，镜像后端 services/workflow.ts 的 WorkflowNodeRow / WorkflowEdgeRow / suggestMapping。
// 客户端 cycle detector 也用此类型（编辑器"本地校验"路径）。
// suggestMapping 在 switch-workflow 弹窗中用来预填映射表。

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

export type MappingConfidence = 'high' | 'low'

export interface MappingSuggestion {
  newNodeId: string
  confidence: MappingConfidence
}

function manhattan(a: WorkflowNodeRow, b: WorkflowNodeRow): number {
  return Math.abs(a.positionX - b.positionX) + Math.abs(a.positionY - b.positionY)
}

/**
 * 镜像后端 services/workflow.ts:suggestMapping
 * - 唯一 agentId → high
 * - 同一 agentId 多份 → Manhattan 距离贪心 + low
 * - 新工作流里没的 agentId → 不出现在结果中
 */
export function suggestMapping(
  oldNodes: WorkflowNodeRow[],
  newNodes: WorkflowNodeRow[],
): Record<string, MappingSuggestion> {
  const byAgent = new Map<string, WorkflowNodeRow[]>()
  for (const n of newNodes) {
    const list = byAgent.get(n.agentId) ?? []
    list.push(n)
    byAgent.set(n.agentId, list)
  }
  const consumed = new Set<string>()
  const result: Record<string, MappingSuggestion> = {}
  const ambigOld: WorkflowNodeRow[] = []
  for (const o of oldNodes) {
    const cs = byAgent.get(o.agentId)
    if (!cs || cs.length === 0) continue
    const first = cs[0]
    if (!first) continue
    if (cs.length === 1) {
      result[o.nodeId] = { newNodeId: first.nodeId, confidence: 'high' }
      consumed.add(first.nodeId)
    } else {
      ambigOld.push(o)
    }
  }
  for (const o of ambigOld) {
    const cs = (byAgent.get(o.agentId) ?? []).filter((c) => !consumed.has(c.nodeId))
    if (cs.length === 0) continue
    let best: WorkflowNodeRow | undefined = cs[0]
    let bestD = best ? manhattan(o, best) : Number.POSITIVE_INFINITY
    for (let i = 1; i < cs.length; i++) {
      const c = cs[i]
      if (!c) continue
      const d = manhattan(o, c)
      if (d < bestD) { best = c; bestD = d }
    }
    if (best) {
      result[o.nodeId] = { newNodeId: best.nodeId, confidence: 'low' }
      consumed.add(best.nodeId)
    }
  }
  return result
}

/**
 * 客户端 cycle detector（与后端 mirror）。仅做用户输入即时反馈。
 */
export function detectCycles(nodes: WorkflowNodeRow[], edges: WorkflowEdgeRow[]): string[] | null {
  const adj = new Map<string, string[]>()
  const color = new Map<string, 0 | 1 | 2>()
  for (const n of nodes) {
    adj.set(n.nodeId, [])
    color.set(n.nodeId, 0)
  }
  for (const e of edges) {
    if (adj.has(e.fromNodeId)) adj.get(e.fromNodeId)!.push(e.toNodeId)
  }
  const dfs = (start: string, parent: Map<string, string | null>): string[] | null => {
    const stack: Array<{ node: string; iter: Iterator<string> }> = []
    color.set(start, 1)
    parent.set(start, null)
    stack.push({ node: start, iter: (adj.get(start) ?? [])[Symbol.iterator]() })
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (!top) break
      const next = top.iter.next()
      if (next.done) {
        color.set(top.node, 2)
        stack.pop()
        continue
      }
      const v = next.value
      const c = color.get(v) ?? 0
      if (c === 1) {
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
    }
    return null
  }
  for (const n of nodes) {
    if (color.get(n.nodeId) === 0) {
      const c = dfs(n.nodeId, new Map())
      if (c) return c
    }
  }
  return null
}
