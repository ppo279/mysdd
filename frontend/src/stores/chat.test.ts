// Implements: .scratch/agent-contract-db/issues/04-runtime-contract.md
// slice 04：stores/chat.ts:firstOutputName 来源从 agent.outputs[0] 拿（不再走 configJson 覆盖）。
// artifactContent 初始值用 firstOutputName 当 key；与 stage_run.outputs 合并时保留已有 key。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useChatStore } from './chat'
import { api } from '@/api'

vi.mock('@/api', () => ({
  api: {
    features: {
      get: vi.fn(),
    },
    stages: {
      messages: vi.fn(),
    },
  },
  streamPost: vi.fn(),
}))

function makeFeatureDetail(agentOutputs: string[], nodeId = 'spec') {
  return {
    id: 'feat-1',
    workspaceId: 'ws-1',
    name: 'feat',
    description: '',
    currentStage: nodeId,
    currentWorkflowId: 'wf-1',
    currentNodeId: nodeId,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    intent: 'new_feature',
    lockedFiles: null,
    looksLike: null,
    stageRuns: [],
    nodeStates: {},
    workflow: {
      id: 'wf-1',
      nodes: [
        {
          nodeId,
          agentId: 'spec',
          displayName: 'Spec',
          positionX: 0,
          positionY: 0,
          outputs: [],
          agentOutputs,
        },
      ],
      edges: [],
    },
  }
}

describe('stores/chat#firstOutputName (slice 04)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.features.get).mockReset()
    vi.mocked(api.stages.messages).mockReset()
  })

  it('currentNode.agentOutputs=[x.md, y.md] → artifactContent key = "x.md"', async () => {
    vi.mocked(api.features.get).mockResolvedValue(makeFeatureDetail(['x.md', 'y.md']) as any)
    const chat = useChatStore()
    await chat.loadFeature('feat-1')
    expect(Object.keys(chat.artifactContent)).toEqual(['x.md'])
    expect(chat.artifactContent['x.md']).toBe('')
  })

  it('agentOutputs 为空 → fallback "default"', async () => {
    vi.mocked(api.features.get).mockResolvedValue(makeFeatureDetail([]) as any)
    const chat = useChatStore()
    await chat.loadFeature('feat-1')
    expect(Object.keys(chat.artifactContent)).toEqual(['default'])
  })

  it('已有 stageRun.outputs 时优先用其 key（保留用户已编辑内容）', async () => {
    const detail = makeFeatureDetail(['x.md', 'y.md'])
    detail.stageRuns = [{
      id: 'run-1',
      featureId: 'feat-1',
      stage: 'spec',
      nodeId: 'spec',
      runtimeId: 'claude',
      cliSessionId: 'cli-sess',
      status: 'active',
      artifactContent: '',
      artifactPath: '',
      instructionSnapshot: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      approvedAt: null,
      attempt: 1,
      parentStageRunId: null,
      rejectionReason: null,
      outputs: { 'x.md': '# already edited' },
    } as any]
    vi.mocked(api.features.get).mockResolvedValue(detail)
    const chat = useChatStore()
    await chat.loadFeature('feat-1')
    expect(chat.artifactContent['x.md']).toBe('# already edited')
    expect(chat.artifactContent['y.md']).toBeUndefined()
  })
})
