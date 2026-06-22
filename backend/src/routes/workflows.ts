// Implements: docs/adr/0001-workflow-execution-model.md (Phase 1: workflow CRUD API)
// 5 个端点：
//   GET   /api/workspaces/:workspaceId/workflows       列出 workspace 的 workflows
//   POST  /api/workspaces/:workspaceId/workflows       创建（含 nodes + edges 全量校验）
//   GET   /api/workflows/:id                           拉取单个 workflow（含 nodes + edges）
//   PATCH /api/workflows/:id                           改名 / 描述 / 归档（不改 nodes/edges）
//   DELETE /api/workflows/:id                          删除；若有 feature 引用则拒绝
//
// Phase 1 范围内：CRUD + 校验。Canvas 编辑（nodes/edges 部分更新）在 Phase 4。
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { workflows, workflowNodes, workflowEdges, features } from '../db/schema.js'
import { eq, and, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { validateWorkflow, validateWorkflowPorts, rejectPortOverrideInConfigJson, type WorkflowNodeRow, type WorkflowEdgeRow } from '../services/workflow.js'
import { getAgentConfig } from '../config/agents.js'
import { BizError, Code, ok } from '../lib/envelope.js'

// ── zod schemas ───────────────────────────────────────────────
// 与 services/workflow.ts 的 plain row shape 镜像
const NodeSchema = z.object({
  nodeId: z.string().min(1),
  agentId: z.string().min(1),
  positionX: z.number().default(0),
  positionY: z.number().default(0),
  displayName: z.string().default(''),
  configJson: z.string().default('{}'),
})

const EdgeSchema = z.object({
  fromNodeId: z.string().min(1),
  fromOutput: z.string().default('default'),
  toNodeId: z.string().min(1),
  toInput: z.string().default('default'),
})

const CreateWorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  nodes: z.array(NodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
})

const UpdateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  isArchived: z.boolean().optional(),
})

// PATCH /:id/graph 专用：只接 nodes + edges，name/description/isArchived 走 PATCH /:id
// 用 .pick() 复用 CreateWorkflowSchema 的子结构，避免字段重复定义时漂移
const UpdateGraphSchema = CreateWorkflowSchema.pick({ nodes: true, edges: true })

// 工具：把 zod 解析后的 DTO 转换成纯 row 喂给 validateWorkflow
// 同时把每个 node 的 configJson 喂给 rejectPortOverrideInConfigJson——
// outputs/inputs 覆盖在 slice 03 关闭。返回的 portsByNode 是 nodeId → 端口列表的查表闭包。
//
// 顺序：先 validateWorkflow（拒未知 agentId / 重复 nodeId / 环 / 端点缺失）；
// 再 rejectPortOverrideInConfigJson（拒 configJson ports 覆盖）；
// 再 getAgentConfig 取 ports（用于 validateWorkflowPorts）。
// 顺序保证未知 agentId 走 validateWorkflow 的 BizError 而非 getAgentConfig 的 raw Error。
function toRows(
  nodes: z.infer<typeof NodeSchema>[],
  edges: z.infer<typeof EdgeSchema>[],
): {
  nodes: WorkflowNodeRow[]
  edges: WorkflowEdgeRow[]
  portsByNode: Map<string, { inputs: string[]; outputs: string[] }>
} {
  const nodeRows: WorkflowNodeRow[] = nodes.map((n) => ({
    nodeId: n.nodeId,
    agentId: n.agentId,
    positionX: n.positionX,
    positionY: n.positionY,
  }))
  const edgeRows: WorkflowEdgeRow[] = edges.map((e) => ({
    fromNodeId: e.fromNodeId,
    fromOutput: e.fromOutput,
    toNodeId: e.toNodeId,
    toInput: e.toInput,
  }))
  // 第一道：基础结构校验（拒未知 agentId、重复 nodeId、环、端点缺失）
  validateWorkflow({ nodes: nodeRows, edges: edgeRows })
  // 第二道：configJson 不含 ports 覆盖
  for (const n of nodes) {
    rejectPortOverrideInConfigJson(n.configJson, n.nodeId)
  }
  // 第三道：从 agent 取 ports（validateWorkflow 已保证 agentId 存在）
  const portsByNode = new Map<string, { inputs: string[]; outputs: string[] }>()
  for (const n of nodes) {
    const cfg = getAgentConfig(n.agentId)
    portsByNode.set(n.nodeId, { inputs: cfg.inputs, outputs: cfg.outputs })
  }
  return {
    nodes: nodeRows,
    edges: edgeRows,
    portsByNode,
  }
}

// 工具：把 workflow 行的响应形状（不含 updatedAt 等无关列）统一化
// is_archived 在 DB 里是 INTEGER(0/1)，这里转成 boolean 给前端。
function shapeWorkflow(wf: typeof workflows.$inferSelect) {
  return {
    id: wf.id,
    workspaceId: wf.workspaceId,
    name: wf.name,
    description: wf.description,
    isArchived: Boolean(wf.isArchived),
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
  }
}

export async function workflowRoutes(app: FastifyInstance) {
  // 列出 workspace 下的所有 workflows（含默认 + 用户自建）
  app.get('/api/workspaces/:workspaceId/workflows', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string }
    const list = await db
      .select()
      .from(workflows)
      .where(eq(workflows.workspaceId, workspaceId))
      .orderBy(asc(workflows.createdAt))
    return ok(reply, list.map(shapeWorkflow))
  })

  // 创建 workflow（全量）
  // 校验：nodes 至少一个 / 内部 nodeId 唯一 / agentId 都在 agents 表 / 边端点存在 / 无环
  app.post('/api/workspaces/:workspaceId/workflows', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string }
    const body = CreateWorkflowSchema.parse(req.body)

    // 业务校验（通过则继续；失败抛 BizError）：
    // toRows 内部已跑 validateWorkflow + rejectPortOverrideInConfigJson + 拿 ports。
    const rows = toRows(body.nodes, body.edges)
    // Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
    // 端口对齐：edge 的 from_output/to_input 必须 ∈ source/target agent 的声明端口；
    // 每个 input port 必须有入边。
    validateWorkflowPorts(rows, (nodeId) => rows.portsByNode.get(nodeId)!)

    const wfId = randomUUID()
    const now = new Date()
    await db.insert(workflows).values({
      id: wfId,
      workspaceId,
      name: body.name,
      description: body.description,
      isArchived: 0,
      createdAt: now,
      updatedAt: now,
    })

    if (body.nodes.length > 0) {
      await db.insert(workflowNodes).values(
        body.nodes.map((n) => ({
          id: randomUUID(),
          workflowId: wfId,
          nodeId: n.nodeId,
          agentId: n.agentId,
          positionX: n.positionX,
          positionY: n.positionY,
          configJson: n.configJson,
          displayName: n.displayName,
          createdAt: now,
        })),
      )
    }

    if (body.edges.length > 0) {
      await db.insert(workflowEdges).values(
        body.edges.map((e) => ({
          id: randomUUID(),
          workflowId: wfId,
          fromNodeId: e.fromNodeId,
          fromOutput: e.fromOutput,
          toNodeId: e.toNodeId,
          toInput: e.toInput,
          createdAt: now,
        })),
      )
    }

    return ok(reply, shapeWorkflow({ ...({} as any), id: wfId, workspaceId, name: body.name, description: body.description, isArchived: 0, createdAt: now, updatedAt: now } satisfies typeof workflows.$inferSelect), 201)
  })

  // 拉取单个 workflow + 它的 nodes / edges
  app.get('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [wf] = await db.select().from(workflows).where(eq(workflows.id, id))
    if (!wf) throw new BizError(Code.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`, 404)

    const nodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, id))
      .orderBy(asc(workflowNodes.createdAt))
    const edges = await db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, id))
      .orderBy(asc(workflowEdges.createdAt))

    return ok(reply, {
      ...shapeWorkflow(wf),
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        agentId: n.agentId,
        positionX: n.positionX,
        positionY: n.positionY,
        configJson: n.configJson,
        displayName: n.displayName,
      })),
      edges: edges.map((e) => ({
        fromNodeId: e.fromNodeId,
        fromOutput: e.fromOutput,
        toNodeId: e.toNodeId,
        toInput: e.toInput,
      })),
    })
  })

  // 更新 workflow 的元数据（name / description / isArchived）
  // Phase 1 不开放 nodes/edges 的部分更新——那需要换事务 + 重写全部边，留给 Phase 4 canvas
  app.patch('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateWorkflowSchema.parse(req.body)

    const [existing] = await db.select().from(workflows).where(eq(workflows.id, id))
    if (!existing) throw new BizError(Code.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`, 404)

    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (body.name !== undefined) patch.name = body.name
    if (body.description !== undefined) patch.description = body.description
    if (body.isArchived !== undefined) patch.isArchived = body.isArchived ? 1 : 0

    await db.update(workflows).set(patch as any).where(eq(workflows.id, id))
    const [updated] = await db.select().from(workflows).where(eq(workflows.id, id))
    return ok(reply, shapeWorkflow(updated))
  })

  // 原地替换 workflow 的图（nodes + edges）
  // Phase 4 canvas 编辑的真正落点：保留 workflow.id，避免前端走 DELETE+POST 触发
  // features.current_workflow_id 引用守卫的 400。事务内 DELETE 子表 + INSERT 子表，
  // workflows 行不动 → 引用稳住 → 现有 stage_runs / feature_node_states 不需迁移。
  app.patch('/api/workflows/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateGraphSchema.parse(req.body)

    const [existing] = await db.select().from(workflows).where(eq(workflows.id, id))
    if (!existing) throw new BizError(Code.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`, 404)

    // 复用 create 路径的同一套校验（路线 1 锁死 + 节点/边结构 + 无环 + 端口对齐 + configJson 覆盖）
    const rows = toRows(body.nodes, body.edges)
    // Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
    // 端口对齐 + input coverage + 拒 configJson 覆盖——和 create 路径一致。
    validateWorkflowPorts(rows, (nodeId) => rows.portsByNode.get(nodeId)!)

    const now = new Date()
    // better-sqlite3 的 transaction 是同步的——callback 不能是 async，也不能 await。
    // Drizzle 在 better-sqlite3 上同步返回结果。
    db.transaction((tx) => {
      // workflow_nodes / workflow_edges 是 sibling 表，FK 都指向 workflows.id，
      // 但彼此不级联。手动清两个子表，workflows 行不动。
      tx.delete(workflowNodes).where(eq(workflowNodes.workflowId, id)).run()
      tx.delete(workflowEdges).where(eq(workflowEdges.workflowId, id)).run()
      if (body.nodes.length > 0) {
        tx.insert(workflowNodes).values(
          body.nodes.map((n) => ({
            id: randomUUID(),
            workflowId: id,
            nodeId: n.nodeId,
            agentId: n.agentId,
            positionX: n.positionX,
            positionY: n.positionY,
            configJson: n.configJson,
            displayName: n.displayName,
            createdAt: now,
          })),
        ).run()
      }
      if (body.edges.length > 0) {
        tx.insert(workflowEdges).values(
          body.edges.map((e) => ({
            id: randomUUID(),
            workflowId: id,
            fromNodeId: e.fromNodeId,
            fromOutput: e.fromOutput,
            toNodeId: e.toNodeId,
            toInput: e.toInput,
            createdAt: now,
          })),
        ).run()
      }
      tx.update(workflows).set({ updatedAt: now }).where(eq(workflows.id, id)).run()
    })

    const [updated] = await db.select().from(workflows).where(eq(workflows.id, id))
    return ok(reply, shapeWorkflow(updated))
  })

  // 删除 workflow
  // 拒绝：仍有 features.current_workflow_id 引用此 workflow
  app.delete('/api/workflows/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [existing] = await db.select().from(workflows).where(eq(workflows.id, id))
    if (!existing) throw new BizError(Code.WORKFLOW_NOT_FOUND, `Workflow ${id} not found`, 404)

    const refs = await db
      .select({ id: features.id })
      .from(features)
      .where(eq(features.currentWorkflowId, id))
    if (refs.length > 0) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Cannot delete workflow ${id}: ${refs.length} feature(s) still reference it. Switch those features to a different workflow first.`,
        400,
      )
    }

    // ON DELETE CASCADE 接管 workflow_nodes / workflow_edges
    await db.delete(workflows).where(eq(workflows.id, id))
    return ok(reply, null)
  })
}
