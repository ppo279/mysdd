<script setup lang="ts">
// Implements: bug-report 2026-06-18
// 进入 /workspace/:id/workflows 与 /workflow/:id 之后页面没有导航头部，
// 用户无法回退。把顶部面包屑提到 App.vue 全局，所有路由共享。
//
// 关键设计：
// - 路由层不依赖 route.meta：面包屑层级由 path/params 直接推导，零配置即可工作。
// - 异步资源（工作区名、workflow 名）通过 watch + store.loadXxx 按需拉取，
//   拉取前显示 "…" 占位，避免对每个路由都强制发起请求。
// - 现有 view（WorkspaceView / FeatureView）仍保留各自的 NLayout 内部容器，
//   嵌套在 NLayout 内是合法的（多一层 div 但不破坏布局）。view 内部重复的
//   NLayoutHeader 在后续 slice 6 重构步骤统一删除。

import { computed, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import {
  NConfigProvider, NGlobalStyle, NMessageProvider, NDialogProvider,
  NNotificationProvider, NLayout, NLayoutHeader,
  NBreadcrumb, NBreadcrumbItem,
} from 'naive-ui'
import { useWorkspaceStore } from '@/stores/workspace'
import { useWorkflowStore } from '@/stores/workflow'

type Crumb = { label: string; to?: string }

const route = useRoute()
const router = useRouter()
const wsStore = useWorkspaceStore()
const wfStore = useWorkflowStore()

const crumbs = computed<Crumb[]>(() => {
  const items: Crumb[] = [{ label: 'SDD Multi-Agent', to: '/' }]
  const workspaceId = String(route.params.workspaceId ?? '')
  if (workspaceId) {
    const ws = wsStore.detail?.id === workspaceId ? wsStore.detail : null
    items.push({ label: ws?.name ?? '…', to: `/workspace/${workspaceId}` })
  }
  // workflow 列表（路径末尾固定为 /workflows）
  if (/\/workflows$/.test(route.path)) {
    items.push({ label: 'Workflows' })
    return items
  }
  // workflow 编辑器：workflowId === 'new' 表示新建态
  const workflowId = String(route.params.workflowId ?? '')
  if (workflowId) {
    items.push({ label: 'Workflows', to: `/workspace/${workspaceId}/workflows` })
    items.push({
      label: workflowId === 'new'
        ? '新建 Workflow'
        : (wfStore.detail[workflowId]?.name ?? '…'),
    })
    return items
  }
  // 全局配置
  if (route.path === '/config') {
    items.push({ label: 'Agent 配置' })
  }
  return items
})

// 路由变化时按需加载工作区详情 → 面包屑显示真实名称
watch(
  () => route.params.workspaceId,
  async (id) => {
    if (typeof id !== 'string' || !id) return
    if (wsStore.detail?.id === id) return
    try { await wsStore.loadWorkspace(id) } catch { /* 网络/鉴权错误静默，breadcrumb 显示 … */ }
  },
  { immediate: true },
)

// 路由变化时按需加载 workflow 详情（新建态跳过）
watch(
  () => route.params.workflowId,
  async (id) => {
    if (typeof id !== 'string' || !id || id === 'new') return
    if (wfStore.detail[id]) return
    try { await wfStore.loadOne(id) } catch { /* ignore */ }
  },
  { immediate: true },
)
</script>

<template>
  <NConfigProvider :theme="null" style="height: 100%">
    <NGlobalStyle />
    <NMessageProvider>
      <NDialogProvider>
        <NNotificationProvider>
          <NLayout style="height: 100vh;">
            <!-- Implements: bug-report 2026-06-18 -->
            <!-- 全局顶部导航：所有路由都显示。to 不存在即为当前层级（不可点击） -->
            <NLayoutHeader
              style="padding: 0 24px; border-bottom: 1px solid #efeff5; background: #fff;"
            >
              <NBreadcrumb style="height: 56px; line-height: 56px;">
                <NBreadcrumbItem
                  v-for="(c, i) in crumbs"
                  :key="i"
                  :clickable="!!c.to"
                  @click="c.to && router.push(c.to)"
                  style="cursor: pointer;"
                >
                  {{ c.label }}
                </NBreadcrumbItem>
              </NBreadcrumb>
            </NLayoutHeader>
            <RouterView />
          </NLayout>
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
</style>
