// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04) +
//   CONTEXT.md decisions 20 (FB2 — user-prompted merge, no auto-merge) and 21 (TF1 —
//   reproduction test always committed; structured commit message with Bug: and
//   Adds regression test: trailers).
//
// Two responsibilities:
//   1. loadAuditReport — read the latest approved audit run from DB + disk and
//      return a structured payload the frontend can render (3-phase table, mutation
//      score, coverage delta, fix.patch content, reproduction test, bug_analysis).
//   2. commitFeatureFix — squash all agent commits on bugfix/<featId> into a
//      single review commit with the TF1 commit message, mark the feature
//      'merged', clear locked_files, and fire the rebase-validate signal for
//      Issue 06 (stubbed here — the rebase itself ships in Issue 06).

import fs from 'fs'
import path from 'path'
import { execFileSync, spawnSync } from 'child_process'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import {
  features,
  stageRuns,
  stageRunOutputs,
} from '../db/schema.js'
import { BizError, Code } from '../lib/envelope.js'
import { ArtifactService } from './artifact.js'
import { assertWithinWorkspaceBase } from '../routes/workspaces.js'

// ============================================================================
// Constants
// ============================================================================

const AUDIT_NODE_ID = 'audit'
const FIX_NODE_ID = 'fix'
const ANALYZE_NODE_ID = 'analyze'
const DESIGN_TEST_NODE_ID = 'design-test'

/** Path inside the worktree where the audit report is materialized for the commit. */
const AUDIT_PATH_IN_REPO = '.sdd/audit_report.md'

// ============================================================================
// Git helpers
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

// ============================================================================
// Public types
// ============================================================================

export interface AuditReportData {
  verdict: 'APPROVED' | 'REJECTED'
  rejectionReason: string | null
  auditReportMd: string
  reverseValidationPhases: Array<{
    phase: string
    passed: boolean | null
    expected: string
    exitCode: number | null
    durationMs: number
  }>
  mutationScore: number | null
  mutationSkipped: boolean
  coverageDelta: { entries: unknown[]; toolDetected: boolean } | null
  filesModified: string[]
  startedAt: string
  finishedAt: string
  durationMs: number
  fixPatch: string
  reproductionTest: string
  bugAnalysis: { symptom: string } | null
}

export interface CommitFeatureFixResult {
  branch: string
  commit: string
  message: string
  status: 'merged'
}

// ============================================================================
// Audit report loader
// ============================================================================

interface AuditRunRow {
  id: string
  status: string
  rejectionReason: string | null
  approvedAt: Date | null
  createdAt: Date
}

/**
 * Load the latest audit-run stage_run and its 4 stage_run_outputs rows,
 * then assemble the structured AuditReportData the frontend renders.
 *
 * The audit run is identified as: the most recent stage_runs row with
 * node_id='audit' and status in ('approved', 'rejected'). Returns null
 * when no audit has run yet (caller → 404).
 */
export async function loadAuditReport(featureId: string, _workspaceId: string): Promise<AuditReportData | null> {
  const auditRuns = await db
    .select()
    .from(stageRuns)
    .where(and(eq(stageRuns.featureId, featureId), eq(stageRuns.nodeId, AUDIT_NODE_ID)))
    .orderBy(desc(stageRuns.createdAt))

  if (auditRuns.length === 0) return null
  const auditRun = auditRuns[0] as AuditRunRow
  // The verdict is the status of the audit run; rejection_reason carries the
  // structured failure reason when status='rejected'.
  const verdict: 'APPROVED' | 'REJECTED' = auditRun.status === 'approved' ? 'APPROVED' : 'REJECTED'

  // Pull the 4 stage_run_outputs rows
  const outRows = await db
    .select()
    .from(stageRunOutputs)
    .where(eq(stageRunOutputs.stageRunId, auditRun.id))
  const outMap: Record<string, string> = {}
  for (const o of outRows) outMap[o.outputName] = o.content

  const auditReportMd = outMap['audit_report.md'] ?? ''
  const reverseLog = outMap['reverse_validation.log'] ?? ''
  const mutationLog = outMap['mutation_test.log'] ?? ''
  const coverageRaw = outMap['coverage_delta.json'] ?? ''

  // Parse the reverse validation log → 3 phases (forward / reverse / reapply)
  // Each phase in the log has a header like
  //   `## Phase: <name> (expected=<exp>, passed=<bool>, exit=<code>, hash=<hex>, durationMs=<ms>)`
  // The hash field is part of the actual format written by reverse-validation.ts.
  // Note: the log also contains full_suite / scope / coverage phase headers
  // (the runner writes ALL of them); we filter to just the reverse-validation
  // triple for the frontend's 3-phase table.
  const REVERSE_VALIDATION_PHASES = new Set(['forward', 'reverse', 'reapply'])
  const reverseValidationPhases: AuditReportData['reverseValidationPhases'] = []
  const phaseRe = /## Phase:\s*(\w+)\s*\(expected=([\w-]+),\s*passed=([\w-]+),\s*exit=(-?\d+),\s*hash=([\w-]+),\s*durationMs=(\d+)\)/
  for (const line of reverseLog.split('\n')) {
    const m = phaseRe.exec(line)
    if (!m) continue
    const [, phase, expected, passed, exitStr, , durStr] = m
    if (!REVERSE_VALIDATION_PHASES.has(phase)) continue
    const passedNorm: boolean | null = passed === 'true' ? true : passed === 'false' ? false : null
    reverseValidationPhases.push({
      phase,
      passed: passedNorm,
      expected,
      exitCode: Number(exitStr),
      durationMs: Number(durStr),
    })
  }

  // Mutation score from the log header (e.g. `Mutation score: 87%` or `Mutation score: skipped`).
  let mutationScore: number | null = null
  let mutationSkipped = true
  const msMatch = /^Mutation score:\s*(\d+)%/m.exec(auditReportMd)
  if (msMatch) {
    mutationScore = Number(msMatch[1]) / 100
    mutationSkipped = false
  }

  // Coverage delta JSON
  let coverageDelta: AuditReportData['coverageDelta'] = null
  if (coverageRaw) {
    try {
      const parsed = JSON.parse(coverageRaw)
      if (parsed && typeof parsed === 'object') {
        coverageDelta = {
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          toolDetected: !!parsed.toolDetected,
        }
      }
    } catch { /* keep null */ }
  }

  // filesModified — derive from audit_report.md line `fix.patch touches N files`
  // is not enough; we use a robust grep: any `## N: <file>` line is too noisy.
  // Instead, parse the fix.patch on disk for `diff --git a/<path> b/<path>`.
  const fixPatchPath = ArtifactService.getArtifactPath(_workspaceId, featureId, FIX_NODE_ID, 'fix.patch')
  const fixPatch = fs.existsSync(fixPatchPath) ? fs.readFileSync(fixPatchPath, 'utf-8') : ''
  const filesModified: string[] = []
  const diffRe = /^diff --git a\/(.+?) b\/(.+?)$/gm
  let dm: RegExpExecArray | null
  while ((dm = diffRe.exec(fixPatch)) !== null) {
    if (!filesModified.includes(dm[2])) filesModified.push(dm[2])
  }

  // Reproduction test content (for the test-link panel)
  const reproTestPath = ArtifactService.getArtifactPath(_workspaceId, featureId, DESIGN_TEST_NODE_ID, 'reproduction_test')
  const reproductionTest = fs.existsSync(reproTestPath) ? fs.readFileSync(reproTestPath, 'utf-8') : ''

  // bug_analysis.json → symptom (for the commit message Bug: trailer)
  const bugAnalysisPath = ArtifactService.getArtifactPath(_workspaceId, featureId, ANALYZE_NODE_ID, 'bug_analysis.json')
  let bugAnalysis: AuditReportData['bugAnalysis'] = null
  if (fs.existsSync(bugAnalysisPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(bugAnalysisPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && typeof parsed.symptom === 'string') {
        bugAnalysis = { symptom: parsed.symptom }
      }
    } catch { /* keep null */ }
  }

  // Started/finished/duration are baked into audit_report.md; expose them
  // if present, otherwise use the DB timestamps.
  const startedAt = extractIsoFromMd(auditReportMd, /^Started:\s*(.+)$/m) ?? auditRun.createdAt.toISOString()
  const finishedAt = extractIsoFromMd(auditReportMd, /^Finished:\s*(.+)$/m) ?? auditRun.approvedAt?.toISOString() ?? auditRun.createdAt.toISOString()
  const durationStr = extractIsoFromMd(auditReportMd, /^Duration:\s*(\d+)\s*ms$/m)
  const durationMs = durationStr ? Number(durationStr) : 0

  return {
    verdict,
    rejectionReason: auditRun.rejectionReason,
    auditReportMd,
    reverseValidationPhases,
    mutationScore,
    mutationSkipped,
    coverageDelta,
    filesModified,
    startedAt,
    finishedAt,
    durationMs,
    fixPatch,
    reproductionTest,
    bugAnalysis,
  }
}

function extractIsoFromMd(md: string, re: RegExp): string | null {
  const m = re.exec(md)
  return m ? m[1].trim() : null
}

// ============================================================================
// Commit-message field resolution
// ============================================================================

interface CommitMessageFields {
  scope: string
  summary: string
  bug: string
  testPath: string
  auditPath: string
}

/**
 * Resolve all 4 fields of the TF1 commit message from on-disk artifacts.
 *
 * - scope: first non-default subdirectory of fix.patch's file list, or 'bugfix'
 * - summary: first line of bug_analysis.symptom, truncated to 72 chars
 * - bug: full bug_analysis.symptom
 * - testPath: path parsed from test_metadata.json::test_command
 * - auditPath: '.sdd/audit_report.md' (the file is materialized into the worktree
 *              at commit time so this path is a real repo path)
 */
export function resolveCommitMessageFields(opts: {
  fixPatch: string
  bugAnalysis: { symptom: string } | null
  testMetadata: { test_command?: string } | null
}): CommitMessageFields {
  // scope
  let scope = 'bugfix'
  const fileRe = /^diff --git a\/(.+?) b\/(.+?)$/gm
  const firstFile = fileRe.exec(opts.fixPatch)?.[2]
  if (firstFile) {
    const firstSlash = firstFile.indexOf('/')
    if (firstSlash > 0) {
      scope = firstFile.slice(0, firstSlash)
    } else {
      // File at the root — use its name (sans extension) as the scope
      scope = firstFile.replace(/\.[^.]+$/, '') || scope
    }
  }

  // summary + bug
  const symptom = opts.bugAnalysis?.symptom ?? ''
  const firstLine = symptom.split('\n')[0] ?? ''
  const summary = firstLine.length > 72 ? firstLine.slice(0, 69) + '...' : firstLine
  const bug = symptom

  // testPath — parse the test_command (first non-flag arg)
  let testPath = ''
  if (opts.testMetadata?.test_command) {
    const tokens = opts.testMetadata.test_command.split(/\s+/).filter((t) => t && !t.startsWith('-'))
    // Heuristic: skip the runner (node / npx / etc.) and take the first
    // path-looking token. For 'node src/foo.test.mjs' that's 'src/foo.test.mjs'.
    for (const t of tokens) {
      if (t.includes('/') || t.endsWith('.mjs') || t.endsWith('.js') || t.endsWith('.ts')) {
        testPath = t
        break
      }
    }
    if (!testPath && tokens.length > 0) testPath = tokens[tokens.length - 1]
  }

  return {
    scope,
    summary,
    bug,
    testPath,
    auditPath: AUDIT_PATH_IN_REPO,
  }
}

/** Build the TF1 commit message body. */
export function buildCommitMessage(fields: CommitMessageFields): string {
  // Per CONTEXT.md decision 21 (TF1), all three trailers are mandatory:
  // `Bug:` / `Adds regression test:` / `Audit:`. We always emit them; if
  // a field couldn't be resolved, fall back to '(unspecified)' so the
  // trailer is present and grep-able for the regression-guard tooling.
  const lines: string[] = []
  lines.push(`fix(${fields.scope}): ${fields.summary}`)
  lines.push('')
  lines.push(`Bug: ${fields.bug || '(unspecified)'}`)
  lines.push(`Adds regression test: ${fields.testPath || '(unspecified)'}`)
  lines.push(`Audit: ${fields.auditPath || AUDIT_PATH_IN_REPO}`)
  return lines.join('\n')
}

// ============================================================================
// The merge operation
// ============================================================================

export interface CommitFeatureFixOpts {
  featureId: string
  workspaceId: string
  featureWorktreePath: string
}

/**
 * Squash all agent commits on bugfix/<featId> into a single review commit
 * with the TF1 message. Idempotent: a branch that already has the TF1
 * trailer on HEAD returns the existing commit instead of creating a new one.
 *
 * Throws 409 when features.status !== 'approved' (or no audit has run yet).
 */
export async function commitFeatureFix(opts: CommitFeatureFixOpts): Promise<CommitFeatureFixResult> {
  const [feature] = await db.select().from(features).where(eq(features.id, opts.featureId))
  if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${opts.featureId} not found`, 404)
  if (feature.status !== 'approved') {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Feature ${opts.featureId} is not approved (current status: ${feature.status}); merge requires status='approved'`,
      409,
    )
  }
  // Path-traversal guard: the worktree path comes from ensureFeatureWorktree
  // (which itself nests under WORKSPACE_BASE), but a malformed DB row or a
  // future caller could supply an outside path. The guard is cheap; do it.
  assertWithinWorkspaceBase(opts.featureWorktreePath)

  const branch = `bugfix/${opts.featureId}`
  // Sanity: HEAD on the worktree must be on bugfix/<featId>
  const headBranch = git(opts.featureWorktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (headBranch !== branch) {
    // Not fatal — just switch into the branch so the commit lands there.
    git(opts.featureWorktreePath, 'checkout', branch)
  }

  // 1. Materialize audit_report.md into the worktree so the trailer's path
  //    resolves in the repo.
  const auditSrc = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, AUDIT_NODE_ID, 'audit_report.md')
  const auditDst = path.join(opts.featureWorktreePath, AUDIT_PATH_IN_REPO)
  if (!fs.existsSync(auditSrc)) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Cannot merge: audit_report.md not found on disk (${auditSrc})`,
      400,
    )
  }
  fs.mkdirSync(path.dirname(auditDst), { recursive: true })
  fs.copyFileSync(auditSrc, auditDst)

  // 2. Resolve commit-message fields
  const fixPatchPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, FIX_NODE_ID, 'fix.patch')
  const testMetadataPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, FIX_NODE_ID, 'test_metadata.json')
  const bugAnalysisPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, ANALYZE_NODE_ID, 'bug_analysis.json')

  const fixPatch = fs.existsSync(fixPatchPath) ? fs.readFileSync(fixPatchPath, 'utf-8') : ''
  let bugAnalysis: { symptom: string } | null = null
  if (fs.existsSync(bugAnalysisPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(bugAnalysisPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && typeof parsed.symptom === 'string') {
        bugAnalysis = { symptom: parsed.symptom }
      }
    } catch { /* keep null */ }
  }
  let testMetadata: { test_command?: string } | null = null
  if (fs.existsSync(testMetadataPath)) {
    try { testMetadata = JSON.parse(fs.readFileSync(testMetadataPath, 'utf-8')) } catch { /* keep null */ }
  }

  const fields = resolveCommitMessageFields({ fixPatch, bugAnalysis, testMetadata })
  const message = buildCommitMessage(fields)

  // 3. Idempotency check — if HEAD already has the TF1 Bug: trailer, return early.
  try {
    const headBody = git(opts.featureWorktreePath, 'log', '-1', '--format=%B')
    if (headBody.includes(`Bug: ${fields.bug}`) && headBody.includes(`Audit: ${fields.auditPath}`)) {
      const commit = git(opts.featureWorktreePath, 'rev-parse', 'HEAD')
      // Still finalize DB state in case it was missed
      await finalizeMerge(opts.featureId, branch, commit, message)
      return { branch, commit, message, status: 'merged' }
    }
  } catch { /* fall through to squash path */ }

  // 4. Soft-reset against the workspace's default branch ('main') so the
  //    TF1 commit is the ONLY commit on bugfix/<featId> on top of main.
  //    `git reset --soft main` keeps all changes staged but uncommitted.
  const softReset = gitMayFail(opts.featureWorktreePath, 'reset', '--soft', 'main')
  if (!softReset.ok) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Failed to soft-reset ${branch} against main: ${softReset.stderr || softReset.stdout}`,
      400,
    )
  }

  // 5. Single commit with the TF1 message
  const commitRes = gitMayFail(opts.featureWorktreePath, 'commit', '-m', message)
  if (!commitRes.ok) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `git commit failed: ${commitRes.stderr || commitRes.stdout}`,
      400,
    )
  }
  const commit = git(opts.featureWorktreePath, 'rev-parse', 'HEAD')

  // 6. Finalize DB state + fire Issue 06 signal
  await finalizeMerge(opts.featureId, branch, commit, message)
  return { branch, commit, message, status: 'merged' }
}

async function finalizeMerge(
  featureId: string,
  branch: string,
  commit: string,
  message: string,
): Promise<void> {
  // 1. features.status='merged' + clear locked_files
  await db
    .update(features)
    .set({ status: 'merged', lockedFiles: null })
    .where(eq(features.id, featureId))

  // 2. Fire-and-forget: notify other in-flight features in the same workspace
  //    that they should rebase. Issue 06 will implement the actual rebase
  //    runner; we just call the seam so the trigger is in place.
  try {
    await notifyOtherFeaturesRebase(featureId, branch, commit)
  } catch (err) {
    // best-effort: never block the merge on the rebase signal.
    // eslint-disable-next-line no-console
    console.error('[merge] notifyOtherFeaturesRebase failed:', err)
  }
  void message
}

/**
 * Seam for Issue 06: when a feature merges, every other in-flight feature
 * in the same workspace with intent=bug_fix should rebase onto the new main
 * tip and re-run the gatekeeper. The actual rebase lives in Issue 06; this
 * function is exported so the runner can wire it up. For now it is a stub
 * that surfaces a log line.
 *
 * Fire-and-forget: errors are swallowed by the caller.
 */
export async function notifyOtherFeaturesRebase(
  mergedFeatureId: string,
  mergedBranch: string,
  mergedCommit: string,
): Promise<void> {
  // Look up the workspaceId of the merged feature
  const [feat] = await db.select().from(features).where(eq(features.id, mergedFeatureId))
  if (!feat) return

  // Find in-flight features in the same workspace with intent='bug_fix'
  // and status not in ('done', 'merged', 'circuit_broken', 'upgraded').
  // We just *list* them here; Issue 06 will iterate the rebase.
  const inFlight = await db
    .select()
    .from(features)
    .where(and(eq(features.workspaceId, feat.workspaceId), eq(features.intent, 'bug_fix')))

  const targets = inFlight.filter((f) =>
    f.id !== mergedFeatureId
    && f.status !== 'done'
    && f.status !== 'merged'
    && f.status !== 'circuit_broken'
    && f.status !== 'upgraded',
  )

  if (targets.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[merge] rebase-validate signal: ${mergedFeatureId} merged @ ${mergedCommit} on ${mergedBranch}; ` +
      `${targets.length} in-flight feature(s) eligible for rebase in workspace ${feat.workspaceId}`,
    )
  }
}
