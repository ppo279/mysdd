<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkspaceStore } from '@/stores/workspace'
import type { WorkspaceInput } from '@/api'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NGrid, NGridItem,
  NCard, NTag, NText, NEmpty, NSpin, NModal, NForm, NFormItem, NInput,
  NSelect, NScrollbar, useMessage,
} from 'naive-ui'

const router = useRouter()
const store = useWorkspaceStore()
const message = useMessage()

const showCreate = ref(false)
const creating = ref(false)
const form = ref<WorkspaceInput>({ name: '', description: '', repoUrl: '', techStack: 'ts', background: '' })

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
  if (!form.value.name.trim()) return
  creating.value = true
  try {
    const ws = await store.create(form.value)
    showCreate.value = false
    form.value = { name: '', description: '', repoUrl: '', techStack: 'ts', background: '' }
    router.push(`/workspace/${ws.id}`)
    message.success('Workspace 创建成功')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    creating.value = false
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
                <NText v-if="ws.repoUrl" depth="3" style="font-size: 12px;">
                  {{ ws.repoUrl }}
                </NText>
              </NSpace>
            </NSpace>
          </NCard>
        </NGridItem>
      </NGrid>
    </NLayoutContent>
  </NLayout>

  <NModal v-model:show="showCreate">
    <NCard title="新建 Workspace" closable style="width:500px;background:#fff;"
      @close="showCreate = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="名称 *">
          <NInput v-model:value="form.name" placeholder="如：电商平台" />
        </NFormItem>
        <NFormItem label="描述">
          <NInput v-model:value="form.description" placeholder="简要说明项目用途" />
        </NFormItem>
        <NFormItem label="仓库地址">
          <NInput v-model:value="form.repoUrl" placeholder="https://github.com/..." />
        </NFormItem>
        <NFormItem label="技术选型">
          <NSelect v-model:value="form.techStack" :options="techOptions" />
        </NFormItem>
        <NFormItem label="背景上下文">
          <NInput v-model:value="form.background" type="textarea" :rows="4"
            placeholder="项目背景、约束、注意事项..." />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" :disabled="!form.name.trim()" @click="handleCreate">
            创建
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>
</template>
