<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api, type WorkspaceDetail, type Feature } from '@/api'

const router = useRouter()
const route = useRoute()
const workspaceId = route.params.workspaceId as string

const detail = ref<WorkspaceDetail | null>(null)
const showCreate = ref(false)
const newFeature = ref({ name: '', description: '' })

const STAGE_LABELS: Record<string, string> = {
  spec: 'Spec', plan: 'Plan', tasks: 'Tasks', coding: 'Coding',
}
const STAGE_COLORS: Record<string, string> = {
  spec: '#6366f1', plan: '#0ea5e9', tasks: '#f59e0b', coding: '#10b981',
}

onMounted(async () => {
  detail.value = await api.workspaces.get(workspaceId)
})

async function handleCreateFeature() {
  if (!newFeature.value.name.trim() || !detail.value) return
  const feature = await api.features.create(workspaceId, newFeature.value)
  detail.value.features.push(feature)
  showCreate.value = false
  newFeature.value = { name: '', description: '' }
  router.push(`/workspace/${workspaceId}/feature/${feature.id}`)
}

function openFeature(feature: Feature) {
  router.push(`/workspace/${workspaceId}/feature/${feature.id}`)
}
</script>

<template>
  <div class="workspace-view">
    <nav class="breadcrumb">
      <span class="link" @click="router.push('/')">SDD Multi-Agent</span>
      <span class="sep">/</span>
      <span>{{ detail?.name }}</span>
    </nav>

    <div v-if="!detail" class="loading">加载中...</div>

    <template v-else>
      <header class="ws-header">
        <div>
          <h2>{{ detail.name }}</h2>
          <p class="desc">{{ detail.description }}</p>
          <div class="meta">
            <span class="badge">{{ detail.techStack }}</span>
            <a v-if="detail.repoUrl" :href="detail.repoUrl" target="_blank" class="repo-link">
              {{ detail.repoUrl }}
            </a>
          </div>
        </div>
        <button class="btn-primary" @click="showCreate = true">+ 新建 Feature</button>
      </header>

      <div v-if="detail.features.length === 0" class="empty">还没有 Feature，点击右上角新建</div>

      <div v-else class="feature-list">
        <div
          v-for="feature in detail.features"
          :key="feature.id"
          class="feature-card"
          @click="openFeature(feature)"
        >
          <div class="feature-left">
            <div class="feature-name">{{ feature.name }}</div>
            <div class="feature-desc">{{ feature.description || '无描述' }}</div>
          </div>
          <div class="feature-right">
            <span
              class="stage-badge"
              :style="{ background: STAGE_COLORS[feature.currentStage] + '20', color: STAGE_COLORS[feature.currentStage] }"
            >
              {{ STAGE_LABELS[feature.currentStage] ?? feature.currentStage }}
            </span>
            <span v-if="feature.status === 'done'" class="done-badge">完成</span>
          </div>
        </div>
      </div>
    </template>

    <div v-if="showCreate" class="modal-overlay" @click.self="showCreate = false">
      <div class="modal">
        <h2>新建 Feature</h2>
        <label>Feature 名称 *</label>
        <input v-model="newFeature.name" placeholder="如：用户注册功能" />
        <label>描述</label>
        <textarea v-model="newFeature.description" rows="3" placeholder="简要描述这个 Feature 的目标..." />
        <div class="modal-actions">
          <button class="btn-secondary" @click="showCreate = false">取消</button>
          <button class="btn-primary" :disabled="!newFeature.name.trim()" @click="handleCreateFeature">
            创建并开始
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-view { padding: 24px; max-width: 900px; margin: 0 auto; }
.breadcrumb { font-size: 0.85rem; color: #94a3b8; margin-bottom: 20px; }
.breadcrumb .link { cursor: pointer; color: #6366f1; }
.breadcrumb .link:hover { text-decoration: underline; }
.breadcrumb .sep { margin: 0 6px; }
.ws-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; }
h2 { font-size: 1.4rem; font-weight: 700; color: #1a1a2e; margin-bottom: 4px; }
.desc { color: #64748b; font-size: 0.9rem; margin-bottom: 8px; }
.meta { display: flex; gap: 10px; align-items: center; }
.badge { background: #ede9fe; color: #6d28d9; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
.repo-link { color: #6366f1; font-size: 0.8rem; }
.feature-list { display: flex; flex-direction: column; gap: 10px; }
.feature-card {
  border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px 20px;
  display: flex; justify-content: space-between; align-items: center;
  cursor: pointer; background: #fff; transition: all 0.15s;
}
.feature-card:hover { border-color: #6366f1; box-shadow: 0 2px 8px rgba(99,102,241,0.1); }
.feature-name { font-weight: 600; margin-bottom: 4px; }
.feature-desc { font-size: 0.85rem; color: #64748b; }
.feature-right { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.stage-badge { padding: 3px 10px; border-radius: 4px; font-size: 0.8rem; font-weight: 500; }
.done-badge { background: #dcfce7; color: #16a34a; padding: 3px 10px; border-radius: 4px; font-size: 0.8rem; }
.empty, .loading { text-align: center; color: #94a3b8; padding: 60px 0; }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 100;
}
.modal {
  background: #fff; border-radius: 12px; padding: 28px; width: 440px;
  display: flex; flex-direction: column; gap: 10px;
}
.modal h2 { margin-bottom: 8px; font-size: 1.1rem; }
.modal label { font-size: 0.85rem; color: #64748b; }
.modal input, .modal textarea {
  border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px 10px;
  font-size: 0.9rem; width: 100%; box-sizing: border-box; outline: none;
}
.modal input:focus, .modal textarea:focus { border-color: #6366f1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.btn-primary {
  background: #6366f1; color: #fff; border: none; padding: 8px 16px;
  border-radius: 6px; cursor: pointer; font-size: 0.9rem;
}
.btn-primary:hover { background: #4f46e5; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: #f1f5f9; color: #475569; border: none; padding: 8px 16px;
  border-radius: 6px; cursor: pointer;
}
.btn-secondary:hover { background: #e2e8f0; }
</style>
