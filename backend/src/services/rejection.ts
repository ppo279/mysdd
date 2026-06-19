// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03) + CONTEXT.md decision 18 (RT1)
//
// Rejection routing + repair budget:
//   - parse rejection_edges (already on workflow.rejection_edges_json) into typed objects
//   - map a (fromNodeId, rejection.reason) pair to the upstream nodeId it should retry
//   - compute the next attempt number for a node given its history
//   - decide whether per-node or global repair budgets are exhausted
//
// All functions here are pure over the rows they're given. The caller (the
// gatekeeper service) handles the DB writes.

import { eq, and, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { stageRuns } from '../db/schema.js'
import type { RejectionReason } from './reverse-validation.js'

export interface RejectionEdge {
  from: string
  trigger: string           // e.g. 'rejection.reason == "reverse_validation_failed"'
  to: string
  action: string
  consumesRepairBudget: boolean
}

const TRIGGER_RE = /rejection\.reason\s*==\s*["']([^"']+)["']/

/**
 * Parse the JSON column into typed RejectionEdge[]. Unparseable / non-array
 * values yield [] (don't block the workflow — just no rejection edges).
 */
export function parseRejectionEdges(raw: string | null | undefined): RejectionEdge[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const edges: RejectionEdge[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const from = typeof item.from === 'string' ? item.from : ''
      const trigger = typeof item.trigger === 'string' ? item.trigger : ''
      const to = typeof item.to === 'string' ? item.to : ''
      const action = typeof item.action === 'string' ? item.action : ''
      const consumes = typeof item.consumes_repair_budget === 'boolean'
        ? item.consumes_repair_budget
        : true
      if (from && trigger && to) edges.push({ from, trigger, to, action, consumesRepairBudget: consumes })
    }
    return edges
  } catch {
    return []
  }
}

/**
 * Extract the rejection.reason enum value from a trigger expression.
 * Returns null when the trigger doesn't match the simple `==`-style predicate.
 */
export function parseTriggerReason(trigger: string): RejectionReason | null {
  const m = TRIGGER_RE.exec(trigger)
  if (!m) return null
  const reason = m[1]
  const valid: RejectionReason[] = [
    'reverse_validation_failed',
    'flaky_test',
    'regressions',
    'fix_out_of_scope',
    'mutation_score_low',
    'test_passes_on_clean_tree',
    'coverage_regression',
  ]
  return (valid as string[]).includes(reason) ? (reason as RejectionReason) : null
}

/** Find the rejection edge matching the (from, reason) tuple, or null. */
export function findRejectionEdge(
  edges: RejectionEdge[],
  fromNodeId: string,
  reason: RejectionReason,
): RejectionEdge | null {
  for (const e of edges) {
    if (e.from !== fromNodeId) continue
    if (parseTriggerReason(e.trigger) === reason) return e
  }
  return null
}

// ============================================================================
// Repair budget — read from per-node config_json (set by workflow-seed.ts)
// and workflow.settings.total_repair_budget.
// ============================================================================

const DEFAULT_TOTAL_REPAIR_BUDGET = 3

export interface NodeRepairBudget {
  perNode: number
  total: number
}

export function getNodeRepairBudget(configJson: string | null | undefined): number {
  if (!configJson) return 0
  try {
    const cfg = JSON.parse(configJson)
    const v = cfg?.repair_budget
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  } catch {
    return 0
  }
}

/**
 * Read the workflow's `total_repair_budget` from settings_json. The settings
 * field isn't yet a dedicated column; for now we keep it as a free-form JSON
 * blob the runner reads at workflow load. The bug-fix seed YAML puts it in
 * `settings.total_repair_budget` per CONTEXT.md decision 18.
 */
export function getTotalRepairBudget(workflowSettings: unknown): number {
  if (!workflowSettings || typeof workflowSettings !== 'object') return DEFAULT_TOTAL_REPAIR_BUDGET
  const v = (workflowSettings as Record<string, unknown>).total_repair_budget
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
    ? Math.floor(v)
    : DEFAULT_TOTAL_REPAIR_BUDGET
}

// ============================================================================
// Attempt counting — query stage_runs for the per-node and global counts.
// ============================================================================

/**
 * Returns the next attempt number for the given (featureId, nodeId). If a
 * previous attempt exists for the same node, returns (max attempt) + 1.
 * Always >= 1.
 */
export async function getNextAttempt(featureId: string, nodeId: string): Promise<number> {
  const rows = await db
    .select({ attempt: stageRuns.attempt })
    .from(stageRuns)
    .where(and(eq(stageRuns.featureId, featureId), eq(stageRuns.nodeId, nodeId)))
  const max = rows.reduce((acc, r) => Math.max(acc, r.attempt ?? 1), 0)
  return max + 1
}

/**
 * Per-node repair count = MAX(attempt) - 1 for this node. (A node that has
 * been attempted 3 times has consumed 2 retries — the 1st attempt is free,
 * the 2nd and 3rd are each "retry" instances.) Global count = sum over nodes.
 */
export async function countRepairBudgetConsumed(featureId: string): Promise<{ perNode: Record<string, number>; total: number }> {
  const rows = await db
    .select({ nodeId: stageRuns.nodeId, attempt: stageRuns.attempt })
    .from(stageRuns)
    .where(eq(stageRuns.featureId, featureId))
  const perNodeMax: Record<string, number> = {}
  for (const r of rows) {
    if (!r.nodeId) continue
    const a = Math.max(1, r.attempt ?? 1)
    if (a > (perNodeMax[r.nodeId] ?? 0)) perNodeMax[r.nodeId] = a
  }
  const perNode: Record<string, number> = {}
  let total = 0
  for (const [nodeId, maxAttempt] of Object.entries(perNodeMax)) {
    const retries = Math.max(0, maxAttempt - 1)
    perNode[nodeId] = retries
    total += retries
  }
  return { perNode, total }
}

/**
 * True when either per-node or global budget is exhausted for the target node.
 * Pass `budgets.consumed` from countRepairBudgetConsumed() — we don't re-query.
 */
export function isBudgetExhausted(
  consumed: { perNode: Record<string, number>; total: number },
  targetNodeId: string,
  budgets: NodeRepairBudget,
): boolean {
  if (consumed.total >= budgets.total) return true
  if ((consumed.perNode[targetNodeId] ?? 0) >= budgets.perNode) return true
  return false
}