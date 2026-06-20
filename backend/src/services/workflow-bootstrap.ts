// Implements: docs/adr/0001-workflow-execution-model.md
// workspace 创建时，从 agents.yaml 读出 agent 列表并种子一条"默认工作流"：
// - 一个 workflows 行
// - 每个 agent 一个 workflow_nodes 行（nodeId 默认等于 agentId，displayName=agentName）
// - 按 agents.yaml 数组顺序串联 workflow_edges：i → i+1
// - 把 workflows.id 写回 workspaces.default_workflow_id
//
// 重入：若 workspace 已有 default_workflow_id 则幂等返回。
// 同步失败 → 抛 BizError；调用方负责回滚 workspace 行。
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../db/index.js'
import { workflows, workflowNodes, workflowEdges, workspaces } from '../db/schema.js'
import { loadAgentsConfig } from '../config/agents.js'
import { BizError, Code } from '../lib/envelope.js'

export async function createInitialWorkflow(workspaceId: string): Promise<string> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, `Workspace ${workspaceId} not found`, 404)

  // 幂等：已有默认工作流则直接返回
  if (ws.defaultWorkflowId) return ws.defaultWorkflowId

  const agents = loadAgentsConfig().agents
  const now = new Date()
  const workflowId = randomUUID()

  // 先插 workflows 行（FK 目标）
  await db.insert(workflows).values({
    id: workflowId,
    workspaceId,
    name: '默认工作流',
    description: '由 agents.yaml 自动生成的初始工作流。',
    isArchived: 0,
    createdAt: now,
    updatedAt: now,
  })

  // 插节点（nodeId = agentId，确保 UNIQUE(workflow_id, node_id) 与 agents 一一对应）
  // 水平均布以避免画布节点全堆在 (0,0) — 间距 280 与 seed.ts / AgentNode.vue 对齐
  const NODE_SPACING_X = 280
  if (agents.length > 0) {
    await db.insert(workflowNodes).values(
      agents.map((a, i) => ({
        id: randomUUID(),
        workflowId,
        nodeId: a.id,
        agentId: a.id,
        positionX: i * NODE_SPACING_X,
        positionY: 0,
        configJson: '{}',
        displayName: a.name,
        createdAt: now,
      })),
    )

    // 串联边：i -> i+1（使用 default input/output）
    if (agents.length > 1) {
      await db.insert(workflowEdges).values(
        agents.slice(0, -1).map((a, i) => ({
          id: randomUUID(),
          workflowId,
          fromNodeId: a.id,
          fromOutput: 'default',
          toNodeId: agents[i + 1].id,
          toInput: 'default',
          createdAt: now,
        })),
      )
    }
  }

  await db.update(workspaces).set({ defaultWorkflowId: workflowId }).where(eq(workspaces.id, workspaceId))
  return workflowId
}

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// runAgentSweep：扫一遍所有 workflow_nodes，若有节点引用的 agentId
// 不在当前 agents.yaml 中（说明该 agent 被删了），则：
//   1) 把该 workflow 标记为 archived（is_archived=1）
//   2) 把该 workflow 下所有 feature_node_states 行标记为 rejected
//
// 触发点：routes/config.ts PUT /api/config/agents 在 clearCache() 之后。
// 这样删 agent 立即在 UI 上以"已归档"形式可见。
//
// 失败容忍：只读路径（不删数据），错误以 BizError 抛出由 registerErrorHandler 接管。
import { features, featureNodeStates } from '../db/schema.js'
import { inArray, and, ne, eq as eqOp } from 'drizzle-orm'

export interface AgentSweepResult {
  archivedWorkflows: number
  rejectedNodeStates: number
  missingAgentIds: string[]
}

export async function runAgentSweep(): Promise<AgentSweepResult> {
  const validIds = new Set(loadAgentsConfig().agents.map((a) => a.id))
  const allNodes = await db.select().from(workflowNodes)
  const missingByWorkflow = new Map<string, Set<string>>()
  const missingAgentIds = new Set<string>()

  for (const n of allNodes) {
    if (!validIds.has(n.agentId)) {
      missingAgentIds.add(n.agentId)
      const set = missingByWorkflow.get(n.workflowId) ?? new Set<string>()
      set.add(n.agentId)
      missingByWorkflow.set(n.workflowId, set)
    }
  }

  let archivedWorkflows = 0
  let rejectedNodeStates = 0

  for (const [workflowId, missing] of missingByWorkflow) {
    // 归档
    const r = await db
      .update(workflows)
      .set({ isArchived: 1, updatedAt: new Date() })
      .where(and(eqOp(workflows.id, workflowId), ne(workflows.isArchived, 1)))
    archivedWorkflows += r.changes ?? 0

    // 把引用了这些已删 agent 的 node 的所有 feature_node_states 标为 rejected
    // 找到该 workflow 下 nodeId 的列表
    const nodesInWf = await db
      .select({ nodeId: workflowNodes.nodeId })
      .from(workflowNodes)
      .where(eqOp(workflowNodes.workflowId, workflowId))
    const nodeIds = nodesInWf.map((n) => n.nodeId)
    if (nodeIds.length === 0) continue

    // 找出引用了这些 node 的 features
    const stateRows = await db
      .select({ featureId: featureNodeStates.featureId, nodeId: featureNodeStates.nodeId })
      .from(featureNodeStates)
      .where(inArray(featureNodeStates.nodeId, nodeIds))
    if (stateRows.length === 0) continue

    // 批量 reject（仅对尚未 rejected 的）
    const featureIds = Array.from(new Set(stateRows.map((r) => r.featureId)))
    const u = await db
      .update(featureNodeStates)
      .set({ status: 'rejected', updatedAt: new Date() })
      .where(
        and(
          inArray(featureNodeStates.featureId, featureIds),
          inArray(featureNodeStates.nodeId, nodeIds),
          ne(featureNodeStates.status, 'rejected'),
        ),
      )
    rejectedNodeStates += u.changes ?? 0

    // 让所有 features 切到 paused 状态（如果它们当前 current_workflow_id == 这个被归档的 workflow）
    await db
      .update(features)
      .set({ status: 'paused' })
      .where(
        and(
          eqOp(features.currentWorkflowId, workflowId),
          ne(features.status, 'paused'),
        ),
      )
  }

  return {
    archivedWorkflows,
    rejectedNodeStates,
    missingAgentIds: Array.from(missingAgentIds),
  }
}
