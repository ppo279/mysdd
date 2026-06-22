<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api, type WorkspaceDetail, type Feature } from '@/api'
import {
  NLayout, NLayoutContent, NSpace, NButton, NText, NEmpty, NSpin,
  NModal, NCard, NForm, NFormItem, NInput, NSelect, NTag,
  NList, NListItem, NThing, NPopconfirm, NDropdown, NLog, useMessage,
} from 'naive-ui'

const router = useRouter()
const route = useRoute()
const workspaceId = route.params.workspaceId as string
const message = useMessage()

const detail = ref<WorkspaceDetail | null>(null)
const showCreate = ref(false)
const creating = ref(false)
// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
// intent + workflow-level inputs (bug_report) 一并提交。
const newFeature = ref({
  name: '',
  description: '',
  intent: 'new_feature' as 'bug_fix' | 'spec_change' | 'new_feature' | 'refactor',
  bugReport: '',
})
const taskModeOptions = [
  { label: '从零开始设计并实现', value: '从零开始设计并实现' },
  { label: '在原有代码基础上修改', value: '在原有代码基础上修改' },
  { label: '仅生成文档 / 分析', value: '仅生成文档 / 分析' },
]
// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
const intentOptions = [
  { label: 'Bug 修复（4 步反向流水线）', value: 'bug_fix' as const },
  { label: '规范变更（升格到正向 SDD）', value: 'spec_change' as const },
  { label: '新增功能（默认正向 SDD）', value: 'new_feature' as const },
  { label: '重构（占位）', value: 'refactor' as const },
]
const deletingId = ref<string | null>(null)

// Implements: tasks.md#T025 / plan.md#R-02
// 二次确认弹窗开关（T026/T027 将在此 modal 内渲染 SSE 日志）
const showReinitConfirm = ref(false)

// Implements: tasks.md#T027 / plan.md#D-04
// reinit SSE 客户端状态：累积日志行、错误标记、是否流式中
const reinitLog = ref<string[]>([])
const reinitError = ref(false)
const reinitBusy = ref(false)

// Implements: tasks.md#T025 / plan.md#R-02
// 仅当后端判定 isLegacy=true 时，操作菜单才含"迁移到新结构…"项
const reinitMenuOption = computed(() =>
  detail.value?.isLegacy
    ? { label: '迁移到新结构…', key: 'reinit' }
    : null,
)

// NDropdown 实际绑定的 options：reinitMenuOption 存在时插入
const workspaceMenuOptions = computed(() => {
  const opts: Array<{ label: string; key: string }> = []
  const reinit = reinitMenuOption.value
  if (reinit) opts.push(reinit)
  return opts
})

function handleMenuSelect(key: string) {
  if (key === 'reinit') showReinitConfirm.value = true
}

// Implements: tasks.md#T027 / plan.md#D-04
// reinit 启动：调用 SSE 客户端，按帧累积日志；done 关闭 + reload；error 帧（M0 envelope 化后是 {error: 消息字符串, code}）标记 + 保持打开
async function handleStartReinit() {
  if (reinitBusy.value) return
  reinitLog.value = []
  reinitError.value = false
  reinitBusy.value = true
  try {
    await api.workspaces.reinit(workspaceId, (chunk) => {
      if (chunk.text) reinitLog.value.push(chunk.text)
      // M0 统一 SSE 错误帧：{ error: 消息字符串, code? } —— truthy 即视为错误
      if (chunk.error) {
        reinitError.value = true
        reinitLog.value.push(`\n❌ ${chunk.error}\n`)
        return
      }
      if (chunk.done) {
        // 成功：关闭 modal + 重新拉取 detail（让 isLegacy=false 反映新结构）
        showReinitConfirm.value = false
        // reload：与 useWorkspaceStore.loadWorkspace 行为一致
        if (workspaceId) {
          void api.workspaces.get(workspaceId)
            .then((d) => { detail.value = d })
            .catch((e: any) => message.error(e.message ?? '刷新工作区失败'))
        }
      }
    })
  } catch (e: any) {
    // fetch 抛错（非 SSE 帧错误）→ 也走 error 通道
    reinitError.value = true
    reinitLog.value.push(`\n❌ ${e?.message ?? '迁移失败'}\n`)
  } finally {
    reinitBusy.value = false
  }
}

const STAGE_LABELS: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', tasks: 'Tasks', coding: 'Coding',
}
const STAGE_TYPES: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default'> = {
  spec: 'info', plan: 'default', tasks: 'warning', coding: 'success',
}
const STACK_COLORS: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default'> = {
  ts: 'info', java: 'warning', python: 'success', csharp: 'error',
}

onMounted(async () => {
  try {
    detail.value = await api.workspaces.get(workspaceId)
  } catch (e: any) {
    message.error(e.message)
  }
})

async function handleCreateFeature() {
  if (!newFeature.value.name.trim() || !detail.value) return
  if (newFeature.value.intent === 'bug_fix' && !newFeature.value.bugReport.trim()) {
    message.warning('Bug 修复需要填写 bug_report（自然语言描述）')
    return
  }
  creating.value = true
  try {
    const payload: Parameters<typeof api.features.create>[1] = {
      name: newFeature.value.name,
      description: newFeature.value.description,
      intent: newFeature.value.intent,
    }
    if (newFeature.value.intent === 'bug_fix') {
      payload.inputs = { bug_report: newFeature.value.bugReport }
    }
    const feature = await api.features.create(workspaceId, payload)
    detail.value.features.push(feature)
    showCreate.value = false
    newFeature.value = {
      name: '',
      description: '',
      intent: 'new_feature',
      bugReport: '',
    }
    router.push(`/workspace/${workspaceId}/feature/${feature.id}`)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    creating.value = false
  }
}

async function handleDeleteFeature(feature: Feature) {
  if (!detail.value) return
  deletingId.value = feature.id
  try {
    await api.features.delete(feature.id)
    detail.value.features = detail.value.features.filter((f) => f.id !== feature.id)
    message.success(`已删除 Feature「${feature.name}」`)
  } catch (e: any) {
    message.error(e.message)
  } finally {
    deletingId.value = null
  }
}

// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 05)
// Tooltip for the "排队中" tag. Per spec: user should see "waiting on
// bugfix/feat-X" — surface the sibling feature id(s) holding the conflicting
// lock; fall back to the local claim preview when the backend didn't attach
// blockedBy (defensive).
function queuedReason(feature: Feature): string {
  const blockers = feature.blockedBy ?? []
  if (blockers.length === 0) {
    const files = feature.lockedFiles ?? []
    if (files.length === 0) return '排队中：等待锁释放'
    const preview = files.slice(0, 3).join(', ')
    const more = files.length > 3 ? ` 等 ${files.length} 个文件` : ''
    return `排队中：等待其他 Feature 释放 ${preview}${more}`
  }
  const ids = blockers.map((b) => `bugfix/${b.id.slice(0, 8)}`).join(', ')
  return `排队中：等待 ${ids}`
}

// Implements: tasks.md#T025 / T026 / T027
// 暴露给组件单测的关键状态（不暴露整个 detail，避免误改）
defineExpose({
  reinitMenuOption,
  showReinitConfirm,
  handleMenuSelect,
  reinitLog,
  reinitError,
  reinitBusy,
  handleStartReinit,
})
</script>

<template>
  <NLayout style="height: 100vh;">
    <NLayoutContent style="padding: 28px 24px; overflow: auto;">
      <div v-if="!detail" style="text-align:center; padding:80px 0;">
        <NSpin size="large" />
      </div>

      <template v-else>
        <!-- Workspace info -->
        <NSpace vertical :size="4" style="margin-bottom: 24px;">
          <NSpace align="center" :size="8">
            <NText strong style="font-size: 22px;">{{ detail.name }}</NText>
            <!--
              Implements: tasks.md#T025 / plan.md#R-02
              操作菜单触发器：仅当 workspaceMenuOptions 非空时显示（legacy 工作区才会出现）
            -->
            <NDropdown
              v-if="workspaceMenuOptions.length > 0"
              trigger="click"
              :options="workspaceMenuOptions"
              @select="handleMenuSelect"
            >
              <NButton text size="small" style="font-size: 18px; line-height: 1;">⋯</NButton>
            </NDropdown>
          </NSpace>
          <NText depth="3">{{ detail.description }}</NText>
          <NSpace align="center" style="margin-top: 4px;">
            <NTag :type="STACK_COLORS[detail.techStack] ?? 'default'" size="small" round>
              {{ detail.techStack }}
            </NTag>
            <NText v-if="detail.repoUrl" depth="3" style="font-size: 12px;">
              {{ detail.repoUrl }}
            </NText>
          </NSpace>
          <NText v-if="detail.localPath" depth="3" style="font-size: 12px; margin-top: 2px;">
            📁 {{ detail.localPath }}
          </NText>
        </NSpace>

        <NEmpty v-if="detail.features.length === 0" description="还没有 Feature，点击右上角新建" />

        <NList v-else bordered>
          <NListItem
            v-for="feature in detail.features"
            :key="feature.id"
            style="cursor: pointer;"
            @click="router.push(`/workspace/${workspaceId}/feature/${feature.id}`)"
          >
            <NThing :title="feature.name" :description="feature.description || '无描述'">
              <template #header-extra>
                <NSpace align="center" :size="6">
                  <!-- Implements: docs/prd/0001-bug-fix-workflow.md (Issue 05) -->
                  <NTag
                    v-if="feature.status === 'queued'"
                    type="warning"
                    size="small"
                    round
                    :title="queuedReason(feature)"
                  >
                    排队中
                  </NTag>
                  <NTag v-else-if="feature.status === 'done'" type="success" size="small" round>完成</NTag>
                  <NTag v-else-if="feature.status === 'merged'" type="success" size="small" round>已合并</NTag>
                  <NTag v-else-if="feature.status === 'circuit_broken'" type="error" size="small" round>已熔断</NTag>
                  <NTag v-else-if="feature.status === 'abandoned'" type="default" size="small" round>已废弃</NTag>
                  <NTag v-else-if="feature.status === 'approved'" type="info" size="small" round>待合并</NTag>
                  <NTag :type="STAGE_TYPES[feature.currentStage] ?? 'default'" size="small">
                    {{ STAGE_LABELS[feature.currentStage] ?? feature.currentStage }}
                  </NTag>
                  <NPopconfirm
                    @positive-click="handleDeleteFeature(feature)"
                    :positive-button-props="{ loading: deletingId === feature.id, type: 'error' }"
                  >
                    <template #trigger>
                      <NButton
                        size="tiny"
                        quaternary
                        type="error"
                        :loading="deletingId === feature.id"
                        @click.stop
                      >
                        删除
                      </NButton>
                    </template>
                    确定删除 Feature「{{ feature.name }}」？<br/>
                    该操作不可恢复，所有阶段产物和对话历史都会被清除。
                  </NPopconfirm>
                </NSpace>
              </template>
            </NThing>
          </NListItem>
        </NList>
      </template>
    </NLayoutContent>
  </NLayout>

  <!-- Implements: bug-report 2026-06-18 / slice 6 -->
  <!-- 原 view 自带 NLayoutHeader 已删除，操作按钮通过 Teleport 注入到 App.vue header 右侧 -->
  <Teleport to="#app-header-actions-slot">
    <NSpace>
      <NButton type="primary" @click="showCreate = true">+ 新建 Feature</NButton>
      <NButton @click="router.push(`/workspace/${workspaceId}/workflows`)">Workflows</NButton>
    </NSpace>
  </Teleport>

  <NModal v-model:show="showCreate">
    <NCard title="新建 Feature" closable style="width:560px;background:#fff;"
      @close="showCreate = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="Feature 名称 *">
          <NInput v-model:value="newFeature.name" placeholder="如：用户注册功能" />
        </NFormItem>
        <!-- Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01) -->
        <NFormItem label="意图（Intent）">
          <NSelect
            v-model:value="newFeature.intent"
            :options="intentOptions"
            placeholder="请选择意图"
            style="width:100%"
          />
        </NFormItem>
        <NFormItem
          v-if="newFeature.intent === 'bug_fix'"
          label="Bug Report（自然语言描述）*"
        >
          <NInput
            v-model:value="newFeature.bugReport"
            type="textarea"
            :autosize="{ minRows: 5, maxRows: 10 }"
            placeholder="描述 bug 的现象、复现步骤、期望与实际行为、错误信息等"
          />
        </NFormItem>
        <NFormItem label="任务模式">
          <NSelect
            v-model:value="newFeature.description"
            :options="taskModeOptions"
            placeholder="请选择任务模式"
            style="width:100%"
          />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" :disabled="!newFeature.name.trim()"
            @click="handleCreateFeature">
            创建并开始
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>

  <!--
    Implements: tasks.md#T025 / T026 / T027 / plan.md#R-02 / plan.md#D-04
    迁移到新结构二次确认弹窗 + SSE 日志展示：
    - 初始显示说明文字 + "开始迁移" / "取消" 按钮
    - 点击"开始迁移"后展示 NLog 累积服务端输出
    - error:true 帧：reinitError=true → 标题/日志标红、按钮变"关闭"
  -->
  <NModal v-model:show="showReinitConfirm">
    <NCard
      :title="reinitError ? '迁移失败' : '迁移到新结构'"
      :bordered="false"
      size="huge"
      closable
      style="width: 640px; background: #fff;"
      @close="showReinitConfirm = false"
    >
      <NSpace vertical :size="12">
        <NText v-if="!reinitBusy && reinitLog.length === 0" depth="3">
          即将按 repo / memory / tmp 三层结构整理本工作区目录，原有内容会移入 repo/。
        </NText>
        <!--
          NLog：SSE 帧累积。type 在 error 时切换为 error（红色）
          rows 限定最大高度；language="text" 关闭语法高亮（纯文本日志）
        -->
        <NLog
          v-if="reinitLog.length > 0"
          :log="reinitLog.join('')"
          :type="reinitError ? 'error' : 'default'"
          language="text"
          style="max-height: 320px;"
        />
      </NSpace>
      <template #footer>
        <NSpace justify="end">
          <NButton
            v-if="!reinitError"
            :disabled="reinitBusy"
            @click="showReinitConfirm = false"
          >
            取消
          </NButton>
          <NButton
            v-if="!reinitError"
            type="primary"
            :loading="reinitBusy"
            @click="handleStartReinit"
          >
            开始迁移
          </NButton>
          <NButton
            v-if="reinitError"
            type="primary"
            @click="showReinitConfirm = false"
          >
            关闭
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
