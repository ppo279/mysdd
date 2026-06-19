// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 06) +
//   CONTEXT.md decision 23 (CC2).
//
// Post-merge rebase-validate:
//   When a feature in the same workspace transitions to 'merged', the engine
//   iterates over all in-flight bug_fix features with a non-null bugfix branch
//   and:
//     1. Sets the feature's status to 'rebasing' (visible to the UI).
//     2. Runs `git rebase <newBase>` inside the feature's worktree.
//        - On conflict: mark the feature 'circuit_broken' and emit a report.
//     3. Re-runs the full reverse validation (3 phases + suite + mutation) on
//        the rebased tree. This is the load-bearing reason reverse validation
//        exists: it must work not just once at approval time, but also after
//        the world has changed.
//     4. On all checks passing, push the rebased branch (or amend the local
//        commit if no remote) and return the feature to 'approved' state.
//     5. On any check failing, mark the feature 'circuit_broken'.
//
//   The sweep is idempotent: a second trigger while a previous sweep is in
//   progress returns the same in-flight promise (no double-run).
//
// Why a single in-process flag and not a DB row?
//   The sweep is per-server-instance. Cross-instance coordination would need
//   a leader election or row-level lock — out of scope for Issue 06. The
//   probability of a second merge arriving during a sweep is very low (the
//   sweep is seconds, not minutes), so a small race window is acceptable.

import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  features,
  stageRuns,
  stageRunOutputs,
  featureNodeStates,
  workspaces,
} from '../db/schema.js'
import { BizError, Code } from '../lib/envelope.js'
import { ArtifactService } from './artifact.js'
import { assertWithinWorkspaceBase } from '../routes/workspaces.js'
import {
  runReverseValidation,
  persistAuditArtifacts,
  isApproved,
  type AuditVerdict,
  type RejectionReason,
} from './reverse-validation.js'
import { clearFeatureLocks } from './queue.js'
import { ensureFeatureWorktree } from './worktree.js'

// ============================================================================
// Constants
// ============================================================================

const REBASE_VALIDATE_NODE_ID = 'rebase-validate'
const AUDIT_NODE_ID = 'audit'
const FIX_NODE_ID = 'fix'

// New enum value for features.status. Recorded in comments; the column is a
// free-form TEXT so no schema migration is required. The UI distinguishes it
// from the other statuses.
export const REBASING_STATUS = 'rebasing' as const

// ============================================================================
// Public types
// ============================================================================

export interface RebaseValidateOpts {
  targetFeatureId: string
  workspaceId: string
  /** The base to rebase onto. Typically `bugfix/<mergedFeatureId>` — the
   *  TF1 commit on the merged branch, which is functionally equivalent to
   *  "new main tip" once the user fast-forwards main. */
  newBase: string
}

export interface RebaseValidateResult {
  ok: boolean
  circuitBroken: boolean
  reason: string                  // 'approved' | 'rebase_conflict' | <rejection reason>
  /** The full audit verdict from the re-validation, when reached. */
  verdict: AuditVerdict | null
  /** True if the rebase step itself was clean. */
  rebaseClean: boolean
  /** Captured stderr/stdout from the rebase command (for reports). */
  rebaseLog: string
}

export interface SweepOpts {
  workspaceId: string
  mergedFeatureId: string
  newBase: string
}

export interface SweepResult {
  rebased: string[]              // featureIds that successfully rebased + revalidated
  circuitBroken: string[]         // featureIds that circuit-broke
  skipped: string[]               // featureIds that didn't need rebase
  errors: Array<{ featureId: string; reason: string }>
}

export interface RebaseTarget {
  id: string
  status: string
  currentNodeId: string
  intent: string
}

// ============================================================================
// Git helpers
// ============================================================================

function gitMayFail(cwd: string, ...args: string[]): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
  }
}

// ============================================================================
// Target selection
// ============================================================================

/**
 * Return the in-flight bug_fix siblings of the merged feature that are
 * candidates for rebase-validate.
 *
 * Inclusion criteria:
 *   - Same workspace
 *   - intent = 'bug_fix'
 *   - status is in (active, paused, approved, queued, rebasing) — i.e. NOT
 *     in a terminal status (merged / done / abandoned / circuit_broken /
 *     upgraded)
 *   - NOT the merged feature itself
 *   - Has a non-null `bugfix/<featId>` branch (per Issue 06 AC: "sweep
 *     iterates over all in-flight bug-fix features ... whose
 *     `bugfix/<featId>` branch is non-null"). Features that have not yet
 *     progressed past intake don't have a branch and are skipped — the
 *     rebase-validate is meaningless for them.
 *
 * Excludes decoys (already terminal), the merge source, and features that
 * have not yet created their per-feature worktree branch.
 */
export async function findRebaseTargets(opts: SweepOpts): Promise<RebaseTarget[]> {
  const IN_FLIGHT = new Set(['active', 'paused', 'approved', 'queued', 'rebasing'])
  const rows = await db
    .select({
      id: features.id,
      status: features.status,
      currentNodeId: features.currentNodeId,
      intent: features.intent,
    })
    .from(features)
    .where(and(eq(features.workspaceId, opts.workspaceId), eq(features.intent, 'bug_fix')))
  const candidates = rows.filter((r) => r.id !== opts.mergedFeatureId && IN_FLIGHT.has(r.status))
  // Filter to features whose bugfix/<featId> branch exists in the repo.
  // We probe the workspace's local repo for each candidate; if the
  // workspace has no localPath yet (shouldn't happen post-issue-01, but
  // defensive), we conservatively keep the candidate so the runner can
  // surface a clearer error in runRebaseValidate.
  const targets: RebaseTarget[] = []
  for (const r of candidates) {
    if (await hasBugfixBranch(opts.workspaceId, r.id)) {
      targets.push({ ...r, status: r.status as string })
    }
  }
  return targets
}

async function hasBugfixBranch(workspaceId: string, featureId: string): Promise<boolean> {
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
  if (!ws?.localPath) return true
  const repoDir = path.join(ws.localPath, 'repo')
  const branch = `bugfix/${featureId}`
  // `git rev-parse --verify --quiet <branch>` exits 0 if the branch exists.
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', branch], {
    cwd: repoDir,
    encoding: 'utf-8',
  })
  return r.status === 0
}

// ============================================================================
// Per-feature rebase + revalidate
// ============================================================================

interface RebaseStepResult {
  ok: boolean
  log: string
}

/**
 * Run `git rebase <newBase>` in the worktree. On conflict, run
 * `git rebase --abort` to leave the worktree in a clean state (the failure
 * is recorded in the circuit-breaker report instead of a half-finished rebase).
 */
function rebaseWorktree(featureWorktreePath: string, newBase: string): RebaseStepResult {
  assertWithinWorkspaceBase(featureWorktreePath)
  const res = gitMayFail(featureWorktreePath, 'rebase', newBase)
  if (res.ok) {
    return { ok: true, log: res.stdout + res.stderr }
  }
  // Conflict — abort the rebase to leave the worktree in a clean state.
  const abort = gitMayFail(featureWorktreePath, 'rebase', '--abort')
  const log = res.stdout + res.stderr + (abort.ok ? '' : `\n[rebase --abort failed: ${abort.stderr || abort.stdout}]`)
  return { ok: false, log }
}

// ============================================================================
// Audit-run persistence for rebase-validate
// ============================================================================

interface PersistRebaseAuditOpts {
  featureId: string
  workspaceId: string
  parentAuditStageRunId: string | null
  verdict: AuditVerdict
  rejectionReason: RejectionReason | null
}

async function persistRebaseValidateRun(opts: PersistRebaseAuditOpts): Promise<{ stageRunId: string }> {
  const stageRunId = randomUUID()
  const now = new Date()
  await db.insert(stageRuns).values({
    id: stageRunId,
    featureId: opts.featureId,
    stage: 'rebase-validator',
    nodeId: REBASE_VALIDATE_NODE_ID,
    runtimeId: 'system',
    cliSessionId: null,
    status: opts.verdict.status,
    artifactContent: '',
    artifactPath: '',
    createdAt: now,
    approvedAt: opts.verdict.status === 'approved' ? now : null,
    attempt: 1,
    parentStageRunId: opts.parentAuditStageRunId,
    rejectionReason: opts.rejectionReason,
  })

  // Write the four audit artifacts under storage/<ws>/<feat>/rebase-validate/
  const auditReportPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, REBASE_VALIDATE_NODE_ID, 'audit_report.md')
  const reverseLogPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, REBASE_VALIDATE_NODE_ID, 'reverse_validation.log')
  const mutationLogPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, REBASE_VALIDATE_NODE_ID, 'mutation_test.log')
  const coveragePath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, REBASE_VALIDATE_NODE_ID, 'coverage_delta.json')
  fs.mkdirSync(path.dirname(auditReportPath), { recursive: true })
  persistAuditArtifacts(
    { auditReport: auditReportPath, reverseValidationLog: reverseLogPath, mutationTestLog: mutationLogPath, coverageDelta: coveragePath },
    opts.verdict,
    opts.verdict.mutationSkipped ? 'mutation_test_skipped: no framework detected\n' : '',
  )

  const outputs: Record<string, string> = {
    'audit_report.md': fs.readFileSync(auditReportPath, 'utf-8'),
    'reverse_validation.log': fs.readFileSync(reverseLogPath, 'utf-8'),
    'mutation_test.log': fs.readFileSync(mutationLogPath, 'utf-8'),
    'coverage_delta.json': fs.readFileSync(coveragePath, 'utf-8'),
  }
  for (const [name, content] of Object.entries(outputs)) {
    await db.insert(stageRunOutputs).values({
      id: randomUUID(),
      stageRunId,
      outputName: name,
      content,
      approvedAt: now,
    })
  }

  await db
    .update(featureNodeStates)
    .set({ status: opts.verdict.status, lastStageRunId: stageRunId, updatedAt: now })
    .where(and(eq(featureNodeStates.featureId, opts.featureId), eq(featureNodeStates.nodeId, REBASE_VALIDATE_NODE_ID)))

  return { stageRunId }
}

// ============================================================================
// Circuit-breaker report writer
// ============================================================================

function writeCircuitBreakerReport(opts: {
  workspaceId: string
  featureId: string
  reason: RejectionReason
  rebaseLog: string
  verdict: AuditVerdict | null
}): string {
  const dir = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, REBASE_VALIDATE_NODE_ID, '')
  fs.mkdirSync(dir, { recursive: true })
  const reportPath = path.join(dir, 'circuit_breaker_report.md')
  const lines: string[] = []
  lines.push('# Circuit Breaker Report (Post-Merge Rebase-Validate)')
  lines.push('')
  lines.push(`Feature: ${opts.featureId}`)
  lines.push(`Workspace: ${opts.workspaceId}`)
  lines.push(`Reason: ${opts.reason}`)
  lines.push(`Generated: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Rebase step')
  lines.push('```')
  lines.push(opts.rebaseLog || '(no rebase log captured)')
  lines.push('```')
  lines.push('')
  if (opts.verdict) {
    lines.push('## Re-validation verdict')
    lines.push(`- status: ${opts.verdict.status}`)
    lines.push(`- rejectionReason: ${opts.verdict.rejectionReason ?? 'none'}`)
    const reverse = opts.verdict.phases.find((p) => p.phase === 'reverse')
    if (reverse) {
      lines.push(`- reverse phase: ${reverse.passed ? 'PASS' : 'FAIL'} (expected=${reverse.expected})`)
    }
  } else {
    lines.push('## Re-validation verdict')
    lines.push('- (re-validation did not run; the rebase step itself failed)')
  }
  lines.push('')
  lines.push('## Recommended next step')
  lines.push('- Manually rebase `bugfix/<featId>` onto the new main and resolve the conflict, OR')
  lines.push('- Abandon the feature and re-file the bug report with a cleaner patch scope.')
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8')
  return reportPath
}

// ============================================================================
// Main per-feature entry point
// ============================================================================

/**
 * Rebase a single target feature onto the new base and re-validate. Updates
 * features.status accordingly (rebasing → approved | circuit_broken) and
 * persists a stage_run under nodeId='rebase-validate'.
 */
export async function runRebaseValidate(opts: RebaseValidateOpts): Promise<RebaseValidateResult> {
  const [feature] = await db.select().from(features).where(eq(features.id, opts.targetFeatureId))
  if (!feature) {
    throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${opts.targetFeatureId} not found`, 404)
  }
  if (feature.workspaceId !== opts.workspaceId) {
    throw new BizError(Code.WORKFLOW_INVALID, 'Feature workspace mismatch', 400)
  }
  const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, opts.workspaceId))
  if (!ws?.localPath) {
    throw new BizError(Code.WORKFLOW_INVALID, `Workspace ${opts.workspaceId} has no localPath`, 400)
  }

  // 1. Mark the feature as 'rebasing' so the UI can show a distinct status.
  await db
    .update(features)
    .set({ status: REBASING_STATUS })
    .where(eq(features.id, opts.targetFeatureId))

  // 2. Ensure the worktree exists (idempotent — reuses the existing one if so).
  const wt = await ensureFeatureWorktree({
    featureId: opts.targetFeatureId,
    localPath: ws.localPath,
  })
  const worktreePath = wt.path
  assertWithinWorkspaceBase(worktreePath)

  // 3. Rebase step
  const rebase = rebaseWorktree(worktreePath, opts.newBase)
  if (!rebase.ok) {
    // Circuit-break on rebase conflict. Persist a stage_run with status='rejected'
    // and rejection_reason='rebase_conflict'.
    const stageRunId = randomUUID()
    const now = new Date()
    const parentAudit = await db
      .select({ id: stageRuns.id })
      .from(stageRuns)
      .where(and(eq(stageRuns.featureId, opts.targetFeatureId), eq(stageRuns.nodeId, AUDIT_NODE_ID)))
      .orderBy(desc(stageRuns.createdAt))
      .limit(1)
    await db.insert(stageRuns).values({
      id: stageRunId,
      featureId: opts.targetFeatureId,
      stage: 'rebase-validator',
      nodeId: REBASE_VALIDATE_NODE_ID,
      runtimeId: 'system',
      cliSessionId: null,
      status: 'rejected',
      artifactContent: '',
      artifactPath: '',
      createdAt: now,
      approvedAt: null,
      attempt: 1,
      parentStageRunId: parentAudit[0]?.id ?? null,
      rejectionReason: 'rebase_conflict',
    })
    await db
      .update(featureNodeStates)
      .set({ status: 'rejected', lastStageRunId: stageRunId, updatedAt: now })
      .where(and(eq(featureNodeStates.featureId, opts.targetFeatureId), eq(featureNodeStates.nodeId, REBASE_VALIDATE_NODE_ID)))

    // Set the feature to circuit_broken and clear its locks.
    await db
      .update(features)
      .set({ status: 'circuit_broken' })
      .where(eq(features.id, opts.targetFeatureId))
    await clearFeatureLocks(opts.targetFeatureId)

    // Emit the report.
    writeCircuitBreakerReport({
      workspaceId: opts.workspaceId,
      featureId: opts.targetFeatureId,
      reason: 'rebase_conflict',
      rebaseLog: rebase.log,
      verdict: null,
    })

    return {
      ok: false,
      circuitBroken: true,
      reason: 'rebase_conflict',
      verdict: null,
      rebaseClean: false,
      rebaseLog: rebase.log,
    }
  }

  // 4. Re-validation step — re-run the full reverse validation on the rebased tree.
  const fixPatchPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.targetFeatureId, FIX_NODE_ID, 'fix.patch')
  const testMetadataPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.targetFeatureId, FIX_NODE_ID, 'test_metadata.json')
  if (!fs.existsSync(fixPatchPath) || !fs.existsSync(testMetadataPath)) {
    // The feature was approved before but its on-disk artifacts are gone —
    // treat as circuit_broken with a clear reason.
    const now = new Date()
    const stageRunId = randomUUID()
    const parentAudit = await db
      .select({ id: stageRuns.id })
      .from(stageRuns)
      .where(and(eq(stageRuns.featureId, opts.targetFeatureId), eq(stageRuns.nodeId, AUDIT_NODE_ID)))
      .orderBy(desc(stageRuns.createdAt))
      .limit(1)
    await db.insert(stageRuns).values({
      id: stageRunId,
      featureId: opts.targetFeatureId,
      stage: 'rebase-validator',
      nodeId: REBASE_VALIDATE_NODE_ID,
      runtimeId: 'system',
      cliSessionId: null,
      status: 'rejected',
      artifactContent: '',
      artifactPath: '',
      createdAt: now,
      approvedAt: null,
      attempt: 1,
      parentStageRunId: parentAudit[0]?.id ?? null,
      rejectionReason: 'fix_out_of_scope',
    })
    await db
      .update(featureNodeStates)
      .set({ status: 'rejected', lastStageRunId: stageRunId, updatedAt: now })
      .where(and(eq(featureNodeStates.featureId, opts.targetFeatureId), eq(featureNodeStates.nodeId, REBASE_VALIDATE_NODE_ID)))

    await db
      .update(features)
      .set({ status: 'circuit_broken' })
      .where(eq(features.id, opts.targetFeatureId))
    await clearFeatureLocks(opts.targetFeatureId)

    writeCircuitBreakerReport({
      workspaceId: opts.workspaceId,
      featureId: opts.targetFeatureId,
      reason: 'fix_out_of_scope',
      rebaseLog: 'rebase OK; re-validation skipped — missing fix.patch or test_metadata.json on disk',
      verdict: null,
    })

    return {
      ok: false,
      circuitBroken: true,
      reason: 'fix_out_of_scope',
      verdict: null,
      rebaseClean: true,
      rebaseLog: rebase.log,
    }
  }

  let verdict: AuditVerdict
  try {
    verdict = await runReverseValidation({
      featureId: opts.targetFeatureId,
      featureWorktreePath: worktreePath,
      fixPatchPath,
      testMetadataPath,
    })
  } catch (err: any) {
    // Re-validation infrastructure failure — circuit-break.
    await db
      .update(features)
      .set({ status: 'circuit_broken' })
      .where(eq(features.id, opts.targetFeatureId))
    await clearFeatureLocks(opts.targetFeatureId)
    writeCircuitBreakerReport({
      workspaceId: opts.workspaceId,
      featureId: opts.targetFeatureId,
      reason: 'regressions',
      rebaseLog: rebase.log + `\n[re-validation crashed: ${err.message ?? String(err)}]`,
      verdict: null,
    })
    return {
      ok: false,
      circuitBroken: true,
      reason: 'regressions',
      verdict: null,
      rebaseClean: true,
      rebaseLog: rebase.log,
    }
  }

  // 5. Persist the rebase-validate stage_run with the verdict.
  const parentAudit = await db
    .select({ id: stageRuns.id })
    .from(stageRuns)
    .where(and(eq(stageRuns.featureId, opts.targetFeatureId), eq(stageRuns.nodeId, AUDIT_NODE_ID)))
    .orderBy(desc(stageRuns.createdAt))
    .limit(1)

  await persistRebaseValidateRun({
    featureId: opts.targetFeatureId,
    workspaceId: opts.workspaceId,
    parentAuditStageRunId: parentAudit[0]?.id ?? null,
    verdict,
    rejectionReason: verdict.rejectionReason,
  })

  if (isApproved(verdict)) {
    // 6a. On approval: try to push; if no remote, the local branch is already
    //     updated by the rebase. Reset status to 'approved' (B is ready again).
    pushOrAmend(worktreePath, `bugfix/${opts.targetFeatureId}`)
    await db
      .update(features)
      .set({ status: 'approved' })
      .where(eq(features.id, opts.targetFeatureId))
    return {
      ok: true,
      circuitBroken: false,
      reason: 'approved',
      verdict,
      rebaseClean: true,
      rebaseLog: rebase.log,
    }
  }

  // 6b. On rejection from re-validation: circuit-break with a clear report.
  const reason: RejectionReason = verdict.rejectionReason ?? 'regressions'
  await db
    .update(features)
    .set({ status: 'circuit_broken' })
    .where(eq(features.id, opts.targetFeatureId))
  await clearFeatureLocks(opts.targetFeatureId)
  writeCircuitBreakerReport({
    workspaceId: opts.workspaceId,
    featureId: opts.targetFeatureId,
    reason,
    rebaseLog: rebase.log,
    verdict,
  })
  return {
    ok: false,
    circuitBroken: true,
    reason,
    verdict,
    rebaseClean: true,
    rebaseLog: rebase.log,
  }
}

/**
 * Try to push `bugfix/<featId>` to origin. If there's no remote configured,
 * the local branch is already updated by the rebase and there's nothing to
 * do — we surface a console line so the operator can see the path.
 */
function pushOrAmend(worktreePath: string, branch: string): void {
  const remoteRes = gitMayFail(worktreePath, 'remote')
  const hasOrigin = (remoteRes.stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes('origin')
  if (!hasOrigin) {
    // eslint-disable-next-line no-console
    console.log(`[rebase-validate] no remote 'origin' on ${worktreePath}; branch ${branch} is already updated locally`)
    return
  }
  const pushRes = gitMayFail(worktreePath, 'push', 'origin', branch)
  if (!pushRes.ok) {
    // eslint-disable-next-line no-console
    console.error(`[rebase-validate] git push origin ${branch} failed: ${pushRes.stderr || pushRes.stdout}`)
  }
}

// ============================================================================
// Sweep — workspace-internal trigger
// ============================================================================

// Per-workspace sweep in-flight promise. A second trigger while a sweep is
// running returns the same promise (idempotent).
const inFlightSweeps: Map<string, Promise<SweepResult>> = new Map()

export function isRebaseValidateSweepInProgress(workspaceId: string): boolean {
  return inFlightSweeps.has(workspaceId)
}

/**
 * Wait for any in-flight rebase-validate sweep on the given workspace to
 * complete. Returns immediately when no sweep is running.
 *
 * Used by tests to synchronize on the fire-and-forget sweep that
 * finalizeMerge kicks off.
 */
export async function awaitRebaseValidateFor(workspaceId: string): Promise<SweepResult | null> {
  const p = inFlightSweeps.get(workspaceId)
  if (!p) return null
  return p
}

/**
 * Run the rebase-validate sweep for one workspace.
 *
 * Idempotent: a second call while a sweep is running returns the same
 * in-flight promise — the targets list is computed once for the active
 * sweep and not re-computed for the queued call.
 */
export function sweepRebaseValidateForWorkspace(opts: SweepOpts): Promise<SweepResult> {
  const existing = inFlightSweeps.get(opts.workspaceId)
  if (existing) return existing

  const promise = doSweepRebaseValidate(opts).finally(() => {
    inFlightSweeps.delete(opts.workspaceId)
  })
  inFlightSweeps.set(opts.workspaceId, promise)
  return promise
}

async function doSweepRebaseValidate(opts: SweepOpts): Promise<SweepResult> {
  const targets = await findRebaseTargets(opts)
  const result: SweepResult = { rebased: [], circuitBroken: [], skipped: [], errors: [] }
  for (const t of targets) {
    try {
      const r = await runRebaseValidate({
        targetFeatureId: t.id,
        workspaceId: opts.workspaceId,
        newBase: opts.newBase,
      })
      if (r.circuitBroken) result.circuitBroken.push(t.id)
      else if (r.ok) result.rebased.push(t.id)
      else result.skipped.push(t.id)
    } catch (err: any) {
      result.errors.push({ featureId: t.id, reason: err?.message ?? String(err) })
    }
  }
  return result
}
