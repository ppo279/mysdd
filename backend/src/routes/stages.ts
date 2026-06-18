import path from 'path'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { stageRuns, features, workspaces, stageRunOutputs } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { AgentService } from '../services/agent.js'
import type { StreamChunk } from '../runtime/adapter.js'
import { BizError, Code, ok } from '../lib/envelope.js'
import { sseHeaders, sseWrite, writeSseError } from '../lib/sse.js'

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 0)
// /stages/start body 用 nodeId（workflow-scoped）替代 stage（agent id）。
const StartStageSchema = z.object({
  nodeId: z.string().min(1),
  firstMessage: z.string().min(1),
  runtimeId: z.string().default('claude'),
})

const SendMessageSchema = z.object({
  message: z.string().min(1),
})

// approve 接受 Record<outputName, content>。Phase 0 默认仅 'default'。
const ApproveSchema = z.object({
  outputs: z.record(z.string(), z.string()).refine(
    (o) => Object.keys(o).length > 0,
    { message: 'outputs must contain at least one entry' },
  ),
})

// 把 StreamChunk 映射成 SSE 帧：text / thinking / tool 三类分别落点
function writeChunk(res: NodeJS.WritableStream, chunk: StreamChunk) {
  if (chunk.kind === 'text') {
    sseWrite(res, { text: chunk.text })
  } else if (chunk.kind === 'thinking') {
    sseWrite(res, {
      thinking: {
        text: chunk.text,
        tokensDelta: chunk.tokensDelta,
        tokensTotal: chunk.tokensTotal,
      },
    })
  } else if (chunk.kind === 'tool') {
    sseWrite(res, {
      tool: {
        phase: chunk.phase,
        name: chunk.name,
        toolUseId: chunk.toolUseId,
        input: chunk.input,
      },
    })
  } else if (chunk.kind === 'question') {
    sseWrite(res, { question: chunk.questions })
  }
}

// 运行中的 stage run → AbortController（允许从外部终止子进程）
const activeAbortControllers = new Map<string, AbortController>()

export async function stageRoutes(app: FastifyInstance) {
  // 启动阶段 —— 返回 SSE 流
  app.post('/api/features/:featureId/stages/start', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const body = StartStageSchema.parse(req.body)

    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
    if (!workspace) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    // 自动将 workspace 元数据前置拼入背景信息，让 agent 知道工作区名称和代码路径
    const metaLines: string[] = [`**工作区名称：** ${workspace.name}`]
    if (workspace.localPath) {
      metaLines.push(`**代码仓库目录：** ${path.join(workspace.localPath, 'repo')}`)
    }
    if (workspace.repoUrl) {
      metaLines.push(`**远程仓库地址：** ${workspace.repoUrl}`)
    }
    if (workspace.techStack && workspace.techStack !== 'ts') {
      metaLines.push(`**技术栈：** ${workspace.techStack}`)
    }
    const enrichedBackground = [metaLines.join('\n'), workspace.background]
      .filter(Boolean)
      .join('\n\n')

    const abortController = new AbortController()

    try {
      const { stageRunId, stream } = await AgentService.startStage(
        featureId,
        body.nodeId,
        feature.workspaceId,
        workspace.techStack,
        enrichedBackground,
        body.firstMessage,
        body.runtimeId,
        workspace.localPath || undefined,
        {
          name: feature.name,
          description: body.firstMessage,   // [想法描述] = 用户在聊天框输入的首条消息
          mode: feature.description || '',  // [任务模式] = Feature 创建时填写的任务模式字段
        },
        abortController.signal,
      )

      activeAbortControllers.set(stageRunId, abortController)
      sseWrite(reply.raw, { stageRunId })

      for await (const chunk of stream) {
        writeChunk(reply.raw, chunk)
      }
      sseWrite(reply.raw, { done: true, stageRunId })
    } catch (err: any) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      if (aborted) {
        sseWrite(reply.raw, { done: true, aborted: true })
      } else {
        const code = err instanceof BizError ? err.code : Code.INTERNAL
        writeSseError(reply.raw, { message: err.message ?? String(err), code })
      }
    } finally {
      // stageRunId 可能尚未赋值（startStage 失败），用 AbortController 实例反查
      for (const [id, ctrl] of activeAbortControllers) {
        if (ctrl === abortController) { activeAbortControllers.delete(id); break }
      }
    }

    reply.raw.end()
  })

  // 续接消息 —— SSE 流
  app.post('/api/stage-runs/:stageRunId/messages', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const { message } = SendMessageSchema.parse(req.body)

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    const abortController = new AbortController()
    activeAbortControllers.set(stageRunId, abortController)

    try {
      const stream = await AgentService.sendMessage(stageRunId, message, abortController.signal)

      for await (const chunk of stream) {
        writeChunk(reply.raw, chunk)
      }
      sseWrite(reply.raw, { done: true })
    } catch (err: any) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      if (aborted) {
        sseWrite(reply.raw, { done: true, aborted: true })
      } else {
        const code = err instanceof BizError ? err.code : Code.INTERNAL
        writeSseError(reply.raw, { message: err.message ?? String(err), code })
      }
    } finally {
      activeAbortControllers.delete(stageRunId)
    }

    reply.raw.end()
  })

  // 中止正在运行的 stage（停止按钮）
  app.post('/api/stage-runs/:stageRunId/abort', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const ctrl = activeAbortControllers.get(stageRunId)
    if (!ctrl) return ok(reply, { aborted: false, reason: 'not running' })
    ctrl.abort()
    return ok(reply, { aborted: true })
  })

  // 获取 stageRun 消息历史
  app.get('/api/stage-runs/:stageRunId/messages', async (req) => {
    const { stageRunId } = req.params as { stageRunId: string }
    return AgentService.getMessages(stageRunId)
  })

  // 批准产物并写文件
  // body: { outputs: Record<outputName, content> }
  app.post('/api/stage-runs/:stageRunId/approve', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const { outputs } = ApproveSchema.parse(req.body)

    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new BizError(Code.STAGERUN_NOT_FOUND, 'StageRun not found', 404)

    const [feature] = await db.select().from(features).where(eq(features.id, run.featureId))
    if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, 'Feature not found', 404)

    const result = await AgentService.approveStage(stageRunId, outputs, feature.workspaceId, run.featureId)
    return ok(reply, result)
  })

  // 获取 stageRun 详情（Phase 3 起附带 outputs: Record<outputName, content>）
  app.get('/api/stage-runs/:stageRunId', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new BizError(Code.STAGERUN_NOT_FOUND, 'StageRun not found', 404)
    const outRows = await db
      .select()
      .from(stageRunOutputs)
      .where(eq(stageRunOutputs.stageRunId, stageRunId))
    const outputs: Record<string, string> = {}
    for (const o of outRows) outputs[o.outputName] = o.content
    return { ...run, outputs }
  })
}
