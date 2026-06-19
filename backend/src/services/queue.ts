// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 05) +
//   CONTEXT.md decisions 22 (CC1) and 23 (CC2)
//
// Multi-feature concurrency control for bug_fix features:
//   - features.locked_files claims a set of file paths.
//   - Two in-flight bug_fix features with overlapping locked_files cannot run
//     in parallel. The second is parked in status='queued'.
//   - When an in-flight feature leaves the in-flight set (merged / abandoned /
//     circuit_broken / done / upgraded), its locks are cleared and queued
//     features in the same workspace are re-evaluated; the first non-conflicting
//     queued feature transitions back to 'active'.
//
// Seam surface (exported):
//   - IN_FLIGHT_STATUSES / LOCK_RELEASING_STATUSES / isInFlight — status sets
//   - parseLockedFiles(raw)                  — safe JSON parsing
//   - clearFeatureLocks(featureId)           — release locks on terminal status
//   - hasLockConflict(wsId, candidate, excludeFeatureId)
//   - findConflictingSiblings(wsId, candidate, excludeFeatureId)
//   - maybeQueueFeature(featureId)           — active → queued on conflict
//   - evaluateQueueForWorkspace(wsId)        — queued → active when locks clear

import { eq, and, asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { features, workflowNodes } from '../db/schema.js'

/** Statuses that still hold a lock on the workspace's files. */
export const IN_FLIGHT_STATUSES = ['active', 'paused', 'approved', 'queued'] as const

/** Statuses that release the lock and let queued siblings run. */
export const LOCK_RELEASING_STATUSES = [
  'done',
  'merged',
  'abandoned',
  'circuit_broken',
  'upgraded',
] as const

export function isInFlight(status: string): boolean {
  return (IN_FLIGHT_STATUSES as readonly string[]).includes(status)
}

/** Parse a JSON-encoded locked_files column into a string[]. Returns [] for null/empty/invalid. */
export function parseLockedFiles(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: string[] = []
    for (const p of parsed) {
      if (typeof p === 'string' && p.trim()) out.push(p.trim())
    }
    return out
  } catch {
    return []
  }
}

/**
 * Clear locked_files on a feature. Called whenever the feature leaves the
 * in-flight set so its locks no longer block queued siblings.
 */
export async function clearFeatureLocks(featureId: string): Promise<void> {
  await db
    .update(features)
    .set({ lockedFiles: null })
    .where(eq(features.id, featureId))
}

/**
 * In-flight bug_fix features in this workspace that hold a non-empty
 * locked_files claim, EXCLUDING the given featureId.
 */
async function loadInFlightLockHolders(
  workspaceId: string,
  excludeFeatureId: string,
): Promise<Array<{ id: string; status: string; lockedFiles: string }>> {
  const rows = await db
    .select()
    .from(features)
    .where(and(eq(features.workspaceId, workspaceId), eq(features.intent, 'bug_fix')))
  return rows
    .filter((r) => r.id !== excludeFeatureId && isInFlight(r.status))
    .map((r) => ({ id: r.id, status: r.status, lockedFiles: r.lockedFiles ?? '' }))
    .filter((r) => parseLockedFiles(r.lockedFiles).length > 0)
}

/**
 * Return true if `candidate` overlaps any in-flight holder's locked_files in
 * the same workspace (other than `excludeFeatureId`).
 */
export async function hasLockConflict(
  workspaceId: string,
  candidate: string[],
  excludeFeatureId: string,
): Promise<boolean> {
  if (candidate.length === 0) return false
  const holders = await loadInFlightLockHolders(workspaceId, excludeFeatureId)
  for (const h of holders) {
    const paths = parseLockedFiles(h.lockedFiles)
    for (const p of paths) {
      if (candidate.includes(p)) return true
    }
  }
  return false
}

/**
 * Returns the in-flight bug_fix siblings whose locked_files overlap
 * `candidate` (used by the frontend to render "waiting on bugfix/feat-X").
 */
export async function findConflictingSiblings(
  workspaceId: string,
  candidate: string[],
  excludeFeatureId: string,
): Promise<Array<{ id: string; status: string }>> {
  if (candidate.length === 0) return []
  const holders = await loadInFlightLockHolders(workspaceId, excludeFeatureId)
  const conflicts: Array<{ id: string; status: string }> = []
  for (const h of holders) {
    const paths = parseLockedFiles(h.lockedFiles)
    for (const p of paths) {
      if (candidate.includes(p)) {
        conflicts.push({ id: h.id, status: h.status })
        break
      }
    }
  }
  return conflicts
}

/**
 * After bug-analyst writes locked_files on a feature, check whether the new
 * claim overlaps any other in-flight bug_fix feature in the same workspace.
 * If yes, transition the feature to status='queued' (the analyze stage remains
 * approved; downstream stages will not start until the feature is re-promoted).
 * Returns 'queued' if the feature was queued, 'active' otherwise.
 */
export async function maybeQueueFeature(featureId: string): Promise<'queued' | 'active'> {
  const [feature] = await db.select().from(features).where(eq(features.id, featureId))
  if (!feature) return 'active'
  if (feature.intent !== 'bug_fix') return feature.status as 'queued' | 'active'

  const candidate = parseLockedFiles(feature.lockedFiles)
  const conflict = await hasLockConflict(feature.workspaceId, candidate, featureId)
  if (!conflict) return feature.status as 'queued' | 'active'

  // Mark queued; record current node so we can advance when unblocking.
  await db
    .update(features)
    .set({ status: 'queued' })
    .where(eq(features.id, featureId))
  return 'queued'
}

/**
 * Re-evaluate queued bug_fix features in a workspace. For each queued feature
 * (in createdAt order), check whether its locked_files now conflict with any
 * in-flight holder. The first non-conflicting queued feature transitions back
 * to 'active' and is advanced to the next downstream node (if its
 * current_node_id points at a fully-approved node).
 *
 * Returns the list of featureIds that were promoted from queued → active.
 */
export async function evaluateQueueForWorkspace(workspaceId: string): Promise<string[]> {
  const all = await db
    .select()
    .from(features)
    .where(and(eq(features.workspaceId, workspaceId), eq(features.intent, 'bug_fix')))
    .orderBy(asc(features.createdAt))

  const promoted: string[] = []

  for (const f of all) {
    if (f.status !== 'queued') continue
    const candidate = parseLockedFiles(f.lockedFiles)
    if (candidate.length === 0) {
      // Defensive: a queued feature with no locks should not exist, but if
      // it does (e.g. cleared by clearFeatureLocks), promote it.
      await promoteFromQueue(f.id)
      promoted.push(f.id)
      continue
    }
    const conflict = await hasLockConflict(workspaceId, candidate, f.id)
    if (!conflict) {
      await promoteFromQueue(f.id)
      promoted.push(f.id)
    }
  }

  return promoted
}

async function promoteFromQueue(featureId: string): Promise<void> {
  const [feature] = await db.select().from(features).where(eq(features.id, featureId))
  if (!feature) return

  // Find the next node in toposort order. If the current_node_id is no
  // longer the head (e.g. bug-analyst already approved before queueing),
  // leave it; the workflow engine will pick up at the next dispatch.
  let nextNodeId: string = feature.currentNodeId
  if (feature.currentWorkflowId) {
    const nodes = await db
      .select()
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, feature.currentWorkflowId))
    // The bug-fix workflow's first real node is 'analyze'; if current_node_id
    // is still 'analyze', the next real node is 'design-test'.
    if (feature.currentNodeId === 'analyze' && nodes.some((n) => n.nodeId === 'design-test')) {
      nextNodeId = 'design-test'
    }
  }

  await db
    .update(features)
    .set({ status: 'active', currentNodeId: nextNodeId })
    .where(eq(features.id, featureId))
}