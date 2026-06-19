// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03)
//
// End-to-end reverse validation runner test: real git repo + 4 scenarios
//   1. good fix          → approved
//   2. weak test         → rejected (reverse_validation_failed)
//   3. flaky test        → rejected (flaky_test)
//   4. fix out of scope  → rejected (fix_out_of_scope)
//
// Seam: runReverseValidation() against a real git worktree created from a
// fixture repo. We don't touch the DB — the runner is a pure file/git/test
// function that returns a structured AuditVerdict.

// Pin HOME before loading modules that capture os.homedir() at module load.
// routes/workspaces.ts computes WORKSPACE_BASE = path.join(os.homedir(), 'sdd-workspaces')
// at module load; we need the test's fixture paths to live under that base.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-rv-home-'))
process.env.HOME = TEST_HOME

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'

// Dynamic import AFTER HOME is set so the workspaces module's WORKSPACE_BASE
// is computed from the new HOME value.
const rv = await import('../services/reverse-validation.js')
const { runReverseValidation, persistAuditArtifacts } = rv

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

interface Fixture {
  wsLocalPath: string
  repoDir: string
  srcFile: string
  testFile: string
}

/**
 * Set up a fixture repo with a known bug:
 *   export function add(a, b) { return a - b }   // BUG
 * Test asserts add(2, 3) === 5 (so a passing test exposes the bug).
 */
function setupFixture(wsDir: string): Fixture {
  const repoDir = path.join(wsDir, 'repo')
  const srcFile = path.join(repoDir, 'src', 'calc.js')
  const testFile = path.join(repoDir, 'src', 'reproduction_test.mjs')

  fs.mkdirSync(path.dirname(srcFile), { recursive: true })
  fs.writeFileSync(srcFile, 'export function add(a, b) { return a - b }\n')
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n')
  fs.writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n.worktree/\n')
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' }, null, 2),
  )

  git(repoDir, 'init', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'test@example.com')
  git(repoDir, 'config', 'user.name', 'Test')
  git(repoDir, 'config', 'commit.gpgsign', 'false')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'initial buggy commit')

  return { wsLocalPath: wsDir, repoDir, srcFile, testFile }
}

/**
 * Build a per-feature worktree and write the on-disk artifacts the runner
 * expects: fix.patch + test_metadata.json + the reproduction test.
 */
function buildFeatureWorktree(fx: Fixture, featureId: string, opts: {
  srcBody?: string        // override the post-fix src/calc.js content (default = 'export function add(a, b) { return a + b }\n')
  testBody?: string       // the reproduction test body
  commitFix?: boolean     // commit the fix on the worktree (default true)
  patchScope?: 'source-only' | 'includes-test' | 'includes-spec'
}): { featureWorktreePath: string; fixPatchPath: string; testMetadataPath: string } {
  const wtDir = path.join(fx.wsLocalPath, 'repo.worktrees', `feat-${featureId}`)
  const branch = `bugfix/${featureId}`
  git(fx.repoDir, 'worktree', 'add', '-b', branch, wtDir, 'main')

  // Always write the reproduction test (test-architect's contract)
  const wtTestFile = path.join(wtDir, 'src', 'reproduction_test.mjs')
  fs.mkdirSync(path.dirname(wtTestFile), { recursive: true })
  const testBody = opts.testBody ?? [
    "import { add } from './calc.js'",
    "if (add(2, 3) !== 5) { console.error('FAIL: add(2,3) =', add(2, 3)); process.exit(1) }",
    "console.log('PASS')",
    '',
  ].join('\n')
  fs.writeFileSync(wtTestFile, testBody)

  // Apply the fix unless this scenario is testing "fix doesn't work"
  const srcBody = opts.srcBody ?? 'export function add(a, b) { return a + b }\n'
  fs.writeFileSync(path.join(wtDir, 'src', 'calc.js'), srcBody)

  // Optionally write a spec.md (for scope test)
  if (opts.patchScope === 'includes-spec') {
    fs.writeFileSync(path.join(wtDir, 'spec.md'), '# spec\nmodified by fix\n')
  }

  if (opts.commitFix !== false) {
    // Add test (so the runner sees a real fix.patch that doesn't include the test)
    git(wtDir, 'add', 'src/reproduction_test.mjs')
    git(wtDir, 'commit', '-m', 'test: add reproduction test')
    git(wtDir, 'add', 'src/calc.js')
    if (opts.patchScope === 'includes-spec') git(wtDir, 'add', 'spec.md')
    git(wtDir, 'commit', '-m', 'fix: add returns a + b')
  }

  // Generate fix.patch: only the SOURCE change (HEAD = fix commit, HEAD~1 = test commit).
  const fixPatchPath = path.join(wtDir, 'fix.patch')
  const staged = opts.commitFix !== false
  if (staged) {
    // `git format-patch -1 HEAD` = patch for the most recent commit (the fix)
    const patch = execFileSync('git', ['format-patch', '-1', '--stdout', 'HEAD'], { cwd: wtDir, encoding: 'utf-8' })
    fs.writeFileSync(fixPatchPath, patch)
  } else {
    // For the "fix doesn't work" scenario we still produce a patch from a
    // scratch commit so the runner has something to apply.
    fs.writeFileSync(fixPatchPath, 'diff --git a/src/calc.js b/src/calc.js\nindex 0000..1111 100644\n--- a/src/calc.js\n+++ b/src/calc.js\n@@ -1 +1 @@\n-export function add(a, b) { return a - b }\n+export function add(a, b) { return a - b }\n')
  }

  // Write test_metadata.json
  const testMetadataPath = path.join(wtDir, 'test_metadata.json')
  fs.writeFileSync(
    testMetadataPath,
    JSON.stringify({
      framework: 'node',
      test_command: 'node src/reproduction_test.mjs',
      full_test_command: 'node src/reproduction_test.mjs',
      assertion_summary: 'add(2, 3) should equal 5',
      expected_failure_reason: 'add() returns a - b instead of a + b',
      deterministic: true,
    }, null, 2),
  )

  return { featureWorktreePath: wtDir, fixPatchPath, testMetadataPath }
}

function cleanup(fx: Fixture, featureIds: string[]) {
  for (const fid of featureIds) {
    const wtDir = path.join(fx.wsLocalPath, 'repo.worktrees', `feat-${fid}`)
    try { git(fx.repoDir, 'worktree', 'remove', '--force', wtDir) } catch { /* ignore */ }
    try { git(fx.repoDir, 'branch', '-D', `bugfix/${fid}`) } catch { /* ignore */ }
  }
  try { git(fx.repoDir, 'worktree', 'prune') } catch { /* ignore */ }
}

let tmpRoot = ''
let fx: Fixture
let featureIds: string[] = []

beforeEach(() => {
  // The workspace localPath must live under $HOME/sdd-workspaces/ so the
  // production assertWithinWorkspaceBase check (captured at module load time
  // from the TEST_HOME above) passes.
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-rv-'))
  const wsDir = path.join(TEST_HOME, 'sdd-workspaces', `ws-${Date.now()}`)
  fs.mkdirSync(wsDir, { recursive: true })
  fx = setupFixture(wsDir)
  featureIds = []
})

afterEach(() => {
  cleanup(fx, featureIds)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

function newFeatureId(): string {
  const id = `f${Math.random().toString(36).slice(2, 8)}`
  featureIds.push(id)
  return id
}

describe('reverse-validation runner: 4 scenarios', () => {
  it('scenario 1 (good fix): all phases pass → APPROVED', async () => {
    const fid = newFeatureId()
    const built = buildFeatureWorktree(fx, fid, {
      srcBody: 'export function add(a, b) { return a + b }\n',
      patchScope: 'source-only',
    })
    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })
    expect(verdict.status).toBe('approved')
    expect(verdict.rejectionReason).toBeNull()
    const forward = verdict.phases.find((p) => p.phase === 'forward')!
    const reverse = verdict.phases.find((p) => p.phase === 'reverse')!
    const reapply = verdict.phases.find((p) => p.phase === 'reapply')!
    const suite = verdict.phases.find((p) => p.phase === 'full_suite')!
    expect(forward.passed).toBe(true)
    expect(reverse.passed).toBe(true)   // expected=FAIL means "test failed" → passed=true for the verifier
    expect(reapply.passed).toBe(true)
    expect(suite.passed).toBe(true)
    // Audit worktree was cleaned up
    expect(fs.existsSync(built.featureWorktreePath)).toBe(true)
    // The .worktree/audit-* directory was removed
    const worktreeDir = path.join(built.featureWorktreePath, '.worktree')
    if (fs.existsSync(worktreeDir)) {
      const remaining = fs.readdirSync(worktreeDir).filter((n) => n.startsWith('audit-'))
      expect(remaining).toEqual([])
    }
  })

  it('scenario 2 (weak test): reverse-phase test PASSES → REJECTED with reverse_validation_failed', async () => {
    const fid = newFeatureId()
    // The "weak test" passes BOTH with and without the fix (asserts nothing
    // that depends on the bug). Phase 2's test still exits 0 → verifier fails.
    const weakTest = [
      "import { add } from './calc.js'",
      "const r = add(2, 3)",
      "console.log('result =', r)",
      "process.exit(0)",
      '',
    ].join('\n')
    const built = buildFeatureWorktree(fx, fid, {
      srcBody: 'export function add(a, b) { return a + b }\n',
      testBody: weakTest,
      patchScope: 'source-only',
    })
    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.rejectionReason).toBe('reverse_validation_failed')
    const reverse = verdict.phases.find((p) => p.phase === 'reverse')!
    expect(reverse.passed).toBe(false)
    expect(reverse.detail).toMatch(/reverse_validation_failed/)
  })

  it('scenario 3 (flaky test): reapply hash differs from forward → REJECTED with flaky_test', async () => {
    const fid = newFeatureId()
    // The "flaky test" prints the current time, so its output hash differs
    // between runs even though both exit 0.
    const flakyTest = [
      "import { add } from './calc.js'",
      "console.log('ran at', Date.now())",
      "if (add(2, 3) !== 5) process.exit(1)",
      "process.exit(0)",
      '',
    ].join('\n')
    const built = buildFeatureWorktree(fx, fid, {
      srcBody: 'export function add(a, b) { return a + b }\n',
      testBody: flakyTest,
      patchScope: 'source-only',
    })
    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.rejectionReason).toBe('flaky_test')
    const reapply = verdict.phases.find((p) => p.phase === 'reapply')!
    expect(reapply.passed).toBe(false)
    expect(reapply.detail).toMatch(/Mismatch/)
  })

  it('scenario 4 (fix out of scope): patch modifies test files → REJECTED with fix_out_of_scope', async () => {
    const fid = newFeatureId()
    // Build a worktree, then post-hoc rewrite fix.patch to include a test
    // file change so the scope check trips.
    const built = buildFeatureWorktree(fx, fid, {
      srcBody: 'export function add(a, b) { return a + b }\n',
      patchScope: 'source-only',
    })
    // Read the existing patch and prepend a fake "diff --git" for a test file.
    const orig = fs.readFileSync(built.fixPatchPath, 'utf-8')
    const tampered =
      'diff --git a/src/some_test.test.js b/src/some_test.test.js\nindex 0000..1111 100644\n' +
      '--- a/src/some_test.test.js\n+++ b/src/some_test.test.js\n@@ -1 +1 @@\n-old\n+new\n' +
      orig
    fs.writeFileSync(built.fixPatchPath, tampered)

    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.rejectionReason).toBe('fix_out_of_scope')
    const scope = verdict.phases.find((p) => p.phase === 'scope')!
    expect(scope.passed).toBe(false)
    expect(scope.detail).toMatch(/src\/some_test\.test\.js/)
  })
})

describe('reverse-validation runner: persistence side-outputs', () => {
  it('exposes getAuditArtifactPaths and persistAuditArtifacts for the storage tree', async () => {
    const fid = newFeatureId()
    const built = buildFeatureWorktree(fx, fid, {})
    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })

    // Use the persistence API directly — it writes to storage/<ws>/<feat>/audit/
    const storageRoot = path.join(TEST_HOME, 'storage')
    const paths = {
      auditReport: path.join(storageRoot, 'ws-test', fid, 'audit', 'audit_report.md'),
      reverseValidationLog: path.join(storageRoot, 'ws-test', fid, 'audit', 'reverse_validation.log'),
      mutationTestLog: path.join(storageRoot, 'ws-test', fid, 'audit', 'mutation_test.log'),
      coverageDelta: path.join(storageRoot, 'ws-test', fid, 'audit', 'coverage_delta.json'),
    }
    persistAuditArtifacts(paths, verdict, 'mutation_test_skipped\n')

    expect(fs.existsSync(paths.auditReport)).toBe(true)
    expect(fs.readFileSync(paths.auditReport, 'utf-8')).toContain(`## 结论: ${verdict.status === 'approved' ? 'APPROVED' : 'REJECTED'}`)
    expect(fs.existsSync(paths.coverageDelta)).toBe(true)
    const coverage = JSON.parse(fs.readFileSync(paths.coverageDelta, 'utf-8'))
    expect(coverage.toolDetected).toBe(false)
    expect(Array.isArray(coverage.entries)).toBe(true)
  })
})

describe('reverse-validation runner: forward failure short-circuits', () => {
  it('returns test_passes_on_clean_tree when Phase 1 itself fails', async () => {
    const fid = newFeatureId()
    // Test asserts a WRONG value so it fails on the post-fix tree too.
    const brokenTest = [
      "import { add } from './calc.js'",
      "if (add(2, 3) === 99) process.exit(0)",
      "process.exit(1)",
      '',
    ].join('\n')
    const built = buildFeatureWorktree(fx, fid, {
      srcBody: 'export function add(a, b) { return a + b }\n',
      testBody: brokenTest,
      patchScope: 'source-only',
    })
    const verdict = await runReverseValidation({
      featureId: fid,
      featureWorktreePath: built.featureWorktreePath,
      fixPatchPath: built.fixPatchPath,
      testMetadataPath: built.testMetadataPath,
    })
    expect(verdict.status).toBe('rejected')
    expect(verdict.rejectionReason).toBe('test_passes_on_clean_tree')
  })
})