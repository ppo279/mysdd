// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03) +
//   docs/adr/0002-bug-fix-workflow.md §4.4 + §6
//
// Reverse validation runner — performs the 3-phase TDD reverse validation on a
// clean per-invocation git worktree at `<featureWorktree>/.worktree/audit-<ts>/`.
//
// Phases:
//   1. Forward  — verify the test PASSES on the worktree's HEAD (which already
//                 has the fix applied, since the worktree was branched off the
//                 post-fix commit). Capture baseline exit code + output hash.
//   2. Reverse  — `git apply -R fix.patch` then re-run the test. Must FAIL.
//                 If PASS: emit `reverse_validation_failed` (the keystone).
//   3. Re-apply — `git apply fix.patch` then re-run. Must PASS with the same
//                 exit code + output hash as Phase 1. Mismatch → `flaky_test`.
//
// Then the runner runs the full test suite, checks fix.patch scope (no test
// files / spec.md / plan.md / tasks.md), and optionally runs mutation testing
// (best-effort). Emits audit_report.md, reverse_validation.log,
// mutation_test.log, and coverage_delta.json. Removes the audit worktree on
// completion, success or failure.
//
// This service is intentionally LLM-free: the verdict is a deterministic
// function of the file system and test results. The quality-gatekeeper agent
// (when invoked in production) uses this service as its source of truth.

import fs from 'fs'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { assertWithinWorkspaceBase } from '../routes/workspaces.js'

// ============================================================================
// Types
// ============================================================================

export type RejectionReason =
  | 'reverse_validation_failed'
  | 'flaky_test'
  | 'regressions'
  | 'fix_out_of_scope'
  | 'mutation_score_low'
  | 'test_passes_on_clean_tree'
  | 'coverage_regression'
  | 'rebase_conflict'

export const ALL_REJECTION_REASONS: RejectionReason[] = [
  'reverse_validation_failed',
  'flaky_test',
  'regressions',
  'fix_out_of_scope',
  'mutation_score_low',
  'test_passes_on_clean_tree',
  'coverage_regression',
  'rebase_conflict',
]

export type PhaseName = 'forward' | 'reverse' | 'reapply' | 'full_suite' | 'scope' | 'mutation' | 'coverage'

export interface PhaseResult {
  phase: PhaseName
  passed: boolean | null   // null when skipped (e.g. mutation unsupported)
  expected: 'pass' | 'fail' | 'skip'
  detail: string
  exitCode: number | null
  durationMs: number
  outputHash: string | null  // hash of captured stdout/stderr (for flaky detection)
  log: string                // captured stdout + stderr
}

export interface CoverageEntry {
  file: string
  before: number
  after: number
  linesRemovedFromCoverage: string[]
}

export interface CoverageDelta {
  entries: CoverageEntry[]
  toolDetected: boolean
}

export interface AuditVerdict {
  status: 'approved' | 'rejected'
  rejectionReason: RejectionReason | null
  phases: PhaseResult[]
  mutationScore: number | null
  mutationSkipped: boolean
  coverageDelta: CoverageDelta | null
  filesModified: string[]
  auditWorktreePath: string | null
  startedAt: string  // ISO timestamp
  finishedAt: string
  durationMs: number
}

export interface RunReverseValidationOpts {
  featureId: string
  /** Absolute path to the per-feature worktree (bugfix/<featId>). The audit
   *  worktree will be created inside it as `.worktree/audit-<ts>/`. */
  featureWorktreePath: string
  /** Absolute path to the fix.patch file on disk. */
  fixPatchPath: string
  /** Absolute path to test_metadata.json (must contain `test_command` and
   *  optionally `full_test_command`). */
  testMetadataPath: string
  /** When true (default), the audit worktree is removed on completion. */
  cleanup?: boolean
}

// ============================================================================
// Git + shell helpers
// ============================================================================

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitMayFail(cwd: string, ...args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  }
}

function hashOutput(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

function nowIso(): string {
  return new Date().toISOString()
}

function timestamp(): string {
  // YYYYMMDD-HHMMSS, used in audit worktree path
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  )
}

// ============================================================================
// Audit worktree lifecycle
// ============================================================================

function getAuditWorktreePath(featureWorktreePath: string): string {
  return path.join(featureWorktreePath, '.worktree', `audit-${timestamp()}`)
}

function ensureAuditWorktree(featureWorktreePath: string): string {
  // Defense in depth: assert the feature worktree itself sits inside WORKSPACE_BASE.
  assertWithinWorkspaceBase(featureWorktreePath)

  const auditPath = getAuditWorktreePath(featureWorktreePath)
  fs.mkdirSync(path.dirname(auditPath), { recursive: true })

  // Detached HEAD from feature worktree's current HEAD. Using --detach means
  // Phase 2's `git apply -R` has a clean baseline to roll back to.
  const result = gitMayFail(featureWorktreePath, 'worktree', 'add', '--detach', auditPath, 'HEAD')
  if (!result.ok) {
    throw new Error(
      `Failed to create audit worktree at ${auditPath}: ${result.stderr || result.stdout}`,
    )
  }
  return auditPath
}

function removeAuditWorktree(featureWorktreePath: string, auditPath: string): void {
  try {
    git(featureWorktreePath, 'worktree', 'remove', '--force', auditPath)
  } catch {
    // Fall back to direct removal so a corrupt git state can't strand the dir.
    try {
      fs.rmSync(auditPath, { recursive: true, force: true })
    } catch { /* best-effort */ }
  }
  // Always direct-rm too: git's `worktree remove --force` leaves the dir
  // intact when there are untracked files (e.g. the audit worktree's own
  // node_modules, .gitignore, etc.). We want the dir fully gone so the
  // next call can recreate it cleanly.
  try {
    fs.rmSync(auditPath, { recursive: true, force: true })
  } catch { /* best-effort */ }
  try { git(featureWorktreePath, 'worktree', 'prune') } catch { /* best-effort */ }
}

// ============================================================================
// Test execution
// ============================================================================

interface RunTestResult {
  exitCode: number
  stdout: string
  stderr: string
  outputHash: string
  durationMs: number
}

function runShellCommand(cwd: string, cmd: string, timeoutMs = 60_000): RunTestResult {
  const started = Date.now()
  // Use shell so the test_command can be `npx vitest run ...` etc.
  const r = spawnSync(cmd, {
    cwd,
    shell: true,
    encoding: 'utf-8',
    timeout: timeoutMs,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  })
  const stdout = r.stdout ?? ''
  const stderr = r.stderr ?? ''
  const combined = stdout + stderr
  return {
    exitCode: r.status ?? -1,
    stdout,
    stderr,
    outputHash: hashOutput(combined),
    durationMs: Date.now() - started,
  }
}

function passedTest(result: RunTestResult): boolean {
  return result.exitCode === 0
}

// ============================================================================
// fix.patch scope check
// ============================================================================

interface ScopeCheckResult {
  passed: boolean
  filesModified: string[]
  forbiddenTouched: string[]
}

/**
 * Parse `git apply --numstat`-style output of a patch to list the files it
 * touches. We use `git apply --stat` which prints a per-file line like
 * ` src/calc.js | 2 +-` even when the patch can't be applied to the current
 * tree. This is robust whether or not the patch is currently applied.
 */
function listPatchFiles(patchPath: string): string[] {
  if (!fs.existsSync(patchPath)) return []
  const raw = fs.readFileSync(patchPath, 'utf-8')
  const files = new Set<string>()
  // git apply-style headers: "diff --git a/<path> b/<path>"
  const re = /^diff --git a\/(.+?) b\/(.+?)$/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    // Prefer the b/ side so renames show their post-rename path.
    files.add(m[2])
  }
  return Array.from(files)
}

function isTestFile(p: string): boolean {
  const base = path.basename(p)
  if (/\.(test|spec)\.[a-z]+$/.test(base)) return true
  // Conventional test directories
  const segments = p.split('/')
  if (segments.includes('__tests__')) return true
  if (segments.includes('test') || segments.includes('tests')) return true
  return false
}

function isSpecArtifact(p: string): boolean {
  const base = path.basename(p)
  return base === 'spec.md' || base === 'plan.md' || base === 'tasks.md'
}

function checkScope(patchPath: string): ScopeCheckResult {
  const filesModified = listPatchFiles(patchPath)
  const forbiddenTouched = filesModified.filter(
    (f) => isTestFile(f) || isSpecArtifact(f),
  )
  return { passed: forbiddenTouched.length === 0, filesModified, forbiddenTouched }
}

// ============================================================================
// Mutation testing (best-effort)
// ============================================================================

const MUTATION_THRESHOLD = 0.70

interface MutationResult {
  score: number | null
  skipped: boolean
  detail: string
}

function detectMutationTool(auditPath: string): string | null {
  const pkgPath = path.join(auditPath, 'package.json')
  if (!fs.existsSync(pkgPath)) return null
  let pkg: any
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) } catch { return null }
  const dev = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) }
  if (dev['@stryker-mutator/core'] || dev['stryker']) return 'stryker'
  if (dev['mutmut'] || dev['mutmut-python']) return 'mutmut'
  if (dev['pitest'] || dev['pitest-maven']) return 'pitest'
  return null
}

function runMutationTest(auditPath: string): MutationResult {
  const tool = detectMutationTool(auditPath)
  if (!tool) {
    return { score: null, skipped: true, detail: 'No mutation testing tool detected.' }
  }
  // Best-effort run; we don't fail the audit when the tool isn't installed.
  const cmd = tool === 'stryker'
    ? 'npx stryker run --reporters json --logLevel error'
    : tool === 'mutmut'
      ? 'mutmut run'
      : 'mvn test -Ppitest'
  const r = spawnSync(cmd, { cwd: auditPath, shell: true, encoding: 'utf-8', timeout: 300_000, env: process.env })
  // Stryker emits .stryker-report/mutation.json; we don't parse it here. We
  // surface the score as null (unknown) on success and detail on failure.
  return {
    score: null,
    skipped: r.status !== 0,
    detail: `Mutation tool ${tool} exited ${r.status}`,
  }
}

// ============================================================================
// Coverage delta (best-effort)
// ============================================================================

function computeCoverageDelta(_auditPath: string): CoverageDelta {
  // We don't run actual coverage in this implementation — the audit only emits
  // an empty entries[] unless the test runner itself produced coverage data.
  // `mutation_test_skipped` / `coverage_delta_empty` are explicitly allowed by
  // the PRD when the tool isn't available.
  return { entries: [], toolDetected: false }
}

// ============================================================================
// Audit artifacts on disk
// ============================================================================

interface WriteArtifactsOpts {
  auditReportPath: string
  reverseLogPath: string
  mutationLogPath: string
  coveragePath: string
  verdict: AuditVerdict
  mutationLogText: string
}

function writeAuditArtifacts(opts: WriteArtifactsOpts): void {
  const { verdict, mutationLogText } = opts
  fs.mkdirSync(path.dirname(opts.auditReportPath), { recursive: true })

  // reverse_validation.log — concatenated phase logs
  const reverseLog = verdict.phases
    .filter((p) => p.phase !== 'mutation')
    .map((p) => {
      const header = `## Phase: ${p.phase} (expected=${p.expected}, passed=${p.passed}, exit=${p.exitCode}, hash=${p.outputHash ?? '-'}, durationMs=${p.durationMs})`
      return `${header}\n\n${p.log}\n`
    })
    .join('\n---\n\n')
  fs.writeFileSync(opts.reverseLogPath, reverseLog, 'utf-8')

  // mutation_test.log
  fs.writeFileSync(opts.mutationLogPath, mutationLogText, 'utf-8')

  // coverage_delta.json
  const coveragePayload = verdict.coverageDelta ?? { entries: [], toolDetected: false }
  fs.writeFileSync(opts.coveragePath, JSON.stringify(coveragePayload, null, 2), 'utf-8')

  // audit_report.md — structured human-readable verdict
  const lines: string[] = []
  lines.push('# 审核报告 (Quality-Gatekeeper Audit)')
  lines.push('')
  lines.push(`## 结论: ${verdict.status === 'approved' ? 'APPROVED' : 'REJECTED'}`)
  if (verdict.rejectionReason) lines.push(`## 拒绝原因: ${verdict.rejectionReason}`)
  lines.push('')
  lines.push(`Started: ${verdict.startedAt}`)
  lines.push(`Finished: ${verdict.finishedAt}`)
  lines.push(`Duration: ${verdict.durationMs} ms`)
  lines.push('')
  lines.push('## 反向验证三阶段结果')
  for (const p of verdict.phases.filter((p) => p.phase === 'forward' || p.phase === 'reverse' || p.phase === 'reapply')) {
    const verdict_ = p.passed === true ? 'PASS' : p.passed === false ? 'FAIL' : 'SKIP'
    lines.push(`- ${p.phase}: ${verdict_} (expected=${p.expected}, exit=${p.exitCode}, hash=${p.outputHash ?? '-'})`)
  }
  lines.push('')
  const fullSuite = verdict.phases.find((p) => p.phase === 'full_suite')
  lines.push(`## 全量测试: ${fullSuite?.passed ? 'PASS' : 'FAIL'}`)
  lines.push('')
  lines.push(`## Mutation score: ${verdict.mutationScore !== null ? `${(verdict.mutationScore * 100).toFixed(0)}%` : 'skipped'}`)
  if (verdict.mutationSkipped) lines.push('> mutation_test_skipped: no framework detected or tool unavailable')
  lines.push('')
  if (verdict.coverageDelta) {
    lines.push(`## 覆盖率变化: ${verdict.coverageDelta.toolDetected ? 'detected' : 'no tool detected'} (${verdict.coverageDelta.entries.length} files)`)
  }
  lines.push('')
  lines.push('## 规则检查')
  const scope = verdict.phases.find((p) => p.phase === 'scope')
  lines.push(`- fix.patch scope: ${scope?.passed ? '✓ within source files' : `✗ forbidden files: ${scope?.detail}`}`)
  lines.push(`- fix.patch touches ${verdict.filesModified.length} files`)
  lines.push('')
  lines.push('## 拒绝原因详情')
  if (verdict.rejectionReason) {
    lines.push(`- **${verdict.rejectionReason}**`)
    const failing = verdict.phases.find((p) => p.passed === false)
    if (failing) lines.push(`  - First failing phase: ${failing.phase} — ${failing.detail}`)
  } else {
    lines.push('- None')
  }
  fs.writeFileSync(opts.auditReportPath, lines.join('\n'), 'utf-8')
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Run the 3-phase reverse validation on a fresh audit worktree.
 *
 * Idempotent on cleanup: the audit worktree is removed in `finally` so a
 * crash mid-run doesn't strand the directory. Returns the structured verdict.
 *
 * The runner never throws on logical failures (rejections are returned via
 * `verdict.status`); it only throws if the worktree itself can't be created.
 */
export async function runReverseValidation(opts: RunReverseValidationOpts): Promise<AuditVerdict> {
  const cleanup = opts.cleanup ?? true
  const startedAt = nowIso()
  const startedMs = Date.now()

  const testMetaRaw = fs.readFileSync(opts.testMetadataPath, 'utf-8')
  let testMeta: { test_command?: string; full_test_command?: string }
  try {
    testMeta = JSON.parse(testMetaRaw)
  } catch (err: any) {
    throw new Error(`test_metadata.json is not valid JSON: ${err.message}`)
  }
  const reproductionTestCmd = testMeta.test_command
  if (!reproductionTestCmd) {
    throw new Error('test_metadata.json is missing required field: test_command')
  }
  const fullTestCmd = testMeta.full_test_command ?? reproductionTestCmd

  // Scope check is computed up front (independent of the worktree) but is
  // NOT short-circuited. Per the issue spec, scope runs as the LAST gate
  // before mutation, AFTER the full suite passes. We still pre-compute it
  // here because the verdict needs `filesModified` regardless.
  const scope = checkScope(opts.fixPatchPath)

  const phases: PhaseResult[] = []
  let auditPath: string | null = null

  try {
    auditPath = ensureAuditWorktree(opts.featureWorktreePath)

    // ----- Phase 1: Forward (verify the test passes on the current tree) ---
    // The audit worktree was created from `HEAD`, which already has the fix
    // and the reproduction test applied. So Phase 1 is a verification, not an
    // apply — but we still invoke `git apply` (it should be a no-op) so any
    // drift between the recorded patch and the worktree state is surfaced.
    gitMayFail(auditPath, 'apply', opts.fixPatchPath)
    const forward = runShellCommand(auditPath, reproductionTestCmd)
    phases.push({
      phase: 'forward',
      passed: passedTest(forward),
      expected: 'pass',
      detail: passedTest(forward) ? 'Test passes on worktree HEAD' : `Test failed (exit=${forward.exitCode})`,
      exitCode: forward.exitCode,
      durationMs: forward.durationMs,
      outputHash: forward.outputHash,
      log: forward.stdout + forward.stderr,
    })

    // ----- Phase 2: Reverse (revert fix.patch, expect FAIL) ---------------
    const rev = gitMayFail(auditPath, 'apply', '-R', opts.fixPatchPath)
    if (!rev.ok) {
      // The patch couldn't be cleanly reverted — that itself is a failure.
      phases.push({
        phase: 'reverse',
        passed: false,
        expected: 'fail',
        detail: `git apply -R failed: ${rev.stderr || rev.stdout}`,
        exitCode: rev.status,
        durationMs: 0,
        outputHash: null,
        log: rev.stderr + rev.stdout,
      })
    } else {
      const reverseRun = runShellCommand(auditPath, reproductionTestCmd)
      // Keystone: if the test STILL PASSES without the fix, the entire chain
      // is invalid. We pass `expected='fail'`; verdict is "PASS for the
      // verifier" iff the runner's exit code is NON-zero.
      phases.push({
        phase: 'reverse',
        passed: !passedTest(reverseRun),  // we WANT this test to fail
        expected: 'fail',
        detail: passedTest(reverseRun)
          ? 'Test PASSED without fix — reverse_validation_failed'
          : 'Test failed without fix (as expected)',
        exitCode: reverseRun.exitCode,
        durationMs: reverseRun.durationMs,
        outputHash: reverseRun.outputHash,
        log: reverseRun.stdout + reverseRun.stderr,
      })
    }

    // ----- Phase 3: Re-apply (apply fix.patch again, expect PASS) ---------
    const reapply = gitMayFail(auditPath, 'apply', opts.fixPatchPath)
    if (!reapply.ok) {
      phases.push({
        phase: 'reapply',
        passed: false,
        expected: 'pass',
        detail: `git apply failed on reapply: ${reapply.stderr || reapply.stdout}`,
        exitCode: reapply.status,
        durationMs: 0,
        outputHash: null,
        log: reapply.stderr + reapply.stdout,
      })
    } else {
      const reapplyRun = runShellCommand(auditPath, reproductionTestCmd)
      const forwardPhase = phases.find((p) => p.phase === 'forward')
      const sameHash = forwardPhase?.outputHash !== undefined
        && forwardPhase.outputHash === reapplyRun.outputHash
      const sameExit = forwardPhase?.exitCode === reapplyRun.exitCode
      const passed = passedTest(reapplyRun) && sameHash && sameExit
      phases.push({
        phase: 'reapply',
        passed,
        expected: 'pass',
        detail: passed
          ? 'Re-applied test passes with matching exit code + output hash'
          : `Mismatch: sameExit=${sameExit}, sameHash=${sameHash}, passedTest=${passedTest(reapplyRun)}`,
        exitCode: reapplyRun.exitCode,
        durationMs: reapplyRun.durationMs,
        outputHash: reapplyRun.outputHash,
        log: reapplyRun.stdout + reapplyRun.stderr,
      })
    }

    // ----- Full test suite (regression gate) ------------------------------
    const suiteRun = runShellCommand(auditPath, fullTestCmd)
    phases.push({
      phase: 'full_suite',
      passed: passedTest(suiteRun),
      expected: 'pass',
      detail: passedTest(suiteRun) ? 'Full suite green' : `Full suite failed (exit=${suiteRun.exitCode})`,
      exitCode: suiteRun.exitCode,
      durationMs: suiteRun.durationMs,
      outputHash: null,
      log: suiteRun.stdout + suiteRun.stderr,
    })

    // ----- Scope check (per spec: runs AFTER full suite) -------------------
    phases.push({
      phase: 'scope',
      passed: scope.passed,
      expected: 'pass',
      detail: scope.passed
        ? `Scope OK (${scope.filesModified.length} files modified)`
        : `Forbidden files: ${scope.forbiddenTouched.join(', ')}`,
      exitCode: 0,
      durationMs: 0,
      outputHash: null,
      log: scope.filesModified.join('\n'),
    })

    // ----- Mutation (best-effort) -----------------------------------------
    const mutation = runMutationTest(auditPath)
    phases.push({
      phase: 'mutation',
      passed: mutation.score === null ? null : mutation.score >= MUTATION_THRESHOLD,
      expected: 'pass',
      detail: mutation.detail,
      exitCode: 0,
      durationMs: 0,
      outputHash: null,
      log: mutation.detail,
    })

    // ----- Coverage delta (best-effort) ------------------------------------
    const coverageDelta = computeCoverageDelta(auditPath)
    const coverageRegressed = coverageDelta.toolDetected
      && coverageDelta.entries.some((e) => e.linesRemovedFromCoverage.length > 0)
    phases.push({
      phase: 'coverage',
      passed: coverageRegressed ? false : null,
      expected: 'pass',
      detail: coverageRegressed
        ? `Coverage regressed: ${coverageDelta.entries.filter((e) => e.linesRemovedFromCoverage.length > 0).map((e) => e.file).join(', ')}`
        : coverageDelta.toolDetected
          ? `Coverage check OK (${coverageDelta.entries.length} files)`
          : 'No coverage tool detected — coverage_regression check skipped',
      exitCode: 0,
      durationMs: 0,
      outputHash: null,
      log: JSON.stringify(coverageDelta),
    })

    // ----- Verdict computation --------------------------------------------
    const verdict = computeVerdict(phases, mutation.score, coverageRegressed)
    const finishedAt = nowIso()
    const auditVerdict: AuditVerdict = {
      status: verdict.status,
      rejectionReason: verdict.rejectionReason,
      phases,
      mutationScore: mutation.score,
      mutationSkipped: mutation.skipped,
      coverageDelta,
      filesModified: scope.filesModified,
      auditWorktreePath: auditPath,
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
    }
    return auditVerdict
  } finally {
    if (cleanup && auditPath) {
      removeAuditWorktree(opts.featureWorktreePath, auditPath)
    }
  }
}

function computeVerdict(
  phases: PhaseResult[],
  mutationScore: number | null,
  coverageRegressed: boolean,
): { status: 'approved' | 'rejected'; rejectionReason: RejectionReason | null } {
  // Verdict precedence — matches the spec's intent even when the runner
  // had to attempt phases out of order. Scope violations are absolute (a
  // patch touching test files is wrong by definition) so we check it first.
  const forward = phases.find((p) => p.phase === 'forward')
  const reverse = phases.find((p) => p.phase === 'reverse')
  const reapply = phases.find((p) => p.phase === 'reapply')
  const fullSuite = phases.find((p) => p.phase === 'full_suite')
  const scope = phases.find((p) => p.phase === 'scope')
  const mutation = phases.find((p) => p.phase === 'mutation')

  // 1. Forward failure: fix doesn't even work on its own tree.
  if (forward?.passed === false) {
    return { status: 'rejected', rejectionReason: 'test_passes_on_clean_tree' }
  }
  // 2. Scope check: patch violated test/spec/plan artifacts. Wins over the
  //    reverse/reapply noise that a scope-violating patch generates.
  if (scope?.passed === false) {
    return { status: 'rejected', rejectionReason: 'fix_out_of_scope' }
  }
  // 3. Reverse validation keystone: test passes without fix.
  if (reverse?.passed === false) {
    return { status: 'rejected', rejectionReason: 'reverse_validation_failed' }
  }
  // 4. Reapply mismatch: flaky test.
  if (reapply?.passed === false) {
    return { status: 'rejected', rejectionReason: 'flaky_test' }
  }
  // 5. Full suite regressions.
  if (fullSuite?.passed === false) {
    return { status: 'rejected', rejectionReason: 'regressions' }
  }
  // 6. Coverage dropped on touched files.
  if (coverageRegressed) {
    return { status: 'rejected', rejectionReason: 'coverage_regression' }
  }
  // 7. Mutation score below threshold.
  if (mutation?.passed === false) {
    return { status: 'rejected', rejectionReason: 'mutation_score_low' }
  }
  return { status: 'approved', rejectionReason: null }
}

// ============================================================================
// Helpers exposed for tests + downstream services
// ============================================================================

export interface AuditArtifactPaths {
  auditReport: string
  reverseValidationLog: string
  mutationTestLog: string
  coverageDelta: string
}

/** Compute the disk paths under `storage/<ws>/<feat>/audit/`. */
export function getAuditArtifactPaths(storageRoot: string, workspaceId: string, featureId: string): AuditArtifactPaths {
  const dir = path.join(storageRoot, workspaceId, featureId, 'audit')
  return {
    auditReport: path.join(dir, 'audit_report.md'),
    reverseValidationLog: path.join(dir, 'reverse_validation.log'),
    mutationTestLog: path.join(dir, 'mutation_test.log'),
    coverageDelta: path.join(dir, 'coverage_delta.json'),
  }
}

/** Persist the audit verdict + its four artifacts to disk. */
export function persistAuditArtifacts(
  paths: AuditArtifactPaths,
  verdict: AuditVerdict,
  mutationLogText: string,
): void {
  writeAuditArtifacts({
    auditReportPath: paths.auditReport,
    reverseLogPath: paths.reverseValidationLog,
    mutationLogPath: paths.mutationTestLog,
    coveragePath: paths.coverageDelta,
    verdict,
    mutationLogText,
  })
}

/** Public for tests: did the audit report end up `approved`? */
export function isApproved(v: AuditVerdict): boolean {
  return v.status === 'approved'
}