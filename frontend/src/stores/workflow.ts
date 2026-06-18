// Implements: docs/adr/0001-workflow-execution-model.md (Phase 1)
// 工作流 store：缓存按 workspaceId 索引的 workflow 列表 + 单个 workflow 的详情。
// 与 stores/workspace.ts / stores/chat.ts 一致的 setup style。
//
// 设计点：
// - 不持有 Feature 上的 `currentWorkflowId` 状态——那是 chat store 的责任。
// - `byWorkspaceId[id]` 缓存，刷新时整体覆盖。
// - 写操作（create / update / remove / archive）落库后同步更新本地缓存，避免后续 list 出现幽灵/缺失。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  api,
  type Workflow,
  type WorkflowDetail,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from '@/api'

export const useWorkflowStore = defineStore('workflow', () => {
  // workspaceId → workflows 列表
  const byWorkspaceId = ref<Record<string, Workflow[]>>({})
  // workflowId → 详情（含 nodes / edges）
  const detail = ref<Record<string, WorkflowDetail>>({})
  const loading = ref(false)
  // 当前 list 正在加载的 workspace（用于 UI 上"加载中"标记）
  const listingWorkspaceId = ref<string | null>(null)

  // ── 读 ─────────────────────────────────────────────────────
  async function loadList(workspaceId: string) {
    listingWorkspaceId.value = workspaceId
    loading.value = true
    try {
      const list = await api.workflows.list(workspaceId)
      byWorkspaceId.value[workspaceId] = list
      return list
    } finally {
      loading.value = false
      listingWorkspaceId.value = null
    }
  }

  async function loadOne(id: string) {
    const wf = await api.workflows.get(id)
    detail.value[id] = wf
    return wf
  }

  function getList(workspaceId: string): Workflow[] {
    return byWorkspaceId.value[workspaceId] ?? []
  }

  function getDetail(id: string): WorkflowDetail | null {
    return detail.value[id] ?? null
  }

  // ── 写 ─────────────────────────────────────────────────────
  async function create(workspaceId: string, data: WorkflowCreateInput) {
    const wf = await api.workflows.create(workspaceId, data)
    const list = byWorkspaceId.value[workspaceId] ?? []
    byWorkspaceId.value[workspaceId] = [...list, wf]
    return wf
  }

  async function update(id: string, data: WorkflowUpdateInput) {
    const wf = await api.workflows.update(id, data)
    // 同步 list 缓存（按 workspaceId 索引）
    const list = byWorkspaceId.value[wf.workspaceId] ?? []
    byWorkspaceId.value[wf.workspaceId] = list.map((w) => (w.id === wf.id ? wf : w))
    // 同步 detail 缓存
    if (detail.value[id]) {
      detail.value[id] = { ...detail.value[id], ...wf } as WorkflowDetail
    }
    return wf
  }

  async function remove(id: string, workspaceId: string) {
    await api.workflows.remove(id)
    const list = byWorkspaceId.value[workspaceId] ?? []
    byWorkspaceId.value[workspaceId] = list.filter((w) => w.id !== id)
    delete detail.value[id]
  }

  // 复位：切 workspace 或测试时用
  function reset() {
    byWorkspaceId.value = {}
    detail.value = {}
    loading.value = false
    listingWorkspaceId.value = null
  }

  return {
    // 状态
    byWorkspaceId,
    detail,
    loading,
    listingWorkspaceId,
    // 读
    loadList,
    loadOne,
    getList,
    getDetail,
    // 写
    create,
    update,
    remove,
    // 工具
    reset,
  }
})
