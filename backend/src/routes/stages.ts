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

export async function stageRoutes(app: FastifyInstance) {
  // 启动阶段 —— 返回 SSE 流
  app.post('/api/features/:featureId/stages/start', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const body = StartStageSchema.parse(req.body)

    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
    if (!workspace) return reply.code(404).send({ error: 'Workspace not found' })

    const { stageRunId, stream } = await AgentService.startStage(
      featureId,
      body.stage,
      feature.workspaceId,
      workspace.techStack,
      workspace.background,
      body.firstMessage,
      body.runtimeId,
    )

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Stage-Run-Id': stageRunId,
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
      'Access-Control-Expose-Headers': 'X-Stage-Run-Id',
    })

    for await (const chunk of stream) {
      reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
    }
    reply.raw.write(`data: ${JSON.stringify({ done: true, stageRunId })}\n\n`)
    reply.raw.end()
  })

  // 续接消息 —— SSE 流
  app.post('/api/stage-runs/:stageRunId/messages', async (req, reply) => {
    const { stageRunId } = req.params as { stageRunId: string }
    const { message } = SendMessageSchema.parse(req.body)

    const stream = await AgentService.sendMessage(stageRunId, message)

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': (req.headers.origin as string) ?? '*',
    })

    for await (const chunk of stream) {
      reply.raw.write(`data: ${JSON.stringify({ text: chunk })}\n\n`)
    }
    reply.raw.write(`data: ${JSON.stringify({ done: true })}\n\n`)
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
