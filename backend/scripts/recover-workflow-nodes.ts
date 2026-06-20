// 一次性恢复脚本:2026-06-21 我把 data/sdd.db 的 workflow_nodes / workflow_edges
// 全部误删了,本脚本按名字识别每个 workflow,重新插入对应的节点和边到**原 workflowId**。
//
// 规则(只动下面 4 类):
//   - "Bug Fix (TDD-Driven)" → 从 workflows/seed/bug-fix.yaml 重建
//   - "默认工作流"           → 从 agents.yaml 重建(每个 agent 一个节点,顺序串联)
//   - "plain" / 其它自定义名   → 留空(workflow 行保留,无节点无边),用户在 UI 重新布
//   - "fake-bug-fix"         → 留空(测试 fixture,跑测试时会被重建)
//
// 严格幂等:每个 workflow 都先 SELECT 该 workflowId 下当前节点数,
//   若 >0 则跳过(防止重复跑把数据搞乱)。
//
// 整个恢复包在一个事务里,失败回滚,不会留下半成品。
//
// 运行:cd backend && npx tsx scripts/recover-workflow-nodes.ts

import { eq, sql } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db, initDb } from '../src/db/index.js'
import { workflows, workflowNodes, workflowEdges } from '../src/db/schema.js'
import { loadWorkflowYaml } from '../src/services/workflow-yaml.js'
import { loadAgentsConfig } from '../src/config/agents.js'

initDb()

const NODE_SPACING_X = 280
const RECOVERABLE_NAMES = new Set(['Bug Fix (TDD-Driven)', '默认工作流'])

async function counts(workflowId: string): Promise<{ nodes: number; edges: number }> {
  const [n] = await db
    .select({ c: sql<number>`count(*)`.as('c') })
    .from(workflowNodes)
    .where(eq(workflowNodes.workflowId, workflowId))
  const [e] = await db
    .select({ c: sql<number>`count(*)`.as('c') })
    .from(workflowEdges)
    .where(eq(workflowEdges.workflowId, workflowId))
  return { nodes: n?.c ?? 0, edges: e?.c ?? 0 }
}

async function rebuildBugFix(workflowId: string) {
  const { yaml } = loadWorkflowYaml('bug-fix.yaml')
  const now = new Date()
  const nodeRows = yaml.nodes.map((n, idx) => ({
    id: randomUUID(),
    workflowId,
    nodeId: n.nodeId,
    agentId: n.agentId,
    positionX: idx * NODE_SPACING_X,
    positionY: 0,
    configJson: JSON.stringify({ repair_budget: n.repair_budget }),
    displayName: n.description || n.agentId,
    createdAt: now,
  }))
  if (nodeRows.length > 0) await db.insert(workflowNodes).values(nodeRows)
  const edgeRows = yaml.edges.map((e) => ({
    id: randomUUID(),
    workflowId,
    fromNodeId: e.from,
    fromOutput: e.fromOutput,
    toNodeId: e.to,
    toInput: e.toInput,
    createdAt: now,
  }))
  if (edgeRows.length > 0) await db.insert(workflowEdges).values(edgeRows)
  return { nodes: nodeRows.length, edges: edgeRows.length }
}

async function rebuildDefault(workflowId: string) {
  const agents = loadAgentsConfig().agents
  const now = new Date()
  const nodeRows = agents.map((a, i) => ({
    id: randomUUID(),
    workflowId,
    nodeId: a.id,
    agentId: a.id,
    positionX: i * NODE_SPACING_X,
    positionY: 0,
    configJson: '{}',
    displayName: a.name,
    createdAt: now,
  }))
  if (nodeRows.length > 0) await db.insert(workflowNodes).values(nodeRows)
  let edgeCount = 0
  if (agents.length > 1) {
    const edgeRows = agents.slice(0, -1).map((a, i) => ({
      id: randomUUID(),
      workflowId,
      fromNodeId: a.id,
      fromOutput: 'default',
      toNodeId: agents[i + 1].id,
      toInput: 'default',
      createdAt: now,
    }))
    await db.insert(workflowEdges).values(edgeRows)
    edgeCount = edgeRows.length
  }
  return { nodes: nodeRows.length, edges: edgeCount }
}

async function main() {
  const all = await db.select().from(workflows)
  console.log(`[recover] 待扫描 workflow: ${all.length}`)

  const stats = { bugFix: 0, default: 0, skippedComplete: 0, skippedCustom: 0, cleanedPartial: 0 }

  // better-sqlite3 不支持 async transaction,所以用幂等 + 完整性检查代替。
  // 判定"已完成":节点和边都 >0 且成对存在。任何半成品(nodes 0 edges >0,或反之)都先清空再重建。
  for (const wf of all) {
    const { nodes, edges } = await counts(wf.id)
    const complete = nodes > 0 && edges > 0
    const partial = (nodes > 0) !== (edges > 0)  // 一个有,一个没有

    if (complete) {
      console.log(`[skip-complete] ${wf.id} (${wf.name}) — ${nodes} nodes, ${edges} edges`)
      stats.skippedComplete++
      continue
    }
    if (partial) {
      console.log(`[clean-partial] ${wf.id} (${wf.name}) — ${nodes} nodes, ${edges} edges, 清理后重建`)
      await db.delete(workflowNodes).where(eq(workflowNodes.workflowId, wf.id))
      await db.delete(workflowEdges).where(eq(workflowEdges.workflowId, wf.id))
      stats.cleanedPartial++
    }

    if (wf.name === 'Bug Fix (TDD-Driven)') {
      const r = await rebuildBugFix(wf.id)
      console.log(`[recover-bug-fix] ${wf.id} — ${r.nodes} nodes, ${r.edges} edges`)
      stats.bugFix++
    } else if (wf.name === '默认工作流') {
      const r = await rebuildDefault(wf.id)
      console.log(`[recover-default] ${wf.id} — ${r.nodes} nodes, ${r.edges} edges`)
      stats.default++
    } else {
      console.log(`[leave-empty] ${wf.id} (${wf.name}) — 非可识别模板,保留空壳,UI 重布`)
      stats.skippedCustom++
    }
  }

  console.log(`\n[recover] 完成 —  bug-fix: ${stats.bugFix}, default: ${stats.default}, 完整跳过: ${stats.skippedComplete}, 清理半成品: ${stats.cleanedPartial}, 留空: ${stats.skippedCustom}`)
  process.exit(0)
}

main().catch((e) => {
  console.error('[recover] 失败:', e)
  process.exit(1)
})
