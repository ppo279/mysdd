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
