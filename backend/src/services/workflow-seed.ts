// Implements: docs/prd/0001-bug-fix-workflow.md
// 种子 bug-fix workflow 到指定 workspace：
// - 读取 workflows/seed/bug-fix.yaml
// - 解析成 plain rows
// - 幂等插入到 workflows / workflow_nodes / workflow_edges 表
// - 写入 inputs_json / rejection_edges_json（per the new schema columns）
//
// 调用时机：routes/workspaces.ts 在 createInitialWorkflow 之后调用。
// agent 不存在时的处理：保留 workflow 结构（让用户能看见），节点标记 invalid（issue #2 之前 agent 也未必被使用）。
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../db/index.js'
import { workflows, workflowNodes, workflowEdges, workspaces } from '../db/schema.js'
import { loadWorkflowYaml } from './workflow-yaml.js'
import { loadAgentsConfig } from '../config/agents.js'
import { BizError, Code } from '../lib/envelope.js'
import { isReservedNodeId, validateWorkflow, type WorkflowNodeRow, type WorkflowEdgeRow } from './workflow.js'

export interface SeedWorkflowResult {
  workflowId: string
  alreadyExisted: boolean
  /** 引用了未在 agents.yaml 中声明的 agentId；节点会保留但功能受限（issue #2 之前合法）。 */
  missingAgentIds: string[]
}

const BUG_FIX_SEED_FILE = 'bug-fix.yaml'

/**
 * 把 bug-fix workflow 种子到 workspace。
 * 幂等：若该 workspace 下已存在同名 workflow，跳过；返回已存在的 id + alreadyExisted=true。
 */
export async function seedBugFixWorkflow(workspaceId: string): Promise<SeedWorkflowResult> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, `Workspace ${workspaceId} not found`, 404)

  const { yaml: wfYaml } = loadWorkflowYaml(BUG_FIX_SEED_FILE)

  const existing = await db
    .select()
    .from(workflows)
    .where(eq(workflows.workspaceId, workspaceId))
  const dup = existing.find((w) => w.name === wfYaml.name && !w.isArchived)
  if (dup) {
    return { workflowId: dup.id, alreadyExisted: true, missingAgentIds: [] }
  }

  const validAgentIds = new Set(loadAgentsConfig().agents.map((a) => a.id))
  const missingAgentIds = Array.from(new Set(wfYaml.nodes.map((n) => n.agentId).filter((id) => !validAgentIds.has(id))))

  const nodeRows: WorkflowNodeRow[] = wfYaml.nodes.map((n) => ({
    nodeId: n.nodeId,
    agentId: n.agentId,
    positionX: 0,
    positionY: 0,
  }))
  // 保留节点边（__intake__ → real, real → __terminal__）需要单独处理：
  // validateWorkflow 只看真实节点的 nodeRow；保留节点边由运行时引擎消费。
  const realEdgeRows: WorkflowEdgeRow[] = wfYaml.edges
    .filter((e) => !isReservedNodeId(e.from) && !isReservedNodeId(e.to))
    .map((e) => ({
      fromNodeId: e.from,
      fromOutput: e.fromOutput,
      toNodeId: e.to,
      toInput: e.toInput,
    }))
  validateWorkflow({ nodes: nodeRows, edges: realEdgeRows })

  const workflowId = randomUUID()
  const now = new Date()

  await db.insert(workflows).values({
    id: workflowId,
    workspaceId,
    name: wfYaml.name,
    description: wfYaml.description,
    isArchived: 0,
    inputsJson: JSON.stringify(wfYaml.inputs),
    rejectionEdgesJson: JSON.stringify(wfYaml.rejection_edges),
    createdAt: now,
    updatedAt: now,
  })

  if (nodeRows.length > 0) {
    await db.insert(workflowNodes).values(
      nodeRows.map((n) => {
        const def = wfYaml.nodes.find((x) => x.nodeId === n.nodeId)!
        return {
          id: randomUUID(),
          workflowId,
          nodeId: n.nodeId,
          agentId: n.agentId,
          positionX: n.positionX,
          positionY: n.positionY,
          // 修复预算持久化在 config_json 里（per-node runtime config 的扩展位）
          configJson: JSON.stringify({ repair_budget: def.repair_budget }),
          displayName: def.description || def.agentId,
          createdAt: now,
        }
      }),
    )
  }

  // 全部边（含 __intake__ 来源）一次性入库——运行时 collectUpstreamArtifacts 按 toNodeId 聚合
  const allEdges: WorkflowEdgeRow[] = wfYaml.edges.map((e) => ({
    fromNodeId: e.from,
    fromOutput: e.fromOutput,
    toNodeId: e.to,
    toInput: e.toInput,
  }))
  if (allEdges.length > 0) {
    await db.insert(workflowEdges).values(
      allEdges.map((e) => ({
        id: randomUUID(),
        workflowId,
        fromNodeId: e.fromNodeId,
        fromOutput: e.fromOutput,
        toNodeId: e.toNodeId,
        toInput: e.toInput,
        createdAt: now,
      })),
    )
  }

  return { workflowId, alreadyExisted: false, missingAgentIds }
}