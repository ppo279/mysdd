// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
// API integration test: end-to-end "create bug-fix feature with intent and bug_report".
//
// Seam: 通过 routes 暴露的 HTTP API + production DB（data/sdd.db）。
// 测试用 UUID 隔离 workspace；teardown 显式删除。
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { eq, and, inArray } from 'drizzle-orm'
import { db, initDb } from '../db/index.js'
import {
  workspaces,
  workflows,
  workflowNodes,
  features,
  stageRuns,
  stageRunOutputs,
  featureNodeStates,
  messages,
} from '../db/schema.js'
import { seedBugFixWorkflow } from '../services/workflow-seed.js'
import { featureRoutes } from '../routes/features.js'
import { registerErrorHandler } from '../lib/envelope.js'

// 每次跑测试的根：进程级别数据目录隔离
const TEST_HOME = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sdd-test-home-'))
process.env.HOME = TEST_HOME
// initDb 会检查 data 目录；它用 path.resolve(__dirname, '../../../data/sdd.db')，无法直接覆盖。
// 由于 routes 用的是单例 db（已 init 过），我们直接调用 initDb() 让它复用现有 DB。
beforeAll(() => {
  initDb()
})

afterAll(() => {
  // 关闭全局 DB（Drizzle/better-sqlite3）
  // 这里 db 单例没有暴露 close；保留进程退出时的清理
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best-effort */ }
})

// 每个 test 创建的 workspaceId，用于 teardown 清理
const createdWorkspaceIds = new Set<string>()

async function buildIsolatedWorkspace(): Promise<{ workspaceId: string; app: Awaited<ReturnType<typeof Fastify>> }> {
  const workspaceId = randomUUID()
  await db.insert(workspaces).values({
    id: workspaceId,
    name: `test-ws-${workspaceId.slice(0, 8)}`,
    description: '',
    repoUrl: '',
    techStack: 'ts',
    background: '',
    localPath: '',
    defaultWorkflowId: null,
    createdAt: new Date(),
  })
  createdWorkspaceIds.add(workspaceId)
  await seedBugFixWorkflow(workspaceId)

  const app = Fastify({ logger: false })
  // 与 backend/src/index.ts 镜像：挂载业务路由 + 错误处理器
  await featureRoutes(app)
  registerErrorHandler(app)
  return { workspaceId, app }
}

async function teardownWorkspace(workspaceId: string) {
  // 与 routes/features.ts DELETE /api/features/:id 镜像：先清 messages，再清 stage_runs，
  // 才能删除 features（FK stage_runs.feature_id → features.id 没有 CASCADE）。
  const featureRows = await db.select({ id: features.id }).from(features).where(eq(features.workspaceId, workspaceId))
  for (const f of featureRows) {
    const runIds = (await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, f.id))).map((r) => r.id)
    if (runIds.length > 0) {
      await db.delete(messages).where(inArray(messages.stageRunId, runIds))
    }
    await db.delete(stageRuns).where(eq(stageRuns.featureId, f.id))
    await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, f.id))
  }
  await db.delete(features).where(eq(features.workspaceId, workspaceId))
  // workspace 删除会 CASCADE → workflows → workflow_nodes / workflow_edges
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  createdWorkspaceIds.delete(workspaceId)
}

// 测试用 stub：avoid assertWithinWorkspaceBase 抛错（TEST_HOME 是临时目录）
describe('POST /api/workspaces/:workspaceId/features — bug-fix intent', () => {
  it('accepts intent=bug_fix + bug_report, selects bug-fix workflow, creates __intake__ run + side outputs', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'fix login bug',
          description: '',
          intent: 'bug_fix',
          inputs: { bug_report: '## Steps\n1. open login\n2. observe' },
        },
      })
      expect(res.statusCode).toBe(201)

      const env = JSON.parse(res.body)
      expect(env.code).toBe(0)
      const feature = env.data
      expect(feature.intent).toBe('bug_fix')
      expect(feature.currentWorkflowId).toBeTruthy()
      // bug-fix workflow 第一个真实节点是 'analyze'
      expect(feature.currentNodeId).toBe('analyze')

      // 选中的 workflow 是 bug-fix（声明了 bug_report input）
      const [bugFix] = await db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId))
      expect(feature.currentWorkflowId).toBe(bugFix.id)

      // 合成 __intake__ stage_run
      const intakeRuns = await db
        .select()
        .from(stageRuns)
        .where(and(eq(stageRuns.featureId, feature.id), eq(stageRuns.nodeId, '__intake__')))
      expect(intakeRuns.length).toBe(1)
      expect(intakeRuns[0].status).toBe('approved')
      expect(intakeRuns[0].runtimeId).toBe('synthetic')

      // stage_run_outputs 包含 bug_report（outputName 不带扩展名；磁盘文件带 .md）
      const outputs = await db
        .select()
        .from(stageRunOutputs)
        .where(eq(stageRunOutputs.stageRunId, intakeRuns[0].id))
      const bugReportRow = outputs.find((o) => o.outputName === 'bug_report')
      expect(bugReportRow?.content).toContain('observe')

      // __intake__ 节点状态为 approved
      const [intakeState] = await db
        .select()
        .from(featureNodeStates)
        .where(and(eq(featureNodeStates.featureId, feature.id), eq(featureNodeStates.nodeId, '__intake__')))
      expect(intakeState?.status).toBe('approved')

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('writes side output file under storage/<wsId>/<featId>/__intake__/<inputName>', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'fix login',
          intent: 'bug_fix',
          inputs: { bug_report: '# Repro\ngo to /login' },
        },
      })
      expect(res.statusCode).toBe(201)
      const env = JSON.parse(res.body)
      const feature = env.data

      // ArtifactService 的 STORAGE_ROOT 是 backend/src/services/artifact.ts 的 fileURLToPath 解析出来的 ../../../storage
      // 测试时 __dirname 指向 dist 或 src（取决于运行环境），用绝对路径直接拼 storage
      const storageRoot = path.resolve(__dirname, '../../../storage')
      const sideOutputPath = path.join(storageRoot, workspaceId, feature.id, '__intake__', 'bug_report.md')
      expect(fs.existsSync(sideOutputPath)).toBe(true)
      expect(fs.readFileSync(sideOutputPath, 'utf-8')).toContain('Repro')

      // 清理 disk artifact（不影响其它测试）
      try { fs.rmSync(path.dirname(path.dirname(sideOutputPath)), { recursive: true, force: true }) } catch { /* ignore */ }

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('rejects when intent=bug_fix and required bug_report is missing', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'fix',
          intent: 'bug_fix',
        },
      })
      expect(res.statusCode).toBe(400)
      const env = JSON.parse(res.body)
      expect(env.code).not.toBe(0)
      expect(env.msg).toMatch(/bug_report/)

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('returns 400 when explicit workflowId does not belong to the workspace', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'x',
          workflowId: '00000000-0000-0000-0000-000000000000',
        },
      })
      expect(res.statusCode).toBe(400)
      const env = JSON.parse(res.body)
      expect(env.code).toBe(1011) // WORKFLOW_INVALID
      expect(env.msg).toMatch(/does not belong/)

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })
})

describe('POST /api/workspaces/:workspaceId/features — non-bug intents', () => {
  it('infers intent=new_feature when no intent given and default workflow has no bug_report input', async () => {
    const workspaceId = randomUUID()
    createdWorkspaceIds.add(workspaceId)
    const wfId = randomUUID()
    // 1) 先创建 workspace（default_workflow_id 暂为 null）
    await db.insert(workspaces).values({
      id: workspaceId,
      name: 'w', description: '', repoUrl: '', techStack: 'ts', background: '',
      localPath: '', defaultWorkflowId: null, createdAt: new Date(),
    })
    // 2) 创建 workflow
    await db.insert(workflows).values({
      id: wfId, workspaceId, name: 'plain', description: '', isArchived: 0,
      inputsJson: '[]', rejectionEdgesJson: '[]', createdAt: new Date(), updatedAt: new Date(),
    })
    // 3) 创建至少一个节点（toposort 需要）
    await db.insert(workflowNodes).values({
      id: randomUUID(), workflowId: wfId, nodeId: 'spec', agentId: 'spec',
      positionX: 0, positionY: 0, configJson: '{}', displayName: 'spec', createdAt: new Date(),
    })
    // 4) 再回写 workspace.default_workflow_id
    await db.update(workspaces).set({ defaultWorkflowId: wfId }).where(eq(workspaces.id, workspaceId))

    const app = Fastify({ logger: false })
    await featureRoutes(app)
    registerErrorHandler(app)
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: { name: 'x' },
      })
      expect(res.statusCode).toBe(201)
      const env = JSON.parse(res.body)
      expect(env.data.intent).toBe('new_feature')
      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })
})