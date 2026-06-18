<script setup lang="ts">
// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// 切换 feature 工作流的映射弹窗。
// - props:
//     show: boolean
//     feature: FeatureDetail
//     targetWorkflow: WorkflowDetail
// - 流程：
//   1) 打开时，用 suggestMapping(oldNodes, newNodes) 预填 mapping
//   2) 用户可在每行调整 newNodeId / outputRename / inputRename
//   3) "Apply" 调用 api.features.switchWorkflow，关闭弹窗后由父组件 reload
//   4) 若任何 approved 节点没出现在 mapping，按钮 disabled
//
// 关键约束（来自后端 POST /api/features/:id/switch-workflow）：
//   - feature_node_states.status='approved' 的 oldNodeId 必须出现在 mapping
//   - mapping 中的 newNodeId 必须存在于 targetWorkflow.nodes
//   - 同 newNodeId 上多个来源：以 status 优先级（approved > active > pending）合并

import { computed, h, ref, watch } from 'vue'
import {
  NModal, NCard, NSpace, NButton, NSelect, NTag, NDataTable, NEmpty, NInput, NSpin, useMessage,
  type DataTableColumns,
} from 'naive-ui'
import { api, type FeatureDetail, type WorkflowDetail, type SwitchWorkflowMapping } from '@/api'
import { suggestMapping, type MappingSuggestion, type WorkflowNodeRow } from '@/types/workflow'

const props = defineProps<{
  show: boolean
  feature: FeatureDetail | null
  workflowOptions: Array<{ label: string; value: string }>
}>()

// 在弹层内部管理目标 workflow 的选择与加载
const selectedWorkflowId = ref<string | null>(null)
const targetWorkflow = ref<WorkflowDetail | null>(null)
const loadingTarget = ref(false)
const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'applied'): void
}>()

const message = useMessage()
const mapping = ref<Record<string, SwitchWorkflowMapping>>({})
const saving = ref(false)

interface Row {
  oldNodeId: string
  oldAgentId: string
  oldStatus: string
  newNodeId: string | null
  newNodeOptions: Array<{ label: string; value: string }>
  outputRename: string
  inputRename: string
  confidence?: 'high' | 'low'
}

const rows = computed<Row[]>(() => {
  if (!props.feature || !targetWorkflow.value) return []
  const wf = targetWorkflow.value
  const oldRows: WorkflowNodeRow[] = props.feature.workflow.nodes.map((n: any) => ({
    nodeId: n.nodeId,
    agentId: n.agentId,
    positionX: n.positionX,
    positionY: n.positionY,
  }))
  const newRows: WorkflowNodeRow[] = wf.nodes.map((n: any) => ({
    nodeId: n.nodeId,
    agentId: n.agentId,
    positionX: n.positionX,
    positionY: n.positionY,
  }))
  const suggestions = suggestMapping(oldRows, newRows)
  const newNodeOptions = wf.nodes.map((n) => ({
    label: `${n.nodeId} (${n.agentId})`,
    value: n.nodeId,
  }))

  return oldRows.map((o) => {
    const userMapping = mapping.value[o.nodeId]
    const s: MappingSuggestion | undefined = userMapping
      ? { newNodeId: userMapping.newNodeId, confidence: 'high' }
      : suggestions[o.nodeId]
    const status = props.feature!.nodeStates[o.nodeId]?.status ?? 'pending'
    return {
      oldNodeId: o.nodeId,
      oldAgentId: o.agentId,
      oldStatus: status,
      newNodeId: s?.newNodeId ?? null,
      newNodeOptions,
      outputRename: mapping.value[o.nodeId]?.outputRename ?? '',
      inputRename: mapping.value[o.nodeId]?.inputRename ?? '',
      confidence: s?.confidence,
    }
  })
})

const allApprovedMapped = computed(() => {
  return rows.value
    .filter((r) => r.oldStatus === 'approved')
    .every((r) => !!r.newNodeId)
})

watch(
  () => props.show,
  (v) => {
    if (v) {
      // 打开时重置所有状态
      mapping.value = {}
      selectedWorkflowId.value = null
      targetWorkflow.value = null
    }
  },
)

async function onSelectWorkflow(id: string) {
  selectedWorkflowId.value = id
  loadingTarget.value = true
  targetWorkflow.value = null
  mapping.value = {}
  try {
    targetWorkflow.value = await api.workflows.get(id)
  } catch (e: any) {
    message.error(`加载 workflow 详情失败: ${e?.message ?? e}`)
  } finally {
    loadingTarget.value = false
  }
}

function setNew(oldNodeId: string, newNodeId: string) {
  mapping.value[oldNodeId] = {
    ...(mapping.value[oldNodeId] ?? {}),
    newNodeId,
  }
}

function setOutputRename(oldNodeId: string, v: string) {
  mapping.value[oldNodeId] = {
    ...(mapping.value[oldNodeId] ?? { newNodeId: '' }),
    outputRename: v,
  }
}

function setInputRename(oldNodeId: string, v: string) {
  mapping.value[oldNodeId] = {
    ...(mapping.value[oldNodeId] ?? { newNodeId: '' }),
    inputRename: v,
  }
}

const columns: DataTableColumns<Row> = [
  { title: '旧 nodeId', key: 'oldNodeId', width: 130 },
  { title: 'agent', key: 'oldAgentId', width: 90 },
  {
    title: '状态',
    key: 'oldStatus',
    width: 80,
    render: (r) => {
      const type = r.oldStatus === 'approved' ? 'success' : r.oldStatus === 'active' ? 'info' : 'default'
      return h(NTag, { type, size: 'small', round: true }, { default: () => r.oldStatus })
    },
  },
  {
    title: '新 nodeId',
    key: 'newNodeId',
    width: 180,
    render: (r) =>
      h(NSelect, {
        value: r.newNodeId,
        options: r.newNodeOptions,
        placeholder: '选择',
        'onUpdate:value': (v: string) => setNew(r.oldNodeId, v),
      }),
  },
  {
    title: 'confidence',
    key: 'confidence',
    width: 100,
    render: (r) =>
      r.confidence
        ? h(
            NTag,
            { size: 'small', type: r.confidence === 'high' ? 'success' : 'warning' },
            { default: () => r.confidence },
          )
        : h('span'),
  },
  {
    title: 'output rename',
    key: 'outputRename',
    width: 110,
    render: (r) =>
      h(NInput, {
        value: r.outputRename,
        placeholder: '可选',
        'onUpdate:value': (v: string) => setOutputRename(r.oldNodeId, v),
      }),
  },
  {
    title: 'input rename',
    key: 'inputRename',
    width: 110,
    render: (r) =>
      h(NInput, {
        value: r.inputRename,
        placeholder: '可选',
        'onUpdate:value': (v: string) => setInputRename(r.oldNodeId, v),
      }),
  },
]

function close() {
  emit('update:show', false)
}

async function apply() {
  if (!props.feature || !targetWorkflow.value) return
  if (!allApprovedMapped.value) {
    message.error('已批准的节点必须全部映射到新 workflow 的节点')
    return
  }
  saving.value = true
  try {
    // 过滤掉 newNodeId 为空的行（pending 节点可选）
    const filtered: Record<string, SwitchWorkflowMapping> = {}
    for (const r of rows.value) {
      if (!r.newNodeId) continue
      const m: SwitchWorkflowMapping = { newNodeId: r.newNodeId }
      if (r.outputRename) m.outputRename = r.outputRename
      if (r.inputRename) m.inputRename = r.inputRename
      filtered[r.oldNodeId] = m
    }
    await api.features.switchWorkflow(props.feature.id, {
      toWorkflowId: targetWorkflow.value.id,
      mapping: filtered,
    })
    message.success('已切换工作流')
    emit('applied')
    close()
  } catch (e: any) {
    message.error(`切换失败: ${e?.message ?? e}`)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    :style="{ width: '900px' }"
    :title="`切换工作流 → ${targetWorkflow?.name ?? '请选择目标工作流'}`"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <NSpace vertical>
      <!-- 第一步：选目标工作流 -->
      <NSpace align="center">
        <span style="font-size: 13px; color: #333; white-space: nowrap;">目标工作流：</span>
        <NSelect
          :value="selectedWorkflowId"
          :options="workflowOptions"
          placeholder="请选择要切换到的工作流"
          style="width: 320px"
          @update:value="onSelectWorkflow"
        />
        <NSpin v-if="loadingTarget" size="small" />
      </NSpace>

      <template v-if="targetWorkflow">
        <div style="color: #666; font-size: 13px">
          左侧是当前工作流的节点；右侧"新 nodeId"是自动建议（按 agentId 配对，歧义时按位置距离）。<br />
          <strong>已批准</strong>的节点必须映射到新 workflow；未映射时 Apply 按钮会禁用。
        </div>

        <NDataTable
          :columns="columns"
          :data="rows"
          :bordered="false"
          :single-line="false"
          size="small"
        />

        <NEmpty v-if="rows.length === 0" description="目标工作流没有节点" />
      </template>

      <div v-else-if="!loadingTarget" style="padding: 32px 0; text-align: center; color: #aaa; font-size: 13px;">
        请先选择目标工作流
      </div>
    </NSpace>

    <template #footer>
      <NSpace justify="end">
        <NButton @click="close">取消</NButton>
        <NButton
          type="primary"
          :loading="saving"
          :disabled="!allApprovedMapped"
          @click="apply"
        >
          Apply
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

<style scoped>
</style>
