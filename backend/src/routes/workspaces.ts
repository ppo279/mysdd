import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { workspaces, features } from '../db/schema.js'
import { eq, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import { spawn } from 'child_process'
import { BizError, Code, ok } from '../lib/envelope.js'
import { sseHeaders, sseWrite, writeSseError } from '../lib/sse.js'
import { createInitialWorkflow } from '../services/workflow-bootstrap.js'
import { seedBugFixWorkflow } from '../services/workflow-seed.js'

// Cross-platform workspace root: ~/sdd-workspaces/ (C:\Users\...\sdd-workspaces on Windows)
export const WORKSPACE_BASE = path.join(os.homedir(), 'sdd-workspaces')
fs.mkdirSync(WORKSPACE_BASE, { recursive: true })

function workspaceDir(id: string) {
  return path.join(WORKSPACE_BASE, id)
}

// Implements: spec.md#AC-09 / plan.md#D-01 / tasks.md#T004
// 原子建工作区三层布局（repo/ memory/ tmp/），任一失败反序回滚。
// 顺序：mkdir repo → mkdir memory → writeFile MEMORY.md → mkdir .draft → mkdir tmp → writeFile .gitignore(若不存在)
export async function createWorkspaceLayout(localPath: string): Promise<void> {
  const repoDir = path.join(localPath, 'repo')
  const memoryDir = path.join(localPath, 'memory')
  const memoryFile = path.join(memoryDir, 'MEMORY.md')
  const draftDir = path.join(memoryDir, '.draft')
  const tmpDir = path.join(localPath, 'tmp')
  const gitignoreFile = path.join(localPath, '.gitignore')

  const createdDirs: string[] = []
  const createdFiles: string[] = []

  const rollback = () => {
    for (const f of createdFiles) {
      try { fs.rmSync(f, { force: true }) } catch { /* best-effort */ }
    }
    for (let i = createdDirs.length - 1; i >= 0; i--) {
      try { fs.rmSync(createdDirs[i], { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }

  try {
    createdDirs.push(repoDir)
    await fsp.mkdir(repoDir)

    createdDirs.push(memoryDir)
    await fsp.mkdir(memoryDir)

    createdFiles.push(memoryFile)
    await fsp.writeFile(memoryFile, '')

    createdDirs.push(draftDir)
    await fsp.mkdir(draftDir)

    createdDirs.push(tmpDir)
    await fsp.mkdir(tmpDir)

    // .gitignore：仅当不存在时创建，避免覆盖用户既有规则
    if (!fs.existsSync(gitignoreFile)) {
      createdFiles.push(gitignoreFile)
      await fsp.writeFile(gitignoreFile, 'memory/\n')
    }
  } catch (err) {
    rollback()
    throw err
  }
}

// Implements: spec.md#SCN-06 / plan.md#D-05
// 旧结构判定：.git 在 <root>/ 根且无 <root>/repo。
export function isLegacyWorkspace(localPath: string): boolean {
  return fs.existsSync(path.join(localPath, '.git')) && !fs.existsSync(path.join(localPath, 'repo'))
}

// Implements: spec.md#AC-14
// 路径遍历防护：解析后必须以 WORKSPACE_BASE 为前缀（避免同名前缀绕过）。
// 抛 BizError 让 registerErrorHandler 统一转 envelope
export function assertWithinWorkspaceBase(localPath: string): void {
  const resolved = path.resolve(localPath)
  const base = path.resolve(WORKSPACE_BASE)
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new BizError(
      Code.PATH_TRAVERSAL,
      `localPath outside WORKSPACE_BASE: ${localPath}`,
      400,
    )
  }
}

// Implements: spec.md#AC-12
// 候选区同名追加后缀：baseName.md → baseName-1.md → baseName-2.md → ...
export function nextAvailableDraftPath(dir: string, baseName: string): string {
  const first = path.join(dir, `${baseName}.md`)
  if (!fs.existsSync(first)) return first
  let n = 1
  while (true) {
    const candidate = path.join(dir, `${baseName}-${n}.md`)
    if (!fs.existsSync(candidate)) return candidate
    n++
  }
}

const CreateWorkspaceSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  repoUrl: z.string().default(''),
  background: z.string().default(''),
})

const UpdateWorkspaceSchema = CreateWorkspaceSchema.extend({
  techStack: z.string().optional(),
  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
  // 允许 PATCH 把 default_workflow_id 指向 workspace 下的某个 workflow
  defaultWorkflowId: z.string().nullable().optional(),
}).partial()

// Implements: spec.md#SCN-06 / plan.md#D-04 / tasks.md#T018
// reinit 二次确认：body.confirm 必须 === true，缺失视为取消（E-10）
const ReinitSchema = z.object({
  confirm: z.literal(true),
})

export async function workspaceRoutes(app: FastifyInstance) {
  // 列出所有 workspace
  app.get('/api/workspaces', async (req, reply) => {
    const list = await db.select().from(workspaces).orderBy(asc(workspaces.createdAt))
    return ok(reply, list)
  })

  // 创建 workspace（三层目录布局 + DB 行；任一失败回滚）
  // Implements: spec.md#SCN-01 / plan.md#2.3 / tasks.md#T006
  app.post('/api/workspaces', async (req, reply) => {
    // zod 校验失败由 registerErrorHandler 接管为 envelope 1001
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

    try {
      await db.insert(workspaces).values(workspace)
      // 创建 repo/ memory/ tmp/ 三层布局 + MEMORY.md + .gitignore
      await createWorkspaceLayout(localPath)
      // Implements: docs/adr/0001-workflow-execution-model.md (Phase 0)
      // 种子"默认工作流"：从 agents.yaml 读出 agent 列表，插入 1 个 workflows + N 个 workflow_nodes + (N-1) 个串联的 workflow_edges
      // 设回 workspaces.default_workflow_id。失败时回滚（workflow 表上没有 CASCADE 到 workspace，所以这里顺序很重要）
      await createInitialWorkflow(id)
      // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
      // 种子 bug-fix workflow 到 workspace library；幂等，缺少 agent 不阻断
      await seedBugFixWorkflow(id)
    } catch (err) {
      // 任一失败：回滚 DB 行 + 清理本地目录
      try { await db.delete(workspaces).where(eq(workspaces.id, id)) } catch { /* best-effort */ }
      try { fs.rmSync(localPath, { recursive: true, force: true }) } catch { /* best-effort */ }
      throw err
    }

    return ok(reply, {
      ...workspace,
      isLegacy: isLegacyWorkspace(localPath),  // 新建工作区恒为 false
    }, 201)
  })

  // 获取单个 workspace（含 features）
  app.get('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    const featureList = await db
      .select()
      .from(features)
      .where(eq(features.workspaceId, id))
      .orderBy(asc(features.createdAt))

    return ok(reply, { ...ws, features: featureList, isLegacy: isLegacyWorkspace(ws.localPath) })
  })

  // 更新 workspace
  app.patch('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = UpdateWorkspaceSchema.parse(req.body)
    await db.update(workspaces).set(body).where(eq(workspaces.id, id))
    const [updated] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    return ok(reply, updated)
  })

  // 删除 workspace：FK ON DELETE CASCADE 接管所有业务行级联
  // - features 行被显式删除（features.workspace_id 没有 CASCADE 约束）
  // - 删除 features 行后，stage_runs 自动 CASCADE → messages / stage_run_outputs
  // - 删除 workspace 行后，workflows 自动 CASCADE → workflow_nodes / workflow_edges
  app.delete('/api/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    await db.delete(features).where(eq(features.workspaceId, id))

    if (ws.localPath) {
      // Implements: spec.md#AC-14 / plan.md#D-07 / tasks.md#T012
      // 路径遍历防护：解析后必须以 WORKSPACE_BASE 为前缀；越界抛 BizError(400)
      assertWithinWorkspaceBase(ws.localPath)
      try { fs.rmSync(ws.localPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    await db.delete(workspaces).where(eq(workspaces.id, id))
    return ok(reply, null)
  })

  // 初始化 workspace（git clone，SSE 流式输出）
  app.post('/api/workspaces/:id/init', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    const write = (text: string, extra?: Record<string, unknown>) =>
      sseWrite(reply.raw, { text, ...extra })

    if (!ws.repoUrl?.trim()) {
      write('未配置 Git 仓库地址，跳过克隆。\n', { done: true })
      reply.raw.end()
      return
    }

    write(`正在克隆 ${ws.repoUrl} ...\n`)

    // Implements: spec.md#AC-01 / plan.md#D-02 / tasks.md#T016
    // 目标改为 <root>/repo/（决策 D-02）。
    // 空 repo/ 视为 createWorkspaceLayout 的预创建产物，移除后允许 clone；
    // 非空 repo/ 视为用户已有内容，报 REPO_DIR_EXISTS 停手避免覆盖。
    const repoTarget = path.join(ws.localPath, 'repo')
    if (fs.existsSync(repoTarget)) {
      if (fs.readdirSync(repoTarget).length === 0) {
        fs.rmSync(repoTarget, { recursive: true, force: true })
      } else {
        writeSseError(reply.raw, {
          message: `目标目录 ${repoTarget} 已存在，无法克隆。请先清理或重命名。`,
          code: Code.REPO_DIR_EXISTS,
        })
        write(`\n❌ 目标目录 ${repoTarget} 已存在，无法克隆。请先清理或重命名。\n`, { done: true })
        reply.raw.end()
        return
      }
    }

    const proc = spawn('git', ['clone', ws.repoUrl, 'repo/'], {
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
        writeSseError(reply.raw, {
          message: `git clone 失败（exit code: ${code}）`,
          code: Code.GIT_CLONE_FAILED,
        })
        write(`\n❌ git clone 失败（exit code: ${code}）\n`, { done: true })
      }
      reply.raw.end()
    })

    proc.on('error', (err) => {
      writeSseError(reply.raw, {
        message: `无法启动 git：${err.message}`,
        code: Code.GIT_SPAWN_FAILED,
      })
      write(`\n❌ 无法启动 git：${err.message}\n`, { done: true })
      reply.raw.end()
    })
  })

  // Implements: spec.md#SCN-06 / plan.md#D-04 / tasks.md#T018
  // 存量工作区按新结构迁移（SSE 流式输出，复用 /init 的 {text}/{done} 帧格式 + {error,code} 错误帧）
  // 流程：confirm 校验 → 路径防护 → 检查目标 repo/ → mkdir 新结构 → rename 旧内容 → 失败回滚
  app.post('/api/workspaces/:id/reinit', async (req, reply) => {
    const { id } = req.params as { id: string }
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, id))
    if (!ws) throw new BizError(Code.WORKSPACE_NOT_FOUND, 'Workspace not found', 404)

    // E-10：二次确认缺失视为取消
    const parsed = ReinitSchema.safeParse(req.body)
    if (!parsed.success) {
      throw new BizError(Code.MISSING_CONFIRM, 'Missing confirm: true', 400)
    }

    // AC-14：路径遍历防护，越界抛 4xx
    assertWithinWorkspaceBase(ws.localPath)

    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.writeHead(200, sseHeaders(req.headers.origin as string | undefined))

    const write = (text: string, extra?: Record<string, unknown>) =>
      sseWrite(reply.raw, { text, ...extra })

    const memoryDir = path.join(ws.localPath, 'memory')
    const memoryFile = path.join(memoryDir, 'MEMORY.md')
    const draftDir = path.join(memoryDir, '.draft')
    const tmpDir = path.join(ws.localPath, 'tmp')
    const repoDir = path.join(ws.localPath, 'repo')

    // AC-11 / E-08：目标 repo/ 已存在且非空 → 报错并停手（不执行任何 fs 动作）
    if (fs.existsSync(repoDir) && fs.readdirSync(repoDir).length > 0) {
      writeSseError(reply.raw, {
        message: `目标目录 ${repoDir} 已存在且非空，无法迁移。请先手动清理。`,
        code: Code.REPO_DIR_NOT_EMPTY,
      })
      write(`\n❌ 目标目录 ${repoDir} 已存在且非空，无法迁移。请先手动清理。\n`, { done: true })
      reply.raw.end()
      return
    }

    // 回滚状态：已移动条目 / 新建目录 / 新建文件
    const movedItems: Array<{ src: string; dest: string }> = []
    const createdDirs: string[] = []
    const createdFiles: string[] = []

    // 使用 fs.renameSync（同步 API）做回滚，避开测试对 fsp.rename 的 mock
    const rollback = () => {
      // 反序：把已移动条目移回 <root>/
      for (let i = movedItems.length - 1; i >= 0; i--) {
        const m = movedItems[i]
        try { fs.renameSync(m.dest, m.src) } catch { /* best-effort */ }
      }
      // 删除新建文件
      for (const f of createdFiles) {
        try { fs.rmSync(f, { force: true }) } catch { /* best-effort */ }
      }
      // 反序删除新建目录
      for (let i = createdDirs.length - 1; i >= 0; i--) {
        try { fs.rmSync(createdDirs[i], { recursive: true, force: true }) } catch { /* best-effort */ }
      }
      // 清理可能新建的 repo/（若为空或仅含已回滚的条目）
      try { fs.rmSync(repoDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }

    try {
      write('🔧 创建 memory/\n')
      createdDirs.push(memoryDir)
      await fsp.mkdir(memoryDir)

      write('🔧 创建 tmp/\n')
      createdDirs.push(tmpDir)
      await fsp.mkdir(tmpDir)

      write('🔧 创建 memory/MEMORY.md\n')
      createdFiles.push(memoryFile)
      await fsp.writeFile(memoryFile, '')

      write('🔧 创建 memory/.draft/\n')
      createdDirs.push(draftDir)
      await fsp.mkdir(draftDir)

      // 创建 repo/（接受"已存在但为空"的情况；上面已拒绝非空）
      if (!fs.existsSync(repoDir)) {
        write('🔧 创建 repo/\n')
        createdDirs.push(repoDir)
        await fsp.mkdir(repoDir)
      }

      write('📦 移动既有内容到 repo/\n')
      // 把 <root>/ 下除 memory/ tmp/ repo/ 之外的所有顶层条目移入 repo/
      // .sort() 保证确定性顺序
      for (const entry of fs.readdirSync(ws.localPath).sort()) {
        if (entry === 'memory' || entry === 'tmp' || entry === 'repo') continue
        const src = path.join(ws.localPath, entry)
        const dest = path.join(repoDir, entry)
        await fsp.rename(src, dest)
        movedItems.push({ src, dest })
      }

      // 注：legacy 工作区的 .git/ 已通过 rename 移入 repo/，无需 git clone（与 /init 的 clone 行为互斥）
      write('\n✅ 迁移完成！\n', { done: true })
    } catch (err) {
      rollback()
      const msg = err instanceof Error ? err.message : String(err)
      const code = err instanceof BizError ? err.code : Code.INTERNAL
      writeSseError(reply.raw, { message: `迁移失败：${msg}`, code })
      write(`\n❌ 迁移失败：${msg}\n`, { done: true })
    } finally {
      reply.raw.end()
    }
  })
}
