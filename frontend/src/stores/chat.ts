import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, streamPost, type Message, type StageRun, type FeatureDetail, type QuestionItem } from '@/api'

export interface ToolCall {
  name: string
  input?: unknown
  status: 'running' | 'done'
}

// Phase 0 起：artifactContent 是按 outputName 索引的 map。
// 默认仅包含 'default'，Phase 3 起会扩展到多 output。
export type ArtifactMap = Record<string, string>

export const useChatStore = defineStore('chat', () => {
  const featureDetail = ref<FeatureDetail | null>(null)
  const messages = ref<Message[]>([])
  const activeStageRun = ref<StageRun | null>(null)
  const streamingText = ref('')
  const isStreaming = ref(false)
  const artifactContent = ref<ArtifactMap>({ default: '' })

  // ── Thinking / Tool 进度（流式期间实时更新） ────────────────────
  const thinkingText = ref('')       // 最近一段思考文本（最多 200 字覆盖式）
  const thinkingTokens = ref(0)      // 累计 token 数（来自 thinking_tokens 事件）
  const activeTool = ref<{ name: string; input?: unknown } | null>(null)
  const toolLog = ref<ToolCall[]>([])// 已完成的工具调用历史
  const pendingQuestions = ref<QuestionItem[] | null>(null) // AskUserQuestion 拦截
  let _abortCtrl: AbortController | null = null  // 当前流的 fetch AbortController

  function resetStreamingProgress() {
    streamingText.value = ''
    thinkingText.value = ''
    thinkingTokens.value = 0
    activeTool.value = null
    toolLog.value = []
    pendingQuestions.value = null
  }

  async function loadFeature(featureId: string) {
    featureDetail.value = await api.features.get(featureId).catch((e) => {
      throw new Error(`加载 Feature 失败: ${e?.message ?? e}`)
    })

    // 找到当前 nodeId 最新的 stageRun（按 nodeId 而非 stage 匹配）
    const currentNodeId = featureDetail.value.currentNodeId
    const runs = featureDetail.value.stageRuns
    const currentRun = [...runs].reverse().find((r) => r.nodeId === currentNodeId)

    // 找到当前节点配置的第一个 output handle 名，approve 时用它作 outputName key，
    // 与 workflow_edges.fromOutput 保持一致，使后端能正确注入上游产物。
    const currentNode = featureDetail.value.workflow.nodes.find(
      (n) => n.nodeId === currentNodeId,
    )
    const firstOutputName = currentNode?.outputs?.[0] ?? 'default'

    if (currentRun) {
      activeStageRun.value = currentRun
      messages.value = await api.stages.messages(currentRun.id)
      // 已有 outputs 时直接用（保持 outputName 一致性）；否则用节点配置的第一个 handle 名
      artifactContent.value = currentRun.outputs && Object.keys(currentRun.outputs).length > 0
        ? { ...currentRun.outputs }
        : { [firstOutputName]: '' }
    } else {
      activeStageRun.value = null
      messages.value = []
      artifactContent.value = { [firstOutputName]: '' }
    }
  }

  // 启动新阶段（第一条消息）。nodeId 是 workflow-scoped 节点 id。
  async function startStage(featureId: string, nodeId: string, firstMessage: string) {
    isStreaming.value = true
    resetStreamingProgress()
    _abortCtrl = new AbortController()

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
        { nodeId, firstMessage, runtimeId: 'claude' },
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
          onQuestion: (qs) => { pendingQuestions.value = qs },
        },
        _abortCtrl?.signal,
      )

      // 流结束后，刷新真实数据
      if (stageRunId) {
        await loadFeature(featureId)
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e
      // AbortError = 用户主动停止，静默处理
    } finally {
      isStreaming.value = false
      streamingText.value = ''
      _abortCtrl = null
    }
  }

  // 续接消息
  async function sendMessage(featureId: string, message: string) {
    if (!activeStageRun.value) return
    isStreaming.value = true
    resetStreamingProgress()
    _abortCtrl = new AbortController()

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
        onQuestion: (qs) => { pendingQuestions.value = qs },
      }, _abortCtrl?.signal)

      // 刷新消息列表
      messages.value = await api.stages.messages(activeStageRun.value.id)
    } catch (e: any) {
      if (e?.name !== 'AbortError') throw e
    } finally {
      isStreaming.value = false
      streamingText.value = ''
    }
  }

  // 停止当前正在进行的流（停止按钮）
  async function abortStage() {
    if (!isStreaming.value) return
    const stageRunId = activeStageRun.value?.id
    // 双重中止：先断 fetch 连接，再通知后端杀进程
    _abortCtrl?.abort()
    if (stageRunId) {
      try { await api.stages.abort(stageRunId) } catch { /* best-effort */ }
    }
  }

  // 把 AskUserQuestion 的选择结果格式化成用户消息发回 Agent
  async function answerQuestion(featureId: string, answers: Array<{ question: string; selected: string[] }>) {
    const lines = answers.map(({ question, selected }) => `**${question}**\n→ ${selected.join(' / ')}`)
    const msg = lines.join('\n\n')
    pendingQuestions.value = null
    await sendMessage(featureId, msg)
  }

  // 批准产物 + 流转
  // Phase 0：单 output 场景，把整个 artifactContent map 发上去。
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
    artifactContent.value = { default: '' }
    thinkingText.value = ''
    thinkingTokens.value = 0
    activeTool.value = null
    toolLog.value = []
    pendingQuestions.value = null
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
    pendingQuestions,
    loadFeature,
    startStage,
    sendMessage,
    abortStage,
    answerQuestion,
    approveAndAdvance,
    $reset,
  }
})
