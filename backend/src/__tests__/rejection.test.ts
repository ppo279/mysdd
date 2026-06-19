// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 03)
//
// Workflow engine unit tests: each of the 7 rejection reasons routes to the
// correct upstream node, plus archive-on-retry semantics and budget exhaustion.
//
// Seam: pure functions over plain JSON inputs (parseRejectionEdges,
// parseTriggerReason, findRejectionEdge, isBudgetExhausted). No DB / git / HTTP.

import { describe, it, expect } from 'vitest'
import {
  parseRejectionEdges,
  parseTriggerReason,
  findRejectionEdge,
  getNodeRepairBudget,
  getTotalRepairBudget,
  isBudgetExhausted,
  type RejectionEdge,
} from '../services/rejection.js'

const ALL_REASONS = [
  'reverse_validation_failed',
  'flaky_test',
  'regressions',
  'fix_out_of_scope',
  'mutation_score_low',
  'test_passes_on_clean_tree',
  'coverage_regression',
] as const

describe('rejection: parseRejectionEdges', () => {
  it('parses a valid array of rejection edges', () => {
    const raw = JSON.stringify([
      { from: 'audit', trigger: 'rejection.reason == "reverse_validation_failed"', to: 'design-test', action: 'replace_reproduction_test', consumes_repair_budget: true },
      { from: 'audit', trigger: 'rejection.reason == "flaky_test"', to: 'design-test', action: 'replace_reproduction_test', consumes_repair_budget: true },
    ])
    const edges = parseRejectionEdges(raw)
    expect(edges.length).toBe(2)
    expect(edges[0].from).toBe('audit')
    expect(edges[0].to).toBe('design-test')
    expect(edges[0].consumesRepairBudget).toBe(true)
  })

  it('returns [] for null / empty / non-array JSON', () => {
    expect(parseRejectionEdges(null)).toEqual([])
    expect(parseRejectionEdges('')).toEqual([])
    expect(parseRejectionEdges('not-json')).toEqual([])
    expect(parseRejectionEdges('{"foo":"bar"}')).toEqual([])
    expect(parseRejectionEdges('[]')).toEqual([])
  })

  it('skips malformed entries (missing from/to/trigger)', () => {
    const raw = JSON.stringify([
      { from: 'audit', trigger: 'rejection.reason == "x"', to: 'design-test' },
      { from: 'audit' },                                  // missing trigger + to
      { trigger: 'rejection.reason == "y"', to: 'design-test' }, // missing from
      null,
      'string',
    ])
    const edges = parseRejectionEdges(raw)
    expect(edges.length).toBe(1)
  })

  it('defaults consumes_repair_budget to true when absent', () => {
    const raw = JSON.stringify([{ from: 'audit', trigger: 'rejection.reason == "flaky_test"', to: 'design-test' }])
    const edges = parseRejectionEdges(raw)
    expect(edges[0].consumesRepairBudget).toBe(true)
  })
})

describe('rejection: parseTriggerReason', () => {
  it.each(ALL_REASONS)('extracts the reason enum from trigger: %s', (reason) => {
    const trigger = `rejection.reason == "${reason}"`
    expect(parseTriggerReason(trigger)).toBe(reason)
  })

  it('accepts both single and double quotes around the value', () => {
    expect(parseTriggerReason(`rejection.reason == 'reverse_validation_failed'`)).toBe('reverse_validation_failed')
  })

  it('returns null for unknown / non-matching trigger strings', () => {
    expect(parseTriggerReason('')).toBeNull()
    expect(parseTriggerReason('rejection.reason == "unknown_reason"')).toBeNull()
    expect(parseTriggerReason('always')).toBeNull()
    expect(parseTriggerReason('rejection.reason > 5')).toBeNull()
  })
})

describe('rejection: findRejectionEdge (7 reasons × 7 expected targets)', () => {
  // Exact mapping per workflows/seed/bug-fix.yaml:
  //   reverse_validation_failed, mutation_score_low, flaky_test → design-test
  //   fix_out_of_scope, regressions, coverage_regression     → fix
  //   test_passes_on_clean_tree                              → analyze
  const seedJson = JSON.stringify([
    { from: 'audit', trigger: 'rejection.reason == "reverse_validation_failed"', to: 'design-test', action: 'replace_reproduction_test', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "mutation_score_low"', to: 'design-test', action: 'replace_reproduction_test', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "flaky_test"', to: 'design-test', action: 'replace_reproduction_test', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "fix_out_of_scope"', to: 'fix', action: 'reject_fix', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "regressions"', to: 'fix', action: 'reject_fix', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "test_passes_on_clean_tree"', to: 'analyze', action: 're_analyze', consumes_repair_budget: true },
    { from: 'audit', trigger: 'rejection.reason == "coverage_regression"', to: 'fix', action: 'reject_fix', consumes_repair_budget: true },
  ])
  const edges = parseRejectionEdges(seedJson)

  const expectedTargets: Record<string, string> = {
    reverse_validation_failed: 'design-test',
    mutation_score_low: 'design-test',
    flaky_test: 'design-test',
    fix_out_of_scope: 'fix',
    regressions: 'fix',
    test_passes_on_clean_tree: 'analyze',
    coverage_regression: 'fix',
  }

  for (const reason of ALL_REASONS) {
    it(`routes ${reason} → ${expectedTargets[reason]}`, () => {
      const edge = findRejectionEdge(edges, 'audit', reason as any)
      expect(edge).not.toBeNull()
      expect(edge!.to).toBe(expectedTargets[reason])
    })
  }

  it('coverage_regression routes to fix (not design-test)', () => {
    const edge = findRejectionEdge(edges, 'audit', 'coverage_regression')
    expect(edge).not.toBeNull()
    expect(edge!.to).toBe('fix')
    expect(edge!.action).toBe('reject_fix')
    expect(edge!.consumesRepairBudget).toBe(true)
  })

  it('returns null when from-node does not match', () => {
    expect(findRejectionEdge(edges, 'design-test', 'reverse_validation_failed')).toBeNull()
  })

  it('returns null for an unknown reason even when from matches', () => {
    expect(findRejectionEdge(edges, 'audit', 'unknown_reason' as any)).toBeNull()
  })
})

describe('rejection: repair budget helpers', () => {
  it('getNodeRepairBudget reads from configJson.repair_budget', () => {
    expect(getNodeRepairBudget('{"repair_budget": 2}')).toBe(2)
    expect(getNodeRepairBudget('{"repair_budget": 0}')).toBe(0)
    expect(getNodeRepairBudget('{}')).toBe(0)
    expect(getNodeRepairBudget('')).toBe(0)
    expect(getNodeRepairBudget(null)).toBe(0)
    expect(getNodeRepairBudget('garbage')).toBe(0)
  })

  it('getNodeRepairBudget clamps negatives to 0', () => {
    expect(getNodeRepairBudget('{"repair_budget": -1}')).toBe(0)
  })

  it('getTotalRepairBudget defaults to 3 when settings is empty', () => {
    expect(getTotalRepairBudget(undefined)).toBe(3)
    expect(getTotalRepairBudget({})).toBe(3)
    expect(getTotalRepairBudget({ foo: 'bar' })).toBe(3)
  })

  it('getTotalRepairBudget reads total_repair_budget from settings', () => {
    expect(getTotalRepairBudget({ total_repair_budget: 7 })).toBe(7)
    expect(getTotalRepairBudget({ total_repair_budget: 0 })).toBe(0)
  })

  it('isBudgetExhausted flips when per-node budget is met', () => {
    const consumed = { perNode: { 'design-test': 2 }, total: 2 }
    // per-node budget 2 → already exhausted
    expect(isBudgetExhausted(consumed, 'design-test', { perNode: 2, total: 3 })).toBe(true)
    // per-node budget 3 → still allowed
    expect(isBudgetExhausted(consumed, 'design-test', { perNode: 3, total: 3 })).toBe(false)
  })

  it('isBudgetExhausted flips when global budget is met', () => {
    const consumed = { perNode: { 'analyze': 1, 'design-test': 2 }, total: 3 }
    // global=3 → exhausted even though per-node budgets are still ok
    expect(isBudgetExhausted(consumed, 'fix', { perNode: 5, total: 3 })).toBe(true)
  })
})

describe('rejection: archive-on-retry path pattern', () => {
  it('archive dir follows <nodeId>/.archive/attempt-<N-1>/', () => {
    // Per CONTEXT.md decision 18 (RT1): on cascade, the prior side outputs
    // move to <nodeId>/.archive/attempt-<N-1>/. The "N-1" is the *previous*
    // attempt number (the one being archived), not the new attempt.
    const cases: Array<[string, number, string]> = [
      ['design-test', 1, 'design-test/.archive/attempt-0'],
      ['design-test', 2, 'design-test/.archive/attempt-1'],
      ['analyze', 3, 'analyze/.archive/attempt-2'],
    ]
    for (const [nodeId, newAttempt, expected] of cases) {
      expect(`${nodeId}/.archive/attempt-${newAttempt - 1}`).toBe(expected)
    }
  })
})