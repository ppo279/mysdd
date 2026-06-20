// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 07) +
//   CONTEXT.md decisions 8 (SW2) and 25 (IW2)
//
// Workflow upgrade (bug-fix → forward SDD).
// The HTTP contract lives in the route handler; this module owns validation
// and persistence. See routes/features.ts POST /api/features/:featureId/upgrade.

import fs from 'fs'
import path from 'path'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../db/index.js'
import {
  features,
  workflows,
  workflowNodes,
  workflowEdges,
  featureNodeStates,
  featureNodeMigrations,
} from '../db/schema.js'
import { BizError, Code } from '../lib/envelope.js'
import { toposort } from './workflow.js'
import { parseWorkflowInputs } from './intake.js'
import { ArtifactService } from './artifact.js'
import {
  clearFeatureLocks,
  evaluateQueueForWorkspace,
} from './queue.js'

const ANALYZE_NODE_ID = 'analyze'
const BUG_ANALYSIS_FILENAME = 'bug_analysis.json'

/** Statuses from which a feature can be upgraded. Per Issue 07 AC. */
const UPGRADEABLE_STATUSES = ['active', 'circuit_broken'] as const

export interface UpgradeWorkflowOpts {
  featureId: string
  targetWorkflowId: string
}

export interface UpgradeWorkflowResult {
  currentWorkflowId: string
  currentNodeId: string
  migrationId: string
  status: 'upgraded'
}

export async function upgradeWorkflow(opts: UpgradeWorkflowOpts): Promise<UpgradeWorkflowResult> {
  // 1. Load + validate the feature
  const [feature] = await db.select().from(features).where(eq(features.id, opts.featureId))
  if (!feature) {
    throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${opts.featureId} not found`, 404)
  }

  if (!(UPGRADEABLE_STATUSES as readonly string[]).includes(feature.status)) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Feature ${opts.featureId} cannot be upgraded from status '${feature.status}'; allowed: ${UPGRADEABLE_STATUSES.join(', ')}`,
      409,
    )
  }

  // Reject `looks_like === 'true_bug'` — the user should finish the bug-fix instead
  if (feature.looksLike === 'true_bug') {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Feature ${opts.featureId} has looks_like='true_bug'; finish the bug-fix workflow instead of upgrading`,
      409,
    )
  }

  // 2. Load + validate the target workflow
  const [targetWf] = await db.select().from(workflows).where(eq(workflows.id, opts.targetWorkflowId))
  if (!targetWf) {
    throw new BizError(Code.WORKFLOW_NOT_FOUND, `Target workflow ${opts.targetWorkflowId} not found`, 404)
  }
  if (targetWf.workspaceId !== feature.workspaceId) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Target workflow ${opts.targetWorkflowId} does not belong to workspace ${feature.workspaceId}`,
      400,
    )
  }

  // Reject targets that declare a `bug_report` input — the upgrade is
  // "bug-fix → forward", not "bug-fix → bug-fix". A workflow without
  // such an intake is treated as forward-pipeline by this heuristic.
  const targetInputs = parseWorkflowInputs(targetWf.inputsJson)
  if (targetInputs.some((i) => i.name === 'bug_report')) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Target workflow ${opts.targetWorkflowId} is a bug-fix workflow (declares 'bug_report' input); upgrade requires a forward pipeline`,
      400,
    )
  }

  // 3. Compute the new current node: toposort[0] of the target workflow.
  const targetNodes = await db
    .select()
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, opts.targetWorkflowId))
  if (targetNodes.length === 0) {
    throw new BizError(Code.WORKFLOW_INVALID, `Target workflow ${opts.targetWorkflowId} has no nodes`, 400)
  }
  const targetEdges = await db
    .select()
    .from(workflowEdges)
    .where(eq(workflowEdges.workflowId, opts.targetWorkflowId))
  const order = toposort({ nodes: targetNodes, edges: targetEdges })
  if (order.length === 0) {
    throw new BizError(Code.WORKFLOW_INVALID, `Target workflow ${opts.targetWorkflowId} has no nodes after toposort`, 400)
  }
  const newCurrentNodeId = order[0]
  const newCurrentNode = targetNodes.find((n) => n.nodeId === newCurrentNodeId)

  if (!feature.currentWorkflowId) {
    throw new BizError(Code.WORKFLOW_INVALID, `Feature ${opts.featureId} has no current workflow; cannot upgrade`, 400)
  }

  // 4. Build the SW2 mapping. Per CONTEXT.md decision 25 (IW2), the upgrade
  //    maps the (zero) intake node to the first node of the new workflow.
  //    The bug-fix pipeline's real nodes (analyze / design-test / fix /
  //    audit) are intentionally dropped — they are different agents from
  //    the forward pipeline and cannot be remapped automatically.
  const mapping = { __intake__: newCurrentNodeId }

  // 5. Persist the SW2 migration row.
  const migrationId = randomUUID()
  await db.insert(featureNodeMigrations).values({
    id: migrationId,
    featureId: opts.featureId,
    fromWorkflowId: feature.currentWorkflowId,
    toWorkflowId: opts.targetWorkflowId,
    mappingJson: JSON.stringify(mapping),
    createdAt: new Date(),
    appliedAt: new Date(),
  })

  // 6. Clear old per-node state and seed a fresh `pending` state for the
  //    new current node. The bug-fix pipeline's states don't carry
  //    meaning to the forward pipeline.
  await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, opts.featureId))
  await db.insert(featureNodeStates).values({
    featureId: opts.featureId,
    nodeId: newCurrentNodeId,
    status: 'pending',
    lastStageRunId: null,
    updatedAt: new Date(),
  })

  // 7. Mount bug_analysis.json as a reference input to the new spec node,
  //    so the spec author has the analyzed bug context at hand. The
  //    file is copied (not moved) so the original analyze-node artifact
  //    remains intact for the audit trail.
  const bugAnalysisSrc = ArtifactService.getArtifactPath(
    feature.workspaceId, opts.featureId, ANALYZE_NODE_ID, BUG_ANALYSIS_FILENAME,
  )
  if (fs.existsSync(bugAnalysisSrc)) {
    const bugAnalysisDst = ArtifactService.getArtifactPath(
      feature.workspaceId, opts.featureId, newCurrentNodeId, BUG_ANALYSIS_FILENAME,
    )
    fs.mkdirSync(path.dirname(bugAnalysisDst), { recursive: true })
    fs.copyFileSync(bugAnalysisSrc, bugAnalysisDst)
  }

  // 8. Update the feature row. The bugfix/<featId> branch is preserved
  //    (we never touch the worktree). lockedFiles is cleared so queued
  //    siblings can promote.
  await db
    .update(features)
    .set({
      currentWorkflowId: opts.targetWorkflowId,
      currentNodeId: newCurrentNodeId,
      currentStage: newCurrentNode?.agentId ?? newCurrentNodeId,
      status: 'upgraded',
      lockedFiles: null,
    })
    .where(eq(features.id, opts.featureId))

  // 9. Release locks and re-evaluate the workspace queue. status='upgraded'
  //    is in LOCK_RELEASING_STATUSES, so this is a no-op for this feature,
  //    but queued siblings may now be free of conflict.
  await clearFeatureLocks(opts.featureId)
  await evaluateQueueForWorkspace(feature.workspaceId)

  return {
    currentWorkflowId: opts.targetWorkflowId,
    currentNodeId: newCurrentNodeId,
    migrationId,
    status: 'upgraded',
  }
}
