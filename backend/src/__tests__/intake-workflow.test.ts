// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
// Workflow engine unit test: workflow with __intake__ node creates the synthetic
// stage_run and the first real node can read its inputs.
//
// Seam: 纯函数 + DB（用 production DB，test workspace 隔离）。
import { describe, it, expect, afterAll } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db, initDb } from '../db/index.js'
import {
  workspaces,
  workflows,
  workflowNodes,
  workflowEdges,
  features,
  stageRuns,
  stageRunOutputs,
  featureNodeStates,
  messages,
} from '../db/schema.js'
import { createSyntheticIntakeRun, INTAKE } from '../services/intake.js'
import { AgentService } from '../services/agent.js'

initDb()

const createdWorkspaceIds = new Set<string>()

afterAll(async () => {
  const { inArray } = await import('drizzle-orm')
  for (const wsId of createdWorkspaceIds) {
    const featureRows = await db.select({ id: features.id }).from(features).where(eq(features.workspaceId, wsId))
    for (const f of featureRows) {
      const runIds = (await db.select({ id: stageRuns.id }).from(stageRuns).where(eq(stageRuns.featureId, f.id))).map((r) => r.id)
      if (runIds.length > 0) {
        await db.delete(messages).where(inArray(messages.stageRunId, runIds))
      }
      await db.delete(stageRuns).where(eq(stageRuns.featureId, f.id))
      await db.delete(featureNodeStates).where(eq(featureNodeStates.featureId, f.id))
    }
    await db.delete(features).where(eq(features.workspaceId, wsId))
    await db.delete(workspaces).where(eq(workspaces.id, wsId))
  }
})

interface FakeWorkflow {
  workspaceId: string
  workflowId: string
  featureId: string
}

async function buildFakeBugFixWorkflow(): Promise<FakeWorkflow> {
  const workspaceId = randomUUID()
  const workflowId = randomUUID()
  const featureId = randomUUID()
  createdWorkspaceIds.add(workspaceId)

  await db.insert(workspaces).values({
    id: workspaceId,
    name: 'fake', description: '', repoUrl: '', techStack: 'ts', background: '',
    localPath: '', defaultWorkflowId: null, createdAt: new Date(),
  })
  await db.insert(workflows).values({
    id: workflowId,
    workspaceId,
    name: 'fake-bug-fix',
    description: '',
    isArchived: 0,
    inputsJson: JSON.stringify([{ name: 'bug_report', type: 'file', required: true }]),
    rejectionEdgesJson: '[]',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  await db.insert(workflowNodes).values({
    id: randomUUID(), workflowId, nodeId: 'analyze', agentId: 'bug-analyst',
    positionX: 0, positionY: 0, configJson: '{}', displayName: 'analyze', createdAt: new Date(),
  })
  // 边：__intake__ (bug_report) → analyze (bug_report)
  await db.insert(workflowEdges).values({
    id: randomUUID(), workflowId,
    fromNodeId: INTAKE.NODE_ID, fromOutput: 'bug_report',
    toNodeId: 'analyze', toInput: 'bug_report',
    createdAt: new Date(),
  })
  await db.insert(features).values({
    id: featureId,
    workspaceId,
    name: 'fake-feat',
    description: '',
    currentStage: 'analyze',
    currentWorkflowId: workflowId,
    currentNodeId: 'analyze',
    status: 'active',
    intent: 'bug_fix',
    lockedFiles: null,
    looksLike: null,
    createdAt: new Date(),
  })

  return { workspaceId, workflowId, featureId }
}

describe('workflow engine: __intake__ virtual node', () => {
  it('createSyntheticIntakeRun writes a synthetic stage_run with status=approved', async () => {
    const { workspaceId, featureId } = await buildFakeBugFixWorkflow()
    const result = await createSyntheticIntakeRun(featureId, workspaceId, {
      bug_report: '# My bug\nsteps to reproduce',
    })
    expect(result).not.toBeNull()
    expect(result!.stageRunId).toBeTruthy()

    const runs = await db.select().from(stageRuns).where(and(eq(stageRuns.featureId, featureId), eq(stageRuns.nodeId, '__intake__')))
    expect(runs.length).toBe(1)
    expect(runs[0].status).toBe('approved')
    expect(runs[0].runtimeId).toBe('synthetic')

    const outputs = await db.select().from(stageRunOutputs).where(eq(stageRunOutputs.stageRunId, runs[0].id))
    const bugReport = outputs.find((o) => o.outputName === 'bug_report')
    expect(bugReport?.content).toContain('steps to reproduce')
  })

  it('createSyntheticIntakeRun returns null when workflow declares no inputs', async () => {
    const workspaceId = randomUUID()
    const workflowId = randomUUID()
    const featureId = randomUUID()
    createdWorkspaceIds.add(workspaceId)
    await db.insert(workspaces).values({
      id: workspaceId, name: 'noinputs', description: '', repoUrl: '', techStack: 'ts',
      background: '', localPath: '', defaultWorkflowId: null, createdAt: new Date(),
    })
    await db.insert(workflows).values({
      id: workflowId, workspaceId, name: 'plain', description: '', isArchived: 0,
      inputsJson: '[]', rejectionEdgesJson: '[]', createdAt: new Date(), updatedAt: new Date(),
    })
    await db.insert(features).values({
      id: featureId, workspaceId, name: 'f', description: '',
      currentStage: 'spec', currentWorkflowId: workflowId, currentNodeId: 'spec',
      status: 'active', intent: 'new_feature', lockedFiles: null, looksLike: null,
      createdAt: new Date(),
    })
    const result = await createSyntheticIntakeRun(featureId, workspaceId, {})
    expect(result).toBeNull()
  })

  it('first real node (analyze) can read __intake__ side outputs via collectUpstreamArtifacts', async () => {
    const { workspaceId, featureId, workflowId } = await buildFakeBugFixWorkflow()
    const content = '## Repro\n1. open /login\n2. submit empty form\n3. observe 500'
    await createSyntheticIntakeRun(featureId, workspaceId, { bug_report: content })

    const nodes = await db.select().from(workflowNodes).where(eq(workflowNodes.workflowId, workflowId))
    const edges = await db.select().from(workflowEdges).where(eq(workflowEdges.workflowId, workflowId))

    const upstream = await AgentService.collectUpstreamArtifacts(featureId, 'analyze', edges, nodes)
    expect(upstream.length).toBe(1)
    expect(upstream[0].fromNodeId).toBe('__intake__')
    expect(upstream[0].fromOutput).toBe('bug_report')
    expect(upstream[0].toInput).toBe('bug_report')
    expect(upstream[0].content).toBe(content)
  })

  it('createSyntheticIntakeRun throws when required input is missing', async () => {
    const { workspaceId, featureId } = await buildFakeBugFixWorkflow()
    await expect(
      createSyntheticIntakeRun(featureId, workspaceId, {}),
    ).rejects.toThrow(/bug_report/)
  })
})