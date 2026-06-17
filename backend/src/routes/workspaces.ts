import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { workspaces, features } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '../../../storage')

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  repoUrl: z.string().default(''),
  techStack: z.string().default('ts'),
  background: z.string().default(''),
})

const UpdateWorkspaceSchema = CreateWorkspaceSchema.partial()

function workspaceDir(id: string) {
  return path.join(STORAGE_ROOT, 'workspaces', id)
}

export async function workspaceRoutes(app: FastifyInstance) {
  // 列出所有 workspace
  app.get('/api/workspaces', async () => {
    return db.select().from(workspaces).orderBy(asc(workspaces.createdAt))
  })

  // 创建 workspace（自动建本地目录）
  app.post('/api/workspaces', async (req, reply) => {
    const body = CreateWorkspaceSchema.parse(req.body)
    const id = randomUUID()
    const localPath = workspaceDir(id)
    fs.mkdirSync(localPath, { recursive: true })

    const workspace = {
      id,
      ...body,
      localPath,
      createdAt: new Date(),
    }
    await db.insert(workspaces).values(workspace)
    return reply.code(201).send(workspace)
  })

  // 获取单个 workspace（含 features）
  app.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) return reply.code(404).send({ error: 'Workspace not found' })

    const featureList = await db
      .select()
      .from(features)
      .where(eq(features.workspaceId, id))
      .orderBy(asc(features.createdAt))

    return { ...ws, features: featureList }
  })

  // 更新 workspace
  app.patch('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateWorkspaceSchema.parse(req.body)
    await db.update(workspaces).set(body).where(eq(workspaces.id, id))
    const [updated] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    return updated
  })

  // 删除 workspace（同时删除本地目录）
  app.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (ws?.localPath) {
      try { fs.rmSync(ws.localPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    await db.delete(workspaces).where(eq(workspaces.id, id))
    return reply.code(204).send()
  })
}
