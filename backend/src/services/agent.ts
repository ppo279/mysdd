// Implements: docs/adr/0001-workflow-execution-model.md
// AgentService 重写为 workflow 驱动：
// - stageRuns.nodeId 取代 stage 字符串作为调度与产物路径的键
// - 上下文注入从"按 agent.upstream 数组"改为"按 workflow_edges"
// - 产物从"单字符串 + 单文件"改为"按 outputName 多行 + 多文件"
import { eq, asc, and } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  stageRuns,
  messages,
  features,
  workspaces,
  workflowNodes,
  workflowEdges,
  stageRunOutputs,
  featureNodeStates,
} from '../db/schema.js'
import { getRuntime } from '../runtime/registry.js'
import {
  buildSystemPrompt,
  buildEdgeBasedContext,
  getAgentConfig,
  type FeatureContext,
  type AgentRuntimeConfig,
} from '../config/agents.js'
import type { StreamChunk, SessionOptions } from '../runtime/adapter.js'
import { ArtifactService } from './artifact.js'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import os from 'os'
import { BizError, Code } from '../lib/envelope.js'
import { assertWithinWorkspaceBase } from '../routes/workspaces.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '../../../storage')

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
// 解析 effective SessionOptions：node.configJson > agent(YAML).config > 默认。
// - runtimeId:  覆盖 adapter 选取（决定走哪条 runtime 链）
// - env:        透传给 spawn
// - cwd:        覆盖自动计算的 <localPath>/repo；必须落在 WORKSPACE_BASE 内（由调用方在拿到结果后调 assertWithinWorkspaceBase 守卫）
// - timeoutMs:  硬超时
function parseJsonConfig(raw: string): AgentRuntimeConfig | undefined {
  if (!raw || raw === '{}' || !raw.trim()) return undefined
  try {
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return undefined
    return v as AgentRuntimeConfig
  } catch {
    return undefined
  }
}

/**
 * 合并三层配置（per-node > per-agent(YAML) > 默认）。
 * per-node 中为 undefined 的字段不覆盖 per-agent（细粒度 override）。
 */
function mergeConfig(
  perNode: AgentRuntimeConfig | undefined,
  perAgent: AgentRuntimeConfig | undefined,
): AgentRuntimeConfig | undefined {
  if (!perNode && !perAgent) return undefined
  return {
    runtimeId: perNode?.runtimeId ?? perAgent?.runtimeId,
    env: { ...(perAgent?.env ?? {}), ...(perNode?.env ?? {}) },
    cwd: perNode?.cwd ?? perAgent?.cwd,
    timeoutMs: perNode?.timeoutMs ?? perAgent?.timeoutMs,
  }
}

/**
 * 决定一次会话最终使用的 runtime id + session options。
 * - runtimeId:  per-node > per-agent > 默认 'claude'
 * - env/cwd/timeoutMs: per-node 字段优先；缺失则继承 per-agent
 */
function resolveSessionOptions(
  nodeConfigJson: string | null | undefined,
  agentId: string,
  localPath: string | undefined,
): { runtimeId: string; options: SessionOptions } {
  const perNode = parseJsonConfig(nodeConfigJson ?? '')
  const agent = getAgentConfig(agentId)
  const merged = mergeConfig(perNode, agent.config)

  const runtimeId = merged?.runtimeId ?? agent.runtime

  const defaultCwd = localPath ? path.join(localPath, 'repo') : undefined
  let cwd = merged?.cwd ?? defaultCwd
  if (cwd) {
    // Phase 2 守卫：per-node / per-agent 显式 cwd 不得逃出 WORKSPACE_BASE。
    // 默认 cwd（localPath/repo）已经在 routes/workspaces.ts 的创建流程里保证
    // localPath 自身在 WORKSPACE_BASE 内，故不必二次校验。
    if (merged?.cwd) {
      try {
        assertWithinWorkspaceBase(cwd)
      } catch (err) {
        throw err
      }
    }
  }

  return {
    runtimeId,
    options: {
      env: merged?.env,
      cwd,
      timeoutMs: merged?.timeoutMs,
    },
  }
}

export class AgentService {
  /**
   * 加载 feature 的当前 workflow（图）：node 行 + edge 行。
   * 找不到 workflow 时抛 WORKFLOW_NOT_FOUND。
   */
  static async loadFeatureGraph(featureId: string) {
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${featureId} not found`, 404)
    if (!feature.currentWorkflowId) {
      throw new BizError(
        Code.WORKFLOW_NOT_FOUND,
        `Feature ${featureId} has no current workflow`,
        400,
      )
    }
    const nodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, feature.currentWorkflowId))
    const edges = await db
      .select()
      .from(workflowEdges)
      .where(eq(workflowEdges.workflowId, feature.currentWorkflowId))
    return { feature, nodes, edges }
  }

  /** 找到该 feature 当前活跃 stageRun（最新一条）。 */
  static async findActiveRunForNode(featureId: string, nodeId: string) {
    const rows = await db
      .select()
      .from(stageRuns)
      .where(and(eq(stageRuns.featureId, featureId), eq(stageRuns.nodeId, nodeId)))
      .orderBy(asc(stageRuns.createdAt))
    return rows
  }

  /**
   * 启动一个新 stageRun。
   * @param nodeId  workflow-scoped 节点 id（不再是 agent id 字符串）
   * @param firstMessage  首发用户消息
   * @param runtimeId     运行时 id
   */
  static async startStage(
    featureId: string,
    nodeId: string,
    workspaceId: string,
    techStack: string,
    background: string,
    firstMessage: string,
    runtimeId: string = 'claude',
    localPath?: string,
    featureCtx?: FeatureContext,
    signal?: AbortSignal,
  ): Promise<{ stageRunId: string; stream: AsyncIterable<StreamChunk> }> {
    const { feature, nodes, edges } = await this.loadFeatureGraph(featureId)
    const node = nodes.find((n) => n.nodeId === nodeId)
    if (!node) {
      throw new BizError(
        Code.WORKFLOW_INVALID,
        `Node "${nodeId}" not found in feature's current workflow`,
        400,
      )
    }
    const agent = getAgentConfig(node.agentId)

    // 通过 workflow_edges 拉取上游产物，按 toInput 聚合
    const upstream = await this.collectUpstreamArtifacts(feature.id, nodeId, edges, nodes)
    const upstreamCtx = buildEdgeBasedContext(upstream)
    const systemPrompt = buildSystemPrompt(agent.id, techStack, background, featureCtx) + upstreamCtx

    const runtime = getRuntime(runtimeId)
    // Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
    // 解析 effective config: per-node > per-agent(YAML) > 默认。
    // 显式 cwd 已被 assertWithinWorkspaceBase 守卫；默认 cwd = <localPath>/repo
    // 由 routes/workspaces.ts 的创建流程保证 localPath 自身在 WORKSPACE_BASE 内。
    const { runtimeId: effectiveRuntimeId, options: sessionOptions } = resolveSessionOptions(
      node.configJson,
      agent.id,
      localPath,
    )
    const effectiveRuntime = getRuntime(effectiveRuntimeId)
    const { sessionId, stream } = await effectiveRuntime.createSession(
      systemPrompt,
      firstMessage,
      sessionOptions.cwd,
      { ...sessionOptions, signal },
    )

    const stageRunId = randomUUID()
    const now = new Date()

    await db.insert(stageRuns).values({
      id: stageRunId,
      featureId,
      stage: agent.id,        // 兼容旧字段：存 agent id
      nodeId: node.nodeId,    // 新字段：workflow-scoped
      runtimeId,
      cliSessionId: sessionId,
      status: 'active',
      artifactContent: '',
      artifactPath: '',
      createdAt: now,
    })

    await db.insert(messages).values({
      id: randomUUID(),
      stageRunId,
      role: 'user',
      content: firstMessage,
      createdAt: now,
    })

    // 标记该 node 为 active（首次启动或新一轮）
    await this.upsertNodeState(feature.id, node.nodeId, 'active', stageRunId)

    // 包装流：结束时存储 assistant 消息（只持久化 text，thinking/tool 透传不落库）
    const self = this
    async function* wrappedStream(): AsyncIterable<StreamChunk> {
      let fullText = ''
      for await (const chunk of stream) {
        if (chunk.kind === 'text') fullText += chunk.text
        yield chunk
      }
      await db.insert(messages).values({
        id: randomUUID(),
        stageRunId,
        role: 'assistant',
        content: fullText,
        createdAt: new Date(),
      })
    }

    return { stageRunId, stream: wrappedStream() }
  }

  /**
   * 沿 workflow_edges 收集上游已批准产物。
   * 产物以 (fromNodeId, fromOutput) 为键 → 内容；返回时也附带 toInput 便于 buildEdgeBasedContext。
   */
  static async collectUpstreamArtifacts(
    featureId: string,
    toNodeId: string,
    edges: Array<{ fromNodeId: string; fromOutput: string; toNodeId: string; toInput: string }>,
    nodes: Array<{ nodeId: string; agentId: string }>,
  ): Promise<Array<{ fromNodeId: string; agentId: string; fromOutput: string; toInput: string; content: string }>> {
    const incoming = edges.filter((e) => e.toNodeId === toNodeId)
    if (incoming.length === 0) return []

    const out: Array<{ fromNodeId: string; agentId: string; fromOutput: string; toInput: string; content: string }> = []
    for (const e of incoming) {
      const upstreamNode = nodes.find((n) => n.nodeId === e.fromNodeId)
      if (!upstreamNode) continue
      // 找该 node 最近一条 approved stageRun
      const runs = await db
        .select()
        .from(stageRuns)
        .where(and(eq(stageRuns.featureId, featureId), eq(stageRuns.nodeId, e.fromNodeId)))
      const approvedRun = runs.filter((r) => r.status === 'approved').sort((a, b) => +b.approvedAt! - +a.approvedAt!)[0]
      if (!approvedRun) continue
      const [output] = await db
        .select()
        .from(stageRunOutputs)
        .where(and(eq(stageRunOutputs.stageRunId, approvedRun.id), eq(stageRunOutputs.outputName, e.fromOutput)))
      if (!output) continue
      out.push({
        fromNodeId: e.fromNodeId,
        agentId: upstreamNode.agentId,
        fromOutput: e.fromOutput,
        toInput: e.toInput,
        content: output.content,
      })
    }
    return out
  }

  static async upsertNodeState(
    featureId: string,
    nodeId: string,
    status: 'pending' | 'active' | 'approved' | 'rejected',
    lastStageRunId?: string,
  ) {
    const existing = await db
      .select()
      .from(featureNodeStates)
      .where(and(eq(featureNodeStates.featureId, featureId), eq(featureNodeStates.nodeId, nodeId)))
    if (existing.length === 0) {
      await db.insert(featureNodeStates).values({
        featureId,
        nodeId,
        status,
        lastStageRunId: lastStageRunId ?? null,
        updatedAt: new Date(),
      })
    } else {
      await db
        .update(featureNodeStates)
        .set({ status, lastStageRunId: lastStageRunId ?? existing[0].lastStageRunId, updatedAt: new Date() })
        .where(and(eq(featureNodeStates.featureId, featureId), eq(featureNodeStates.nodeId, nodeId)))
    }
  }

  // 续接对话（发送后续消息）
  static async sendMessage(
    stageRunId: string,
    userMessage: string,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<StreamChunk>> {
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new BizError(Code.STAGERUN_NOT_FOUND, `StageRun ${stageRunId} not found`, 404)
    if (!run.cliSessionId) throw new BizError(Code.STAGERUN_NO_SESSION, `StageRun ${stageRunId} has no CLI session`, 400)

    const [feature] = await db.select().from(features).where(eq(features.id, run.featureId))
    let localPath: string | undefined
    let effectiveAgentId: string | undefined
    let effectiveNodeConfigJson: string | null = null
    if (feature) {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
      localPath = ws?.localPath || undefined
      effectiveAgentId = run.stage // 兼容字段：run.stage 存的是 agent id
      if (run.nodeId && feature.currentWorkflowId) {
        const [node] = await db
          .select()
          .from(workflowNodes)
          .where(and(eq(workflowNodes.workflowId, feature.currentWorkflowId), eq(workflowNodes.nodeId, run.nodeId)))
        if (node) {
          effectiveNodeConfigJson = node.configJson
          effectiveAgentId = node.agentId
        }
      }
    }

    // Phase 2: resume 也走 resolveSessionOptions，让 per-node / per-agent config
    // 在同一会话中保持一致（避免 start 时 cwd=A、resume 时 cwd=B）
    const { runtimeId: effectiveRuntimeId, options: sessionOptions } = resolveSessionOptions(
      effectiveNodeConfigJson,
      effectiveAgentId ?? run.stage,
      localPath,
    )
    const effectiveRuntime = getRuntime(effectiveRuntimeId)
    const stream = effectiveRuntime.resumeSession(
      run.cliSessionId,
      userMessage,
      sessionOptions.cwd,
      { ...sessionOptions, signal },
    )

    const now = new Date()
    await db.insert(messages).values({
      id: randomUUID(),
      stageRunId,
      role: 'user',
      content: userMessage,
      createdAt: now,
    })

    async function* wrappedStream(): AsyncIterable<StreamChunk> {
      let fullText = ''
      for await (const chunk of stream) {
        if (chunk.kind === 'text') fullText += chunk.text
        yield chunk
      }
      await db.insert(messages).values({
        id: randomUUID(),
        stageRunId,
        role: 'assistant',
        content: fullText,
        createdAt: new Date(),
      })
    }

    return wrappedStream()
  }

  /**
   * 批准产物，保存内容并写文件。
   * @param outputs  Record<outputName, content>。Phase 0 默认仅 'default'。
   *                Phase 3 起可传入多个 outputName，每个落到独立文件 + stage_run_outputs 行。
   */
  static async approveStage(
    stageRunId: string,
    outputs: Record<string, string>,
    workspaceId: string,
    featureId: string,
  ): Promise<{ nodeId: string; outputNames: string[] }> {
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new BizError(Code.STAGERUN_NOT_FOUND, `StageRun ${stageRunId} not found`, 404)

    if (!run.nodeId) {
      throw new BizError(
        Code.INTERNAL,
        `StageRun ${stageRunId} has no nodeId (legacy run?); cannot resolve artifact path`,
        500,
      )
    }

    const outputNames = Object.keys(outputs)
    if (outputNames.length === 0) {
      throw new BizError(Code.WORKFLOW_INVALID, 'approve requires at least one output', 400)
    }

    // 写文件 + 写 stage_run_outputs
    for (const outputName of outputNames) {
      const content = outputs[outputName] ?? ''
      const filePath = ArtifactService.getArtifactPath(workspaceId, featureId, run.nodeId, outputName)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')

      // upsert stage_run_outputs
      const existing = await db
        .select()
        .from(stageRunOutputs)
        .where(and(eq(stageRunOutputs.stageRunId, stageRunId), eq(stageRunOutputs.outputName, outputName)))
      const now = new Date()
      if (existing.length === 0) {
        await db.insert(stageRunOutputs).values({
          id: randomUUID(),
          stageRunId,
          outputName,
          content,
          approvedAt: now,
        })
      } else {
        await db
          .update(stageRunOutputs)
          .set({ content, approvedAt: now })
          .where(and(eq(stageRunOutputs.stageRunId, stageRunId), eq(stageRunOutputs.outputName, outputName)))
      }
    }

    const now = new Date()
    await db
      .update(stageRuns)
      .set({ status: 'approved', approvedAt: now })
      .where(eq(stageRuns.id, stageRunId))

    // 标记 node 状态为 approved
    await this.upsertNodeState(featureId, run.nodeId, 'approved', stageRunId)

    return { nodeId: run.nodeId, outputNames }
  }

  // 获取 stageRun 的全部消息
  static async getMessages(stageRunId: string) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.stageRunId, stageRunId))
      .orderBy(asc(messages.createdAt))
  }
}
