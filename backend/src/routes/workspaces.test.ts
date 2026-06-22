// Implements: tasks.md#T003 / plan.md#5.2.1~5.2.4
// 表格驱动单元测试 + tasks.md#T005 集成测试。
// 本文件先写测试（RED 阶段），T004 / T006 实现对应代码（GREEN）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import { EventEmitter } from 'events'
import Fastify from 'fastify'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'

// ── mock: child_process.spawn ──
// child_process.spawn 是 non-configurable getter，vi.spyOn 无法重新定义；
// 改用 vi.mock + vi.hoisted。mock 函数由 beforeEach 注入实现。
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mockSpawn }))

// Mock workflow-bootstrap：createInitialWorkflow 会读真实 DB（loadAgentsConfig）
// 创建默认工作流节点，与本测试无关。改为 mock 实现：直接返回 'wf-mock'。
// slice 05 起：不再涉及 agents.yaml 文件读取。
const { mockCreateInitialWorkflow } = vi.hoisted(() => ({ mockCreateInitialWorkflow: vi.fn() }))
vi.mock('../services/workflow-bootstrap.js', () => ({
  createInitialWorkflow: mockCreateInitialWorkflow,
}))

// Mock 掉真实 db 模块（避免污染 <repo>/data/sdd.db）；mock factory 使用 globalThis
// 延迟绑定，从而在 db 初始化之后再注入 db 实例。
vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(`
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    repo_url TEXT NOT NULL DEFAULT '', tech_stack TEXT NOT NULL DEFAULT 'ts',
    background TEXT NOT NULL DEFAULT '', local_path TEXT NOT NULL DEFAULT '',
    default_workflow_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE features (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    current_stage TEXT NOT NULL DEFAULT 'spec',
    current_workflow_id TEXT,
    current_node_id TEXT NOT NULL DEFAULT 'spec',
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE stage_runs (
    id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES features(id),
    stage TEXT NOT NULL, node_id TEXT,
    runtime_id TEXT NOT NULL DEFAULT 'claude', cli_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active', artifact_content TEXT NOT NULL DEFAULT '',
    artifact_path TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, approved_at INTEGER
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY, stage_run_id TEXT NOT NULL REFERENCES stage_runs(id),
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflow_nodes (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    node_id TEXT NOT NULL, agent_id TEXT NOT NULL,
    position_x REAL NOT NULL DEFAULT 0, position_y REAL NOT NULL DEFAULT 0,
    config_json TEXT NOT NULL DEFAULT '{}',
    display_name TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(workflow_id, node_id)
  );
  CREATE TABLE workflow_edges (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL, from_output TEXT NOT NULL DEFAULT 'default',
    to_node_id TEXT NOT NULL, to_input TEXT NOT NULL DEFAULT 'default',
    created_at INTEGER NOT NULL
  );
`)
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

// 动态 import：保证 mock factory 在 __testDb 注入后执行
const {
  createWorkspaceLayout,
  isLegacyWorkspace,
  assertWithinWorkspaceBase,
  nextAvailableDraftPath,
  workspaceRoutes,
  WORKSPACE_BASE,
} = await import('./workspaces.js')
const { registerErrorHandler } = await import('../lib/envelope.js')

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-ws-test-'))
  // 默认 createInitialWorkflow 成功
  mockCreateInitialWorkflow.mockReset()
  mockCreateInitialWorkflow.mockResolvedValue('wf-mock')
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// 递归列出 root 下所有"存在的相对路径"（文件或目录）
function listRelative(root: string): Set<string> {
  const out = new Set<string>()
  const walk = (abs: string, rel: string) => {
    let st: fs.Stats
    try {
      st = fs.statSync(abs)
    } catch {
      return
    }
    if (st.isDirectory()) {
      if (rel !== '') out.add(rel.replace(/\\/g, '/'))
      for (const entry of fs.readdirSync(abs)) {
        walk(path.join(abs, entry), rel === '' ? entry : `${rel}/${entry}`)
      }
    } else {
      out.add(rel.replace(/\\/g, '/'))
    }
  }
  walk(root, '')
  return out
}

// ========== AC-09: createWorkspaceLayout 原子性 ==========
describe('AC-09: createWorkspaceLayout 原子性（all-or-nothing rollback）', () => {
  // 实施顺序：mkdir repo → mkdir memory → writeFile MEMORY.md → mkdir .draft → mkdir tmp → writeFile .gitignore
  // 注入失败：被注入的步骤抛错；其后步骤不再执行；已创建内容由 rollback 反序清理。
  const cases: Array<{
    name: string
    failAt: 'none' | 'mkdir_repo' | 'mkdir_memory' | 'writeFile_MEMORY' | 'mkdir_draft' | 'mkdir_tmp' | 'writeFile_gitignore'
    expected: string[]
  }> = [
    { name: '全部成功',                  failAt: 'none',                 expected: ['repo', 'memory', 'memory/MEMORY.md', 'memory/.draft', 'tmp', '.gitignore'] },
    { name: 'mkdir repo 失败',           failAt: 'mkdir_repo',           expected: [] },
    { name: 'mkdir memory 失败',         failAt: 'mkdir_memory',         expected: [] },
    { name: 'writeFile MEMORY.md 失败',  failAt: 'writeFile_MEMORY',     expected: [] },
    { name: 'mkdir .draft 失败',         failAt: 'mkdir_draft',          expected: [] },
    { name: 'mkdir tmp 失败',            failAt: 'mkdir_tmp',            expected: [] },
    { name: 'writeFile .gitignore 失败', failAt: 'writeFile_gitignore',  expected: [] },
  ]

  for (const c of cases) {
    it(c.name, async () => {
      const root = path.join(tmpRoot, c.name.replace(/\s/g, '_'))
      fs.mkdirSync(root, { recursive: true })  // 预创建工作区根（POST handler 的职责）
      const ORDER: Record<typeof c.failAt, number> = {
        none: 0,
        mkdir_repo: 1,
        mkdir_memory: 2,
        writeFile_MEMORY: 3,
        mkdir_draft: 4,
        mkdir_tmp: 5,
        writeFile_gitignore: 6,
      }
      const failStep = ORDER[c.failAt]
      const mkdirOrig = fsp.mkdir
      const writeFileOrig = fsp.writeFile

      const mkdirSpy = vi.spyOn(fsp, 'mkdir').mockImplementation(async (p, opts) => {
        const currentStep =
          (p as string).replace(/\\/g, '/').endsWith('/repo') ? 1
          : (p as string).replace(/\\/g, '/').endsWith('/memory') ? 2
          : (p as string).replace(/\\/g, '/').endsWith('/memory/.draft') ? 4
          : (p as string).replace(/\\/g, '/').endsWith('/tmp') ? 5
          : 99
        if (currentStep === failStep) throw new Error('Injected mkdir failure')
        return mkdirOrig(p as any, opts as any)
      })
      const writeFileSpy = vi.spyOn(fsp, 'writeFile').mockImplementation(async (p, data, opts) => {
        const currentStep =
          (p as string).replace(/\\/g, '/').endsWith('/memory/MEMORY.md') ? 3
          : (p as string).replace(/\\/g, '/').endsWith('/.gitignore') ? 6
          : 99
        if (currentStep === failStep) throw new Error('Injected writeFile failure')
        return writeFileOrig(p as any, data as any, opts as any)
      })

      try {
        await createWorkspaceLayout(root)
        if (c.failAt !== 'none') {
          throw new Error('createWorkspaceLayout 应在注入失败时抛错')
        }
      } catch (err) {
        if (c.failAt === 'none') throw err
      } finally {
        mkdirSpy.mockRestore()
        writeFileSpy.mockRestore()
      }

      const actual = listRelative(root)
      expect(actual).toEqual(new Set(c.expected))
    })
  }

  it('happy path: .gitignore 内容包含 memory/', async () => {
    const root = path.join(tmpRoot, 'happy_gitignore')
    fs.mkdirSync(root, { recursive: true })
    await createWorkspaceLayout(root)
    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    expect(content).toMatch(/^memory\//m)
  })

  it('happy path: 既有 .gitignore 不被覆盖（用户规则保留）', async () => {
    const root = path.join(tmpRoot, 'keep_gitignore')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, '.gitignore'), 'user-rule/\n')
    await createWorkspaceLayout(root)
    const content = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    expect(content).toBe('user-rule/\n')
  })
})

// ========== D-05: isLegacyWorkspace ==========
describe('D-05: isLegacyWorkspace', () => {
  const cases: Array<{ name: string; setup: string[]; expected: boolean }> = [
    { name: '.git 存在 + repo 不存在 = 旧结构',  setup: ['.git'],                expected: true },
    { name: '.git + repo 同时存在 = 新结构',     setup: ['.git', 'repo'],        expected: false },
    { name: '无 .git、仅 repo = 未 init 新结构', setup: ['repo'],                expected: false },
    { name: '空目录 = 新创建未 init',            setup: [],                       expected: false },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const root = path.join(tmpRoot, c.name)
      for (const sub of c.setup) {
        fs.mkdirSync(path.join(root, sub), { recursive: true })
      }
      expect(isLegacyWorkspace(root)).toBe(c.expected)
    })
  }
})

// ========== AC-14: assertWithinWorkspaceBase 路径遍历防护 ==========
describe('AC-14: assertWithinWorkspaceBase 路径遍历防护', () => {
  it.each([
    [`${WORKSPACE_BASE}/abc`,                                       true],
    [`${WORKSPACE_BASE}/abc/../def`,                                 true],   // 解析后仍合法
    [`/etc/passwd`,                                                  false],  // 越界
    [`${WORKSPACE_BASE}-evil/abc`,                                   false],  // 同名前缀绕过
  ])('localPath=%s → ok=%s', (input, ok) => {
    if (ok) {
      expect(() => assertWithinWorkspaceBase(input)).not.toThrow()
    } else {
      expect(() => assertWithinWorkspaceBase(input)).toThrow()
    }
  })
})

// ========== AC-12: nextAvailableDraftPath ==========
describe('AC-12: nextAvailableDraftPath 候选区同名追加后缀', () => {
  const cases: Array<{ name: string; existing: string[]; expected: string }> = [
    { name: '目录为空 → notes.md',            existing: [],                                         expected: 'notes.md' },
    { name: '已有 notes.md → notes-1.md',     existing: ['notes.md'],                               expected: 'notes-1.md' },
    { name: '已有 notes.md + notes-1.md → 2', existing: ['notes.md', 'notes-1.md'],                 expected: 'notes-2.md' },
    { name: '连续已有 → -3',                  existing: ['notes.md', 'notes-1.md', 'notes-2.md'],    expected: 'notes-3.md' },
  ]
  for (const c of cases) {
    it(c.name, () => {
      const dir = path.join(tmpRoot, c.name)
      fs.mkdirSync(dir, { recursive: true })
      for (const f of c.existing) {
        fs.writeFileSync(path.join(dir, f), '')
      }
      const result = nextAvailableDraftPath(dir, 'notes')
      expect(path.basename(result)).toBe(c.expected)
    })
  }
})

// ========== T005: POST /api/workspaces 集成测试 (AC-01/02/09/13) ==========
describe('POST /api/workspaces: 三层目录创建（AC-01 / AC-02 / AC-13）', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    // 清空所有业务表
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    // 清理测试遗留的本地工作区目录
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    // 兜底：清理 db 中残留的（即使 T006 未实现回滚）
    const rows = sqlite.prepare('SELECT local_path FROM workspaces').all() as { local_path: string }[]
    for (const row of rows) {
      if (row.local_path) {
        try { fs.rmSync(row.local_path, { recursive: true, force: true }) } catch { /* best-effort */ }
      }
    }
  })

  it('happy path: 合法 body → 201 + isLegacy:false + 三层目录 + .gitignore + MEMORY.md', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'happy-ws', description: '测试', repoUrl: '', background: '' },
    })
    expect(res.statusCode).toBe(201)
    const env = JSON.parse(res.body)
    // M0 envelope 化：body.data 才是真 DTO
    const body = env.data

    expect(env.code).toBe(0)
    expect(env.msg).toBe('ok')
    expect(body.id).toBeTruthy()
    expect(body.name).toBe('happy-ws')
    expect(body.isLegacy).toBe(false)                              // D-05 / T006
    expect(body.localPath).toMatch(/sdd-workspaces[\\/]/)

    trackedLocalPaths.push(body.localPath)

    // AC-01: 三层目录
    expect(fs.existsSync(path.join(body.localPath, 'repo'))).toBe(true)
    expect(fs.existsSync(path.join(body.localPath, 'memory'))).toBe(true)
    expect(fs.existsSync(path.join(body.localPath, 'tmp'))).toBe(true)

    // AC-02: MEMORY.md + .draft
    expect(fs.existsSync(path.join(body.localPath, 'memory', 'MEMORY.md'))).toBe(true)
    expect(fs.existsSync(path.join(body.localPath, 'memory', '.draft'))).toBe(true)

    // AC-13: .gitignore 含 memory/
    const gitignore = fs.readFileSync(path.join(body.localPath, '.gitignore'), 'utf8')
    expect(gitignore).toMatch(/^memory\//m)

    // DB localPath 仍指向 <workspaceRoot>，不是 repo/
    expect(body.localPath.endsWith('repo')).toBe(false)
    expect(body.localPath).toBe(path.join(WORKSPACE_BASE, body.id))
  })

  it('sad path: zod 校验失败（缺 name） → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { description: 'no name' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('sad path: mkdir 失败 → 500 + DB 行回滚 + localPath 已清理（AC-09 反向）', async () => {
    const realMkdir = fsp.mkdir
    const spy = vi.spyOn(fsp, 'mkdir').mockImplementation(async () => {
      throw new Error('Injected mkdir failure')
    })

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/workspaces',
        payload: { name: 'fail-mkdir' },
      })
      // T006 应让实现返回 500
      expect(res.statusCode).toBe(500)

      // DB 应回滚：T006 应在 catch 内 db.delete + rmSync(localPath)
      const rows = sqlite.prepare('SELECT * FROM workspaces').all()
      expect(rows).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// ========== T011: DELETE /api/workspaces/:id 路径遍历防护 (AC-14) ==========
describe('T011: DELETE /api/workspaces/:id 路径遍历防护 (AC-14)', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('happy: 合法 localPath（在 WORKSPACE_BASE 内）→ 204 + 本地目录消失 + DB 行删除', async () => {
    const wsId = 'ws-del-happy'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    fs.mkdirSync(localPath, { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(wsId, 'del-happy', localPath, Date.now())

    const res = await app.inject({ method: 'DELETE', url: `/api/workspaces/${wsId}` })
    // M0 envelope 化：DELETE 改用 200 + {code:0, data:null}（替代旧 204）
    expect(res.statusCode).toBe(200)
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.data).toBeNull()

    // 本地目录消失
    expect(fs.existsSync(localPath)).toBe(false)
    // DB 行删除
    const rows = sqlite.prepare('SELECT * FROM workspaces WHERE id = ?').all(wsId)
    expect(rows).toEqual([])
  })

  it('sad: localPath 越界（tmpRoot 在 WORKSPACE_BASE 外）→ 400 + rmSync 未被调用 + DB 行保留', async () => {
    const wsId = 'ws-del-evil'
    // tmpRoot 是 os.tmpdir()/sdd-ws-test-XXX/，不在 WORKSPACE_BASE（=homedir/sdd-workspaces/）下
    const evilPath = path.join(tmpRoot, 'evil', 'subpath')

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(wsId, 'del-evil', evilPath, Date.now())

    const rmSpy = vi.spyOn(fs, 'rmSync')

    try {
      const res = await app.inject({ method: 'DELETE', url: `/api/workspaces/${wsId}` })
      // T012 应让实现返回 400
      expect(res.statusCode).toBe(400)
      // 关键断言：rmSync 一次都不该被调用（避免越界删除）
      expect(rmSpy).not.toHaveBeenCalled()
      // DB 行应保留
      const rows = sqlite.prepare('SELECT * FROM workspaces WHERE id = ?').all(wsId)
      expect(rows.length).toBe(1)
    } finally {
      rmSpy.mockRestore()
    }
  })
})

// ========== T013: GET /api/workspaces/:id 返回 isLegacy (D-05) ==========
describe('T013: GET /api/workspaces/:id 返回 isLegacy (D-05)', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('旧结构（<root>/.git 存在 + <root>/repo 缺失）→ isLegacy: true', async () => {
    const wsId = 'ws-legacy-1'
    const localPath = path.join(tmpRoot, 'legacy-1')
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(wsId, 'legacy-1', localPath, Date.now())

    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}` })
    expect(res.statusCode).toBe(200)
    // M0 envelope: 响应是 {code:0, msg, data:{...}}
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.data.id).toBe(wsId)
    // T014 应让实现返回 isLegacy: true
    expect(env.data.isLegacy).toBe(true)
  })

  it('新结构（<root>/.git + <root>/repo 都存在）→ isLegacy: false', async () => {
    const wsId = 'ws-new-1'
    const localPath = path.join(tmpRoot, 'new-1')
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    fs.mkdirSync(path.join(localPath, 'repo'), { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(wsId, 'new-1', localPath, Date.now())

    const res = await app.inject({ method: 'GET', url: `/api/workspaces/${wsId}` })
    expect(res.statusCode).toBe(200)
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.data.isLegacy).toBe(false)
  })
})

// ========== M0 envelope: list / patch 也走 {code, data} ==========
// 修复：GET /api/workspaces 与 PATCH /api/workspaces/:id 之前返回裸 DTO，
// 前端 request<T> 找不到 env.code 抛 "bad response"。
describe('M0 envelope: list / patch 统一返回 {code, data}', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  it('GET /api/workspaces 列表 → {code:0, data: Workspace[]}', async () => {
    const lp1 = path.join(WORKSPACE_BASE, 'ws-list-1')
    const lp2 = path.join(WORKSPACE_BASE, 'ws-list-2')
    fs.mkdirSync(lp1, { recursive: true })
    fs.mkdirSync(lp2, { recursive: true })
    trackedLocalPaths.push(lp1, lp2)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run('ws-list-1', 'list-1', lp1, Date.now() - 1000)
    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run('ws-list-2', 'list-2', lp2, Date.now())

    const res = await app.inject({ method: 'GET', url: '/api/workspaces' })
    expect(res.statusCode).toBe(200)
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.msg).toBe('ok')
    expect(Array.isArray(env.data)).toBe(true)
    expect(env.data).toHaveLength(2)
    expect(env.data[0].id).toBe('ws-list-1')
    expect(env.data[1].id).toBe('ws-list-2')
  })

  it('GET /api/workspaces 空表 → {code:0, data: []}', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/workspaces' })
    expect(res.statusCode).toBe(200)
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.data).toEqual([])
  })

  it('PATCH /api/workspaces/:id → {code:0, data: 更新后的 Workspace}', async () => {
    const wsId = 'ws-patch-1'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    fs.mkdirSync(localPath, { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, description, repo_url, local_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(wsId, 'patch-orig', 'orig desc', 'https://github.com/orig/repo', localPath, Date.now())

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/workspaces/${wsId}`,
      payload: { name: 'patched-name', description: 'patched desc' },
    })
    expect(res.statusCode).toBe(200)
    const env = JSON.parse(res.body)
    expect(env.code).toBe(0)
    expect(env.data.id).toBe(wsId)
    expect(env.data.name).toBe('patched-name')
    expect(env.data.description).toBe('patched desc')
    // 未传入的字段保持原值
    expect(env.data.repoUrl).toBe('https://github.com/orig/repo')
  })
})

// ========== T015: POST /api/workspaces/:id/init 目标 = <root>/repo/ (AC-01) ==========
describe('T015: POST /api/workspaces/:id/init 目标 <root>/repo/ (AC-01)', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    mockSpawn.mockReset()
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  // 工具：mock 一个 EventEmitter 风格的 ChildProcess
  // 模拟 git clone：根据 args 最后一参（目标路径）创建 <targetDir>/.git/HEAD
  function mockGitClone() {
    mockSpawn.mockImplementation((cmd: any, args: any, opts: any) => {
      const proc = new EventEmitter() as any
      proc.stdout = new EventEmitter()
      proc.stderr = new EventEmitter()
      proc.stdin = { end: () => {} }
      proc.pid = 99999

      setImmediate(() => {
        // 模拟 git clone 行为：把 <targetDir>/.git/HEAD 实际创建出来
        const dest = args[args.length - 1]
        const targetDir = path.isAbsolute(dest) ? dest : path.join(opts.cwd, dest)
        fs.mkdirSync(path.join(targetDir, '.git'), { recursive: true })
        fs.writeFileSync(path.join(targetDir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
        proc.stdout.emit('data', Buffer.from('Cloning into target...\n'))
        proc.emit('close', 0)
      })

      return proc
    })
  }

  // 工具：解析 SSE 帧
  function parseFrames(body: string): any[] {
    return body
      .split('\n\n')
      .filter(Boolean)
      .map((f: string) => JSON.parse(f.replace(/^data: /, '').trim()))
  }

  it('happy: SSE done + <root>/repo/.git/HEAD 存在 + spawn 被以 cwd=<root>, args 含 repo/ 调用', async () => {
    const wsId = 'ws-init-1'
    const localPath = path.join(tmpRoot, 'init-1')
    fs.mkdirSync(localPath, { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, repo_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(wsId, 'init-1', localPath, 'https://github.com/test/repo', Date.now())

    mockGitClone()

    const res = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/init` })
    expect(res.statusCode).toBe(200)

    // 解析 SSE 帧
    const frames = parseFrames(res.body)
    const last = frames[frames.length - 1]
    expect(last.done).toBe(true)
    expect(last.error).toBeFalsy()

    // 关键断言 1: spawn 调用参数
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [calledCmd, calledArgs, calledOpts] = mockSpawn.mock.calls[0]
    expect(calledCmd).toBe('git')
    expect(calledArgs[0]).toBe('clone')
    expect(calledArgs[1]).toBe('https://github.com/test/repo')
    // T016 应让 args 末项从 '.' 改为 'repo/'
    expect(calledArgs[2]).toBe('repo/')
    expect(calledOpts.cwd).toBe(localPath)

    // 关键断言 2: <root>/repo/.git/HEAD 实际存在（end-to-end 结果）
    expect(fs.existsSync(path.join(localPath, 'repo', '.git', 'HEAD'))).toBe(true)
    // 反向断言：旧行为（cwd=., 目标=root）下会产生 <root>/.git/HEAD 而不是这里
    expect(fs.existsSync(path.join(localPath, '.git', 'HEAD'))).toBe(false)
  })

  // ========== Bug fix: /init 必须容忍 createWorkspaceLayout 预创建的空 repo/ ==========
  // 现象：用户创建带 repoUrl 的 workspace → createWorkspaceLayout 预创建了空 repo/
  //        → /init 因 REPO_DIR_EXISTS 报错
  // 期望：/init 检测到空 repo/ 时移除后 clone；非空仍按原行为报错
  it('bug fix: createWorkspaceLayout 预创建了空 repo/ → /init 仍应 clone 成功', async () => {
    const wsId = 'ws-init-empty-repo'
    const localPath = path.join(tmpRoot, 'init-empty-repo')
    fs.mkdirSync(localPath, { recursive: true })
    // 模拟 POST /api/workspaces 的副作用：三层布局（含空 repo/）
    await createWorkspaceLayout(localPath)
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, repo_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(wsId, 'init-empty-repo', localPath, 'https://github.com/test/repo', Date.now())

    mockGitClone()

    const res = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/init` })
    expect(res.statusCode).toBe(200)
    const frames = parseFrames(res.body)
    const last = frames[frames.length - 1]
    expect(last.done).toBe(true)
    expect(last.error).toBeFalsy()

    // 关键：clone 必须实际发生
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(fs.existsSync(path.join(localPath, 'repo', '.git', 'HEAD'))).toBe(true)
  })

  it('回归保护: repo/ 已存在且非空 → /init 仍报 REPO_DIR_EXISTS（不覆盖用户内容）', async () => {
    const wsId = 'ws-init-nonempty'
    const localPath = path.join(tmpRoot, 'init-nonempty')
    fs.mkdirSync(localPath, { recursive: true })
    // repo/ 已存在且有用户内容（用户手动放的文件）
    fs.mkdirSync(path.join(localPath, 'repo'), { recursive: true })
    fs.writeFileSync(path.join(localPath, 'repo', '.keep'), 'user data\n')
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, repo_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(wsId, 'init-nonempty', localPath, 'https://github.com/test/repo', Date.now())

    mockGitClone()  // mock 在此但不应被调用

    const res = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/init` })
    expect(res.statusCode).toBe(200)
    const frames = parseFrames(res.body)
    const errFrame = frames.find((f: any) => f.error)
    expect(errFrame).toBeDefined()
    expect(errFrame.code).toBe(2101)  // REPO_DIR_EXISTS

    // 用户数据未被破坏
    expect(fs.readFileSync(path.join(localPath, 'repo', '.keep'), 'utf8')).toBe('user data\n')
    // spawn 未被调用
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('完整链路: POST /api/workspaces → POST /init 成功', async () => {
    mockGitClone()
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/workspaces',
      payload: { name: 'full-chain', repoUrl: 'https://github.com/test/repo' },
    })
    expect(createRes.statusCode).toBe(201)
    const env = JSON.parse(createRes.body)
    const localPath = env.data.localPath
    trackedLocalPaths.push(localPath)

    const initRes = await app.inject({ method: 'POST', url: `/api/workspaces/${env.data.id}/init` })
    expect(initRes.statusCode).toBe(200)
    const frames = parseFrames(initRes.body)
    const last = frames[frames.length - 1]
    expect(last.done).toBe(true)
    expect(last.error).toBeFalsy()

    // 完整链路：<root>/repo/.git/HEAD 存在
    expect(fs.existsSync(path.join(localPath, 'repo', '.git', 'HEAD'))).toBe(true)
  })

  it('重复 init: clone 成功后再调一次 /init → REPO_DIR_EXISTS（不覆盖已有内容）', async () => {
    const wsId = 'ws-init-twice'
    const localPath = path.join(tmpRoot, 'init-twice')
    fs.mkdirSync(localPath, { recursive: true })
    trackedLocalPaths.push(localPath)

    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, repo_url, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(wsId, 'init-twice', localPath, 'https://github.com/test/repo', Date.now())

    // 第一次 init：clone 成功
    mockGitClone()
    const res1 = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/init` })
    expect(res1.statusCode).toBe(200)
    const frames1 = parseFrames(res1.body)
    expect(frames1[frames1.length - 1].done).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'repo', '.git', 'HEAD'))).toBe(true)

    // 第二次 init：repo/ 已有内容，应报 REPO_DIR_EXISTS
    mockSpawn.mockReset()
    mockGitClone()  // mock 在此但不应被调用
    const res2 = await app.inject({ method: 'POST', url: `/api/workspaces/${wsId}/init` })
    expect(res2.statusCode).toBe(200)
    const frames2 = parseFrames(res2.body)
    const errFrame = frames2.find((f: any) => f.error)
    expect(errFrame).toBeDefined()
    expect(errFrame.code).toBe(2101)

    // 第一次 clone 的内容未被覆盖
    expect(fs.readFileSync(path.join(localPath, 'repo', '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n')
  })
})

// ========== T017: POST /api/workspaces/:id/reinit SSE 集成测试 (AC-08/11/E-09/E-10) ==========
describe('T017: POST /api/workspaces/:id/reinit SSE 集成测试 (AC-08/11/E-09/E-10)', () => {
  let app: any
  let trackedLocalPaths: string[] = []

  beforeEach(async () => {
    sqlite.exec(`
      DELETE FROM messages;
      DELETE FROM stage_runs;
      DELETE FROM features;
      DELETE FROM workspaces;
    `)
    trackedLocalPaths = []
    mockSpawn.mockReset()
    app = Fastify({ logger: false })
    await workspaceRoutes(app)
    registerErrorHandler(app)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    for (const dir of trackedLocalPaths) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  })

  // 工具：解析 SSE 帧
  function parseFrames(body: string): any[] {
    return body
      .split('\n\n')
      .filter(Boolean)
      .map((f: string) => JSON.parse(f.replace(/^data: /, '').trim()))
  }

  // 工具：插入 workspace 行；reinit 必须调 assertWithinWorkspaceBase，故 localPath 必须在 WORKSPACE_BASE 内
  function seedWorkspace(wsId: string, localPath: string, name = 'reinit-ws') {
    trackedLocalPaths.push(localPath)
    fs.mkdirSync(localPath, { recursive: true })
    sqlite.prepare(`
      INSERT INTO workspaces (id, name, local_path, created_at)
      VALUES (?, ?, ?, ?)
    `).run(wsId, name, localPath, Date.now())
  }

  it('happy: 旧结构（.git/ 在 root）→ 迁移到新结构（AC-08）', async () => {
    const wsId = 'ws-reinit-happy'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    seedWorkspace(wsId, localPath)
    // 预置旧结构
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(localPath, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    fs.writeFileSync(path.join(localPath, 'README.md'), 'old content\n')

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reinit`,
      payload: { confirm: true },
    })
    expect(res.statusCode).toBe(200)
    const frames = parseFrames(res.body)
    const last = frames[frames.length - 1]
    expect(last.done).toBe(true)
    expect(last.error).toBeFalsy()

    // 新结构三层目录就绪
    expect(fs.existsSync(path.join(localPath, 'memory'))).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'tmp'))).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'memory', 'MEMORY.md'))).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'memory', '.draft'))).toBe(true)

    // 旧 .git 移到 repo/，原 <root>/.git 不存在
    expect(fs.existsSync(path.join(localPath, '.git'))).toBe(false)
    expect(fs.existsSync(path.join(localPath, 'repo', '.git', 'HEAD'))).toBe(true)
    // 其他顶层条目也移到 repo/
    expect(fs.existsSync(path.join(localPath, 'README.md'))).toBe(false)
    expect(fs.existsSync(path.join(localPath, 'repo', 'README.md'))).toBe(true)

    // DB local_path 不变（BI-08 决策）
    const rows = sqlite.prepare('SELECT local_path FROM workspaces WHERE id = ?').all(wsId) as { local_path: string }[]
    expect(rows.length).toBe(1)
    expect(rows[0].local_path).toBe(localPath)

    // reinit 不需要 git clone（.git 已通过 rename 移入 repo/）
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('sad: 目标 <root>/repo 已存在且非空 → error: true + fs 无任何变化（AC-11）', async () => {
    const wsId = 'ws-reinit-evil'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    seedWorkspace(wsId, localPath)
    // 预置旧结构 + 目标 repo/ 已存在且非空
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(localPath, '.git', 'HEAD'), 'old\n')
    fs.mkdirSync(path.join(localPath, 'repo', 'user-content'), { recursive: true })
    fs.writeFileSync(path.join(localPath, 'repo', 'user-content', 'data.txt'), 'user data\n')

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reinit`,
      payload: { confirm: true },
    })
    expect(res.statusCode).toBe(200)
    const frames = parseFrames(res.body)
    const last = frames[frames.length - 1]
    expect(last.done).toBe(true)
    // M0 SSE error 帧统一为 { error: string, code?: number }；error 在 done 帧之前发出
    const errFrame = frames.find((f: any) => f.error)
    expect(errFrame).toBeDefined()
    expect(typeof errFrame.error).toBe('string')
    expect(errFrame.code).toBe(2102)   // REPO_DIR_NOT_EMPTY

    // 文件系统完全无变化
    expect(fs.existsSync(path.join(localPath, '.git', 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'repo', 'user-content', 'data.txt'))).toBe(true)
    // 任何新结构目录都不应被创建
    expect(fs.existsSync(path.join(localPath, 'memory'))).toBe(false)
    expect(fs.existsSync(path.join(localPath, 'tmp'))).toBe(false)
    // mockSpawn 不应被调用
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('sad: 迁移过程中失败 → error: true + 已移动内容回滚到 <root>（E-09）', async () => {
    const wsId = 'ws-reinit-rollback'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    seedWorkspace(wsId, localPath)
    // 预置旧结构（多个顶层条目，确保 rename 至少执行一次）
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(localPath, '.git', 'HEAD'), 'old\n')
    fs.writeFileSync(path.join(localPath, 'README.md'), 'old content\n')

    // 注入失败：拦截 fsp.rename，第一次成功（让 .git/ 移入 repo/），第二次失败（README.md）
    // 这样能验证"已移动内容回滚"——.git/ 应被移回 <root>/
    const realRename = fsp.rename.bind(fsp)
    let renameCount = 0
    const renameSpy = vi.spyOn(fsp, 'rename').mockImplementation(async (src, dest) => {
      renameCount++
      if (renameCount === 1) {
        return realRename(src, dest)
      }
      throw new Error('Injected rename failure on second item')
    })

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${wsId}/reinit`,
        payload: { confirm: true },
      })
      expect(res.statusCode).toBe(200)
      const frames = parseFrames(res.body)
      const last = frames[frames.length - 1]
      expect(last.done).toBe(true)
      // M0 SSE error 帧统一为 { error: string, code?: number }；error 在 done 帧之前
      const errFrame = frames.find((f: any) => f.error)
      expect(errFrame).toBeDefined()
      expect(typeof errFrame.error).toBe('string')
      expect(errFrame.error).toContain('迁移失败')
    } finally {
      renameSpy.mockRestore()
    }

    // 关键断言：已移动的 .git/ 必须回滚到 <root>/
    expect(fs.existsSync(path.join(localPath, '.git', 'HEAD'))).toBe(true)
    // 未移动的 README.md 仍在原位
    expect(fs.existsSync(path.join(localPath, 'README.md'))).toBe(true)
    // 新建的 memory/ tmp/ .draft/ 应被清理
    expect(fs.existsSync(path.join(localPath, 'memory'))).toBe(false)
    expect(fs.existsSync(path.join(localPath, 'tmp'))).toBe(false)
    // mockSpawn 不应被调用
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('用户取消（缺 confirm）→ 4xx + fs 无变化 + spawn 未调用（E-10）', async () => {
    const wsId = 'ws-reinit-cancel'
    const localPath = path.join(WORKSPACE_BASE, wsId)
    seedWorkspace(wsId, localPath)
    // 预置旧结构
    fs.mkdirSync(path.join(localPath, '.git'), { recursive: true })
    fs.writeFileSync(path.join(localPath, '.git', 'HEAD'), 'old\n')

    const res = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsId}/reinit`,
      payload: {},  // 缺 confirm
    })
    expect(res.statusCode).toBe(400)

    // fs 状态完全保留
    expect(fs.existsSync(path.join(localPath, '.git', 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(localPath, 'memory'))).toBe(false)
    expect(fs.existsSync(path.join(localPath, 'tmp'))).toBe(false)
    // mockSpawn 不应被调用
    expect(mockSpawn).not.toHaveBeenCalled()
  })
})
