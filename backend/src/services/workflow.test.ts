// Implements: docs/adr/0001-workflow-execution-model.md
// workflow.ts 纯函数单元测试：不依赖 DB / fs / 网络。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BizError, Code } from '../lib/envelope.js'
import type { WorkflowNodeRow, WorkflowEdgeRow } from './workflow.js'

// mock config/agents：validateWorkflow 调用 getAgentConfig()，我们用 mock 替换为白名单。
// 注意：必须在被测模块 import 之前。
const { mockAgentIds } = vi.hoisted(() => ({ mockAgentIds: new Set<string>(['spec', 'plan', 'tasks', 'coding']) }))
vi.mock('../config/agents.js', () => ({
  getAgentConfig: (id: string) => {
    if (!mockAgentIds.has(id)) {
      throw new BizError(Code.INTERNAL, `mock: agent "${id}" not registered`, 500)
    }
    return { id, name: id, runtime: 'claude', instruction: '', outputFile: `${id}.md`, inputs: ['default'], outputs: ['default'] }
  },
}))

const {
  toposort,
  detectCycles,
  validateWorkflow,
  getUpstreamNodes,
  getDownstreamNodes,
  suggestMapping,
} = await import('./workflow.js')

function n(nodeId: string, agentId = nodeId, x = 0, y = 0): WorkflowNodeRow {
  return { nodeId, agentId, positionX: x, positionY: y }
}
function e(fromNodeId: string, toNodeId: string, fromOutput = 'default', toInput = 'default'): WorkflowEdgeRow {
  return { fromNodeId, fromOutput, toNodeId, toInput }
}

beforeEach(() => {
  mockAgentIds.clear()
  // 默认白名单 + 本测试使用的占位 id。
  // 'nonexistent' 不在此处 — 它专门用于测试 "未知 agentId" 拒绝路径
  ;['spec', 'plan', 'tasks', 'coding', 'a', 'b', 'c', 'ghost'].forEach((id) => mockAgentIds.add(id))
})

// ── toposort ─────────────────────────────────────────────────
describe('toposort', () => {
  it('单节点 → [nodeId]', () => {
    expect(toposort({ nodes: [n('a')], edges: [] })).toEqual(['a'])
  })

  it('线性 3 节点：a→b→c → [a,b,c]', () => {
    expect(toposort({ nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c')] })).toEqual(['a', 'b', 'c'])
  })

  it('DAG 有多个就绪点：a→c, b→c → a, b 都在 c 之前', () => {
    const order = toposort({
      nodes: [n('a'), n('b'), n('c')],
      edges: [e('a', 'c'), e('b', 'c')],
    })
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'))
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'))
    expect(order).toHaveLength(3)
  })

  it('空节点 → []', () => {
    expect(toposort({ nodes: [], edges: [] })).toEqual([])
  })

  it('环：a→b→a → 抛 CYCLE_DETECTED', () => {
    expect(() => toposort({ nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('b', 'a')] }))
      .toThrowError(/cycle/i)
  })

  it('自环：a→a → 抛 CYCLE_DETECTED', () => {
    expect(() => toposort({ nodes: [n('a')], edges: [e('a', 'a')] }))
      .toThrowError(/cycle/i)
  })

  it('Tie-break：多个入度 0 节点按 nodeId 升序加入', () => {
    const order = toposort({
      nodes: [n('c'), n('a'), n('b')],
      edges: [],
    })
    // 三个无依赖的节点，按 nodeId 升序
    expect(order).toEqual(['a', 'b', 'c'])
  })
})

// ── detectCycles ─────────────────────────────────────────────
describe('detectCycles', () => {
  it('DAG 无环 → null', () => {
    expect(detectCycles({ nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c')] })).toBeNull()
  })

  it('简单 2 节点环：a→b→a → 返回环路', () => {
    const cycle = detectCycles({ nodes: [n('a'), n('b')], edges: [e('a', 'b'), e('b', 'a')] })
    expect(cycle).toBeTruthy()
    expect(cycle!.length).toBeGreaterThan(0)
    expect(new Set(cycle)).toEqual(new Set(['a', 'b']))
  })

  it('3 节点环：a→b→c→a → 返回含三个节点的环路', () => {
    const cycle = detectCycles({ nodes: [n('a'), n('b'), n('c')], edges: [e('a', 'b'), e('b', 'c'), e('c', 'a')] })
    expect(cycle).toBeTruthy()
    expect(new Set(cycle)).toEqual(new Set(['a', 'b', 'c']))
  })
})

// ── validateWorkflow ─────────────────────────────────────────
describe('validateWorkflow', () => {
  it('happy: 1 节点 0 边 → 通过', () => {
    expect(() => validateWorkflow({ nodes: [n('spec')], edges: [] })).not.toThrow()
  })

  it('happy: 2 节点 1 边 → 通过', () => {
    expect(() => validateWorkflow({ nodes: [n('spec'), n('plan')], edges: [e('spec', 'plan')] })).not.toThrow()
  })

  // Phase 1: 错误码断言——保证 route 层能正确地"向上映射"到 envelope Code
  // 工作流路由（routes/workflows.ts）通过 validateWorkflow 抛 BizError；这里只验证
  // 纯函数也抛出对应 code 的 BizError（route 层做 envelope wrap）。
  it('空 nodes → 抛 BizError code=1011 WORKFLOW_INVALID', () => {
    try {
      validateWorkflow({ nodes: [], edges: [] })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.WORKFLOW_INVALID)
    }
  })

  it('重复 nodeId → 抛 BizError code=1012 NODE_ID_CONFLICT', () => {
    try {
      validateWorkflow({ nodes: [n('a'), n('a')], edges: [] })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.NODE_ID_CONFLICT)
    }
  })

  it('nodeId !== agentId（路线 1 放宽：允许） → 不抛错', () => {
    // CONTEXT.md N2：bug-fix workflow 节点 id 可以与 agent id 不同
    // （如 analyze/design-test/fix/audit 对应 bug-analyst/test-architect/code-surgeon/quality-gatekeeper）。
    // 因此 validateWorkflow 不再强制 nodeId === agentId——此测试应通过。
    expect(() => validateWorkflow({ nodes: [n('spec', 'plan')], edges: [] })).not.toThrow()
  })

  it('重复 agentId（路线 1 放宽：允许多节点复用同 agent） → 不抛错', () => {
    // 路线 1 放宽后，validateWorkflow 不强制 agentId 唯一——上游层
    // (validateWorkflowPorts 输入覆盖 + 拓扑排序) 才是输入消费约束。
    expect(() => validateWorkflow({ nodes: [n('a', 'coding'), n('b', 'coding')], edges: [] })).not.toThrow()
  })

  it('未知 agentId（nodeId === agentId） → 抛 BizError code=1011 WORKFLOW_INVALID', () => {
    try {
      // nodeId === agentId 让检查跳过 NODE_ID_MISMATCH，落入"agent 不在 agents.yaml"分支
      validateWorkflow({ nodes: [n('nonexistent', 'nonexistent')], edges: [] })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.WORKFLOW_INVALID)
    }
  })

  it('边引用未知 fromNodeId → 抛 BizError code=1011', () => {
    try {
      validateWorkflow({ nodes: [n('a')], edges: [e('ghost', 'a')] })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.WORKFLOW_INVALID)
    }
  })

  it('边引用未知 toNodeId → 抛 BizError code=1011', () => {
    try {
      validateWorkflow({ nodes: [n('a')], edges: [e('a', 'ghost')] })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.WORKFLOW_INVALID)
    }
  })

  it('环 → 抛 BizError code=1013 CYCLE_DETECTED', () => {
    try {
      validateWorkflow({
        nodes: [n('a'), n('b')],
        edges: [e('a', 'b'), e('b', 'a')],
      })
      throw new Error('应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(BizError)
      expect((e as BizError).code).toBe(Code.CYCLE_DETECTED)
    }
  })
})

// ── getUpstreamNodes / getDownstreamNodes ────────────────────
describe('getUpstreamNodes / getDownstreamNodes', () => {
  const graph = {
    nodes: [n('a'), n('b'), n('c')],
    edges: [
      e('a', 'b', 'out1', 'in1'),
      e('a', 'c', 'out2', 'in2'),
      e('b', 'c', 'default', 'default'),
    ],
  }

  it('getUpstreamNodes(b) → [a]', () => {
    expect(getUpstreamNodes(graph, 'b')).toEqual(['a'])
  })

  it('getUpstreamNodes(c) → [a, b]', () => {
    const ups = getUpstreamNodes(graph, 'c')
    expect(ups.sort()).toEqual(['a', 'b'])
  })

  it('getUpstreamNodes(b, "in1") → [a]', () => {
    expect(getUpstreamNodes(graph, 'b', 'in1')).toEqual(['a'])
  })

  it('getUpstreamNodes(b, "in_other") → []', () => {
    expect(getUpstreamNodes(graph, 'b', 'in_other')).toEqual([])
  })

  it('getDownstreamNodes(a) → [b, c]', () => {
    const ds = getDownstreamNodes(graph, 'a')
    expect(ds.sort()).toEqual(['b', 'c'])
  })

  it('getDownstreamNodes(c) → []', () => {
    expect(getDownstreamNodes(graph, 'c')).toEqual([])
  })

  it('getDownstreamNodes(a, "out1") → [b]', () => {
    expect(getDownstreamNodes(graph, 'a', 'out1')).toEqual(['b'])
  })
})

// ── Phase 4: suggestMapping ─────────────────────────────────
//   - 1:1 唯一 agentId → high confidence
//   - 重复 agentId → 贪心 + Manhattan tie-break → low confidence
//   - agentId 缺失 → 不返回（前端要用户手动指定）
// ─────────────────────────────────────────────────────────────
describe('suggestMapping', () => {
  it('1:1 唯一 agentId → high confidence', () => {
    const old = [n('a', 'spec'), n('b', 'plan'), n('c', 'coding')]
    const next = [n('a2', 'spec'), n('b2', 'plan'), n('c2', 'coding')]
    const m = suggestMapping(old, next)
    expect(m).toEqual({
      a: { newNodeId: 'a2', confidence: 'high' },
      b: { newNodeId: 'b2', confidence: 'high' },
      c: { newNodeId: 'c2', confidence: 'high' },
    })
  })

  it('新工作流多了一个 agent → 旧的全配 high；多出的不动', () => {
    const old = [n('a', 'spec'), n('b', 'plan')]
    const next = [n('a2', 'spec'), n('b2', 'plan'), n('c2', 'coding')]
    const m = suggestMapping(old, next)
    expect(m.a?.newNodeId).toBe('a2')
    expect(m.b?.newNodeId).toBe('b2')
  })

  it('旧工作流多了一个 agent → 没匹配的旧节点不出现在结果中', () => {
    const old = [n('a', 'spec'), n('b', 'plan'), n('extra', 'coding')]
    const next = [n('a2', 'spec'), n('b2', 'plan')]
    const m = suggestMapping(old, next)
    expect(m.a?.newNodeId).toBe('a2')
    expect(m.b?.newNodeId).toBe('b2')
    expect(m.extra).toBeUndefined()
  })

  it('重复 agentId → Manhattan 距离贪心 + low confidence', () => {
    // 两个 spec 节点；旧 (0,0) 和 (100,0)，新 (10,0) 和 (90,0)
    const old = [n('s1', 'spec', 0, 0), n('s2', 'spec', 100, 0)]
    const next = [n('sA', 'spec', 10, 0), n('sB', 'spec', 90, 0)]
    const m = suggestMapping(old, next)
    expect(m.s1).toEqual({ newNodeId: 'sA', confidence: 'low' })
    expect(m.s2).toEqual({ newNodeId: 'sB', confidence: 'low' })
  })

  it('agentId 不在新工作流里 → 不出现在结果', () => {
    const old = [n('a', 'spec'), n('b', 'ghost')]
    const next = [n('a2', 'spec')]
    const m = suggestMapping(old, next)
    expect(m.a?.newNodeId).toBe('a2')
    expect(m.b).toBeUndefined()
  })

  it('空数组 → {}', () => {
    expect(suggestMapping([], [])).toEqual({})
    expect(suggestMapping([n('a', 'spec')], [])).toEqual({})
    expect(suggestMapping([], [n('a2', 'spec')])).toEqual({})
  })
})
