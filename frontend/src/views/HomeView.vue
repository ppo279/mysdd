<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '@/stores/workspace'
import type { Workspace, WorkspaceInput } from '@/api'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NGrid, NGridItem,
  NCard, NTag, NText, NEmpty, NSpin, NModal, NForm, NFormItem, NInput,
  NSelect, NPopconfirm, useMessage,
} from 'naive-ui'

const router = useRouter()
const store = useWorkspaceStore()
const message = useMessage()

// ── Create ────────────────────────────────────────────
const showCreate = ref(false)
const creating = ref(false)
const createForm = ref<WorkspaceInput>({
  name: '', description: '', repoUrl: '', techStack: 'ts', background: '',
})

// ── Edit ──────────────────────────────────────────────
const showEdit = ref(false)
const editing = ref(false)
const editTarget = ref<Workspace | null>(null)
const editForm = ref<WorkspaceInput>({
  name: '', description: '', repoUrl: '', techStack: 'ts', background: '',
})

const techOptions = [
  { label: 'TypeScript / Web', value: 'ts' },
  { label: 'Java', value: 'java' },
  { label: 'Python', value: 'python' },
  { label: 'C#', value: 'csharp' },
]

const STACK_COLORS: Record<string, 'info' | 'success' | 'warning' | 'error' | 'default'> = {
  ts: 'info', java: 'warning', python: 'success', csharp: 'error',
}

onMounted(() => store.fetchAll())

async function handleCreate() {
  if (!createForm.value.name.trim()) return
  creating.value = true
  try {
    const ws = await store.create(createForm.value)
    showCreate.value = false
    createForm.value = { name: '', description: '', repoUrl: '', techStack: 'ts', background: '' }
    router.push(`/workspace/${ws.id}`)
    message.success('Workspace 创建成功')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    creating.value = false
  }
}

function openEdit(ws: Workspace, e: Event) {
  e.stopPropagation()
  editTarget.value = ws
  editForm.value = {
    name: ws.name, description: ws.description, repoUrl: ws.repoUrl,
    techStack: ws.techStack, background: ws.background,
  }
  showEdit.value = true
}

async function handleEdit() {
  if (!editTarget.value || !editForm.value.name.trim()) return
  editing.value = true
  try {
    await store.update(editTarget.value.id, editForm.value)
    showEdit.value = false
    message.success('已更新')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    editing.value = false
  }
}

async function handleDelete(id: string) {
  try {
    await store.remove(id)
    message.success('已删除')
  } catch (e: any) {
    message.error(e.message)
  }
}
</script>

<template>
  <NLayout style="height: 100vh;">
    <NLayoutHeader style="padding: 0 24px; border-bottom: 1px solid #efeff5; background: #fff;">
      <NSpace justify="space-between" align="center" style="height: 56px;">
        <NText strong style="font-size: 18px; color: #18181c;">SDD Multi-Agent</NText>
        <NSpace>
          <NButton @click="router.push('/config')">⚙ Agent 配置</NButton>
          <NButton type="primary" @click="showCreate = true">+ 新建 Workspace</NButton>
        </NSpace>
      </NSpace>
    </NLayoutHeader>

    <NLayoutContent style="padding: 28px 24px; overflow: auto;">
      <div v-if="store.loading" style="text-align:center; padding: 80px 0;">
        <NSpin size="large" />
      </div>

      <NEmpty v-else-if="store.workspaces.length === 0"
        description="还没有 Workspace，点击右上角新建一个"
        style="margin-top: 80px;" />

      <NGrid v-else :cols="3" :x-gap="16" :y-gap="16" responsive="screen" :item-responsive="true">
        <NGridItem v-for="ws in store.workspaces" :key="ws.id" span="1">
          <NCard hoverable style="cursor: pointer;" @click="router.push(`/workspace/${ws.id}`)">
            <NSpace vertical :size="8">
              <NText strong style="font-size: 15px;">{{ ws.name }}</NText>
              <NText depth="3" style="font-size: 13px; min-height: 20px;">
                {{ ws.description || '无描述' }}
              </NText>
              <NSpace align="center">
                <NTag :type="STACK_COLORS[ws.techStack] ?? 'default'" size="small" round>
                  {{ ws.techStack }}
                </NTag>
                <NText v-if="ws.localPath" depth="3" style="font-size: 11px; word-break: break-all;">
                  {{ ws.localPath }}
                </NText>
              </NSpace>
              <!-- 操作按钮 -->
              <NSpace style="margin-top: 4px;">
                <NButton size="small" @click="openEdit(ws, $event)">编辑</NButton>
                <NPopconfirm @positive-click="handleDelete(ws.id)" @click.stop>
                  <template #trigger>
                    <NButton size="small" type="error" @click.stop>删除</NButton>
                  </template>
                  确定删除「{{ ws.name }}」及其本地目录吗？
                </NPopconfirm>
              </NSpace>
            </NSpace>
          </NCard>
        </NGridItem>
      </NGrid>
    </NLayoutContent>
  </NLayout>

  <!-- 创建 Modal -->
  <NModal v-model:show="showCreate">
    <NCard title="新建 Workspace" closable style="width:500px;background:#fff;" @close="showCreate = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="名称 *">
          <NInput v-model:value="createForm.name" placeholder="如：电商平台" />
        </NFormItem>
        <NFormItem label="描述">
          <NInput v-model:value="createForm.description" placeholder="简要说明项目用途" />
        </NFormItem>
        <NFormItem label="仓库地址">
          <NInput v-model:value="createForm.repoUrl" placeholder="https://github.com/..." />
        </NFormItem>
        <NFormItem label="技术选型">
          <NSelect v-model:value="createForm.techStack" :options="techOptions" />
        </NFormItem>
        <NFormItem label="背景上下文">
          <NInput v-model:value="createForm.background" type="textarea" :rows="4"
            placeholder="项目背景、约束、注意事项..." />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" :disabled="!createForm.name.trim()" @click="handleCreate">
            创建
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>

  <!-- 编辑 Modal -->
  <NModal v-model:show="showEdit">
    <NCard title="编辑 Workspace" closable style="width:500px;background:#fff;" @close="showEdit = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="名称 *">
          <NInput v-model:value="editForm.name" />
        </NFormItem>
        <NFormItem label="描述">
          <NInput v-model:value="editForm.description" />
        </NFormItem>
        <NFormItem label="仓库地址">
          <NInput v-model:value="editForm.repoUrl" />
        </NFormItem>
        <NFormItem label="技术选型">
          <NSelect v-model:value="editForm.techStack" :options="techOptions" />
        </NFormItem>
        <NFormItem label="背景上下文">
          <NInput v-model:value="editForm.background" type="textarea" :rows="4" />
        </NFormItem>
        <NFormItem label="本地执行目录（只读）">
          <NInput :value="editTarget?.localPath ?? ''" disabled />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showEdit = false">取消</NButton>
          <NButton type="primary" :loading="editing" :disabled="!editForm.name.trim()" @click="handleEdit">
            保存
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
