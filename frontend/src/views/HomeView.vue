<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '@/stores/workspace'
import type { WorkspaceInput } from '@/api'

const router = useRouter()
const store = useWorkspaceStore()

const showCreate = ref(false)
const form = ref<WorkspaceInput>({
  name: '',
  description: '',
  repoUrl: '',
  techStack: 'ts',
  background: '',
})

onMounted(() => store.fetchAll())

async function handleCreate() {
  if (!form.value.name.trim()) return
  const ws = await store.create(form.value)
  showCreate.value = false
  form.value = { name: '', description: '', repoUrl: '', techStack: 'ts', background: '' }
  router.push(`/workspace/${ws.id}`)
}
</script>

<template>
  <div class="home">
    <header class="header">
      <h1>SDD Multi-Agent</h1>
      <button class="btn-primary" @click="showCreate = true">+ 新建 Workspace</button>
    </header>

    <div v-if="store.loading" class="loading">加载中...</div>

    <div v-else-if="store.workspaces.length === 0" class="empty">
      <p>还没有 Workspace，点击右上角新建一个</p>
    </div>

    <div v-else class="workspace-grid">
      <div
        v-for="ws in store.workspaces"
        :key="ws.id"
        class="workspace-card"
        @click="router.push(`/workspace/${ws.id}`)"
      >
        <div class="ws-name">{{ ws.name }}</div>
        <div class="ws-desc">{{ ws.description || '无描述' }}</div>
        <div class="ws-meta">
          <span class="badge">{{ ws.techStack }}</span>
          <span v-if="ws.repoUrl" class="repo">{{ ws.repoUrl }}</span>
        </div>
      </div>
    </div>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h2>新建 Workspace</h2>
        <label>名称 *</label>
        <input v-model="form.name" placeholder="如：电商平台" />
        <label>描述</label>
        <input v-model="form.description" placeholder="简要说明项目用途" />
        <label>仓库地址</label>
        <input v-model="form.repoUrl" placeholder="https://github.com/..." />
        <label>技术选型</label>
        <select v-model="form.techStack">
          <option value="ts">TypeScript / Web</option>
          <option value="java">Java</option>
          <option value="python">Python</option>
          <option value="csharp">C#</option>
        </select>
        <label>背景上下文</label>
        <textarea v-model="form.background" rows="4" placeholder="项目背景、约束、注意事项..." />
        <div class="modal-actions">
          <button class="btn-secondary" @click="showCreate = false">取消</button>
          <button class="btn-primary" :disabled="!form.name.trim()" @click="handleCreate">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home { padding: 24px; max-width: 1100px; margin: 0 auto; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
h1 { font-size: 1.6rem; font-weight: 700; color: #1a1a2e; }
.workspace-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.workspace-card {
  border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px;
  cursor: pointer; transition: all 0.2s; background: #fff;
}
.workspace-card:hover { border-color: #6366f1; box-shadow: 0 4px 12px rgba(99,102,241,0.12); }
.ws-name { font-size: 1.05rem; font-weight: 600; margin-bottom: 6px; }
.ws-desc { color: #64748b; font-size: 0.875rem; margin-bottom: 12px; }
.ws-meta { display: flex; gap: 8px; align-items: center; }
.badge { background: #ede9fe; color: #6d28d9; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
.repo { color: #94a3b8; font-size: 0.75rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty, .loading { text-align: center; color: #94a3b8; padding: 80px 0; }
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #fff; border-radius: 12px; padding: 28px; width: 480px;
  display: flex; flex-direction: column; gap: 10px;
}
.modal h2 { margin-bottom: 8px; font-size: 1.1rem; }
.modal label { font-size: 0.85rem; color: #64748b; margin-top: 4px; }
.modal input, .modal select, .modal textarea {
  border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;
  font-size: 0.9rem; width: 100%; box-sizing: border-box; outline: none;
}
.modal input:focus, .modal select:focus, .modal textarea:focus { border-color: #6366f1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.btn-primary {
  background: #6366f1; color: #fff; border: none; padding: 8px 16px;
  border-radius: 6px; cursor: pointer; font-size: 0.9rem;
}
.btn-primary:hover { background: #4f46e5; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: #f1f5f9; color: #475569; border: none; padding: 8px 16px;
  border-radius: 6px; cursor: pointer; font-size: 0.9rem;
}
.btn-secondary:hover { background: #e2e8f0; }
</style>
