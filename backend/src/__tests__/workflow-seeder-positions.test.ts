// Regression test: workflow seeders used to hardcode (positionX: 0, positionY: 0)
// for every node, which made the canvas editor render all nodes stacked on top
// of each other (用户访问默认 workflow 时,所有节点都重叠在一起)。
//
// Correct seam: this lives at the seeder boundary. The bug is "data the
// seeder writes" — there's no other call site that decides initial positions.
// So a focused test on the seeder output is the right lock-down.
import { describe, it, expect, afterAll } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db, initDb } from '../db/index.js'
import { workspaces, workflows, workflowNodes, workflowEdges } from '../db/schema.js'
import { seedBugFixWorkflow } from '../services/workflow-seed.js'
import { createInitialWorkflow } from '../services/workflow-bootstrap.js'

initDb()

const createdWorkspaceIds = new Set<string>()
const createdWorkflowIds = new Set<string>()

async function newWorkspace(): Promise<string> {
  const workspaceId = randomUUID()
  createdWorkspaceIds.add(workspaceId)
  await db.insert(workspaces).values({
    id: workspaceId,
    name: `pos-test-${workspaceId.slice(0, 8)}`,
    description: '',
    repoUrl: '',
    techStack: 'ts',
    background: '',
    localPath: '',
    defaultWorkflowId: null,
    createdAt: new Date(),
  })
  return workspaceId
}

afterAll(async () => {
  // 只清本测试创建的 workflow + workspace(按 id 精确匹配,绝不 select 全表)。
  // 旧版错误:select({id: workflowNodes.workflowId}).from(workflowNodes) 拿到所有行,
  // 再 inArray 一刀切,会把 DB 里别的 workflow 节点也删了。
  //
  // 顺序要点:seedBugFixWorkflow / createInitialWorkflow 都会把 workspace.default_workflow_id
  // 指向新建的 workflow,所以先要把这个 FK 断掉,否则删 workflow 时会 FK 报错。
  const wsIds = Array.from(createdWorkspaceIds)
  if (wsIds.length > 0) {
    await db.update(workspaces)
      .set({ defaultWorkflowId: null })
      .where(inArray(workspaces.id, wsIds))
  }
  const wfs = Array.from(createdWorkflowIds)
  if (wfs.length > 0) {
    await db.delete(workflowEdges).where(inArray(workflowEdges.workflowId, wfs))
    await db.delete(workflowNodes).where(inArray(workflowNodes.workflowId, wfs))
    await db.delete(workflows).where(inArray(workflows.id, wfs))
  }
  if (wsIds.length > 0) {
    await db.delete(workspaces).where(inArray(workspaces.id, wsIds))
  }
})

describe('workflow seeder positions', () => {
  it('seedBugFixWorkflow spreads node positions (not all at 0,0)', async () => {
    const workspaceId = await newWorkspace()
    const { workflowId } = await seedBugFixWorkflow(workspaceId)
    createdWorkflowIds.add(workflowId)

    const rows = await db
      .select({ nodeId: workflowNodes.nodeId, x: workflowNodes.positionX, y: workflowNodes.positionY })
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflowId))

    expect(rows.length).toBeGreaterThan(1)
    const allAtOrigin = rows.every((r) => r.x === 0 && r.y === 0)
    expect(allAtOrigin).toBe(false)
    const unique = new Set(rows.map((r) => `${r.x},${r.y}`))
    expect(unique.size).toBe(rows.length)  // 每个节点一个独立位置
  })

  it('createInitialWorkflow spreads node positions (not all at 0,0)', async () => {
    const workspaceId = await newWorkspace()
    const workflowId = await createInitialWorkflow(workspaceId)
    createdWorkflowIds.add(workflowId)

    const rows = await db
      .select({ nodeId: workflowNodes.nodeId, x: workflowNodes.positionX, y: workflowNodes.positionY })
      .from(workflowNodes)
      .where(eq(workflowNodes.workflowId, workflowId))

    expect(rows.length).toBeGreaterThan(1)
    const allAtOrigin = rows.every((r) => r.x === 0 && r.y === 0)
    expect(allAtOrigin).toBe(false)
    const unique = new Set(rows.map((r) => `${r.x},${r.y}`))
    expect(unique.size).toBe(rows.length)
  })
})
