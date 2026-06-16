import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Workspace, type WorkspaceInput } from '@/api'

export const useWorkspaceStore = defineStore('workspace', () => {
  const workspaces = ref<Workspace[]>([])
  const loading = ref(false)

  async function fetchAll() {
    loading.value = true
    try {
      workspaces.value = await api.workspaces.list()
    } finally {
      loading.value = false
    }
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

  async function remove(id: string) {
    await api.workspaces.delete(id)
    workspaces.value = workspaces.value.filter((w) => w.id !== id)
  }

  return { workspaces, loading, fetchAll, create, update, remove }
})
