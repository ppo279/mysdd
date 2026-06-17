import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, streamPost, type Message, type StageRun, type FeatureDetail } from '@/api'

export interface ToolCall {
  name: string
  input?: unknown
  status: 'running' | 'done'
}

export const useChatStore = defineStore('chat', () => {
  const featureDetail = ref<FeatureDetail | null>(null)
  const messages = ref<Message[]>([])
  const activeStageRun = ref<StageRun | null>(null)
  const streamingText = ref('')
  const isStreaming = ref(false)
  const artifactContent = ref('')

  // ── Thinking / Tool 进度（流式期间实时更新） ────────────────────
  const thinkingText = ref('')       // 最近一段思考文本（最多 200 字覆盖式）
  const thinkingTokens = ref(0)      // 累计 token 数（来自 thinking_tokens 事件）
  const activeTool = ref<{ name: string; input?: unknown } | null>(null)
  const toolLog = ref<ToolCall[]>([])// 已完成的工具调用历史

  function resetStreamingProgress() {
    streamingText.value = ''
    thinkingText.value = ''
    thinkingTokens.value = 0
    activeTool.value = null
    toolLog.value = []
  }

  async function loadFeature(featureId: string) {
    featureDetail.value = await api.features.get(featureId)

    // 找到当前阶段最新的 stageRun
    const currentStage = featureDetail.value.currentStage
    const runs = featureDetail.value.stageRuns
    const currentRun = [...runs].reverse().find((r) => r.stage === currentStage)

    if (currentRun) {
      activeStageRun.value = currentRun
      messages.value = await api.stages.messages(currentRun.id)
      artifactContent.value = currentRun.artifactContent
    } else {
      activeStageRun.value = null
      messages.value = []
      artifactContent.value = ''
    }
  }

  // 启动新阶段（第一条消息）
  async function startStage(featureId: string, stage: string, firstMessage: string) {
    isStreaming.value = true
    resetStreamingProgress()

    // 乐观添加用户消息
    messages.value.push({
      id: 'tmp-user',
      stageRunId: '',
      role: 'user',
      content: firstMessage,
      createdAt: new Date().toISOString(),
    })

    try {
      const url = api.stages.startUrl(featureId)
      const { stageRunId } = await streamPost(
        url,
        { stage, firstMessage, runtimeId: 'claude' },
        {
          onText: (t) => { streamingText.value += t },
          onThinking: (info) => {
            if (typeof info.tokensTotal === 'number') thinkingTokens.value = info.tokensTotal
            if (info.text) thinkingText.value = info.text.slice(-200)
          },
          onTool: (info) => {
            if (info.phase === 'start') {
              activeTool.value = { name: info.name, input: info.input }
            } else {
              activeTool.value = null
              toolLog.value.push({ name: info.name, status: 'done' })
            }
          },
        },
      )

      // 流结束后，刷新真实数据
      if (stageRunId) {
        await loadFeature(featureId)
      }
    } finally {
      isStreaming.value = false
      streamingText.value = ''
    }
  }

  // 续接消息
  async function sendMessage(featureId: string, message: string) {
    if (!activeStageRun.value) return
    isStreaming.value = true
    resetStreamingProgress()

    messages.value.push({
      id: 'tmp-user-' + Date.now(),
      stageRunId: activeStageRun.value.id,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    })

    try {
      const url = api.stages.messageUrl(activeStageRun.value.id)
      await streamPost(url, { message }, {
        onText: (t) => { streamingText.value += t },
        onThinking: (info) => {
          if (typeof info.tokensTotal === 'number') thinkingTokens.value = info.tokensTotal
          if (info.text) thinkingText.value = info.text.slice(-200)
        },
        onTool: (info) => {
          if (info.phase === 'start') {
            activeTool.value = { name: info.name, input: info.input }
          } else {
            activeTool.value = null
            toolLog.value.push({ name: info.name, status: 'done' })
          }
        },
      })

      // 刷新消息列表
      messages.value = await api.stages.messages(activeStageRun.value.id)
    } finally {
      isStreaming.value = false
      streamingText.value = ''
    }
  }

  // 批准产物 + 流转
  async function approveAndAdvance(featureId: string) {
    if (!activeStageRun.value) return
    await api.stages.approve(activeStageRun.value.id, artifactContent.value)
    await api.features.advance(featureId)
    await loadFeature(featureId)
  }

  function $reset() {
    featureDetail.value = null
    messages.value = []
    activeStageRun.value = null
    streamingText.value = ''
    isStreaming.value = false
    artifactContent.value = ''
    thinkingText.value = ''
    thinkingTokens.value = 0
    activeTool.value = null
    toolLog.value = []
  }

  return {
    featureDetail,
    messages,
    activeStageRun,
    streamingText,
    isStreaming,
    artifactContent,
    thinkingText,
    thinkingTokens,
    activeTool,
    toolLog,
    loadFeature,
    startStage,
    sendMessage,
    approveAndAdvance,
    $reset,
  }
})
