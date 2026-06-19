import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import {
  features,
  stageRuns,
  messages,
  workspaces,
  workflows,
  workflowNodes,
  workflowEdges,
  featureNodeStates,
  stageRunOutputs,
  featureNodeMigrations,
} from '../db/schema.js'
import { eq, asc, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { toposort } from '../services/workflow.js'
import { ArtifactService } from '../services/artifact.js'
import { BizError, Code, ok } from '../lib/envelope.js'
import { createSyntheticIntakeRun, parseWorkflowInputs } from '../services/intake.js'
import { removeFeatureWorktree, ensureFeatureWorktree } from '../services/worktree.js'
import { loadAuditReport, commitFeatureFix } from '../services/merge.js'

// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
const FeatureIntentSchema = z.enum(['bug_fix', 'spec_change', 'new_feature', 'refactor'])

const CreateFeatureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  intent: FeatureIntentSchema.optional(),
  workflowId: z.string().min(1).optional(),
  inputs: z.record(z.string(), z.string()).optional(),
})

export async function featureRoutes(app: FastifyInstance) {
  // 列出 workspace 下的 features
  app.get('/api/workspaces/:workspaceId/features', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string }
    const rows = await db
      .select()
      .from(features)
      .where(eq(features.workspaceId, workspaceId))
      .orderBy(asc(features.createdAt))
    return ok(reply, rows)
  })

  // 创建 feature
  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 0)
  // - 从 workspaces.default_workflow_id 取当前 workflow
  // - 用 toposort 的第一个 nodeId 作为 current_node_id
  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
  // - 接受 intent / workflowId / inputs
  // - intent=bug_fix 且未给 workflowId 时，选 workspace library 中声明了 bug_report input 的工作流
  // - 选完后创建合成 __intake__ stage_run + 写磁盘 side outputs
  app.post('/api/workspaces/:workspaceId/features', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string }
    const body = CreateFeatureSchema.parse(req.body)

    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
    if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    // 决定 workflowId：显式 > bug_fix 路由 > workspace default
    let workflowId: string | null = null
    if (body.workflowId) {
      const [wf] = await db.select().from(workflows).where(eq(workflows.id, body.workflowId))
      if (!wf || wf.workspaceId !== workspaceId) {
        throw new BizError(Code.WORKFLOW_INVALID, `workflowId "${body.workflowId}" does not belong to workspace ${workspaceId}`, 400)
      }
      workflowId = wf.id
    } else if (body.intent === 'bug_fix') {
      const libWorkflows = await db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId))
      const bugFix = libWorkflows.find((w) => !w.isArchived && parseWorkflowInputs(w.inputsJson).some((i) => i.name === 'bug_report'))
      if (!bugFix) {
        throw new BizError(
          Code.WORKFLOW_NOT_FOUND,
          `No bug-fix workflow found in workspace ${workspaceId}`,
          400,
        )
      }
      workflowId = bugFix.id
    } else {
      workflowId = ws.defaultWorkflowId
    }
    if (!workflowId) {
      throw new BizError(
        Code.WORKFLOW_NOT_FOUND,
        `Workspace ${workspaceId} has no default workflow`,
        400,
      )
    }

    // 计算当前 workflow 的 toposort，取首节点作为 current_node_id
    const nodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflowId))
    const edges = await db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, workflowId))
    const order = toposort({ nodes, edges })
    if (order.length === 0) {
      throw new BizError(Code.WORKFLOW_INVALID, `Workflow ${workflowId} has no nodes`, 400)
    }

    // 取 workflow 行一次：用于推导 intent 与 pre-validate intake inputs
    const [wfRow] = await db.select().from(workflows).where(eq(workflows.id, workflowId))
    const declaredInputs = parseWorkflowInputs(wfRow?.inputsJson)
    const missing = declaredInputs.filter((i) => i.required && !(body.inputs?.[i.name]))
    if (missing.length > 0) {
      throw new BizError(
        Code.MISSING_CONFIRM,
        `Workflow requires inputs: ${missing.map((m) => m.name).join(', ')}`,
        400,
      )
    }

    // 推导 intent：显式给则用；否则按 workflow 是否声明了 bug_report 推断
    const inferredFromBugIntake = declaredInputs.some((i) => i.name === 'bug_report')
    const intent: 'bug_fix' | 'spec_change' | 'new_feature' | 'refactor' =
      body.intent ?? (inferredFromBugIntake ? 'bug_fix' : 'new_feature')

    const feature = {
      id: randomUUID(),
      workspaceId,
      name: body.name,
      description: body.description,
      currentStage: order[0],
      currentWorkflowId: workflowId,
      currentNodeId: order[0],
      status: 'active',
      intent,
      lockedFiles: null,
      looksLike: null,
      createdAt: new Date(),
    }
    await db.insert(features).values(feature)

    // 创建合成 __intake__ stage_run（若 workflow 声明了 inputs 且用户提供了对应 content）
    await createSyntheticIntakeRun(feature.id, workspaceId, body.inputs ?? {})

    return ok(reply, feature, 201)
  })

  // 获取 feature 详情（含 stageRuns、nodeStates、workflow nodes）
  app.get('/api/features/:featureId', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)

    const runs = await db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.featureId, featureId))
      .orderBy(asc(stageRuns.createdAt))

    // Phase 3: 把每个 stageRun 的 stage_run_outputs 拼成 Record<outputName, content>
    // 前端从此不再读 stage_runs.artifact_content（该列保留为兼容，但不再是真相之源）
    const runIds = runs.map((r) => r.id)
    const outputsByRun: Record<string, Record<string, string>> = {}
    if (runIds.length > 0) {
      const outRows = await db
        .select()
        .from(stageRunOutputs)
        .where(inArray(stageRunOutputs.stageRunId, runIds))
      for (const o of outRows) {
        const map = outputsByRun[o.stageRunId] ?? (outputsByRun[o.stageRunId] = {})
        map[o.outputName] = o.content
      }
    }
    const enrichedRuns = runs.map((r) => ({ ...r, outputs: outputsByRun[r.id] ?? {} }))

    // 节点状态映射
    const states = await db
      .select()
      .from(featureNodeStates)
      .where(eq(featureNodeStates.featureId, featureId))
    const nodeStates: Record<string, { status: string; lastStageRunId: string | null }> = {}
    for (const s of states) {
      nodeStates[s.nodeId] = { status: s.status, lastStageRunId: s.lastStageRunId }
    }

    // 当前 workflow 的节点 / 边（供前端画阶段进度条）
    let workflowNodesList: Array<{ nodeId: string; agentId: string; displayName: string; positionX: number; positionY: number; outputs: string[] }> = []
    let workflowEdgesList: Array<{ fromNodeId: string; fromOutput: string; toNodeId: string; toInput: string }> = []
    if (feature.currentWorkflowId) {
      const ns = await db
        .select()
        .from(workflowNodes)
        .where(eq(workflowNodes.workflowId, feature.currentWorkflowId))
      const es = await db
        .select()
        .from(workflowEdges)
        .where(eq(workflowEdges.workflowId, feature.currentWorkflowId))
      workflowNodesList = ns.map((n) => {
        let outputs: string[] = ['default']
        try {
          const cfg = n.configJson ? JSON.parse(n.configJson) : {}
          if (Array.isArray(cfg.outputs) && cfg.outputs.length > 0) outputs = cfg.outputs
        } catch { /* 非法 configJson 静默 */ }
        return {
          nodeId: n.nodeId,
          agentId: n.agentId,
          displayName: n.displayName,
          positionX: n.positionX,
          positionY: n.positionY,
          outputs,
        }
      })
      workflowEdgesList = es.map((e) => ({
        fromNodeId: e.fromNodeId,
        fromOutput: e.fromOutput,
        toNodeId: e.toNodeId,
        toInput: e.toInput,
      }))
    }

    return ok(reply, {
      ...feature,
      stageRuns: enrichedRuns,
      nodeStates,
      workflow: {
        id: feature.currentWorkflowId,
        nodes: workflowNodesList,
        edges: workflowEdgesList,
      },
    })
  })

  // 流转到下一阶段：按 toposort 顺序取下一个 nodeId
  app.post('/api/features/:featureId/advance', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)
    if (!feature.currentWorkflowId) {
      throw new BizError(Code.WORKFLOW_NOT_FOUND, 'Feature has no current workflow', 400)
    }

    const nodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, feature.currentWorkflowId))
    const edges = await db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, feature.currentWorkflowId))
    const order = toposort({ nodes, edges })
    const currentIdx = order.indexOf(feature.currentNodeId)
    if (currentIdx === -1 || currentIdx >= order.length - 1) {
      await db.update(features).set({ status: 'done' }).where(eq(features.id, featureId))
      return ok(reply, { currentNodeId: feature.currentNodeId, status: 'done' })
    }

    const nextNodeId = order[currentIdx + 1]
    // 同步 stage 字段为 agent id（兼容旧字段语义）
    const nextNode = nodes.find((n) => n.nodeId === nextNodeId)
    await db
      .update(features)
      .set({ currentNodeId: nextNodeId, currentStage: nextNode?.agentId ?? nextNodeId })
      .where(eq(features.id, featureId))
    return ok(reply, { currentNodeId: nextNodeId, status: 'active' })
  })

  // 删除 feature：级联清理 messages / stage_runs / stage_run_outputs / 磁盘产物
  // （FK ON DELETE CASCADE 已经在 schema 里覆盖 messages / stage_runs / outputs；
  //  featureNodeStates 与 workflow 端的 rows 不挂在 featureId 上，故显式删）
  app.delete('/api/features/:featureId', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)

    // messages 没有 ON DELETE CASCADE，必须在删 stage_runs 之前手动清除
    const runIds = (
      await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, featureId))
    ).map((r) => r.id)
    if (runIds.length > 0) {
      await db.delete(messages).where(inArray(messages.stageRunId, runIds))
    }
    // stage_run_outputs 有 ON DELETE CASCADE from stage_runs，随 stage_runs 一起清理
    await db.delete(stageRuns).where(eq(stageRuns.featureId, featureId))
    // feature_node_states / feature_node_migrations 有 CASCADE from features，但仍显式删保证确定性
    await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, featureId))
    await db.delete(featureNodeMigrations).where(eq(featureNodeMigrations.featureId, featureId))

    // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02)
    // 若 feature 是 bug_fix 且已分配 worktree，删除时清理 worktree 目录与 git worktree 登记
    if (feature.intent === 'bug_fix') {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
      if (ws?.localPath) {
        try { await removeFeatureWorktree(ws.localPath, featureId) } catch { /* best-effort */ }
      }
    }

    // 删除磁盘上的产物目录 storage/<workspaceId>/<featureId>/
    // 利用 getArtifactPath 拼到上一级；为避免引入假参数，直接用 path.dirname
    const samplePath = ArtifactService.getArtifactPath(feature.workspaceId, featureId, 'placeholder', 'placeholder')
    const dir = path.dirname(path.dirname(samplePath))
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    await db.delete(features).where(eq(features.id, featureId))
    return ok(reply, null)
  })

  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04)
  // GET /api/features/:featureId/audit-report
  // Returns the latest quality-gatekeeper audit run (approved OR rejected)
  // plus the structured fields the UI needs:
  //   - verdict / rejectionReason
  //   - 3-phase reverse validation table (forward / reverse / reapply)
  //   - mutation_score / coverage_delta
  //   - fix.patch content (for the diff view)
  //   - reproduction_test content (for the test-link panel)
  //   - bug_analysis.symptom (used by the merge commit message)
  // 404 when no audit has run yet.
  app.get('/api/features/:featureId/audit-report', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)

    const data = await loadAuditReport(featureId, feature.workspaceId)
    if (!data) {
      throw new BizError(
        Code.AUDIT_REPORT_NOT_FOUND,
        `Feature ${featureId} has no audit report yet (gatekeeper has not run)`,
        404,
      )
    }
    return ok(reply, data)
  })

  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04) + CONTEXT.md FB2/TF1
  // POST /api/features/:featureId/merge
  // Squashes the agent commits on bugfix/<featId> into a single review commit
  // with the TF1 commit message (Bug: / Adds regression test: / Audit: trailers).
  // 409 when the feature is not 'approved' (gatekeeper hasn't approved, or
  // already merged).
  app.post('/api/features/:featureId/merge', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)
    if (feature.status !== 'approved') {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Feature ${featureId} is not approved (current status: ${feature.status}); merge requires status='approved'`,
        409,
      )
    }

    // Resolve the worktree path. Reuse the worktree service so the call is
    // idempotent and symlinks node_modules as needed.
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
    if (!ws?.localPath) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Feature ${featureId} has no workspace localPath; cannot resolve worktree`,
        400,
      )
    }
    const wt = await ensureFeatureWorktree({ featureId, localPath: ws.localPath })

    const result = await commitFeatureFix({
      featureId,
      workspaceId: feature.workspaceId,
      featureWorktreePath: wt.path,
    })

    return ok(reply, {
      ...result,
      hint: 'The branch is ready to merge into your main branch. No auto-merge has been performed.',
    })
  })

  // 切换 feature 的工作流
  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
  // body: { toWorkflowId, mapping: Record<oldNodeId, { newNodeId, outputRename?, inputRename? }> }
  // 1) 校验：每个 feature_node_states.status='approved' 的 oldNodeId 都必须有 newNodeId 映射
  // 2) 校验：mapping 中的每个 newNodeId 必须在 toWorkflowId 的 workflow_nodes 里存在
  // 3) 写 feature_node_migrations 一行（applied_at = now）
  // 4) 重映射 feature_node_states：把 (oldNodeId) 行的状态搬到 (newNodeId) 上
  //    - 同一 (newNodeId) 上若已有状态行（来自另一条被映射），以 source feature 的状态为准（合并）
  // 5) 更新 features.current_workflow_id 和 current_node_id：
  //    - 若旧 current_node_id 被映射到 newNodeId，则 newNodeId 成为新 current_node_id
  //    - 否则取新 workflow toposort 的第一个节点
  const SwitchWorkflowSchema = z.object({
    toWorkflowId: z.string().min(1),
    mapping: z.record(
      z.string(),
      z.object({
        newNodeId: z.string().min(1),
        outputRename: z.string().optional(),
        inputRename: z.string().optional(),
      }),
    ),
  })

  app.post('/api/features/:featureId/switch-workflow', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const body = SwitchWorkflowSchema.parse(req.body)

    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)
    if (!feature.currentWorkflowId) {
      throw new BizError(Code.WORKFLOW_NOT_FOUND, 'Feature has no current workflow', 400)
    }
    if (body.toWorkflowId === feature.currentWorkflowId) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        'Target workflow is the same as the current workflow',
        400,
      )
    }

    // 加载目标 workflow
    const newNodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, body.toWorkflowId))
    if (newNodes.length === 0) {
      throw new BizError(Code.WORKFLOW_NOT_FOUND, 'Target workflow not found or has no nodes', 404)
    }
    const newNodeIds = new Set(newNodes.map((n) => n.nodeId))
    const newEdges = await db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, body.toWorkflowId))

    // 校验：mapping 的 newNodeId 都必须存在于目标 workflow
    for (const [oldNodeId, m] of Object.entries(body.mapping)) {
      if (!newNodeIds.has(m.newNodeId)) {
        throw new BizError(
          Code.WORKFLOW_INVALID,
          `Mapping references unknown newNodeId "${m.newNodeId}" (from oldNodeId "${oldNodeId}")`,
          400,
        )
      }
    }

    // 加载 feature 的节点状态
    const states = await db
      .select()
      .from(featureNodeStates)
      .where(eq(featureNodeStates.featureId, featureId))
    const approvedOldIds = states.filter((s) => s.status === 'approved').map((s) => s.nodeId)

    // 校验：每个已批准的 oldNodeId 都必须出现在 mapping 里
    for (const oldId of approvedOldIds) {
      if (!body.mapping[oldId]) {
        throw new BizError(
          Code.WORKFLOW_INVALID,
          `Approved node "${oldId}" is missing from mapping`,
          400,
        )
      }
    }

    // 写 feature_node_migrations
    await db.insert(featureNodeMigrations).values({
      id: randomUUID(),
      featureId,
      fromWorkflowId: feature.currentWorkflowId,
      toWorkflowId: body.toWorkflowId,
      mappingJson: JSON.stringify(body.mapping),
      createdAt: new Date(),
      appliedAt: new Date(),
    })

    // 重映射 feature_node_states：
    // 1) 收集映射后的状态：oldNodeId → newNodeId → {status, lastStageRunId}
    //    同一个 newNodeId 上若有多个来源，取 status 优先级 approved > active > pending
    // 2) 删除所有旧行（外键未跨表，简单删）
    // 3) 重新插入新行
    const statusRank: Record<string, number> = { pending: 0, active: 1, approved: 2, rejected: 3 }
    const merged = new Map<string, { status: string; lastStageRunId: string | null }>()
    for (const s of states) {
      const m = body.mapping[s.nodeId]
      const targetId = m?.newNodeId ?? s.nodeId
      // 同一 newNodeId 上若已有更高优先级状态，保留更优者
      const existing = merged.get(targetId)
      if (!existing || (statusRank[s.status] ?? 0) > (statusRank[existing.status] ?? 0)) {
        merged.set(targetId, { status: s.status, lastStageRunId: s.lastStageRunId })
      }
    }

    await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, featureId))
    const now = new Date()
    for (const [nodeId, s] of merged) {
      await db.insert(featureNodeStates).values({
        featureId,
        nodeId,
        status: s.status,
        lastStageRunId: s.lastStageRunId,
        updatedAt: now,
      })
    }

    // 计算新的 current_node_id：
    // 1) 若旧 current_node_id 被映射，则采用其 newNodeId
    // 2) 否则取新 workflow toposort 的第一个节点
    const newOrder = toposort({ nodes: newNodes, edges: newEdges })
    const mappedCurrent = body.mapping[feature.currentNodeId]?.newNodeId
    const nextCurrent =
      (mappedCurrent && newNodeIds.has(mappedCurrent) ? mappedCurrent : null) ??
      (newOrder.length > 0 ? newOrder[0] : null)
    if (!nextCurrent) {
      throw new BizError(Code.WORKFLOW_INVALID, 'Target workflow has no nodes', 400)
    }
    // 同步 currentStage（兼容旧字段）
    const nextNode = newNodes.find((n) => n.nodeId === nextCurrent)
    await db
      .update(features)
      .set({
        currentWorkflowId: body.toWorkflowId,
        currentNodeId: nextCurrent,
        currentStage: nextNode?.agentId ?? nextCurrent,
      })
      .where(eq(features.id, featureId))

    return ok(reply, {
      currentWorkflowId: body.toWorkflowId,
      currentNodeId: nextCurrent,
      applied: true,
    })
  })
}
