import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Workspace, type WorkspaceDetail, type WorkspaceInput } from '@/api'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<Workspace[]>([])
  const detail = ref<WorkspaceDetail | null>(null)
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try {
      workspaces.value = await api.workspaces.list()
    } finally {
      loading.value = false
    }
  }

  // Implements: tasks.md#T023 / plan.md#D-05
  // 加载单个工作区详情。isLegacy 由后端实时计算并透传（前端不重算）
  async function loadWorkspace(id: string) {
    detail.value = await api.workspaces.get(id)
    return detail.value
  }

  async function create(data: WorkspaceInput) {
    const ws = await api.workspaces.create(data)
    workspaces.value.push(ws)
    return ws
  }

  async function update(id: string, data: Partial<WorkspaceInput>) {
    const updated = await api.workspaces.update(id, data)
    const idx = workspaces.value.findIndex((w) => w.id === id)
    if (idx !== -1) workspaces.value[idx] = updated
    return updated
  }

  // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
  // 把 workspace 的 default_workflow_id 指向某个 workflow。
  // 通过 PATCH /api/workspaces/:id { defaultWorkflowId } 实现。
  async function setDefaultWorkflow(workspaceId: string, workflowId: string) {
    const updated = await api.workspaces.update(workspaceId, { defaultWorkflowId: workflowId })
    const idx = workspaces.value.findIndex((w) => w.id === workspaceId)
    if (idx !== -1) workspaces.value[idx] = updated
    if (detail.value?.id === workspaceId) detail.value = { ...detail.value, ...updated }
    return updated
  }

  async function remove(id: string) {
    await api.workspaces.delete(id)
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
  }

  return { workspaces, detail, loading, fetchAll, loadWorkspace, create, update, remove, setDefaultWorkflow }
})
