<script setup lang="ts">
// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// 工作区下的 workflow 列表视图：
//   - 列出 workspace 下的所有 workflows
//   - 每行：名称 / 描述 / 是否默认 / 是否 archived
//   - 操作：编辑（→ WorkflowEditorView）/ 克隆 / 删除 / 设为默认
//   - "+ 新建" 按钮直接进编辑器

import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NSpin, NEmpty, NList, NListItem, NThing, NSpace, NButton, NTag,
  NDropdown, NIcon, useMessage,
} from 'naive-ui'
import { api, type Workflow } from '@/api'
import { useWorkflowStore } from '@/stores/workflow'
import { useWorkspaceStore } from '@/stores/workspace'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const wfStore = useWorkflowStore()
const wsStore = useWorkspaceStore()

const workspaceId = computed(() => String(route.params.workspaceId ?? ''))

const list = computed<Workflow[]>(() => wfStore.getList(workspaceId.value))
const loading = computed(() => wfStore.loading)
const defaultWorkflowId = computed(() => wsStore.detail?.defaultWorkflowId ?? null)

async function refresh() {
  try {
    await Promise.all([
      wfStore.loadList(workspaceId.value),
      wsStore.detail?.id === workspaceId.value ? null : wsStore.loadWorkspace(workspaceId.value),
    ])
  } catch (e: any) {
    message.error(`加载 workflow 列表失败: ${e?.message ?? e}`)
  }
}

onMounted(refresh)
watch(workspaceId, refresh)

function openEditor(workflowId?: string) {
  if (workflowId) {
    router.push(`/workspace/${workspaceId.value}/workflow/${workflowId}`)
  } else {
    router.push(`/workspace/${workspaceId.value}/workflow/new`)
  }
}

async function cloneWorkflow(src: Workflow) {
  try {
    const detail = await api.workflows.get(src.id)
    const wf = await api.workflows.create(workspaceId.value, {
      name: `${src.name} 副本`,
      description: src.description,
      nodes: detail.nodes.map((n) => ({
        nodeId: n.nodeId,
        agentId: n.agentId,
        positionX: n.positionX,
        positionY: n.positionY,
        displayName: n.displayName,
        configJson: n.configJson,
      })),
      edges: detail.edges.map((e) => ({
        fromNodeId: e.fromNodeId,
        fromOutput: e.fromOutput,
        toNodeId: e.toNodeId,
        toInput: e.toInput,
      })),
    })
    message.success(`已克隆为「${wf.name}」`)
    await refresh()
  } catch (e: any) {
    message.error(`克隆失败: ${e?.message ?? e}`)
  }
}

async function deleteWorkflow(wf: Workflow) {
  try {
    await api.workflows.remove(wf.id)
    message.success(`已删除「${wf.name}」`)
    await refresh()
  } catch (e: any) {
    message.error(`删除失败: ${e?.message ?? e}`)
  }
}

async function setDefault(wf: Workflow) {
  try {
    await wsStore.setDefaultWorkflow(workspaceId.value, wf.id)
    message.success(`「${wf.name}」已设为默认`)
  } catch (e: any) {
    message.error(`设为默认失败: ${e?.message ?? e}`)
  }
}

function menuOptions(wf: Workflow) {
  return [
    { label: '编辑', key: 'edit' },
    { label: '克隆', key: 'clone' },
    { label: '设为默认', key: 'default', disabled: defaultWorkflowId.value === wf.id },
    { type: 'divider', key: 'd1' },
    { label: '删除', key: 'delete' },
  ]
}

async function handleMenu(wf: Workflow, key: string) {
  if (key === 'edit') openEditor(wf.id)
  else if (key === 'clone') cloneWorkflow(wf)
  else if (key === 'default') setDefault(wf)
  else if (key === 'delete') deleteWorkflow(wf)
}
</script>

<template>
  <div class="workflow-list">
    <header class="workflow-list__header">
      <NSpace align="center" justify="space-between">
        <h2>Workflows</h2>
        <NButton type="primary" size="small" @click="openEditor()">+ 新建 Workflow</NButton>
      </NSpace>
    </header>

    <NSpin :show="loading">
      <NEmpty v-if="!loading && list.length === 0" description="还没有 Workflow">
        <template #extra>
          <NButton type="primary" size="small" @click="openEditor()">立即新建</NButton>
        </template>
      </NEmpty>

      <NList v-else bordered>
        <NListItem v-for="wf in list" :key="wf.id">
          <NThing :title="wf.name" :description="wf.description || '（无描述）'">
            <template #header-extra>
              <NSpace>
                <NTag v-if="defaultWorkflowId === wf.id" type="success" size="small" round>默认</NTag>
                <NTag v-if="wf.isArchived" type="warning" size="small" round>已归档</NTag>
                <NDropdown :options="menuOptions(wf)" trigger="click" @select="(k: string) => handleMenu(wf, k)">
                  <NButton text size="small" style="font-size: 18px; line-height: 1;">⋯</NButton>
                </NDropdown>
              </NSpace>
            </template>
            <template #avatar>
              <NIcon :size="22" color="#18a058">⛓</NIcon>
            </template>
          </NThing>
        </NListItem>
      </NList>
    </NSpin>
  </div>
</template>

<style scoped>
.workflow-list {
  padding: 16px;
}
.workflow-list__header h2 {
  margin: 0 0 16px 0;
  font-size: 18px;
  font-weight: 600;
}
</style>
