<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import { api } from '@/api'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NText, NSpin,
  NBreadcrumb, NBreadcrumbItem, NInput, NScrollbar, NTag, NAlert, NDivider,
  NTabs, NTabPane, NDropdown, NSelect,
  useMessage,
} from 'naive-ui'
import SwitchWorkflowDialog from '@/views/SwitchWorkflowDialog.vue'

const route = useRoute()
const router = useRouter()
const featureId = route.params.featureId as string
const workspaceId = route.params.workspaceId as string
const message = useMessage()

const chat = useChatStore()
const inputText = ref('')
const chatScrollRef = ref<InstanceType<typeof NScrollbar> | null>(null)
const isApproving = ref(false)

// ── 思考指示器（Claude Code 风格） ───────────────────────────────
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('')
const spinnerIdx = ref(0)
let spinnerTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => chat.isStreaming,
  (v) => {
    if (v) {
      spinnerTimer = setInterval(() => { spinnerIdx.value = (spinnerIdx.value + 1) % SPINNER.length }, 80)
    } else {
      if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null }
      spinnerIdx.value = 0
    }
  },
  { immediate: true },
)
onUnmounted(() => { if (spinnerTimer) clearInterval(spinnerTimer) })

/** 取 thinkingText 最后一行非空内容，用于单行预览 */
const thinkingLastLine = computed(() => {
  const t = chat.thinkingText
  if (!t) return ''
  const lines = t.split('\n').filter((l) => l.trim())
  const last = lines.at(-1) ?? ''
  return last.length > 100 ? '…' + last.slice(-100) : last
})

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

const STAGE_LABELS: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', tasks: 'Tasks', coding: 'Coding',
}
const STAGE_TYPES: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default'> = {
  spec: 'info', plan: 'default', tasks: 'warning', coding: 'success',
}

// 阶段进度条的数据源：当前 workflow 的 nodes 数组（来自 featureDetail.workflow.nodes）
// 顺序即 backend toposort 的结果
const stages = computed(() => chat.featureDetail?.workflow.nodes ?? [])
const currentNodeId = computed(() => chat.featureDetail?.currentNodeId ?? '')
const currentStage = computed(() => chat.featureDetail?.currentStage ?? '')
const isDone = computed(() => chat.featureDetail?.status === 'done')
const hasActiveRun = computed(() => !!chat.activeStageRun)
const isActiveRunApproved = computed(() => chat.activeStageRun?.status === 'approved')
const currentStageIdx = computed(() => stages.value.findIndex((n) => n.nodeId === currentNodeId.value))

// 节点标签：优先用 displayName，否则用 STAGE_LABELS[agentId]，否则原样
function nodeLabel(n: { nodeId: string; agentId: string; displayName: string }): string {
  return n.displayName || STAGE_LABELS[n.agentId] || n.nodeId
}

// Phase 3: 产物按 outputName 分 tab。
// 后端在 GET /api/features/:id 把 stage_run_outputs 拼成 chat.artifactContent；
// 这里从 map 的 keys 推导出 tab 列表（保持 chat store 写入顺序）。
// "default" 这个键永远排在最前，方便老 UI 习惯；其余按字母序。
const artifactOutputNames = computed(() => {
  const keys = Object.keys(chat.artifactContent)
  return [
    ...keys.filter((k) => k === 'default'),
    ...keys.filter((k) => k !== 'default').sort(),
  ]
})
const activeOutputName = ref<string>('default')

watch(artifactOutputNames, (names) => {
  if (!names.includes(activeOutputName.value)) activeOutputName.value = names[0] ?? 'default'
})

// 全部 output 都有非空内容才允许"批准"——避免漏审一个新 output 后被默认批准
const allOutputsHaveContent = computed(() =>
  artifactOutputNames.value.every((k) => (chat.artifactContent[k] ?? '').trim() !== ''),
)

onMounted(async () => {
  chat.$reset()
  try {
    await chat.loadFeature(featureId)
  } catch (e: any) {
    message.error(e.message ?? '加载失败')
  }
  scrollToBottom()
})

watch(
  [
    () => chat.messages.length,
    () => chat.streamingText,
    () => chat.thinkingText,
    () => chat.thinkingTokens,
  ],
  () => {
    nextTick(scrollToBottom)
  },
)

function scrollToBottom() {
  chatScrollRef.value?.scrollTo({ top: 999999, behavior: 'smooth' })
}

async function handleSend() {
  const msg = inputText.value.trim()
  if (!msg || chat.isStreaming) return
  inputText.value = ''

  try {
    if (!hasActiveRun.value) {
      // Phase 0：startStage 用 currentNodeId 而非 currentStage
      await chat.startStage(featureId, currentNodeId.value, msg)
    } else {
      await chat.sendMessage(featureId, msg)
    }
  } catch (e: any) {
    message.error(e.message)
  }
}

async function handleApproveAndAdvance() {
  if (!chat.activeStageRun || isApproving.value) return
  isApproving.value = true
  try {
    await chat.approveAndAdvance(featureId)
    message.success('批准成功，已进入下一阶段')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    isApproving.value = false
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
  }
}

// ── AskUserQuestion 问卡交互 ─────────────────────────────────────
// 每道题的已选 label 列表（单选: 最多1个, 多选: 任意多个）
const questionSelections = ref<string[][]>([])

watch(() => chat.pendingQuestions, (qs) => {
  questionSelections.value = qs ? qs.map(() => []) : []
})

function toggleOption(qi: number, label: string, multi?: boolean) {
  const sel = questionSelections.value[qi] ?? []
  if (multi) {
    const idx = sel.indexOf(label)
    if (idx >= 0) sel.splice(idx, 1)
    else sel.push(label)
  } else {
    questionSelections.value[qi] = sel[0] === label ? [] : [label]
  }
}

const hasQuestionAnswers = computed(() =>
  (chat.pendingQuestions ?? []).every((_, i) => (questionSelections.value[i]?.length ?? 0) > 0),
)

async function submitQuestionAnswers() {
  const qs = chat.pendingQuestions
  if (!qs) return
  const answers = qs.map((q, i) => ({
    question: q.header ?? q.question,
    selected: questionSelections.value[i] ?? [],
  }))
  try {
    await chat.answerQuestion(featureId, answers)
  } catch (e: any) {
    message.error(e.message)
  }
}

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
// 切换工作流：弹窗打开后在弹层内部选择目标 workflow
const showSwitchDialog = ref(false)
const workflowList = ref<Array<{ label: string; value: string }>>([])
const isLoadingWorkflowList = ref(false)

async function openSwitchDialog() {
  if (isLoadingWorkflowList.value) return
  isLoadingWorkflowList.value = true
  try {
    const list = await api.workflows.list(workspaceId)
    workflowList.value = list.map((w) => ({
      label: `${w.name} (${w.isArchived ? '已归档' : 'active'})`,
      value: w.id,
    }))
    if (list.length === 0) {
      message.warning('当前 workspace 还没有 workflow')
      return
    }
    showSwitchDialog.value = true
  } catch (e: any) {
    message.error(`加载 workflow 列表失败: ${e?.message ?? e}`)
  } finally {
    isLoadingWorkflowList.value = false
  }
}

async function onSwitchApplied() {
  // 重新拉 feature 详情，currentWorkflowId / currentNodeId / nodeStates 都已更新
  await chat.loadFeature(featureId)
  message.success('已切换；当前节点已重置')
}
</script>

<template>
  <NLayout style="height: 100vh; display: flex; flex-direction: column;">
    <!-- 顶部导航 -->
    <NLayoutHeader style="padding: 0 20px; border-bottom: 1px solid #efeff5; background: #fff; flex-shrink: 0;">
      <NSpace justify="space-between" align="center" style="height: 48px;">
        <NBreadcrumb>
          <NBreadcrumbItem @click="router.push('/')" style="cursor:pointer;">SDD Multi-Agent</NBreadcrumbItem>
          <NBreadcrumbItem @click="router.push(`/workspace/${workspaceId}`)" style="cursor:pointer;">
            Workspace
          </NBreadcrumbItem>
          <NBreadcrumbItem>{{ chat.featureDetail?.name ?? '...' }}</NBreadcrumbItem>
        </NBreadcrumb>
        <NSpace align="center">
          <NText depth="3" style="font-size:12px;">Feature ID: {{ featureId.slice(0,8) }}</NText>
          <NButton
            size="small"
            :loading="isLoadingWorkflowList"
            @click="openSwitchDialog"
          >
            切换工作流…
          </NButton>
        </NSpace>
      </NSpace>
    </NLayoutHeader>

    <!-- 阶段进度 -->
    <div style="padding: 12px 20px; border-bottom: 1px solid #efeff5; background: #fafafa; flex-shrink: 0;">
      <NSpace align="center" :wrap="false">
        <template v-for="(node, idx) in stages" :key="node.nodeId">
          <NSpace align="center" :size="4">
            <div :style="{
              width: '24px', height: '24px', borderRadius: '50%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700',
              background: idx < currentStageIdx || isDone ? '#18a058'
                        : node.nodeId === currentNodeId ? '#2080f0'
                        : '#e0e0e6',
              color: (idx < currentStageIdx || isDone || node.nodeId === currentNodeId) ? '#fff' : '#999',
            }">
              {{ idx < currentStageIdx || isDone ? '✓' : idx + 1 }}
            </div>
            <NText
              :style="{
                fontSize: '13px', fontWeight: node.nodeId === currentNodeId ? '600' : '400',
                color: idx < currentStageIdx || isDone ? '#18a058'
                     : node.nodeId === currentNodeId ? '#2080f0'
                     : '#aaa',
              }"
            >{{ nodeLabel(node) }}</NText>
          </NSpace>
          <NText v-if="idx < stages.length - 1" depth="3" style="margin: 0 4px;">→</NText>
        </template>
        <NTag v-if="isDone" type="success" size="small" round style="margin-left: 8px;">全部完成 🎉</NTag>
      </NSpace>
    </div>

    <!-- 主体区域 -->
    <div v-if="!chat.featureDetail" style="flex:1;display:flex;align-items:center;justify-content:center;">
      <NSpin size="large" />
    </div>

    <div v-else style="flex:1; display:flex; overflow:hidden;">
      <!-- 左：对话区 -->
      <div style="flex:1; display:flex; flex-direction:column; border-right:1px solid #efeff5; min-width:0;">
        <NScrollbar ref="chatScrollRef" style="flex:1;">
          <div style="padding: 20px; display:flex; flex-direction:column; gap:16px; min-height:100%;">
            <!-- 提示 -->
            <template v-if="!hasActiveRun && !chat.isStreaming">
              <div style="text-align:center; color:#aaa; padding: 48px 0; font-size:14px; line-height:2;">
                <div style="font-size:32px; margin-bottom:12px;">💬</div>
                <div>当前阶段：<NText strong>{{ STAGE_LABELS[currentStage] ?? currentNodeId }}</NText></div>
                <div v-if="!isDone">发送消息以开始与 Agent 对话</div>
                <div v-else style="color:#18a058;">所有阶段已完成 🎉</div>
              </div>
            </template>

            <!-- 消息列表 -->
            <div v-for="msg in chat.messages" :key="msg.id"
              :style="{
                display: 'flex', flexDirection: 'column', gap: '4px', maxWidth: '88%',
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }"
            >
              <NText depth="3" :style="{ fontSize:'12px', textAlign: msg.role==='user'?'right':'left' }">
                {{ msg.role === 'user' ? '你' : 'Agent' }}
              </NText>
              <div :style="{
                padding: '10px 14px', fontSize:'14px', lineHeight:'1.7',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: msg.role === 'user' ? '#2080f0' : '#f0f0f5',
                color: msg.role === 'user' ? '#fff' : '#1a1a2e',
                borderRadius: msg.role === 'user' ? '10px 10px 2px 10px' : '10px 10px 10px 2px',
              }">{{ msg.content }}</div>
            </div>

            <!-- 思考中指示器（Claude Code 风格：紧凑行式） -->
            <div v-if="chat.isStreaming"
              style="align-self:flex-start; max-width:90%; display:flex; flex-direction:column; gap:0; padding:4px 2px;">
              <!-- 已完成工具调用（静态，置顶） -->
              <div v-for="(t, i) in chat.toolLog" :key="i"
                style="display:flex; gap:6px; align-items:center; font-size:12px; color:#aaa; font-family:monospace; line-height:2;">
                <span style="color:#18a058; width:12px; text-align:center;">✓</span>
                <span>{{ t.name }}</span>
              </div>
              <!-- 当前状态行（spinner + 标签） -->
              <div v-if="chat.thinkingTokens || chat.thinkingText || chat.activeTool"
                style="display:flex; gap:6px; align-items:center; font-size:12px; color:#888; font-family:monospace; line-height:2;">
                <span style="width:12px; text-align:center;">{{ SPINNER[spinnerIdx] }}</span>
                <template v-if="chat.activeTool">
                  <span style="color:#2080f0;">{{ chat.activeTool.name }}</span>
                </template>
                <template v-else>
                  <span>Thinking</span>
                  <span v-if="chat.thinkingTokens > 0" style="color:#bbb;">({{ fmtTokens(chat.thinkingTokens) }} tokens)</span>
                </template>
              </div>
              <!-- 当前思考最后一行（单行截断） -->
              <div v-if="thinkingLastLine && !chat.activeTool"
                style="font-size:11px; color:#bbb; font-family:monospace; padding-left:18px;
                       white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:480px;">
                {{ thinkingLastLine }}
              </div>
            </div>

            <!-- 流式输出 -->
            <div v-if="chat.isStreaming && chat.streamingText"
              style="display:flex; flex-direction:column; gap:4px; max-width:88%; align-self:flex-start;">
              <NText depth="3" style="font-size:12px;">Agent</NText>
              <div style="padding:10px 14px; border-radius:10px 10px 10px 2px; background:#f0f0f5;
                         font-size:14px; line-height:1.7; white-space:pre-wrap; word-break:break-word;">
                {{ chat.streamingText }}<span style="animation: blink 1s step-end infinite;">▊</span>
              </div>
            </div>
          </div>
        </NScrollbar>

        <!-- AskUserQuestion 结构化问卡 -->
        <div v-if="chat.pendingQuestions && !chat.isStreaming"
          style="border-top:1px solid #efeff5; padding:12px 16px; display:flex; flex-direction:column; gap:12px; background:#fafafa;">
          <div v-for="(q, qi) in chat.pendingQuestions" :key="qi"
            style="display:flex; flex-direction:column; gap:6px;">
            <div style="font-size:13px; font-weight:600; color:#333;">{{ q.question }}</div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">
              <NButton
                v-for="(opt, oi) in q.options"
                :key="oi"
                size="small"
                :type="questionSelections[qi]?.includes(opt.label) ? 'primary' : 'default'"
                @click="toggleOption(qi, opt.label, q.multiSelect)"
              >
                {{ opt.label }}
                <NText v-if="opt.description" depth="3" style="font-size:11px; margin-left:4px;">
                  — {{ opt.description }}
                </NText>
              </NButton>
            </div>
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end;">
            <NButton size="small" @click="chat.pendingQuestions = null">忽略</NButton>
            <NButton
              size="small"
              type="primary"
              :disabled="!hasQuestionAnswers"
              @click="submitQuestionAnswers"
            >发送答案</NButton>
          </div>
        </div>

        <!-- 输入区 -->
        <div v-if="!isDone"
          style="padding:12px 16px; border-top:1px solid #efeff5; display:flex; gap:8px; align-items:flex-end;">
          <NInput
            v-model:value="inputText"
            type="textarea"
            :rows="3"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
            :disabled="chat.isStreaming"
            style="flex:1;"
            @keydown="onKeydown"
          />
          <NButton
            v-if="chat.isStreaming"
            type="error"
            style="align-self:flex-end;"
            @click="chat.abortStage()"
          >
            ■ 停止
          </NButton>
          <NButton
            v-else
            type="primary"
            :disabled="!inputText.trim()"
            style="align-self:flex-end;"
            @click="handleSend"
          >
            发送
          </NButton>
        </div>
      </div>

      <!-- 右：产物区 -->
      <div style="width:440px; flex-shrink:0; display:flex; flex-direction:column; background:#fafafa;">
        <!-- 产物头 -->
        <div style="padding:12px 16px; border-bottom:1px solid #efeff5; background:#fff; flex-shrink:0; display:flex; justify-content:space-between; align-items:center;">
          <NSpace align="center" :size="8">
            <NText strong style="font-size:14px;">
              产物：{{ STAGE_LABELS[currentStage] ?? currentStage }}
            </NText>
            <NTag v-if="isActiveRunApproved" type="success" size="small" round>已批准</NTag>
          </NSpace>
        </div>

        <!-- 产物编辑器（Phase 3：按 outputName 分 tab；旧版本仅 'default'） -->
        <NScrollbar style="flex:1;">
          <NTabs
            v-if="artifactOutputNames.length > 0"
            v-model:value="activeOutputName"
            type="line"
            size="small"
            style="height:100%; display:flex; flex-direction:column;"
            pane-style="padding: 8px 12px;"
          >
            <NTabPane
              v-for="name in artifactOutputNames"
              :key="name"
              :name="name"
              :tab="name"
              style="height:calc(100% - 40px);"
            >
              <NInput
                :value="chat.artifactContent[name] ?? ''"
                @update:value="(v: string) => { chat.artifactContent[name] = v }"
                type="textarea"
                :rows="20"
                :placeholder="`output ${name} — Agent 产出的内容将显示在这里，你可以直接编辑...`"
                :readonly="isActiveRunApproved"
                style="font-family: 'Courier New', monospace; font-size:13px; border:none; background:transparent; width:100%; height:100%;"
                :bordered="false"
              />
            </NTabPane>
          </NTabs>
          <div v-else style="padding:16px; color:#aaa; font-size:13px;">
            暂无产物
          </div>
        </NScrollbar>

        <!-- 批准操作区 -->
        <div v-if="hasActiveRun && !isActiveRunApproved && !isDone"
          style="padding:12px 16px; border-top:1px solid #efeff5; background:#fff; flex-shrink:0;">
          <NText depth="3" style="font-size:12px; display:block; margin-bottom:8px;">
            确认所有 output（{{ artifactOutputNames.join('、') }}）均有内容后，点击批准并流转
          </NText>
          <NButton
            type="primary"
            block
            :loading="isApproving"
            :disabled="!allOutputsHaveContent || isApproving || chat.isStreaming"
            @click="handleApproveAndAdvance"
          >
            ✓ 批准并进入下一阶段
          </NButton>
        </div>

        <div v-else-if="isActiveRunApproved && !isDone"
          style="padding:12px 16px; border-top:1px solid #efeff5; flex-shrink:0;">
          <NAlert type="success" :show-icon="false" style="font-size:13px;">
            此阶段产物已批准，当前节点：{{ currentNodeId }}
          </NAlert>
        </div>
      </div>
    </div>

    <!-- 切换工作流弹窗 -->
    <SwitchWorkflowDialog
      v-model:show="showSwitchDialog"
      :feature="chat.featureDetail"
      :workflow-options="workflowList"
      @applied="onSwitchApplied"
    />
  </NLayout>
</template>

<style>
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
</style>
