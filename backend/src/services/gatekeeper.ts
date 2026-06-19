// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03) +
//   docs/adr/0002-bug-fix-workflow.md §5 / §7 + CONTEXT.md decision 18 (RT1)
//
// Gatekeeper orchestration:
//   1. After code-surgeon (nodeId='fix') is approved, locate the on-disk
//      fix.patch + test_metadata.json + reproduction_test, then invoke the
//      reverse-validation runner.
//   2. Persist the verdict as an audit_report.md / logs / coverage_delta.json
//      under storage/<ws>/<feat>/audit/.
//   3. Create a synthetic stage_run for the audit node (nodeId='audit') with
//      status='approved' or 'rejected'.
//   4. On rejected: route to the rejection_edge's target node — archive the
//      prior attempt's side outputs to <nodeId>/.archive/attempt-<N-1>/,
//      create a new stage_run with attempt+1 and parent_stage_run_id, and
//      emit a circuit-breaker when the budget is exhausted.
//
// This service is invoked by AgentService.approveStage when the approved node
// is the bug-fix workflow's `fix` node. It does NOT spawn the
// quality-gatekeeper LLM agent — the verdict is fully determined by file +
// test execution. The LLM's role in production is to write a narrative audit
// summary, which is deferred to Issue 04.

import fs from 'fs'
import path from 'path'
import { eq, and, asc } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../db/index.js'
import {
  stageRuns,
  stageRunOutputs,
  features,
  workflows,
  workflowNodes,
  featureNodeStates,
} from '../db/schema.js'
import { BizError, Code } from '../lib/envelope.js'
import { ArtifactService } from './artifact.js'
import {
  runReverseValidation,
  persistAuditArtifacts,
  isApproved,
  type AuditVerdict,
  type RejectionReason,
} from './reverse-validation.js'
import {
  parseRejectionEdges,
  findRejectionEdge,
  getNextAttempt,
  countRepairBudgetConsumed,
  isBudgetExhausted,
  getNodeRepairBudget,
  getTotalRepairBudget,
} from './rejection.js'

const AUDIT_NODE_ID = 'audit'
const FIX_NODE_ID = 'fix'

// ============================================================================
// Helpers
// ============================================================================

interface FeatureRow {
  id: string
  workspaceId: string
  currentWorkflowId: string | null
  currentNodeId: string
  intent: string
}

async function loadFeature(featureId: string): Promise<FeatureRow> {
  const [feature] = await db.select().from(features).where(eq(features.id, featureId))
  if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${featureId} not found`, 404)
  return feature as FeatureRow
}

async function loadWorkflowSettings(workflowId: string): Promise<{ total: number; rejectionEdges: ReturnType<typeof parseRejectionEdges> }> {
  const [wf] = await db.select().from(workflows).where(eq(workflows.id, workflowId))
  if (!wf) return { total: 3, rejectionEdges: [] }
  let settings: unknown = {}
  try { settings = JSON.parse(wf.settingsJson ?? '{}') } catch { /* default */ }
  return {
    total: getTotalRepairBudget(settings),
    rejectionEdges: parseRejectionEdges(wf.rejectionEdgesJson),
  }
}

async function loadNodeBudget(workflowId: string, nodeId: string): Promise<number> {
  const [node] = await db
    .select()
    .from(workflowNodes)
    .where(and(eq(workflowNodes.workflowId, workflowId), eq(workflowNodes.nodeId, nodeId)))
  return getNodeRepairBudget(node?.configJson ?? null)
}

/** Locate the on-disk fix.patch + test_metadata.json for a feature. */
function resolveArtifactPaths(workspaceId: string, featureId: string): {
  fixPatch: string
  testMetadata: string
  reproductionTest: string
  fullSuiteLog: string
} {
  const fixDir = ArtifactService.getArtifactPath(workspaceId, featureId, FIX_NODE_ID, '')
  return {
    fixPatch: path.join(fixDir, 'fix.patch'),
    testMetadata: path.join(fixDir, 'test_metadata.json'),
    reproductionTest: path.join(fixDir, 'reproduction_test'),
    fullSuiteLog: path.join(fixDir, 'full_test_suite.log'),
  }
}

/**
 * Move side outputs of a nodeId into <nodeId>/.archive/attempt-<N>/ so the new
 * attempt's writes don't clobber the audit trail. Per CONTEXT.md decision 18.
 */
function archiveNodeOutputs(
  workspaceId: string,
  featureId: string,
  nodeId: string,
  archiveAttempt: number,
): void {
  const nodeDir = path.dirname(ArtifactService.getArtifactPath(workspaceId, featureId, nodeId, 'placeholder'))
  if (!fs.existsSync(nodeDir)) return
  const archiveDir = path.join(nodeDir, '.archive', `attempt-${archiveAttempt}`)
  fs.mkdirSync(archiveDir, { recursive: true })
  for (const entry of fs.readdirSync(nodeDir)) {
    if (entry === '.archive') continue
    const src = path.join(nodeDir, entry)
    const dst = path.join(archiveDir, entry)
    try {
      fs.renameSync(src, dst)
    } catch { /* best-effort: file in use is OK */ }
  }
}

// ============================================================================
// Audit-run persistence
// ============================================================================

interface PersistAuditOpts {
  featureId: string
  workspaceId: string
  fixStageRunId: string
  nodeId: string       // 'audit'
  verdict: AuditVerdict
  attempt: number
  parentStageRunId: string | null
  rejectionReason: RejectionReason | null
}

/** Insert the synthetic stage_run for the audit node + write the 4 artifacts. */
async function persistAuditRun(opts: PersistAuditOpts): Promise<{ stageRunId: string }> {
  const stageRunId = randomUUID()
  const now = new Date()
  await db.insert(stageRuns).values({
    id: stageRunId,
    featureId: opts.featureId,
    stage: 'quality-gatekeeper',
    nodeId: opts.nodeId,
    runtimeId: 'system',
    cliSessionId: null,
    status: opts.verdict.status,
    artifactContent: '',
    artifactPath: '',
    createdAt: now,
    approvedAt: opts.verdict.status === 'approved' ? now : null,
    attempt: opts.attempt,
    parentStageRunId: opts.parentStageRunId,
    rejectionReason: opts.rejectionReason,
  })

  // Render the four artifacts via the shared helper (single source of truth).
  const auditReportPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, opts.nodeId, 'audit_report.md')
  const reverseLogPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, opts.nodeId, 'reverse_validation.log')
  const mutationLogPath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, opts.nodeId, 'mutation_test.log')
  const coveragePath = ArtifactService.getArtifactPath(opts.workspaceId, opts.featureId, opts.nodeId, 'coverage_delta.json')
  fs.mkdirSync(path.dirname(auditReportPath), { recursive: true })
  persistAuditArtifacts(
    { auditReport: auditReportPath, reverseValidationLog: reverseLogPath, mutationTestLog: mutationLogPath, coverageDelta: coveragePath },
    opts.verdict,
    opts.verdict.mutationSkipped ? 'mutation_test_skipped: no framework detected\n' : '',
  )

  // Mirror the artifact contents into stage_run_outputs so the API surface is
  // uniform with LLM-driven runs (where the agent's text would be stored).
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
    .where(and(eq(featureNodeStates.featureId, opts.featureId), eq(featureNodeStates.nodeId, opts.nodeId)))

  return { stageRunId }
}

// ============================================================================
// Cascade on rejection
// ============================================================================

interface CascadeOpts {
  feature: FeatureRow
  reason: RejectionReason
  rejectedAuditStageRunId: string
}

interface CascadeResult {
  targetNodeId: string | null
  newStageRunId: string | null
  circuitBroken: boolean
  reason: string
}

/**
 * Route a rejection to the upstream node declared in the workflow's
 * rejection_edges. Archives the prior attempt's side outputs, creates a new
 * stage_run with attempt+1, and reports a circuit-breaker when the budget
 * is exhausted.
 */
async function cascadeOnRejection(opts: CascadeOpts): Promise<CascadeResult> {
  const { feature, reason, rejectedAuditStageRunId } = opts
  if (!feature.currentWorkflowId) {
    return { targetNodeId: null, newStageRunId: null, circuitBroken: true, reason: 'no current workflow' }
  }
  const { total, rejectionEdges } = await loadWorkflowSettings(feature.currentWorkflowId)
  const edge = findRejectionEdge(rejectionEdges, AUDIT_NODE_ID, reason)
  if (!edge) {
    return {
      targetNodeId: null,
      newStageRunId: null,
      circuitBroken: true,
      reason: `No rejection edge for ${AUDIT_NODE_ID} / ${reason}`,
    }
  }
  const targetNodeId = edge.to
  const perNodeBudget = await loadNodeBudget(feature.currentWorkflowId, targetNodeId)
  const consumed = await countRepairBudgetConsumed(feature.id)
  if (isBudgetExhausted(consumed, targetNodeId, { perNode: perNodeBudget, total })) {
    // Halve the feature — circuit-breaker
    await db
      .update(features)
      .set({ status: 'circuit_broken' })
      .where(eq(features.id, feature.id))
    return {
      targetNodeId,
      newStageRunId: null,
      circuitBroken: true,
      reason: `Repair budget exhausted (per-node=${perNodeBudget}, global=${total})`,
    }
  }

  // Archive prior side outputs for the upstream node
  // For rejection reasons that route back to the same node (e.g. flaky_test
  // → design-test), we archive attempt-N-1 outputs and let the new attempt
  // overwrite them.
  const nextAttempt = await getNextAttempt(feature.id, targetNodeId)
  archiveNodeOutputs(feature.workspaceId, feature.id, targetNodeId, nextAttempt - 1)

  // Create the new stage_run
  const stageRunId = randomUUID()
  const now = new Date()
  await db.insert(stageRuns).values({
    id: stageRunId,
    featureId: feature.id,
    stage: 'pending',  // unknown agentId; resolved at dispatch time
    nodeId: targetNodeId,
    runtimeId: 'pending',
    cliSessionId: null,
    status: 'pending',
    artifactContent: '',
    artifactPath: '',
    createdAt: now,
    attempt: nextAttempt,
    parentStageRunId: rejectedAuditStageRunId,
    rejectionReason: reason,
  })

  // Mark target node as pending
  await db
    .update(featureNodeStates)
    .set({ status: 'pending', updatedAt: now })
    .where(and(eq(featureNodeStates.featureId, feature.id), eq(featureNodeStates.nodeId, targetNodeId)))

  // Advance the feature's current_node_id to the target so the UI reflects it
  await db
    .update(features)
    .set({ currentNodeId: targetNodeId })
    .where(eq(features.id, feature.id))

  return {
    targetNodeId,
    newStageRunId: stageRunId,
    circuitBroken: false,
    reason: `Routed to ${targetNodeId} (attempt ${nextAttempt})`,
  }
}

// ============================================================================
// Public entry point — auto-invoked from AgentService.approveStage
// ============================================================================

export interface RunGatekeeperOpts {
  featureId: string
  fixStageRunId: string
  /** Path to the per-feature worktree (bugfix/<featId>) — resolved by caller. */
  featureWorktreePath: string
}

export interface RunGatekeeperResult {
  verdict: AuditVerdict
  auditStageRunId: string
  cascade: CascadeResult | null
}

/**
 * Run the gatekeeper end-to-end:
 *  1. Run the reverse-validation runner.
 *  2. Persist the verdict as a synthetic audit stage_run.
 *  3. On rejected, cascade upstream; on approved, advance the feature.
 */
export async function runGatekeeper(opts: RunGatekeeperOpts): Promise<RunGatekeeperResult> {
  const feature = await loadFeature(opts.featureId)
  if (!feature.currentWorkflowId) {
    throw new BizError(Code.WORKFLOW_NOT_FOUND, `Feature ${opts.featureId} has no workflow`, 400)
  }
  const paths = resolveArtifactPaths(feature.workspaceId, feature.id)
  if (!fs.existsSync(paths.fixPatch) || !fs.existsSync(paths.testMetadata)) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Cannot run gatekeeper: missing fix.patch or test_metadata.json on disk (${paths.fixPatch}, ${paths.testMetadata})`,
      400,
    )
  }

  const verdict = await runReverseValidation({
    featureId: feature.id,
    featureWorktreePath: opts.featureWorktreePath,
    fixPatchPath: paths.fixPatch,
    testMetadataPath: paths.testMetadata,
  })

  // Persist the audit run (status=approved or rejected)
  const persisted = await persistAuditRun({
    featureId: feature.id,
    workspaceId: feature.workspaceId,
    fixStageRunId: opts.fixStageRunId,
    nodeId: AUDIT_NODE_ID,
    verdict,
    attempt: 1,
    parentStageRunId: opts.fixStageRunId,
    rejectionReason: verdict.rejectionReason,
  })

  let cascade: CascadeResult | null = null
  if (!isApproved(verdict) && verdict.rejectionReason) {
    cascade = await cascadeOnRejection({
      feature,
      reason: verdict.rejectionReason,
      rejectedAuditStageRunId: persisted.stageRunId,
    })
  }

  return { verdict, auditStageRunId: persisted.stageRunId, cascade }
}