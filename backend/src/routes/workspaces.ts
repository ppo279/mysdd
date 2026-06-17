import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { workspaces, features, stageRuns, messages } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'

// Cross-platform workspace root: ~/sdd-workspaces/ (C:\Users\...\sdd-workspaces on Windows)
const WORKSPACE_BASE = path.join(os.homedir(), 'sdd-workspaces')
fs.mkdirSync(WORKSPACE_BASE, { recursive: true })

function workspaceDir(id: string) {
  return path.join(WORKSPACE_BASE, id)
}

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  repoUrl: z.string().default(''),
  background: z.string().default(''),
})

const UpdateWorkspaceSchema = CreateWorkspaceSchema.extend({
  techStack: z.string().optional(),
}).partial()

function sseHeaders(origin?: string) {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin ?? '*',
  }
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
      techStack: 'ts',   // default, not user-facing for now
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

  // 删除 workspace（级联删 features / stage_runs / messages，再删本地目录）
  app.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) return reply.code(404).send({ error: 'Workspace not found' })

    const featureList = await db.select().from(features).where(eq(features.workspaceId, id))
    for (const feat of featureList) {
      const runs = await db.select().from(stageRuns).where(eq(stageRuns.featureId, feat.id))
      for (const run of runs) {
        await db.delete(messages).where(eq(messages.stageRunId, run.id))
      }
      await db.delete(stageRuns).where(eq(stageRuns.featureId, feat.id))
    }
    await db.delete(features).where(eq(features.workspaceId, id))

    if (ws.localPath) {
      try { fs.rmSync(ws.localPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    await db.delete(workspaces).where(eq(workspaces.id, id))
    return reply.code(204).send()
  })

  // 初始化 workspace（git clone，SSE 流式输出）
  app.post('/api/workspaces/:id/init', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) return reply.code(404).send({ error: 'Workspace not found' })

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    const write = (text: string, extra?: Record<string, unknown>) =>
      reply.raw.write(`data: ${JSON.stringify({ text, ...extra })}\n\n`)

    if (!ws.repoUrl?.trim()) {
      write('未配置 Git 仓库地址，跳过克隆。\n', { done: true })
      reply.raw.end()
      return
    }

    write(`正在克隆 ${ws.repoUrl} ...\n`)

    const proc = spawn('git', ['clone', ws.repoUrl, '.'], {
      cwd: ws.localPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    })

    const onData = (chunk: Buffer) => write(chunk.toString())
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.on('close', (code) => {
      if (code === 0) {
        write('\n✅ 仓库克隆成功！\n', { done: true })
      } else {
        write(`\n❌ git clone 失败（exit code: ${code}）\n`, { done: true, error: true })
      }
      reply.raw.end()
    })

    proc.on('error', (err) => {
      write(`\n❌ 无法启动 git：${err.message}\n`, { done: true, error: true })
      reply.raw.end()
    })
  })
}
