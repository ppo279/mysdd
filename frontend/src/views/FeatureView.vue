<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NText, NSpin,
  NBreadcrumb, NBreadcrumbItem, NInput, NScrollbar, NTag, NAlert, NDivider,
  useMessage,
} from 'naive-ui'

const route = useRoute()
const router = useRouter()
const featureId = route.params.featureId as string
const workspaceId = route.params.workspaceId as string
const message = useMessage()

const chat = useChatStore()
const inputText = ref('')
const chatScrollRef = ref<InstanceType<typeof NScrollbar> | null>(null)
const isApproving = ref(false)

const STAGE_LABELS: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', tasks: 'Tasks', coding: 'Coding',
}
const STAGE_TYPES: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default'> = {
  spec: 'info', plan: 'default', tasks: 'warning', coding: 'success',
}

const stages = computed(() => chat.featureDetail?.agentOrder ?? [])
const currentStage = computed(() => chat.featureDetail?.currentStage ?? '')
const isDone = computed(() => chat.featureDetail?.status === 'done')
const hasActiveRun = computed(() => !!chat.activeStageRun)
const isActiveRunApproved = computed(() => chat.activeStageRun?.status === 'approved')
const currentStageIdx = computed(() => stages.value.indexOf(currentStage.value))

onMounted(async () => {
  chat.$reset()
  await chat.loadFeature(featureId)
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
      await chat.startStage(featureId, currentStage.value, msg)
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
        <NText depth="3" style="font-size:12px;">Feature ID: {{ featureId.slice(0,8) }}</NText>
      </NSpace>
    </NLayoutHeader>

    <!-- 阶段进度 -->
    <div style="padding: 12px 20px; border-bottom: 1px solid #efeff5; background: #fafafa; flex-shrink: 0;">
      <NSpace align="center" :wrap="false">
        <template v-for="(stage, idx) in stages" :key="stage">
          <NSpace align="center" :size="4">
            <div :style="{
              width: '24px', height: '24px', borderRadius: '50%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', fontSize: '12px', fontWeight: '700',
              background: idx < currentStageIdx || isDone ? '#18a058'
                        : stage === currentStage ? '#2080f0'
                        : '#e0e0e6',
              color: (idx < currentStageIdx || isDone || stage === currentStage) ? '#fff' : '#999',
            }">
              {{ idx < currentStageIdx || isDone ? '✓' : idx + 1 }}
            </div>
            <NText
              :style="{
                fontSize: '13px', fontWeight: stage === currentStage ? '600' : '400',
                color: idx < currentStageIdx || isDone ? '#18a058'
                     : stage === currentStage ? '#2080f0'
                     : '#aaa',
              }"
            >{{ STAGE_LABELS[stage] ?? stage }}</NText>
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
                <div>当前阶段：<NText strong>{{ STAGE_LABELS[currentStage] ?? currentStage }}</NText></div>
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

            <!-- 思考中气泡（thinking / tool 进度） -->
            <div v-if="chat.isStreaming && (chat.thinkingTokens || chat.thinkingText || chat.activeTool || chat.toolLog.length)"
              style="display:flex; flex-direction:column; gap:4px; max-width:88%; align-self:flex-start;">
              <NText depth="3" style="font-size:12px;">Agent · 思考中</NText>
              <div style="padding:10px 14px; border-radius:10px 10px 10px 2px; background:#f7f7ff;
                         font-size:13px; line-height:1.6; white-space:pre-wrap; word-break:break-word;
                         border:1px dashed #c8c8e8;">
                <div style="color:#666; margin-bottom:6px; display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center;">
                  <span>💭 思考中...</span>
                  <span v-if="chat.thinkingTokens > 0" style="color:#888;">≈ {{ chat.thinkingTokens }} tokens</span>
                  <span v-if="chat.activeTool" style="color:#2080f0;">
                    🔧 {{ chat.activeTool.name }}
                  </span>
                  <span v-for="(t, i) in chat.toolLog" :key="i" style="color:#18a058;">
                    ✓ {{ t.name }}
                  </span>
                </div>
                <div v-if="chat.thinkingText" style="color:#444;">{{ chat.thinkingText }}<span style="animation: blink 1s step-end infinite;">▊</span></div>
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
            type="primary"
            :loading="chat.isStreaming"
            :disabled="!inputText.trim() || chat.isStreaming"
            style="align-self:flex-end;"
            @click="handleSend"
          >
            {{ chat.isStreaming ? '生成中...' : '发送' }}
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

        <!-- 产物编辑器 -->
        <NScrollbar style="flex:1;">
          <NInput
            v-model:value="chat.artifactContent"
            type="textarea"
            :rows="20"
            placeholder="Agent 产出的内容将显示在这里，你可以直接编辑..."
            :readonly="isActiveRunApproved"
            style="font-family: 'Courier New', monospace; font-size:13px; border:none; background:transparent; width:100%;"
            :bordered="false"
          />
        </NScrollbar>

        <!-- 批准操作区 -->
        <div v-if="hasActiveRun && !isActiveRunApproved && !isDone"
          style="padding:12px 16px; border-top:1px solid #efeff5; background:#fff; flex-shrink:0;">
          <NText depth="3" style="font-size:12px; display:block; margin-bottom:8px;">
            确认产物内容无误后，点击批准并流转到下一阶段
          </NText>
          <NButton
            type="primary"
            block
            :loading="isApproving"
            :disabled="!chat.artifactContent.trim() || isApproving || chat.isStreaming"
            @click="handleApproveAndAdvance"
          >
            ✓ 批准并进入下一阶段
          </NButton>
        </div>

        <div v-else-if="isActiveRunApproved && !isDone"
          style="padding:12px 16px; border-top:1px solid #efeff5; flex-shrink:0;">
          <NAlert type="success" :show-icon="false" style="font-size:13px;">
            此阶段产物已批准，当前阶段：{{ STAGE_LABELS[currentStage] }}
          </NAlert>
        </div>
      </div>
    </div>
  </NLayout>
</template>

<style>
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
</style>
