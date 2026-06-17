import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { features, stageRuns, workspaces, messages } from '../db/schema.js'
import { eq, asc, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import fs from 'fs'
import path from 'path'
import { ArtifactService } from '../services/artifact.js'
import { loadAgentsConfig } from '../config/agents.js'

const CreateFeatureSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
})

export async function featureRoutes(app: FastifyInstance) {
  // 列出 workspace 下的 features
  app.get('/api/workspaces/:workspaceId/features', async (req) => {
    const { workspaceId } = req.params as { workspaceId: string }
    return db
      .select()
      .from(features)
      .where(eq(features.workspaceId, workspaceId))
      .orderBy(asc(features.createdAt))
  })

  // 创建 feature
  app.post('/api/workspaces/:workspaceId/features', async (req, reply) => {
    const { workspaceId } = req.params as { workspaceId: string }
    const body = CreateFeatureSchema.parse(req.body)

    const feature = {
      id: randomUUID(),
      workspaceId,
      name: body.name,
      description: body.description,
      currentStage: 'spec',
      status: 'active',
      createdAt: new Date(),
    }
    await db.insert(features).values(feature)
    return reply.code(201).send(feature)
  })

  // 获取 feature 详情（含 stageRuns）
  app.get('/api/features/:featureId', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    const runs = await db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.featureId, featureId))
      .orderBy(asc(stageRuns.createdAt))

    const agentOrder = loadAgentsConfig().agents.map((a) => a.id)
    return { ...feature, stageRuns: runs, agentOrder }
  })

  // 流转到下一阶段（用户点"确认流转"按钮）
  app.post('/api/features/:featureId/advance', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    const agentOrder = loadAgentsConfig().agents.map((a) => a.id)
    const currentIdx = agentOrder.indexOf(feature.currentStage)
    if (currentIdx === -1 || currentIdx >= agentOrder.length - 1) {
      await db.update(features).set({ status: 'done' }).where(eq(features.id, featureId))
      return { currentStage: feature.currentStage, status: 'done' }
    }

    const nextStage = agentOrder[currentIdx + 1]
    await db.update(features).set({ currentStage: nextStage }).where(eq(features.id, featureId))
    return { currentStage: nextStage, status: 'active' }
  })

  // 删除 feature：级联清理 messages / stage_runs / 磁盘产物，再删行
  app.delete('/api/features/:featureId', async (req, reply) => {
    const { featureId } = req.params as { featureId: string }
    const [feature] = await db.select().from(features).where(eq(features.id, featureId))
    if (!feature) return reply.code(404).send({ error: 'Feature not found' })

    // 先拿到该 feature 下所有 stageRun id，删 messages 走 inArray
    const runs = await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, featureId))
    const runIds = runs.map((r) => r.id)
    if (runIds.length > 0) {
      await db.delete(messages).where(inArray(messages.stageRunId, runIds))
    }
    await db.delete(stageRuns).where(eq(stageRuns.featureId, featureId))

    // 删除磁盘上的产物目录 storage/<workspaceId>/<featureId>/
    const dir = path.dirname(ArtifactService.getArtifactPath(feature.workspaceId, featureId, 'spec.md'))
    if (fs.existsSync(dir)) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }

    await db.delete(features).where(eq(features.id, featureId))
    return reply.code(204).send()
  })
}
