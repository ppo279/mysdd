// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03)
//
// End-to-end gatekeeper integration test:
//   1. After code-surgeon approves, the gatekeeper auto-invokes the runner.
//   2. On rejection, the workflow engine cascades to the upstream node,
//      archives prior side outputs, increments attempt #, and tracks
//      parent_stage_run_id. On budget exhaustion → circuit_broken.

// Pin HOME BEFORE any import that transitively loads routes/workspaces.js
// (which captures `os.homedir()` at module load into WORKSPACE_BASE).
// All imports below are dynamic so they run after HOME is set.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-gk-home-'))
process.env.HOME = TEST_HOME

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { eq, and, inArray } from 'drizzle-orm'

// Dynamic imports so HOME is honored
const dbMod = await import('../db/index.js')
const { db, initDb } = dbMod
const schema = await import('../db/schema.js')
const {
  workspaces,
  workflows,
  features,
  stageRuns,
  featureNodeStates,
  messages,
} = schema
const wsMod = await import('../services/workflow-seed.js')
const { seedBugFixWorkflow } = wsMod
const gkMod = await import('../services/gatekeeper.js')
const { runGatekeeper } = gkMod
const artMod = await import('../services/artifact.js')
const { ArtifactService } = artMod
const rejMod = await import('../services/rejection.js')
const {
  getNextAttempt,
  countRepairBudgetConsumed,
  isBudgetExhausted,
  getNodeRepairBudget,
  getTotalRepairBudget,
} = rejMod

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

const createdWorkspaceIds = new Set<string>()

beforeAll(() => {
  initDb()
})

afterAll(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

interface Fixture {
  wsLocalPath: string
  repoDir: string
  featureWorktreePath: string
  featureId: string
  workspaceId: string
}

async function buildFixture(opts: { testBody?: string; srcBody?: string } = {}): Promise<Fixture> {
  const workspaceId = randomUUID()
  createdWorkspaceIds.add(workspaceId)
  const wsLocalPath = path.join(TEST_HOME, 'sdd-workspaces', `ws-${workspaceId.slice(0, 8)}`)
  fs.mkdirSync(wsLocalPath, { recursive: true })
  const repoDir = path.join(wsLocalPath, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  // Insert the workspace row (required before seedBugFixWorkflow can look it up)
  await db.insert(workspaces).values({
    id: workspaceId,
    name: `ws-${workspaceId.slice(0, 8)}`,
    description: '',
    repoUrl: '',
    techStack: 'ts',
    background: '',
    localPath: wsLocalPath,
    defaultWorkflowId: null,
    createdAt: new Date(),
  })

  // Initial buggy commit on main
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'src', 'calc.js'), 'export function add(a, b) { return a - b }\n')
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n')
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n.worktree/\n')
  fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'f', type: 'module' }))
  git(repoDir, 'init', '-b', 'main')
  git(repoDir, 'config', 'user.email', 't@t')
  git(repoDir, 'config', 'user.name', 'T')
  git(repoDir, 'config', 'commit.gpgsign', 'false')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'init')

  // Seed the bug-fix workflow
  await seedBugFixWorkflow(workspaceId)

  // Create feature
  const featureId = randomUUID()
  await db.insert(features).values({
    id: featureId,
    workspaceId,
    name: 'fix add bug',
    description: '',
    currentStage: 'fix',
    currentWorkflowId: (await db.select().from(workflows).where(eq(workflows.workspaceId, workspaceId)))[0].id,
    currentNodeId: 'fix',
    status: 'active',
    intent: 'bug_fix',
    lockedFiles: null,
    looksLike: null,
    createdAt: new Date(),
  })

  // Create the per-feature worktree
  const featureWorktreePath = path.join(wsLocalPath, 'repo.worktrees', `feat-${featureId}`)
  git(repoDir, 'worktree', 'add', '-b', `bugfix/${featureId}`, featureWorktreePath, 'main')

  // Write test + fix on the worktree
  const testBody = opts.testBody ?? [
    "import { add } from './calc.js'",
    "if (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1) }",
    "console.log('PASS')",
    '',
  ].join('\n')
  fs.writeFileSync(path.join(featureWorktreePath, 'src', 'reproduction_test.mjs'), testBody)
  const srcBody = opts.srcBody ?? 'export function add(a, b) { return a + b }\n'
  fs.writeFileSync(path.join(featureWorktreePath, 'src', 'calc.js'), srcBody)

  // Commit them
  git(featureWorktreePath, 'add', 'src/reproduction_test.mjs')
  git(featureWorktreePath, 'commit', '-m', 'test')
  git(featureWorktreePath, 'add', 'src/calc.js')
  git(featureWorktreePath, 'commit', '-m', 'fix')

  // Generate fix.patch (HEAD only — just the source change)
  const patch = execFileSync('git', ['format-patch', '-1', '--stdout', 'HEAD'], {
    cwd: featureWorktreePath,
    encoding: 'utf-8',
  })

  // Persist fix.patch + test_metadata.json as approved artifacts for nodeId='fix'
  const fixPatchPath = ArtifactService.getArtifactPath(workspaceId, featureId, 'fix', 'fix.patch')
  const testMetadataPath = ArtifactService.getArtifactPath(workspaceId, featureId, 'fix', 'test_metadata.json')
  fs.mkdirSync(path.dirname(fixPatchPath), { recursive: true })
  fs.writeFileSync(fixPatchPath, patch)
  fs.writeFileSync(testMetadataPath, JSON.stringify({
    framework: 'node',
    test_command: 'node src/reproduction_test.mjs',
    full_test_command: 'node src/reproduction_test.mjs',
  }))

  // Create the fix stage_run (parent for the audit run)
  const fixStageRunId = randomUUID()
  await db.insert(stageRuns).values({
    id: fixStageRunId,
    featureId,
    stage: 'code-surgeon',
    nodeId: 'fix',
    runtimeId: 'system',
    cliSessionId: null,
    status: 'approved',
    artifactContent: '',
    artifactPath: '',
    createdAt: new Date(),
    approvedAt: new Date(),
    attempt: 1,
  })
  await db.update(featureNodeStates).set({ status: 'approved', lastStageRunId: fixStageRunId, updatedAt: new Date() })
    .where(and(eq(featureNodeStates.featureId, featureId), eq(featureNodeStates.nodeId, 'fix')))

  return { wsLocalPath, repoDir, featureWorktreePath, featureId, workspaceId }
}

async function teardown() {
  for (const wsId of createdWorkspaceIds) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, wsId))
    const featureRows = await db.select().from(features).where(eq(features.workspaceId, wsId))
    for (const f of featureRows) {
      const runIds = (await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, f.id))).map((r) => r.id)
      if (runIds.length > 0) {
        await db.delete(messages).where(inArray(messages.stageRunId, runIds))
      }
      await db.delete(stageRuns).where(eq(stageRuns.featureId, f.id))
      await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, f.id))
    }
    await db.delete(features).where(eq(features.workspaceId, wsId))
    await db.delete(workspaces).where(eq(workspaces.id, wsId))
    if (ws?.localPath) {
      try { fs.rmSync(ws.localPath, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
  createdWorkspaceIds.clear()
}

beforeEach(async () => {
  await teardown()
})

afterEach(async () => {
  await teardown()
})

afterAll(async () => {
  await teardown()
})

describe('gatekeeper: approved verdict', () => {
  it('runs the runner, persists audit_report.md, marks audit node approved', async () => {
    const fx = await buildFixture({})
    const fixRun = (await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'fix'))))[0]

    const result = await runGatekeeper({
      featureId: fx.featureId,
      fixStageRunId: fixRun.id,
      featureWorktreePath: fx.featureWorktreePath,
    })
    expect(result.verdict.status).toBe('approved')
    expect(result.cascade).toBeNull()

    // audit node approved
    const auditRuns = await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'audit')))
    expect(auditRuns.length).toBe(1)
    expect(auditRuns[0].status).toBe('approved')
    expect(auditRuns[0].parentStageRunId).toBe(fixRun.id)
    expect(auditRuns[0].attempt).toBe(1)

    // 4 audit artifacts on disk
    const auditDir = path.dirname(ArtifactService.getArtifactPath(fx.workspaceId, fx.featureId, 'audit', 'audit_report.md'))
    expect(fs.existsSync(path.join(auditDir, 'audit_report.md'))).toBe(true)
    expect(fs.existsSync(path.join(auditDir, 'reverse_validation.log'))).toBe(true)
    expect(fs.existsSync(path.join(auditDir, 'mutation_test.log'))).toBe(true)
    expect(fs.existsSync(path.join(auditDir, 'coverage_delta.json'))).toBe(true)

    // audit_report.md contains APPROVED
    const report = fs.readFileSync(path.join(auditDir, 'audit_report.md'), 'utf-8')
    expect(report).toContain('APPROVED')
  })
})

describe('gatekeeper: rejection cascade', () => {
  it('rejected → cascade to upstream node with attempt=2 + parent_stage_run_id', async () => {
    const weakTest = [
      "import { add } from './calc.js'",
      "console.log('result =', add(2, 3))",
      "process.exit(0)",
      '',
    ].join('\n')
    const fx = await buildFixture({ testBody: weakTest })
    const fixRun = (await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'fix'))))[0]

    const result = await runGatekeeper({
      featureId: fx.featureId,
      fixStageRunId: fixRun.id,
      featureWorktreePath: fx.featureWorktreePath,
    })
    expect(result.verdict.status).toBe('rejected')
    expect(result.verdict.rejectionReason).toBe('reverse_validation_failed')
    expect(result.cascade).not.toBeNull()
    expect(result.cascade!.targetNodeId).toBe('design-test')
    expect(result.cascade!.circuitBroken).toBe(false)
    expect(result.cascade!.newStageRunId).toBeTruthy()

    // The cascade created a new stage_run for design-test
    const cascadeRuns = await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'design-test')))
    expect(cascadeRuns.length).toBe(1)
    expect(cascadeRuns[0].attempt).toBe(1)  // first run for design-test, but parent is the audit run
    expect(cascadeRuns[0].parentStageRunId).toBe(result.auditStageRunId)
    expect(cascadeRuns[0].rejectionReason).toBe('reverse_validation_failed')

    // Feature currentNodeId updated
    const [feat] = await db.select().from(features).where(eq(features.id, fx.featureId))
    expect(feat.currentNodeId).toBe('design-test')
  })

  it('archives prior side outputs to <nodeId>/.archive/attempt-<N-1>/ on cascade', async () => {
    const weakTest = [
      "import { add } from './calc.js'",
      "process.exit(0)",
      '',
    ].join('\n')
    const fx = await buildFixture({ testBody: weakTest })
    // Pre-populate side outputs for design-test (simulating an earlier attempt)
    const designTestDir = path.dirname(ArtifactService.getArtifactPath(fx.workspaceId, fx.featureId, 'design-test', 'reproduction_test'))
    fs.mkdirSync(designTestDir, { recursive: true })
    fs.writeFileSync(path.join(designTestDir, 'reproduction_test'), '// prior attempt\n')
    fs.writeFileSync(path.join(designTestDir, 'reproduction_test.log'), 'prior attempt failed\n')

    const fixRun = (await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'fix'))))[0]
    const result = await runGatekeeper({
      featureId: fx.featureId,
      fixStageRunId: fixRun.id,
      featureWorktreePath: fx.featureWorktreePath,
    })
    expect(result.cascade?.targetNodeId).toBe('design-test')

    // Prior outputs moved to .archive/attempt-0/
    const archiveDir = path.join(designTestDir, '.archive', 'attempt-0')
    expect(fs.existsSync(path.join(archiveDir, 'reproduction_test'))).toBe(true)
    expect(fs.existsSync(path.join(archiveDir, 'reproduction_test.log'))).toBe(true)
    // Live dir no longer has the files
    expect(fs.existsSync(path.join(designTestDir, 'reproduction_test'))).toBe(false)
  })

  it('circuit-breaker when per-node budget is exhausted', async () => {
    // The design-test node has repair_budget=2 per bug-fix.yaml seed.
    // We pre-seed 2 prior failed attempts for design-test, then trigger a
    // third rejection. The gatekeeper should mark the feature circuit_broken.
    const weakTest = "process.exit(0)\n"
    const fx = await buildFixture({ testBody: weakTest })

    // Seed 2 prior attempts on design-test (attempt=2 and attempt=3, both with parent)
    for (let i = 0; i < 2; i++) {
      const prior = randomUUID()
      await db.insert(stageRuns).values({
        id: prior,
        featureId: fx.featureId,
        stage: 'test-architect',
        nodeId: 'design-test',
        runtimeId: 'system',
        cliSessionId: null,
        status: 'rejected',
        artifactContent: '',
        artifactPath: '',
        createdAt: new Date(),
        attempt: i + 2,
        rejectionReason: 'reverse_validation_failed',
      })
    }

    const fixRun = (await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, fx.featureId), eq(stageRuns.nodeId, 'fix'))))[0]
    const result = await runGatekeeper({
      featureId: fx.featureId,
      fixStageRunId: fixRun.id,
      featureWorktreePath: fx.featureWorktreePath,
    })

    // Per-node budget for design-test is 2; we've already consumed 2 retries
    // → next cascade is rejected with circuitBroken=true.
    expect(result.cascade?.circuitBroken).toBe(true)
    expect(result.cascade?.reason).toMatch(/budget/)

    const [feat] = await db.select().from(features).where(eq(features.id, fx.featureId))
    expect(feat.status).toBe('circuit_broken')
  })
})

describe('gatekeeper: repair-budget helpers (sanity)', () => {
  it('getNextAttempt returns 1 on a fresh node', async () => {
    const fx = await buildFixture({})
    expect(await getNextAttempt(fx.featureId, 'design-test')).toBe(1)
  })

  it('getNextAttempt returns max+1 after retries', async () => {
    const fx = await buildFixture({})
    for (const attempt of [2, 3]) {
      await db.insert(stageRuns).values({
        id: randomUUID(),
        featureId: fx.featureId,
        stage: 'test-architect',
        nodeId: 'design-test',
        runtimeId: 'system',
        cliSessionId: null,
        status: 'rejected',
        artifactContent: '',
        artifactPath: '',
        createdAt: new Date(),
        attempt,
        rejectionReason: 'reverse_validation_failed',
      })
    }
    expect(await getNextAttempt(fx.featureId, 'design-test')).toBe(4)
  })

  it('countRepairBudgetConsumed sums retries across all nodes', async () => {
    const fx = await buildFixture({})
    // 1 retry on analyze, 2 on design-test, 0 on fix
    await db.insert(stageRuns).values({
      id: randomUUID(), featureId: fx.featureId, stage: 'bug-analyst', nodeId: 'analyze',
      runtimeId: 'system', cliSessionId: null, status: 'rejected', artifactContent: '',
      artifactPath: '', createdAt: new Date(), attempt: 2, rejectionReason: 're_analyze',
    })
    await db.insert(stageRuns).values({
      id: randomUUID(), featureId: fx.featureId, stage: 'test-architect', nodeId: 'design-test',
      runtimeId: 'system', cliSessionId: null, status: 'rejected', artifactContent: '',
      artifactPath: '', createdAt: new Date(), attempt: 2, rejectionReason: 'flaky_test',
    })
    await db.insert(stageRuns).values({
      id: randomUUID(), featureId: fx.featureId, stage: 'test-architect', nodeId: 'design-test',
      runtimeId: 'system', cliSessionId: null, status: 'rejected', artifactContent: '',
      artifactPath: '', createdAt: new Date(), attempt: 3, rejectionReason: 'flaky_test',
    })
    const consumed = await countRepairBudgetConsumed(fx.featureId)
    expect(consumed.perNode['analyze']).toBe(1)
    expect(consumed.perNode['design-test']).toBe(2)
    expect(consumed.total).toBe(3)

    // Global budget default 3 → exhausted
    expect(isBudgetExhausted(consumed, 'fix', {
      perNode: getNodeRepairBudget('{"repair_budget": 3}'),
      total: getTotalRepairBudget({ total_repair_budget: 3 }),
    })).toBe(true)
  })
})