<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api, type WorkspaceDetail, type Feature } from '@/api'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NText, NEmpty, NSpin,
  NModal, NCard, NForm, NFormItem, NInput, NTag, NBreadcrumb, NBreadcrumbItem,
  NList, NListItem, NThing, NPopconfirm, useMessage,
} from 'naive-ui'

const router = useRouter()
const route = useRoute()
const workspaceId = route.params.workspaceId as string
const message = useMessage()

const detail = ref<WorkspaceDetail | null>(null)
const showCreate = ref(false)
const creating = ref(false)
const newFeature = ref({ name: '', description: '' })
const deletingId = ref<string | null>(null)

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
  creating.value = true
  try {
    const feature = await api.features.create(workspaceId, newFeature.value)
    detail.value.features.push(feature)
    showCreate.value = false
    newFeature.value = { name: '', description: '' }
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
</script>

<template>
  <NLayout style="height: 100vh;">
    <NLayoutHeader style="padding: 0 24px; border-bottom: 1px solid #efeff5; background: #fff;">
      <NSpace justify="space-between" align="center" style="height: 56px;">
        <NBreadcrumb>
          <NBreadcrumbItem @click="router.push('/')" style="cursor:pointer;">SDD Multi-Agent</NBreadcrumbItem>
          <NBreadcrumbItem>{{ detail?.name ?? '...' }}</NBreadcrumbItem>
        </NBreadcrumb>
        <NButton type="primary" @click="showCreate = true">+ 新建 Feature</NButton>
      </NSpace>
    </NLayoutHeader>

    <NLayoutContent style="padding: 28px 24px; overflow: auto;">
      <div v-if="!detail" style="text-align:center; padding:80px 0;">
        <NSpin size="large" />
      </div>

      <template v-else>
        <!-- Workspace info -->
        <NSpace vertical :size="4" style="margin-bottom: 24px;">
          <NText strong style="font-size: 22px;">{{ detail.name }}</NText>
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
                  <NTag v-if="feature.status === 'done'" type="success" size="small" round>完成</NTag>
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

  <NModal v-model:show="showCreate">
    <NCard title="新建 Feature" closable style="width:460px;background:#fff;"
      @close="showCreate = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="Feature 名称 *">
          <NInput v-model:value="newFeature.name" placeholder="如：用户注册功能" />
        </NFormItem>
        <NFormItem label="描述">
          <NInput v-model:value="newFeature.description" type="textarea" :rows="3"
            placeholder="简要描述这个 Feature 的目标..." />
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
</template>
