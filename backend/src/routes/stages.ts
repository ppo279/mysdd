import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { stageRuns, features, workspaces } from '../db/schema.js'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { AgentService } from '../services/agent.js'
import { randomUUID } from 'crypto'

const StartStageSchema = z.object({
  stage: z.string(),
  firstMessage: z.string().min(1),
  runtimeId: z.string().default('claude'),
})

const SendMessageSchema = z.object({
  message: z.string().min(1),
})

const ApproveSchema = z.object({
  artifactContent: z.string(),
})

function sseHeaders(origin: string | undefined) {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Expose-Headers': 'X-Stage-Run-Id',
  }
}

function sseWrite(res: NodeJS.WritableStream, data: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

export async function stageRoutes(app: FastifyInstance) {
  // 启动阶段 —— 返回 SSE 流
  app.post('/api/features/:featureId/stages/start', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const body = StartStageSchema.parse(req.body)

    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

    // Disable Nagle's algorithm so each write() is flushed to the client immediately
    reply.raw.socket?.setNoDelay?.(true)

    // Send SSE headers NOW — before starting the CLI — so the frontend fetch()
    // resolves immediately and reader.read() is ready to receive tokens in real-time.
    // stageRunId cannot be in the HTTP header anymore; it arrives as the first SSE event.
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    try {
      const { stageRunId, stream } = await AgentService.startStage(
        featureId,
        body.stage,
        feature.workspaceId,
        workspace.techStack,
        workspace.background,
        body.firstMessage,
        body.runtimeId,
        workspace.localPath || undefined,
        { name: feature.name, description: feature.description },
      )

      // First event carries the stageRunId so the frontend can track the run
      sseWrite(reply.raw, { stageRunId })

      for await (const chunk of stream) {
        sseWrite(reply.raw, { text: chunk })
      }
      sseWrite(reply.raw, { done: true, stageRunId })
    } catch (err: any) {
      sseWrite(reply.raw, { error: err.message ?? String(err) })
    }

    reply.raw.end()
  })

  // 续接消息 —— SSE 流
  app.post('/api/stage-runs/:stageRunId/messages', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const { message } = SendMessageSchema.parse(req.body)

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    try {
      const stream = await AgentService.sendMessage(stageRunId, message)

      for await (const chunk of stream) {
        sseWrite(reply.raw, { text: chunk })
      }
      sseWrite(reply.raw, { done: true })
    } catch (err: any) {
      sseWrite(reply.raw, { error: err.message ?? String(err) })
    }

    reply.raw.end()
  })

  // 获取 stageRun 消息历史
  app.get('/api/stage-runs/:stageRunId/messages', async (req) => {
    const { stageRunId } = req.params as { stageRunId: string }
    return AgentService.getMessages(stageRunId)
  })

  // 批准产物并写文件
  app.post('/api/stage-runs/:stageRunId/approve', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const { artifactContent } = ApproveSchema.parse(req.body)

    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) return reply.code(404).send({ error: 'StageRun not found' })

    const [feature] = await db.select().from(features).where(eq(features.id, run.featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    await AgentService.approveStage(stageRunId, artifactContent, feature.workspaceId, run.featureId)
    return { ok: true }
  })

  // 获取 stageRun 详情
  app.get('/api/stage-runs/:stageRunId', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) return reply.code(404).send({ error: 'Not found' })
    return run
  })
}
