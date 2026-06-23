// Implements: tasks.md#T009 / plan.md#D-02 / spec.md#AC-03 AC-05
// services/agent.ts 的 spawn cwd 单元测试（RED 阶段）。
// 验证 startStage / sendMessage 把 cwd 改为 <localPath>/repo（决策 D-02）。
// 验证 <localPath>/repo 缺失时不静默 fallback 到 <localPath>（覆盖 E-06）。
// Phase 0 扩展：新增产物路径 <nodeId>/<outputName> 测试 + 适配新 schema（workflows / workflow_nodes / workflow_edges / stage_run_outputs / feature_node_states）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../db/schema.js'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from '../db/schema-sql.js'
import path from 'path'
import fs from 'fs'
import os from 'os'

// ── mock: runtime/registry ──
const mockRuntime: {
  createSession: ReturnType<typeof vi.fn>
  resumeSession: ReturnType<typeof vi.fn>
} = {
  createSession: vi.fn(),
  resumeSession: vi.fn(),
}
;(globalThis as any).__mockRuntime = mockRuntime
vi.mock('../runtime/registry.js', () => ({
  getRuntime: () => (globalThis as any).__mockRuntime,
  clearRuntimeCache: () => {},
  registerRuntime: () => {},
}))

// ── mock: config/agents ──
// mockAgentConfigs 让各测试自己填充 {id: { config? }}；通过 globalThis 桥接到 mock
const { mockAgentConfigs } = vi.hoisted(() => ({ mockAgentConfigs: {} as Record<string, { config?: any }> }))
vi.mock('../config/agents.js', () => ({
  buildSystemPrompt: () => 'mocked-system-prompt',
  buildResumeSystemPrompt: () => 'mocked-resume-system-prompt',
  buildEdgeBasedContext: () => '',
  getSedimentEnabledAgents: () => [],
  getAgentConfig: (id: string) => {
    const override = (globalThis as any).__mockAgentConfigs?.[id]
    return {
      id,
      name: id,
      runtime: 'claude',
      instruction: '',
      outputFile: `${id}.md`,
      inputs: ['default'],
      outputs: ['default'],
      ...(override ?? {}),
    }
  },
}))

// ── mock: db（in-memory sqlite）──
vi.mock('../db/index.js', () => ({
  get db() { return (globalThis as any).__testDb },
}))

const sqlite = new Database(':memory:')
sqlite.pragma('foreign_keys = ON')
sqlite.exec(SCHEMA_SQL)
// Apply initDb's idempotent ALTERs (matches production startup).
for (const sql of IDEMPOTENT_ALTERS) {
  try { sqlite.exec(sql) } catch { /* already exists */ }
}
;(globalThis as any).__testDb = drizzle(sqlite, { schema })

const { AgentService } = await import('./agent.js')

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-agent-test-'))
  mockRuntime.createSession.mockReset()
  mockRuntime.resumeSession.mockReset()
  ;(globalThis as any).__mockAgentConfigs = {}
  // Disable FK during cleanup so previous tests' leftover rows (if any) can be
  // cleared even when their parent FK references are already gone. The
  // schema enables FK_PRAGMA at connection time; per-test reset of state
  // here doesn't need to enforce it.
  sqlite.pragma('foreign_keys = OFF')
  sqlite.exec(`
    DELETE FROM feature_node_migrations;
    DELETE FROM feature_node_states;
    DELETE FROM stage_run_outputs;
    DELETE FROM messages;
    DELETE FROM stage_runs;
    DELETE FROM workflow_edges;
    DELETE FROM workflow_nodes;
    DELETE FROM workflows;
    DELETE FROM features;
    DELETE FROM workspaces;
    DELETE FROM agents;
    DELETE FROM runtimes;
    DELETE FROM base_layers;
    DELETE FROM artifact_types;
  `)
  sqlite.pragma('foreign_keys = ON')
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// 工具：插入一个 workspace + 默认 workflow + 一个 spec 节点
function seedWorkflow(wsId: string) {
  const wfId = 'wf-' + wsId
  sqlite.prepare(`
    INSERT INTO workflows (id, workspace_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(wfId, wsId, 'default', Date.now(), Date.now())
  sqlite.prepare(`
    INSERT INTO workflow_nodes (id, workflow_id, node_id, agent_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('wn-' + wsId, wfId, 'spec', 'spec', Date.now())
  sqlite.prepare(`
    UPDATE workspaces SET default_workflow_id = ? WHERE id = ?
  `).run(wfId, wsId)
  sqlite.prepare(`
    UPDATE features SET current_workflow_id = ?, current_node_id = 'spec' WHERE workspace_id = ?
  `).run(wfId, wsId)
  return wfId
}

function insertWorkspace(id: string, localPath: string) {
  sqlite.prepare(`
    INSERT INTO workspaces (id, name, local_path, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, `ws-${id}`, localPath, Date.now())
}

function insertFeature(id: string, workspaceId: string) {
  sqlite.prepare(`
    INSERT INTO features (id, workspace_id, name, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, workspaceId, `feat-${id}`, Date.now())
}

function insertStageRun(id: string, featureId: string, stage: string, cliSessionId: string, nodeId: string | null = null) {
  sqlite.prepare(`
    INSERT INTO stage_runs (id, feature_id, stage, node_id, cli_session_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, featureId, stage, nodeId, cliSessionId, Date.now())
}

function makeEmptyStream() {
  return (async function* () {
    yield { kind: 'text' as const, text: 'ok' }
  })()
}

// ─────────────────────────────────────────────────────────────
// AC-03 / D-02: cwd = <localPath>/repo
// ─────────────────────────────────────────────────────────────

describe('AC-03 / D-02: services/agent.ts cwd 调整为 <localPath>/repo', () => {
  it('startStage: localPath = /tmp/xxx → createSession 第 3 参 cwd = /tmp/xxx/repo', async () => {
    const wsId = 'ws-1'
    const featId = 'feat-1'
    const localPath = path.join(tmpRoot, 'ws-1')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-1',
      stream: makeEmptyStream(),
    })

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    expect(stageRunId).toBeTruthy()
    expect(mockRuntime.createSession).toHaveBeenCalledTimes(1)
    const thirdArg = mockRuntime.createSession.mock.calls[0][2]
    expect(thirdArg).toBe(path.join(localPath, 'repo'))
  })

  it('sendMessage: localPath = /tmp/xxx → resumeSession 第 3 参 cwd = /tmp/xxx/repo', async () => {
    const wsId = 'ws-2'
    const featId = 'feat-2'
    const runId = 'run-2'
    const localPath = path.join(tmpRoot, 'ws-2')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'existing-cli-sess', 'spec')

    mockRuntime.resumeSession.mockImplementation(function* () {
      yield { kind: 'text' as const, text: 'reply' }
    })

    const stream = await AgentService.sendMessage(runId, 'next msg')
    for await (const _chunk of stream) { /* drain */ }

    expect(mockRuntime.resumeSession).toHaveBeenCalledTimes(1)
    const thirdArg = mockRuntime.resumeSession.mock.calls[0][2]
    expect(thirdArg).toBe(path.join(localPath, 'repo'))
  })

  it('startStage: localPath = undefined → cwd = undefined（不静默兜底）', async () => {
    const wsId = 'ws-3'
    const featId = 'feat-3'
    insertWorkspace(wsId, path.join(tmpRoot, 'ws-3'))
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-3',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', undefined,
    )
    for await (const _chunk of stream) { /* drain */ }

    const thirdArg = mockRuntime.createSession.mock.calls[0][2]
    expect(thirdArg).toBeUndefined()
  })

  it('startStage: <localPath>/repo 目录不存在时仍传 <localPath>/repo（不静默 fallback 到 <localPath>）', async () => {
    const wsId = 'ws-4'
    const featId = 'feat-4'
    const localPath = path.join(tmpRoot, 'ws-4')
    fs.mkdirSync(localPath, { recursive: true })
    fs.writeFileSync(path.join(localPath, 'placeholder.txt'), '')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-4',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const thirdArg = mockRuntime.createSession.mock.calls[0][2]
    expect(thirdArg).toBe(path.join(localPath, 'repo'))
    expect(thirdArg).not.toBe(localPath)
  })

  it('sendMessage: 模拟 spawn 在 repo 缺失时抛错能透传（E-06）', async () => {
    const wsId = 'ws-5'
    const featId = 'feat-5'
    const runId = 'run-5'
    const localPath = path.join(tmpRoot, 'ws-5')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'existing-cli-sess', 'spec')

    mockRuntime.resumeSession.mockImplementation(function* () {
      throw new Error('spawn ENOENT: <localPath>/repo')
      yield { kind: 'text' as const, text: 'never' }
    })

    const stream = await AgentService.sendMessage(runId, 'next msg')
    await expect(async () => {
      for await (const _chunk of stream) { /* drain */ }
    }).rejects.toThrow(/ENOENT/)
  })
})

// ─────────────────────────────────────────────────────────────
// Phase 0: 产物路径 = storage/<ws>/<feat>/<nodeId>/<outputName>
// ─────────────────────────────────────────────────────────────

describe('Phase 0: approveStage 产物路径 (P2 决策)', () => {
  it('approve 一个 output 后文件落在 storage/<ws>/<feat>/<nodeId>/<outputName>', async () => {
    const wsId = 'ws-app-1'
    const featId = 'feat-app-1'
    const runId = 'run-app-1'
    const localPath = path.join(tmpRoot, 'ws-app-1')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    const result = await AgentService.approveStage(
      runId, { default: '# spec content' }, wsId, featId,
    )
    expect(result.nodeId).toBe('spec')
    expect(result.outputNames).toEqual(['default'])

    // 验证 DB 行写入
    const row = sqlite.prepare(`SELECT * FROM stage_run_outputs WHERE stage_run_id = ?`).get(runId) as { output_name: string; content: string } | undefined
    expect(row).toBeTruthy()
    expect(row!.output_name).toBe('default')
    expect(row!.content).toBe('# spec content')
  })

  it('approve 时把 stageRun 状态置为 approved + featureNodeStates 置为 approved', async () => {
    const wsId = 'ws-app-2'
    const featId = 'feat-app-2'
    const runId = 'run-app-2'
    const localPath = path.join(tmpRoot, 'ws-app-2')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    await AgentService.approveStage(runId, { default: 'content' }, wsId, featId)

    const run = sqlite.prepare(`SELECT status FROM stage_runs WHERE id = ?`).get(runId) as { status: string }
    expect(run.status).toBe('approved')

    const state = sqlite.prepare(`SELECT status FROM feature_node_states WHERE feature_id = ? AND node_id = ?`).get(featId, 'spec') as { status: string } | undefined
    expect(state?.status).toBe('approved')
  })

  it('approve 拒绝空 outputs', async () => {
    const wsId = 'ws-app-3'
    const featId = 'feat-app-3'
    const runId = 'run-app-3'
    insertWorkspace(wsId, path.join(tmpRoot, 'ws-app-3'))
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    await expect(
      AgentService.approveStage(runId, {}, wsId, featId),
    ).rejects.toThrow(/at least one output/i)
  })
})

// ─────────────────────────────────────────────────────────────
// Phase 2: per-agent / per-node runtime config
//   三个层次：per-node (config_json) > per-agent (YAML config) > 默认
//   三个测试分别覆盖：
//     a) 仅 per-node  → 走 per-node 的 env / cwd / runtimeId / timeoutMs
//     b) 仅 per-agent (YAML) → 走 per-agent
//     c) 都没有 → 走默认（runtimeId='claude'，cwd=<localPath>/repo）
//   另加：per-node cwd 越界 WORKSPACE_BASE → 抛 PATH_TRAVERSAL (1003)
// ─────────────────────────────────────────────────────────────

function setNodeConfig(wsId: string, nodeId: string, config: object) {
  sqlite.prepare(`
    UPDATE workflow_nodes SET config_json = ? WHERE workflow_id = ? AND node_id = ?
  `).run(JSON.stringify(config), 'wf-' + wsId, nodeId)
}

describe('Phase 2: per-agent / per-node runtime config', () => {
  it('a) per-node config 全部覆盖默认：env / cwd / runtimeId / timeoutMs 透传给 createSession', async () => {
    const wsId = 'ws-p2-1'
    const featId = 'feat-p2-1'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo') // 落在真实 WORKSPACE_BASE 内
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    setNodeConfig(wsId, 'spec', {
      runtimeId: 'codefree',
      env: { FOO: 'bar', BAZ: 'qux' },
      cwd: path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo'),
      timeoutMs: 30000,
    })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-1',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const call = mockRuntime.createSession.mock.calls[0]
    const [_, __, cwd, opts] = call as [string, string, string | undefined, { env?: Record<string, string>; timeoutMs?: number } | undefined]
    expect(cwd).toBe(path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo'))
    expect(opts?.env?.FOO).toBe('bar')
    expect(opts?.env?.BAZ).toBe('qux')
    expect(opts?.timeoutMs).toBe(30000)
  })

  it('b) per-agent (YAML) config → per-node 无配置时继承之', async () => {
    const wsId = 'ws-p2-2'
    const featId = 'feat-p2-2'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    ;(globalThis as any).__mockAgentConfigs = {
      spec: { config: { env: { HELLO: 'world' }, timeoutMs: 5000 } },
    }

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-2',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    expect(opts?.env?.HELLO).toBe('world')
    expect(opts?.timeoutMs).toBe(5000)
  })

  it('c) 都无配置 → 默认：cwd=<localPath>/repo，env=undefined，timeoutMs=undefined', async () => {
    const wsId = 'ws-p2-3'
    const featId = 'feat-p2-3'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-3',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const [_, __, cwd, opts] = mockRuntime.createSession.mock.calls[0] as [string, string, string | undefined, { env?: Record<string, string>; timeoutMs?: number } | undefined]
    expect(cwd).toBe(path.join(localPath, 'repo'))
    expect(opts?.env).toBeUndefined()
    expect(opts?.timeoutMs).toBeUndefined()
  })

  it('per-node cwd 越界 WORKSPACE_BASE → 抛 PATH_TRAVERSAL (1003)', async () => {
    const wsId = 'ws-p2-4'
    const featId = 'feat-p2-4'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    setNodeConfig(wsId, 'spec', { cwd: '/etc/passwd' })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-4',
      stream: makeEmptyStream(),
    })

    await expect(
      AgentService.startStage(featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath)
        .then(({ stream }) => {
          // drain to make the rejection observable
          return (async () => { for await (const _ of stream) { /* */ } })()
        }),
    ).rejects.toMatchObject({ code: 1003 })
  })

  // ── docs/prds/per-agent-tool-restriction.md / docs/issues/002 ──
  // 三个优先级在 service 层归一化（per-node > per-agent > undefined）；
  // 4) 空串 → undefined（不传 CLI flag）
  it('per-node disallowedTools 覆盖 per-agent：mockRuntime 第 4 参 options.disallowedTools === "Bash"', async () => {
    const wsId = 'ws-p2-dt-1'
    const featId = 'feat-p2-dt-1'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    // per-agent 也设了 'Edit'，验证 per-node 覆盖之
    ;(globalThis as any).__mockAgentConfigs = {
      spec: { config: { disallowedTools: 'Edit' } },
    }
    setNodeConfig(wsId, 'spec', { disallowedTools: 'Bash' })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-dt-1',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    expect(opts?.disallowedTools).toBe('Bash')
  })

  it('per-node 未设、per-agent 设了 → 继承 per-agent：options.disallowedTools === "X,Y"', async () => {
    const wsId = 'ws-p2-dt-2'
    const featId = 'feat-p2-dt-2'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    ;(globalThis as any).__mockAgentConfigs = {
      spec: { config: { disallowedTools: 'X,Y' } },
    }
    // per-node 不设 disallowedTools（只设 cwd 让 block 走到 mergeConfig 路径）
    setNodeConfig(wsId, 'spec', { cwd: path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo') })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-dt-2',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    expect(opts?.disallowedTools).toBe('X,Y')
  })

  it('per-node / per-agent 都未设 → options.disallowedTools === undefined（不传 CLI flag）', async () => {
    const wsId = 'ws-p2-dt-3'
    const featId = 'feat-p2-dt-3'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    // per-agent 不设 config.disallowedTools；per-node 也不设
    ;(globalThis as any).__mockAgentConfigs = { spec: {} }

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-dt-3',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    expect(opts?.disallowedTools).toBeUndefined()
  })

  it('per-node 显式设 ""（空串）→ options.disallowedTools === undefined（与 undefined 等价）', async () => {
    const wsId = 'ws-p2-dt-4'
    const featId = 'feat-p2-dt-4'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    // per-agent 也不设，确保空串归一化不影响"无配置"分支
    ;(globalThis as any).__mockAgentConfigs = { spec: {} }
    setNodeConfig(wsId, 'spec', { disallowedTools: '' })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-dt-4',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    expect(opts?.disallowedTools).toBeUndefined()
  })

  // 评审反馈：normalizeCsv 必须返回 trim 后的值，避免 " Bash " 透传到 CLI flag。
  it('per-node 设 " Bash "（带前后空白）→ options.disallowedTools === "Bash"（已 trim）', async () => {
    const wsId = 'ws-p2-dt-5'
    const featId = 'feat-p2-dt-5'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    ;(globalThis as any).__mockAgentConfigs = { spec: {} }
    setNodeConfig(wsId, 'spec', { disallowedTools: ' Bash ' })

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-p2-dt-5',
      stream: makeEmptyStream(),
    })

    const { stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const opts = (mockRuntime.createSession.mock.calls[0] as any)[3]
    // 关键：trim 后的值，不带前后空白
    expect(opts?.disallowedTools).toBe('Bash')
  })
})

// ─────────────────────────────────────────────────────────────
// Phase 3: 同一 stageRun 批准多个 output → 独立文件 + 独立 stage_run_outputs 行
//   I/O 3 决策：approve 一调用入 N 个 output，每个落到独立文件 + DB 行
//   E-2 边界：只给部分 output（如只给 default），其他未给 → 不写文件，DB 也不应有"幽灵"行
// ─────────────────────────────────────────────────────────────

describe('Phase 3: approve 多 output', () => {
  it('两个 output（default + readme）→ 两个文件 + 两个 stage_run_outputs 行', async () => {
    const wsId = 'ws-p3-1'
    const featId = 'feat-p3-1'
    const runId = 'run-p3-1'
    const localPath = path.join(tmpRoot, 'ws-p3-1')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    const result = await AgentService.approveStage(
      runId, { default: '# spec content', readme: '# readme content' }, wsId, featId,
    )
    expect(result.nodeId).toBe('spec')
    expect(result.outputNames).toEqual(expect.arrayContaining(['default', 'readme']))
    expect(result.outputNames).toHaveLength(2)

    // DB：两个 stage_run_outputs 行
    const rows = sqlite.prepare(`SELECT * FROM stage_run_outputs WHERE stage_run_id = ?`).all(runId) as Array<{ output_name: string; content: string }>
    expect(rows).toHaveLength(2)
    const byName = Object.fromEntries(rows.map((r) => [r.output_name, r.content]))
    expect(byName.default).toBe('# spec content')
    expect(byName.readme).toBe('# readme content')

    // 文件：storage/<ws>/<feat>/spec/<outputName>
    // STORAGE_ROOT = path.resolve(__dirname, '../../../storage') —— agent.ts 在 services/ 下，要升 3 档
    const filePathDefault = path.resolve(__dirname, '..', '..', '..', 'storage', wsId, featId, 'spec', 'default')
    const filePathReadme = path.resolve(__dirname, '..', '..', '..', 'storage', wsId, featId, 'spec', 'readme')
    expect(fs.existsSync(filePathDefault)).toBe(true)
    expect(fs.existsSync(filePathReadme)).toBe(true)
    expect(fs.readFileSync(filePathDefault, 'utf-8')).toBe('# spec content')
    expect(fs.readFileSync(filePathReadme, 'utf-8')).toBe('# readme content')
  })

  it('只给 default → 只产生 default 一行 + 一文件', async () => {
    const wsId = 'ws-p3-2'
    const featId = 'feat-p3-2'
    const runId = 'run-p3-2'
    insertWorkspace(wsId, path.join(tmpRoot, 'ws-p3-2'))
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    const result = await AgentService.approveStage(
      runId, { default: 'only default' }, wsId, featId,
    )
    expect(result.outputNames).toEqual(['default'])

    const rows = sqlite.prepare(`SELECT * FROM stage_run_outputs WHERE stage_run_id = ?`).all(runId) as Array<{ output_name: string }>
    expect(rows).toHaveLength(1)
    expect(rows[0].output_name).toBe('default')

    const filePathDefault = path.resolve(__dirname, '..', '..', '..', 'storage', wsId, featId, 'spec', 'default')
    const filePathReadme = path.resolve(__dirname, '..', '..', '..', 'storage', wsId, featId, 'spec', 'readme')
    expect(fs.existsSync(filePathDefault)).toBe(true)
    expect(fs.existsSync(filePathReadme)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────
// Implements: .scratch/thinking-visibility-and-persistence/issues/01
// wrappedStream 把 thinking.text 累加到 messages.thinking 列
// 三种 CLI 输出形态：
//   1) 增量：thinking_delta 逐 token 推 → 应拼接成完整文本落库
//   2) 兜底：仅末尾 assistant.message.content[thinking] 一次性推 → 应落库
//   3) 纯 token：仅 thinking_tokens 周期上报（无 text） → 应为 null
// ─────────────────────────────────────────────────────────────

function getAssistantMessage(stageRunId: string): { content: string; thinking: string | null } {
  const row = sqlite.prepare(
    `SELECT content, thinking FROM messages WHERE stage_run_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1`,
  ).get(stageRunId) as { content: string; thinking: string | null } | undefined
  if (!row) throw new Error(`no assistant message for stageRun ${stageRunId}`)
  return row
}

describe('Issue 01: wrappedStream 累加 thinking 并落库', () => {
  it('startStage: 增量模式 [text, thinking.text, text, thinking.text] → 落库 content + thinking 各自拼接', async () => {
    const wsId = 'ws-th-1'
    const featId = 'feat-th-1'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockImplementation(() => ({
      sessionId: 'cli-sess-th-1',
      stream: (async function* () {
        yield { kind: 'text', text: 'Hello, ' }
        yield { kind: 'thinking', text: 'Let me ' }
        yield { kind: 'text', text: 'world.' }
        yield { kind: 'thinking', text: 'think about this.' }
      })(),
    }))

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(stageRunId)
    expect(msg.content).toBe('Hello, world.')
    expect(msg.thinking).toBe('Let me think about this.')
  })

  it('sendMessage: 增量模式透传累加逻辑（与 startStage 行为一致）', async () => {
    const wsId = 'ws-th-2'
    const featId = 'feat-th-2'
    const runId = 'run-th-2'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess-th-2', 'spec')

    mockRuntime.resumeSession.mockImplementation(function* () {
      yield { kind: 'thinking', text: 'thinking-A' }
      yield { kind: 'text', text: 'reply-A' }
      yield { kind: 'thinking', text: 'thinking-B' }
    })

    const stream = await AgentService.sendMessage(runId, 'next msg')
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(runId)
    expect(msg.content).toBe('reply-A')
    expect(msg.thinking).toBe('thinking-Athinking-B')
  })

  it('兜底模式：仅一次性 thinking.text（CLI 只在末尾发一次） → 落库 thinking === 原文', async () => {
    const wsId = 'ws-th-3'
    const featId = 'feat-th-3'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    const fullThinking = 'This is the entire reasoning, delivered in one shot.'
    mockRuntime.createSession.mockImplementation(() => ({
      sessionId: 'cli-sess-th-3',
      stream: (async function* () {
        yield { kind: 'text', text: 'final answer' }
        yield { kind: 'thinking', text: fullThinking }
      })(),
    }))

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(stageRunId)
    expect(msg.content).toBe('final answer')
    expect(msg.thinking).toBe(fullThinking)
  })

  it('纯 token 计数（无 text）：thinking.tokensDelta/tokensTotal → 落库 thinking === null', async () => {
    const wsId = 'ws-th-4'
    const featId = 'feat-th-4'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockImplementation(() => ({
      sessionId: 'cli-sess-th-4',
      stream: (async function* () {
        yield { kind: 'text', text: 'just text' }
        yield { kind: 'thinking', tokensDelta: 6, tokensTotal: 6 }
        yield { kind: 'thinking', tokensDelta: 12, tokensTotal: 18 }
      })(),
    }))

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(stageRunId)
    expect(msg.content).toBe('just text')
    expect(msg.thinking).toBeNull() // 纯 token 无文本 → 不入 DB
  })

  it('无 thinking：纯 text 流 → 落库 thinking === null（不存空字符串）', async () => {
    const wsId = 'ws-th-5'
    const featId = 'feat-th-5'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockImplementation(() => ({
      sessionId: 'cli-sess-th-5',
      stream: (async function* () {
        yield { kind: 'text', text: 'plain text' }
      })(),
    }))

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(stageRunId)
    expect(msg.content).toBe('plain text')
    expect(msg.thinking).toBeNull()
  })

  it('空字符串 thinking.text（CLI 偶发）→ 仍走累加路径，落库 thinking === ""（与 null 区分以反映 CLI 行为）', async () => {
    // 边界：CLI 偶尔会发 ""（与 token-only 区分）。当前实现把 chunk.text 空字符串累加进去
    // → fullThinking === '' → 落库时 `|| null` 归一为 null。验证归一化生效
    const wsId = 'ws-th-6'
    const featId = 'feat-th-6'
    const localPath = path.join(os.homedir(), 'sdd-workspaces', wsId, 'repo')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    mockRuntime.createSession.mockImplementation(() => ({
      sessionId: 'cli-sess-th-6',
      stream: (async function* () {
        yield { kind: 'text', text: 'reply' }
        yield { kind: 'thinking', text: '' }
      })(),
    }))

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    const msg = getAssistantMessage(stageRunId)
    expect(msg.content).toBe('reply')
    // 空字符串归一为 null——避免前端被 msg.thinking === "" 误判为"有 thinking"
    expect(msg.thinking).toBeNull()
  })
})

// Implements: .scratch/agent-contract-db/issues/04-runtime-contract.md
// slice 04：startStage 把 agent.instruction 写入 stage_runs.instruction_snapshot；
// 之后改 agent.instruction 不影响 in-flight stage_run（Q2 决策 A）。
// 这里 getAgentConfig 是 mock 的——通过 (globalThis as any).__mockAgentConfigs 改 instruction。
describe('slice 04: instruction_snapshot 写入', () => {
  it('startStage 后修改 agent.instruction，stage_runs.instruction_snapshot 仍是旧值', async () => {
    const wsId = 'ws-snap'
    const featId = 'feat-snap'
    const localPath = path.join(tmpRoot, 'ws-snap')
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    seedWorkflow(wsId)

    // 第一次：把 spec agent 的 instruction 设为 'OLD INSTRUCTION'
    ;(globalThis as any).__mockAgentConfigs = { spec: { instruction: 'OLD INSTRUCTION' } }

    mockRuntime.createSession.mockResolvedValue({
      sessionId: 'cli-sess-snap',
      stream: makeEmptyStream(),
    })

    const { stageRunId, stream } = await AgentService.startStage(
      featId, 'spec', wsId, 'ts', '', 'first msg', 'claude', localPath,
    )
    for await (const _chunk of stream) { /* drain */ }

    // 模拟运维在跑过程中改了 agent.instruction
    ;(globalThis as any).__mockAgentConfigs = { spec: { instruction: 'NEW INSTRUCTION' } }

    // 读 stage_runs.instruction_snapshot——应是旧值
    const row = sqlite.prepare(`SELECT instruction_snapshot FROM stage_runs WHERE id = ?`).get(stageRunId) as
      { instruction_snapshot: string | null }
    expect(row.instruction_snapshot).toBe('OLD INSTRUCTION')
    expect(row.instruction_snapshot).not.toBe('NEW INSTRUCTION')
  })
})

// Implements: .scratch/agent-contract-db/issues/04-runtime-contract.md
// slice 04：approveStage 校验 outputName ∈ agent.outputs —— 拒绝任何不在
// agent 声明里的 key（避免 typo 污染产物路径）；同时校验 content 非空。
// 同时：resume 路径 sendMessage 喂给 runtime 的 prompt 来自 snapshot 而非 live agent。

describe('slice 04: approveStage outputName 校验', () => {
  it('outputName 不在 agent.outputs → 抛 400 + 列出非法 key', async () => {
    const wsId = 'ws-aok-1'
    const featId = 'feat-aok-1'
    const runId = 'run-aok-1'
    insertWorkspace(wsId, path.join(tmpRoot, wsId))
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    // 默认 mockAgentConfigs[spec].outputs = ['default'] —— 'wrong.md' 不在列表里
    await expect(
      AgentService.approveStage(runId, { 'wrong.md': '# oops' }, wsId, featId),
    ).rejects.toThrow(/wrong\.md/)
  })

  it('outputName ∈ agent.outputs 但 content 是空串 → 抛 400 + 列出空 key', async () => {
    const wsId = 'ws-aok-2'
    const featId = 'feat-aok-2'
    const runId = 'run-aok-2'
    insertWorkspace(wsId, path.join(tmpRoot, wsId))
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    await expect(
      AgentService.approveStage(runId, { default: '   ' }, wsId, featId),
    ).rejects.toThrow(/empty content/i)
  })

  it('合法 outputName + 非空 content → 落盘成功', async () => {
    const wsId = 'ws-aok-3'
    const featId = 'feat-aok-3'
    const runId = 'run-aok-3'
    insertWorkspace(wsId, path.join(tmpRoot, wsId))
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    const result = await AgentService.approveStage(
      runId, { default: '# valid' }, wsId, featId,
    )
    expect(result.outputNames).toEqual(['default'])
  })

  it('agent.outputs 为空但请求带了任意 key → 抛 400（agent 没声明任何 port）', async () => {
    const wsId = 'ws-aok-4'
    const featId = 'feat-aok-4'
    const runId = 'run-aok-4'
    insertWorkspace(wsId, path.join(tmpRoot, wsId))
    insertFeature(featId, wsId)
    seedWorkflow(wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess', 'spec')

    // override: agent.outputs = []
    ;(globalThis as any).__mockAgentConfigs = { spec: { outputs: [] } }

    await expect(
      AgentService.approveStage(runId, { default: '# whatever' }, wsId, featId),
    ).rejects.toThrow(/not declared/)
    // AC #2 要求错误消息"列出非法 key"——验证 'default' 出现在消息中
    await expect(
      AgentService.approveStage(runId, { default: '# whatever' }, wsId, featId),
    ).rejects.toThrow(/default/)
  })
})

// Implements: .scratch/agent-contract-db/issues/04-runtime-contract.md
// slice 04：sendMessage 喂给 runtime 的 resumeSystemPrompt 是 buildResumeSystemPrompt
// 的返回值（snapshot 而非 live agent）。通过 mockRuntime.resumeSession 第 5 参断言。

describe('slice 04: sendMessage 喂 snapshot-based prompt 给 runtime', () => {
  it('sendMessage 把 buildResumeSystemPrompt 的返回值作为 resumeSession 第 5 参', async () => {
    const wsId = 'ws-resume-1'
    const featId = 'feat-resume-1'
    const runId = 'run-resume-1'
    const localPath = path.join(tmpRoot, wsId)
    insertWorkspace(wsId, localPath)
    insertFeature(featId, wsId)
    insertStageRun(runId, featId, 'spec', 'cli-sess-resume', 'spec')

    mockRuntime.resumeSession.mockImplementation(function* () {
      yield { kind: 'text' as const, text: 'reply' }
    })

    const stream = await AgentService.sendMessage(runId, 'next msg')
    for await (const _chunk of stream) { /* drain */ }

    expect(mockRuntime.resumeSession).toHaveBeenCalledTimes(1)
    // 第 5 参 = resumeSystemPrompt（mock buildResumeSystemPrompt 返 'mocked-resume-system-prompt'）
    const fifthArg = mockRuntime.resumeSession.mock.calls[0][4]
    expect(fifthArg).toBe('mocked-resume-system-prompt')
  })
})
