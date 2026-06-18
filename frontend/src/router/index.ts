import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/workspace/:workspaceId',
      component: () => import('@/views/WorkspaceView.vue'),
    },
    {
      // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
      // 工作区下所有 workflow 列表
      path: '/workspace/:workspaceId/workflows',
      component: () => import('@/views/WorkflowListView.vue'),
    },
    {
      // 单个 workflow 编辑器；workflowId === 'new' 表示新建
      path: '/workspace/:workspaceId/workflow/:workflowId',
      component: () => import('@/views/WorkflowEditorView.vue'),
    },
    {
      path: '/workspace/:workspaceId/feature/:featureId',
      component: () => import('@/views/FeatureView.vue'),
    },
    {
      path: '/config',
      component: () => import('@/views/ConfigView.vue'),
    },
  ],
})

export default router
