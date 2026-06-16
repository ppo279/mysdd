<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useChatStore } from '@/stores/chat'

const route = useRoute()
const router = useRouter()
const featureId = route.params.featureId as string
const workspaceId = route.params.workspaceId as string

const chat = useChatStore()
const inputText = ref('')
const chatBottom = ref<HTMLElement | null>(null)
const isApproving = ref(false)
const showArtifact = ref(true)

const STAGE_LABELS: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', tasks: 'Tasks', coding: 'Coding',
}

const stages = computed(() => chat.featureDetail?.agentOrder ?? [])
const currentStage = computed(() => chat.featureDetail?.currentStage ?? '')
const isDone = computed(() => chat.featureDetail?.status === 'done')
const hasActiveRun = computed(() => !!chat.activeStageRun)
const isActiveRunApproved = computed(() => chat.activeStageRun?.status === 'approved')

onMounted(async () => {
  chat.$reset()
  await chat.loadFeature(featureId)
  scrollToBottom()
})

watch([() => chat.messages.length, () => chat.streamingText], () => {
  nextTick(scrollToBottom)
})

function scrollToBottom() {
  chatBottom.value?.scrollIntoView({ behavior: 'smooth' })
}

async function handleSend() {
  const msg = inputText.value.trim()
  if (!msg || chat.isStreaming) return
  inputText.value = ''

  if (!hasActiveRun.value) {
    await chat.startStage(featureId, currentStage.value, msg)
  } else {
    await chat.sendMessage(featureId, msg)
  }
}

async function handleApproveAndAdvance() {
  if (!chat.activeStageRun || isApproving.value) return
  isApproving.value = true
  try {
    await chat.approveAndAdvance(featureId)
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
  <div class="feature-view">
    <!-- 顶部导航 -->
    <nav class="breadcrumb">
      <span class="link" @click="router.push('/')">SDD Multi-Agent</span>
      <span class="sep">/</span>
      <span class="link" @click="router.push(`/workspace/${workspaceId}`)">
        {{ chat.featureDetail?.name ?? '...' }}
      </span>
      <span class="sep">/</span>
      <span>{{ chat.featureDetail?.name }}</span>
    </nav>

    <!-- 阶段进度条 -->
    <div class="stage-bar">
      <div
        v-for="(stage, idx) in stages"
        :key="stage"
        class="stage-step"
        :class="{
          active: stage === currentStage,
          done: stages.indexOf(currentStage) > idx || isDone,
        }"
      >
        <div class="step-dot">{{ idx + 1 }}</div>
        <div class="step-label">{{ STAGE_LABELS[stage] ?? stage }}</div>
      </div>
      <div v-if="isDone" class="stage-step done">
        <div class="step-dot">✓</div>
        <div class="step-label">完成</div>
      </div>
    </div>

    <!-- 主体区域 -->
    <div class="main-area">
      <!-- 左：对话区 -->
      <div class="chat-panel">
        <div class="chat-messages">
          <template v-if="!hasActiveRun && !chat.isStreaming">
            <div class="chat-hint">
              <p>当前阶段：<strong>{{ STAGE_LABELS[currentStage] }}</strong></p>
              <p v-if="!isDone">发送消息以开始与 Agent 对话</p>
              <p v-else>所有阶段已完成 🎉</p>
            </div>
          </template>

          <div
            v-for="msg in chat.messages"
            :key="msg.id"
            class="message"
            :class="msg.role"
          >
            <div class="msg-role">{{ msg.role === 'user' ? '你' : 'Agent' }}</div>
            <div class="msg-content">{{ msg.content }}</div>
          </div>

          <!-- 流式输出中 -->
          <div v-if="chat.isStreaming && chat.streamingText" class="message assistant streaming">
            <div class="msg-role">Agent</div>
            <div class="msg-content">{{ chat.streamingText }}<span class="cursor">▊</span></div>
          </div>

          <div ref="chatBottom" />
        </div>

        <!-- 输入框 -->
        <div v-if="!isDone" class="chat-input-area">
          <textarea
            v-model="inputText"
            class="chat-input"
            placeholder="输入消息，Enter 发送，Shift+Enter 换行..."
            :disabled="chat.isStreaming"
            rows="3"
            @keydown="onKeydown"
          />
          <button
            class="send-btn"
            :disabled="!inputText.trim() || chat.isStreaming"
            @click="handleSend"
          >
            {{ chat.isStreaming ? '生成中...' : '发送' }}
          </button>
        </div>
      </div>

      <!-- 右：产物区 -->
      <div class="artifact-panel">
        <div class="artifact-header">
          <span class="artifact-title">
            产物：{{ STAGE_LABELS[currentStage] }}
            <span v-if="isActiveRunApproved" class="approved-tag">已批准</span>
          </span>
          <button class="toggle-btn" @click="showArtifact = !showArtifact">
            {{ showArtifact ? '收起' : '展开' }}
          </button>
        </div>

        <textarea
          v-if="showArtifact"
          v-model="chat.artifactContent"
          class="artifact-editor"
          placeholder="Agent 产出的内容将显示在这里，你可以直接编辑..."
          :readonly="isActiveRunApproved"
        />

        <div v-if="showArtifact && hasActiveRun && !isActiveRunApproved && !isDone" class="artifact-actions">
          <p class="artifact-tip">确认产物内容无误后，点击批准并流转到下一阶段</p>
          <button
            class="approve-btn"
            :disabled="!chat.artifactContent.trim() || isApproving || chat.isStreaming"
            @click="handleApproveAndAdvance"
          >
            {{ isApproving ? '处理中...' : '✓ 批准并进入下一阶段' }}
          </button>
        </div>

        <div v-if="isActiveRunApproved && !isDone" class="artifact-actions">
          <p class="artifact-tip approved-msg">此阶段产物已批准，当前阶段：{{ STAGE_LABELS[currentStage] }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.feature-view { display: flex; flex-direction: column; height: 100vh; padding: 0; overflow: hidden; }

.breadcrumb {
  font-size: 0.82rem; color: #94a3b8; padding: 12px 24px;
  border-bottom: 1px solid #f1f5f9; flex-shrink: 0;
}
.breadcrumb .link { cursor: pointer; color: #6366f1; }
.breadcrumb .link:hover { text-decoration: underline; }
.breadcrumb .sep { margin: 0 6px; }

/* 阶段进度条 */
.stage-bar {
  display: flex; gap: 0; padding: 16px 24px; border-bottom: 1px solid #e2e8f0;
  background: #f8fafc; flex-shrink: 0; overflow-x: auto;
}
.stage-step {
  display: flex; align-items: center; gap: 6px; padding: 4px 16px;
  color: #94a3b8; font-size: 0.85rem; position: relative;
}
.stage-step::after {
  content: '→'; margin-left: 8px; color: #cbd5e1;
}
.stage-step:last-child::after { content: ''; }
.stage-step.active { color: #6366f1; font-weight: 600; }
.stage-step.done { color: #10b981; }
.step-dot {
  width: 24px; height: 24px; border-radius: 50%;
  background: #e2e8f0; display: flex; align-items: center; justify-content: center;
  font-size: 0.75rem; font-weight: 700; flex-shrink: 0;
}
.stage-step.active .step-dot { background: #6366f1; color: #fff; }
.stage-step.done .step-dot { background: #10b981; color: #fff; }

/* 主区域 */
.main-area {
  display: flex; flex: 1; overflow: hidden; gap: 0;
}

/* 对话区 */
.chat-panel {
  flex: 1; display: flex; flex-direction: column; border-right: 1px solid #e2e8f0;
  min-width: 0;
}
.chat-messages {
  flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px;
}
.chat-hint {
  text-align: center; color: #94a3b8; padding: 40px 0; font-size: 0.9rem; line-height: 1.6;
}
.message { display: flex; flex-direction: column; gap: 4px; max-width: 90%; }
.message.user { align-self: flex-end; }
.message.assistant { align-self: flex-start; }
.msg-role { font-size: 0.75rem; color: #94a3b8; }
.message.user .msg-role { text-align: right; }
.msg-content {
  padding: 10px 14px; border-radius: 10px; font-size: 0.9rem; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word;
}
.message.user .msg-content { background: #6366f1; color: #fff; border-radius: 10px 10px 2px 10px; }
.message.assistant .msg-content { background: #f1f5f9; color: #1e293b; border-radius: 10px 10px 10px 2px; }
.message.streaming .msg-content { background: #f1f5f9; }
.cursor { animation: blink 1s step-end infinite; }
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }

.chat-input-area {
  padding: 12px 16px; border-top: 1px solid #e2e8f0;
  display: flex; gap: 8px; align-items: flex-end; flex-shrink: 0;
}
.chat-input {
  flex: 1; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;
  font-size: 0.9rem; resize: none; outline: none; font-family: inherit; line-height: 1.5;
}
.chat-input:focus { border-color: #6366f1; }
.chat-input:disabled { background: #f8fafc; }
.send-btn {
  background: #6366f1; color: #fff; border: none; padding: 10px 18px;
  border-radius: 8px; cursor: pointer; font-size: 0.9rem; white-space: nowrap;
  align-self: flex-end;
}
.send-btn:hover { background: #4f46e5; }
.send-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* 产物区 */
.artifact-panel {
  width: 420px; flex-shrink: 0; display: flex; flex-direction: column;
  background: #fafafa;
}
.artifact-header {
  padding: 12px 16px; border-bottom: 1px solid #e2e8f0; display: flex;
  justify-content: space-between; align-items: center; flex-shrink: 0;
  background: #fff;
}
.artifact-title { font-size: 0.9rem; font-weight: 600; color: #374151; }
.approved-tag {
  background: #dcfce7; color: #16a34a; font-size: 0.72rem; padding: 2px 6px;
  border-radius: 4px; margin-left: 8px; font-weight: 500;
}
.toggle-btn {
  background: none; border: 1px solid #e2e8f0; padding: 3px 10px;
  border-radius: 4px; cursor: pointer; font-size: 0.8rem; color: #64748b;
}
.toggle-btn:hover { background: #f1f5f9; }
.artifact-editor {
  flex: 1; border: none; padding: 16px; font-size: 0.875rem; font-family: 'Courier New', monospace;
  resize: none; outline: none; background: #fafafa; line-height: 1.6; color: #1e293b;
}
.artifact-editor:read-only { color: #475569; }
.artifact-actions {
  padding: 12px 16px; border-top: 1px solid #e2e8f0; background: #fff; flex-shrink: 0;
}
.artifact-tip { font-size: 0.8rem; color: #64748b; margin-bottom: 8px; }
.approved-msg { color: #16a34a !important; }
.approve-btn {
  width: 100%; padding: 10px; background: #10b981; color: #fff;
  border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 500;
}
.approve-btn:hover { background: #059669; }
.approve-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
