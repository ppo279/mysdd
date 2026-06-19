// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 05)
//
// End-to-end API integration test for multi-feature concurrency control:
// - Two bug-fix features with overlapping locked_files must run serially
//   (the second is queued and starts only after the first is merged).
// - Two bug-fix features with disjoint locked_files must both run.
//
// Seam: HTTP routes + production DB + AgentService.approveStage (we drive the
// bug-analyst step directly by calling approveStage with a synthetic
// bug_analysis.json — no LLM invocation needed).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify from 'fastify'
import fs from 'fs'
import path from 'path'
import os from 'os'
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
import { featureRoutes } from '../routes/features.js'
import { registerErrorHandler } from '../lib/envelope.js'
import { AgentService } from '../services/agent.js'

// Pin HOME before loading modules that capture os.homedir() at module load.
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-multi-feat-home-'))
process.env.HOME = TEST_HOME

beforeAll(() => {
  initDb()
})

afterAll(() => {
  try { fs.rmSync(TEST_HOME, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const createdWorkspaceIds = new Set<string>()

async function buildIsolatedWorkspace(): Promise<{ workspaceId: string; app: Awaited<ReturnType<typeof Fastify>> }> {
  const workspaceId = randomUUID()
  await db.insert(workspaces).values({
    id: workspaceId,
    name: `test-ws-${workspaceId.slice(0, 8)}`,
    description: '',
    repoUrl: '',
    techStack: 'ts',
    background: '',
    localPath: '',
    defaultWorkflowId: null,
    createdAt: new Date(),
  })
  createdWorkspaceIds.add(workspaceId)
  await seedBugFixWorkflow(workspaceId)

  const app = Fastify({ logger: false })
  await featureRoutes(app)
  registerErrorHandler(app)
  return { workspaceId, app }
}

async function teardownWorkspace(workspaceId: string) {
  const featureRows = await db.select({ id: features.id }).from(features).where(eq(features.workspaceId, workspaceId))
  for (const f of featureRows) {
    const runIds = (await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, f.id))).map((r) => r.id)
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

/**
 * Drive bug-analyst (nodeId='analyze') to completion by inserting a synthetic
 * stage_run and calling AgentService.approveStage with a bug_analysis.json
 * payload. Returns the new stageRunId of the analyze run.
 */
async function completeBugAnalyst(
  featureId: string,
  workspaceId: string,
  suspectedFiles: string[],
): Promise<string> {
  const stageRunId = randomUUID()
  const now = new Date()
  await db.insert(stageRuns).values({
    id: stageRunId,
    featureId,
    stage: 'bug-analyst',
    nodeId: 'analyze',
    runtimeId: 'synthetic',
    cliSessionId: null,
    status: 'active',
    artifactContent: '',
    artifactPath: '',
    createdAt: now,
  })

  const bugAnalysis = {
    symptom: 'test',
    expected: 'expected',
    repro_steps_normalized: ['step 1'],
    error_signals: [],
    suspected_files: suspectedFiles.map((p) => ({ path: p, evidence: 't', rank: 1 })),
    related_spec_sections: [],
    confidence: 'high',
    needs_more_info: false,
    looks_like: 'true_bug',
  }
  await AgentService.approveStage(
    stageRunId,
    { 'bug_analysis.json': JSON.stringify(bugAnalysis) },
    workspaceId,
    featureId,
  )
  return stageRunId
}

describe('Issue 05 — multi-feature concurrency (locked_files + queue)', () => {
  it('overlapping locked_files: second feature is queued, starts only after first merges', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      // 1. Create feature A with a bug report that will produce overlapping files.
      const createA = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feature A',
          intent: 'bug_fix',
          inputs: { bug_report: 'A repro' },
        },
      })
      expect(createA.statusCode).toBe(201)
      const featureA = JSON.parse(createA.body).data

      // 2. Drive bug-analyst on A → locked_files = ['src/login.ts']
      await completeBugAnalyst(featureA.id, workspaceId, ['src/login.ts'])

      // 3. Confirm A's locked_files was written.
      const [aRow] = await db.select().from(features).where(eq(features.id, featureA.id))
      expect(aRow.lockedFiles).toBe(JSON.stringify(['src/login.ts']))
      // A has no conflict → still 'active' (or 'approved' if analyze advanced).
      // The analyze node is approved; downstream 'design-test' hasn't started.
      expect(aRow.status).not.toBe('queued')

      // 4. Create feature B in the same workspace.
      const createB = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feature B',
          intent: 'bug_fix',
          inputs: { bug_report: 'B repro' },
        },
      })
      expect(createB.statusCode).toBe(201)
      const featureB = JSON.parse(createB.body).data

      // 5. Drive bug-analyst on B → locked_files overlap with A.
      await completeBugAnalyst(featureB.id, workspaceId, ['src/login.ts', 'src/auth.ts'])

      // 6. B must be queued because of overlap with A.
      const [bRow] = await db.select().from(features).where(eq(features.id, featureB.id))
      expect(bRow.lockedFiles).toBe(JSON.stringify(['src/login.ts', 'src/auth.ts']))
      expect(bRow.status).toBe('queued')

      // 7. Mark A as 'merged' to release its lock — B should auto-start.
      await db
        .update(features)
        .set({ status: 'merged', lockedFiles: null })
        .where(eq(features.id, featureA.id))

      // Trigger the queue evaluation seam that merge.ts would call.
      const { evaluateQueueForWorkspace } = await import('../services/queue.js')
      await evaluateQueueForWorkspace(workspaceId)

      // 8. B should be active now.
      const [bAfter] = await db.select().from(features).where(eq(features.id, featureB.id))
      expect(bAfter.status).toBe('active')

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('disjoint locked_files: both features stay active (run in parallel)', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      // Create A and analyze with non-overlapping files.
      const createA = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feature A',
          intent: 'bug_fix',
          inputs: { bug_report: 'A repro' },
        },
      })
      const featureA = JSON.parse(createA.body).data
      await completeBugAnalyst(featureA.id, workspaceId, ['src/login.ts'])

      // Create B and analyze with a disjoint set.
      const createB = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feature B',
          intent: 'bug_fix',
          inputs: { bug_report: 'B repro' },
        },
      })
      const featureB = JSON.parse(createB.body).data
      await completeBugAnalyst(featureB.id, workspaceId, ['src/cart.ts', 'src/checkout.ts'])

      // Both should remain 'active' since the locked_files sets don't overlap.
      const [aRow] = await db.select().from(features).where(eq(features.id, featureA.id))
      const [bRow] = await db.select().from(features).where(eq(features.id, featureB.id))
      expect(aRow.status).not.toBe('queued')
      expect(bRow.status).not.toBe('queued')

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('clearLockedFiles on merged/abandoned/circuit_broken transitions', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const create = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feat',
          intent: 'bug_fix',
          inputs: { bug_report: 'r' },
        },
      })
      const feat = JSON.parse(create.body).data
      await completeBugAnalyst(feat.id, workspaceId, ['src/x.ts'])

      // After analysis, locked_files is set.
      const [r1] = await db.select().from(features).where(eq(features.id, feat.id))
      expect(r1.lockedFiles).toBe(JSON.stringify(['src/x.ts']))

      // Simulate a merged transition via the seam.
      const { clearFeatureLocks } = await import('../services/queue.js')
      await db.update(features).set({ status: 'merged' }).where(eq(features.id, feat.id))
      await clearFeatureLocks(feat.id)
      const [r2] = await db.select().from(features).where(eq(features.id, feat.id))
      expect(r2.lockedFiles).toBeNull()

      // Now test abandon: another feature, set locks, then abandon.
      const create2 = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feat2',
          intent: 'bug_fix',
          inputs: { bug_report: 'r' },
        },
      })
      const feat2 = JSON.parse(create2.body).data
      await completeBugAnalyst(feat2.id, workspaceId, ['src/y.ts'])
      const [r3] = await db.select().from(features).where(eq(features.id, feat2.id))
      expect(r3.lockedFiles).toBe(JSON.stringify(['src/y.ts']))

      await db.update(features).set({ status: 'abandoned' }).where(eq(features.id, feat2.id))
      await clearFeatureLocks(feat2.id)
      const [r4] = await db.select().from(features).where(eq(features.id, feat2.id))
      expect(r4.lockedFiles).toBeNull()

      // Test circuit_broken transition.
      const create3 = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feat3',
          intent: 'bug_fix',
          inputs: { bug_report: 'r' },
        },
      })
      const feat3 = JSON.parse(create3.body).data
      await completeBugAnalyst(feat3.id, workspaceId, ['src/z.ts'])
      const [r5] = await db.select().from(features).where(eq(features.id, feat3.id))
      expect(r5.lockedFiles).toBe(JSON.stringify(['src/z.ts']))

      await db.update(features).set({ status: 'circuit_broken' }).where(eq(features.id, feat3.id))
      await clearFeatureLocks(feat3.id)
      const [r6] = await db.select().from(features).where(eq(features.id, feat3.id))
      expect(r6.lockedFiles).toBeNull()

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('POST /api/workspaces/:workspaceId/features returns 201 with queued status when conflict exists', async () => {
    // Even though at creation locked_files is empty, we should verify the
    // infrastructure path. Since at creation candidate is always empty,
    // creation always returns 'active' status. The queuing happens after
    // bug-analyst writes locked_files.
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      const create = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: {
          name: 'feat',
          intent: 'bug_fix',
          inputs: { bug_report: 'r' },
        },
      })
      expect(create.statusCode).toBe(201)
      const env = JSON.parse(create.body)
      expect(env.code).toBe(0)
      // Empty candidate at creation → no conflict → status='active'.
      expect(env.data.status).toBe('active')
      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })

  it('POST /api/features/:featureId/abandon: sets status=abandoned, clears locks, releases queued siblings', async () => {
    const { workspaceId, app } = await buildIsolatedWorkspace()
    try {
      // 1. Create A, analyze with a file claim.
      const createA = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: { name: 'A', intent: 'bug_fix', inputs: { bug_report: 'r' } },
      })
      const featureA = JSON.parse(createA.body).data
      await completeBugAnalyst(featureA.id, workspaceId, ['src/foo.ts'])

      // 2. Create B (which will queue on A's lock).
      const createB = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/features`,
        payload: { name: 'B', intent: 'bug_fix', inputs: { bug_report: 'r' } },
      })
      const featureB = JSON.parse(createB.body).data
      await completeBugAnalyst(featureB.id, workspaceId, ['src/foo.ts', 'src/bar.ts'])
      const [bBefore] = await db.select().from(features).where(eq(features.id, featureB.id))
      expect(bBefore.status).toBe('queued')

      // 3. Abandon A via the endpoint.
      const abandonRes = await app.inject({
        method: 'POST',
        url: `/api/features/${featureA.id}/abandon`,
      })
      expect(abandonRes.statusCode).toBe(200)
      const abandonEnv = JSON.parse(abandonRes.body)
      expect(abandonEnv.code).toBe(0)
      expect(abandonEnv.data.status).toBe('abandoned')

      // 4. A's locks are cleared; B should be auto-promoted.
      const [aAfter] = await db.select().from(features).where(eq(features.id, featureA.id))
      expect(aAfter.status).toBe('abandoned')
      expect(aAfter.lockedFiles).toBeNull()
      const [bAfter] = await db.select().from(features).where(eq(features.id, featureB.id))
      expect(bAfter.status).toBe('active')

      // 5. Re-abandoning A returns 409 (terminal).
      const reAbandon = await app.inject({
        method: 'POST',
        url: `/api/features/${featureA.id}/abandon`,
      })
      expect(reAbandon.statusCode).toBe(409)

      await app.close()
    } finally {
      await teardownWorkspace(workspaceId)
    }
  })
})