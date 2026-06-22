// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02)
//
// End-to-end TDD pipeline test against a fixture repo with a known bug.
//
// What this exercises:
//   1. ensureFeatureWorktree creates a real git worktree from the workspace's
//      main branch (defaultBranch = 'main').
//   2. test-architect writes its reproduction test AS A REAL FILE in the
//      worktree's source tree (not a side-output blob).
//   3. The test actually runs and FAILS (red phase of TDD) — we capture the
//      log as `reproduction_test.log`.
//   4. test-architect also writes test_metadata.json.
//   5. code-surgeon applies a minimal source change IN the worktree — the test
//      now PASSES (green phase of TDD).
//   6. code-surgeon generates fix.patch as `git diff` between the original
//      commit and the post-fix state (source-only — no test changes).
//
// We do not exercise the LLM agent prompts in this test. The pipeline shape
// (worktree + real test file + minimal fix + diff) is the contract the
// system must guarantee; the agents are responsible for emitting the right
// content.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'
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

// Pin HOME before loading modules that capture os.homedir() at module load.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-tdd-home-'))
process.env.HOME = TEST_HOME

const wt = await import('../services/worktree.js')
const { ensureFeatureWorktree, getFeatureWorktreePath } = wt

const createdWorkspaceIds = new Set<string>()

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function gitStatus(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

/**
 * Set up a fixture repo at <wsDir>/repo with a known bug in src/calc.js.
 *
 *  export function add(a, b) { return a - b }   // BUG: should be a + b
 *
 * The test-architect will write a reproduction test asserting
 * add(2, 3) === 5 (red), then code-surgeon will fix calc.js to return
 * a + b (green). The test file lives at src/reproduction_test.mjs and is
 * run with plain `node` — no TypeScript build step required.
 */
function setupFixtureRepo(wsDir: string): { repoDir: string; srcFile: string; testFile: string } {
  const repoDir = path.join(wsDir, 'repo')
  const srcFile = path.join(repoDir, 'src', 'calc.js')
  const testFile = path.join(repoDir, 'src', 'reproduction_test.mjs')

  fs.mkdirSync(path.dirname(srcFile), { recursive: true })
  fs.writeFileSync(
    srcFile,
    'export function add(a, b) { return a - b }\n',
  )

  // README + .gitignore so the worktree can be created
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Fixture\n')
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n')

  // package.json: ESM so test runner can use import syntax
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      type: 'module',
    }),
  )

  git(repoDir, 'init', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'test@example.com')
  git(repoDir, 'config', 'user.name', 'Test')
  git(repoDir, 'config', 'commit.gpgsign', 'false')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'initial fixture with bug')

  return { repoDir, srcFile, testFile }
}

async function buildIsolatedWorkspace(wsLocalPath: string): Promise<{ workspaceId: string }> {
  const workspaceId = randomUUID()
  await db.insert(workspaces).values({
    id: workspaceId,
    name: `tdd-ws-${workspaceId.slice(0, 8)}`,
    description: '',
    repoUrl: '',
    techStack: 'ts',
    background: '',
    localPath: wsLocalPath,
    defaultWorkflowId: null,
    createdAt: new Date(),
  })
  createdWorkspaceIds.add(workspaceId)
  await seedBugFixWorkflow(workspaceId)
  return { workspaceId }
}

async function teardownWorkspace(workspaceId: string) {
  const featureRows = await db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.workspaceId, workspaceId))
  for (const f of featureRows) {
    const runIds = (
      await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, f.id))
    ).map((r) => r.id)
    if (runIds.length > 0) {
      await db.delete(messages).where(inArray(messages.stageRunId, runIds))
    }
    await db.delete(stageRuns).where(eq(stageRuns.featureId, f.id))
    await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, f.id))
  }
  await db.delete(features).where(eq(features.workspaceId, workspaceId))
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
  createdWorkspaceIds.delete(workspaceId)
}

beforeAll(() => {
  initDb()
})

afterAll(async () => {
  // 兜底:afterEach 用 let workspaceId 检查,beforeEach 抛错时漏;这里用 Set 兜底
  for (const wsId of [...createdWorkspaceIds]) {
    try { await teardownWorkspace(wsId) } catch { /* best-effort */ }
  }
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('TDD pipeline: per-feature worktree + test-architect + code-surgeon', () => {
  let wsLocalPath = ''
  let workspaceId = ''
  let repoDir = ''
  let testFile = ''
  let featureId = ''

  beforeEach(async () => {
    // The workspace localPath must be under $HOME/sdd-workspaces/ so the
    // production assertWithinWorkspaceBase check passes.
    wsLocalPath = path.join(TEST_HOME, 'sdd-workspaces', `ws-${randomUUID().slice(0, 8)}`)
    fs.mkdirSync(wsLocalPath, { recursive: true })
    const fx = setupFixtureRepo(wsLocalPath)
    repoDir = fx.repoDir
    testFile = fx.testFile
    const ws = await buildIsolatedWorkspace(wsLocalPath)
    workspaceId = ws.workspaceId
    featureId = randomUUID()
    await db.insert(features).values({
      id: featureId,
      workspaceId,
      name: 'fix add bug',
      description: '',
      currentStage: 'analyze',
      currentWorkflowId: null,
      currentNodeId: 'analyze',
      status: 'active',
      intent: 'bug_fix',
      lockedFiles: null,
      looksLike: null,
      createdAt: new Date(),
    })
  })

  afterEach(async () => {
    if (workspaceId) await teardownWorkspace(workspaceId)
    if (wsLocalPath) {
      try { fs.rmSync(wsLocalPath, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    workspaceId = ''
    featureId = ''
  })

  it('creates a per-feature worktree exactly once and reuses it on retry', async () => {
    const first = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })
    expect(first.created).toBe(true)
    expect(fs.existsSync(first.path)).toBe(true)
    expect(first.path).toBe(getFeatureWorktreePath(wsLocalPath, featureId))

    // Drop a marker in the worktree; the second call must preserve it.
    const marker = path.join(first.path, 'sentinel.txt')
    fs.writeFileSync(marker, 'still-here')

    const second = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)
    expect(fs.readFileSync(marker, 'utf-8')).toBe('still-here')

    // Branch is bugfix/<featId>, branched from main
    const wtRepo = first.path
    const branch = git(wtRepo, 'rev-parse', '--abbrev-ref', 'HEAD')
    expect(branch).toBe(`bugfix/${featureId}`)
  })

  it('test-architect writes reproduction_test as a real file in the worktree source tree', async () => {
    const { path: worktreePath } = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })

    // The worktree mirrors the main repo's src/ tree; test-architect writes
    // the reproduction test INSIDE that tree (per ADR §4.2). We use .mjs so
    // the test runs under plain Node without a TypeScript build step.
    const wtTestFile = path.join(worktreePath, 'src', 'reproduction_test.mjs')
    expect(fs.existsSync(path.dirname(wtTestFile))).toBe(true)

    fs.writeFileSync(
      wtTestFile,
      [
        "import { add } from './calc.js'",
        "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2,3)); process.exit(1) }",
        "console.log('PASS')",
        '',
      ].join('\n'),
    )

    expect(fs.existsSync(wtTestFile)).toBe(true)
  })

  it('reproduction test runs in the worktree and FAILS on the clean (buggy) tree', async () => {
    const { path: worktreePath } = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })

    // Reproduction test as a real source file in the worktree (per ADR §4.2)
    const wtTestFile = path.join(worktreePath, 'src', 'reproduction_test.mjs')
    fs.writeFileSync(
      wtTestFile,
      [
        "import { add } from './calc.js'",
        "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2,3)); process.exit(1) }",
        "console.log('PASS')",
        '',
      ].join('\n'),
    )

    let exitCode = 0
    let stdout = ''
    try {
      stdout = execFileSync('node', ['src/reproduction_test.mjs'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: any) {
      exitCode = e.status ?? 1
      stdout = (e.stdout ?? '') + (e.stderr ?? '')
    }
    // Test should FAIL on the clean (buggy) tree — that's the red phase
    expect(exitCode).not.toBe(0)
    expect(stdout).toMatch(/FAIL/)
  })

  it('code-surgeon applies a minimal source change that turns the test green, and produces a source-only fix.patch', async () => {
    const { path: worktreePath } = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })

    // test-architect wrote the reproduction test (red)
    const wtTestFile = path.join(worktreePath, 'src', 'reproduction_test.mjs')
    fs.writeFileSync(
      wtTestFile,
      [
        "import { add } from './calc.js'",
        "if (add(2, 3) !== 5) { console.error('FAIL'); process.exit(1) }",
        "console.log('PASS')",
        '',
      ].join('\n'),
    )

    // code-surgeon fixes calc.js in the worktree (green) — minimal change
    const wtSrcFile = path.join(worktreePath, 'src', 'calc.js')
    fs.writeFileSync(wtSrcFile, 'export function add(a, b) { return a + b }\n')

    // Run the test in the worktree — must PASS after the fix (green phase)
    const out = execFileSync('node', ['src/reproduction_test.mjs'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    })
    expect(out).toContain('PASS')

    // Commit only the source change (NOT the test) so we can produce a clean patch
    git(worktreePath, 'add', 'src/calc.js')
    git(worktreePath, 'commit', '-m', 'fix: add returns a + b')

    // fix.patch = the commit's diff
    const patch = gitStatus(worktreePath, 'format-patch', '-1', '--stdout', 'HEAD')
    expect(patch).toMatch(/diff --git a\/src\/calc\.js b\/src\/calc\.js/)
    // The patch must NOT touch any test file
    expect(patch).not.toMatch(/reproduction_test/)
    expect(patch).toMatch(/return a \+ b/)
  })

  it('full happy-path: worktree → test-architect red → code-surgeon green → fix.patch on disk', async () => {
    const { path: worktreePath } = await ensureFeatureWorktree({
      featureId,
      localPath: wsLocalPath,
      defaultBranch: 'main',
    })

    // 1) test-architect: write reproduction test as a real file in the worktree
    const reproPath = path.join(worktreePath, 'src', 'reproduction_test.mjs')
    fs.writeFileSync(
      reproPath,
      [
        "import { add } from './calc.js'",
        "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2,3)); process.exit(1) }",
        "console.log('PASS')",
        '',
      ].join('\n'),
    )

    // 2) test-architect: confirm the test FAILS on the clean (buggy) tree
    let redExit = 0
    let redOut = ''
    try {
      redOut = execFileSync('node', ['src/reproduction_test.mjs'], {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: any) {
      redExit = e.status ?? 1
      redOut = (e.stdout ?? '') + (e.stderr ?? '')
    }
    expect(redExit).not.toBe(0)
    expect(redOut).toMatch(/FAIL/)

    // 3) test-architect writes test_metadata.json
    const metaPath = path.join(worktreePath, 'src', 'test_metadata.json')
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        framework: 'vitest',
        test_command: 'npx vitest run src/reproduction_test.mjs',
        assertion_summary: 'add(2, 3) should equal 5',
        expected_failure_reason: 'add() returns a - b instead of a + b',
        deterministic: true,
      }, null, 2),
    )
    expect(fs.existsSync(metaPath)).toBe(true)

    // 4) code-surgeon: minimal source fix
    fs.writeFileSync(
      path.join(worktreePath, 'src', 'calc.js'),
      'export function add(a, b) { return a + b }\n',
    )

    // 5) Verify the test now PASSES (green phase)
    const greenOut = execFileSync('node', ['src/reproduction_test.mjs'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    })
    expect(greenOut).toContain('PASS')

    // 6) code-surgeon: commit fix and produce fix.patch
    git(worktreePath, 'add', 'src/calc.js')
    git(worktreePath, 'commit', '-m', 'fix: add returns a + b')
    const patch = gitStatus(worktreePath, 'format-patch', '-1', '--stdout', 'HEAD')
    expect(patch).toMatch(/a \+ b/)

    // 7) code-surgeon writes fix_summary.md
    const summaryPath = path.join(worktreePath, 'src', 'fix_summary.md')
    fs.writeFileSync(
      summaryPath,
      [
        '# 修复说明',
        '## 改动的文件',
        '- src/calc.js: 修正加法运算符',
        '## 为什么不改其他地方',
        '- 单点修复，最小范围',
        '',
      ].join('\n'),
    )
    expect(fs.existsSync(summaryPath)).toBe(true)

    // fix.patch and reproduction_test are in the worktree, ready for review
    expect(fs.existsSync(reproPath)).toBe(true)
    expect(patch).toMatch(/diff --git a\/src\/calc\.js/)
  })
})
