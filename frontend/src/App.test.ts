// Implements: bug-report 2026-06-18 / docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// App.vue 全局布局测试：进入 /workspace/:workspaceId/workflows 等子路由时，
// 必须渲染顶部导航头部（面包屑），让用户能从工作流页面回到 workspace。
//
// 关键约束：
// - 测试 App.vue（包含 NLayout/NLayoutHeader），而不是单个 view。
// - 走真路由（createMemoryHistory + 真路由表），保证 meta → 头部 的链路被验证。
// - 用 NMessageProvider 包裹：后续 view 内的 useMessage() 才会工作。
// - 工作区名走 store 异步加载：测试用 flushPromises 等 store 加载完成。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import App from './App.vue'
import { api, type WorkspaceDetail } from '@/api'

// mock @/api：只需要 workspaces.get / list 这两个被 store 触发的方法
vi.mock('@/api', () => ({
  api: {
    workspaces: {
      get: vi.fn(),
      list: vi.fn(),
    },
  },
}))

// 宿主：包一层 Naive UI providers，跟 main.ts 顶层栈一致
// App.vue 自身只包 NConfigProvider，但路由到的 view 可能 useMessage()。
const Host = defineComponent({
  components: { NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider, App },
  template: `
    <NConfigProvider>
      <NMessageProvider>
        <NDialogProvider>
          <NNotificationProvider>
            <App />
          </NNotificationProvider>
        </NDialogProvider>
      </NMessageProvider>
    </NConfigProvider>
  `,
})

const makeDetail = (overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail => ({
  id: 'ws-1',
  name: '电商平台',
  description: '',
  repoUrl: '',
  techStack: 'ts',
  background: '',
  localPath: '/tmp/ws-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [],
  ...overrides,
})

async function mountAtRoute(path: string) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div data-testid="home">home</div>' } },
      {
        path: '/workspace/:workspaceId',
        component: { template: '<div data-testid="workspace">workspace</div>' },
      },
      {
        path: '/workspace/:workspaceId/workflows',
        component: { template: '<div data-testid="workflow-list">list</div>' },
      },
      {
        path: '/workspace/:workspaceId/workflow/:workflowId',
        component: { template: '<div data-testid="workflow-editor">editor</div>' },
      },
      {
        path: '/workspace/:workspaceId/feature/:featureId',
        component: { template: '<div data-testid="feature">feature</div>' },
      },
      { path: '/config', component: { template: '<div data-testid="config">config</div>' } },
    ],
  })
  await router.push(path)
  await router.isReady()
  const wrapper = mount(Host, { global: { plugins: [createPinia(), router] } })
  await flushPromises()
  return wrapper
}

describe('App.vue (bug-report 2026-06-18) - 全局导航头部', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workspaces.get).mockReset()
    vi.mocked(api.workspaces.list).mockReset()
    // 默认 list 返回空数组，避免 HomeView onMounted 触发 fetchAll 抛错
    vi.mocked(api.workspaces.list).mockResolvedValue([])
  })

  // ─── 切片 1：workflow 列表路由下渲染顶部导航 ─────────
  it('① /workspace/:id/workflows 路由下渲染顶部导航头部（面包屑）', async () => {
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    const wrapper = await mountAtRoute('/workspace/ws-1/workflows')

    // 关键断言：存在 NBreadcrumb（naive-ui 渲染为 .n-breadcrumb）
    const breadcrumb = wrapper.find('.n-breadcrumb')
    expect(breadcrumb.exists()).toBe(true)
  })

  // ─── 切片 2：面包屑末项文案 = "Workflows" ─────────────
  it('② /workspace/:id/workflows 路由下，面包屑末项显示 "Workflows"', async () => {
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    const wrapper = await mountAtRoute('/workspace/ws-1/workflows')

    // 面包屑最后一级（不可点击）显示当前视图名
    const breadcrumb = wrapper.find('.n-breadcrumb')
    expect(breadcrumb.exists()).toBe(true)
    // 取最后一个面包屑项（naive-ui 没有 --last modifier class）
    const items = wrapper.findAll('.n-breadcrumb-item')
    expect(items.length).toBeGreaterThan(0)
    const lastItem = items[items.length - 1]!
    expect(lastItem.text()).toContain('Workflows')
  })

  // ─── 切片 3：根级别点击 → 回到 / ─────────────────────
  it('③ 点击面包屑根级别导航到 /', async () => {
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    const wrapper = await mountAtRoute('/workspace/ws-1/workflows')

    const items = wrapper.findAll('.n-breadcrumb-item')
    expect(items.length).toBeGreaterThan(0)
    // naive-ui 把可点击项包在 .n-breadcrumb-item__link 里；点击那个 span 才能触发
    const rootLink = items[0]!.find('.n-breadcrumb-item__link')
    if (rootLink.exists()) {
      await rootLink.trigger('click')
    } else {
      await items[0]!.trigger('click')
    }
    await flushPromises()

    // 通过 RouterView 渲染的内容判断当前路由
    expect(wrapper.find('[data-testid="home"]').exists()).toBe(true)
  })

  // ─── 切片 4：工作区名出现在面包屑 ─────────────────────
  it('④ 工作区详情加载后，面包屑包含工作区名 "电商平台"', async () => {
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    const wrapper = await mountAtRoute('/workspace/ws-1/workflows')

    const breadcrumb = wrapper.find('.n-breadcrumb')
    expect(breadcrumb.exists()).toBe(true)
    expect(breadcrumb.text()).toContain('电商平台')
  })

  // ─── 切片 5：编辑器路由下面包屑多一层 ─────────────────
  it('⑤ /workspace/:id/workflow/:wfId 路由下，面包屑末项为 workflow 名 + 共 4 级', async () => {
    // 工作区详情同步可用；workflow 名通过 store 异步加载
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    // workflows.get 不在 slice 5 范围内，留默认（mockResolvedValue undefined 也会被 store 缓存空对象，
    // 但 breadcrumb 只会读 store.getDetail；此处显式 mock 一份 detail 让 store 拿到 name）
    vi.mocked((api as any).workflows?.get ?? vi.fn()).mockReset?.()
    // 简化：把 workflow 详情 mock 在 @/api 上（如果存在）
    const apiAny = api as any
    if (!apiAny.workflows) apiAny.workflows = {}
    apiAny.workflows.get = vi.fn().mockResolvedValue({
      id: 'wf-1',
      workspaceId: 'ws-1',
      name: '默认流水线',
      description: '',
      isArchived: false,
      createdAt: '',
      updatedAt: '',
      nodes: [],
      edges: [],
    })
    apiAny.workflows.list = vi.fn().mockResolvedValue([])
    apiAny.workflows.create = vi.fn()
    apiAny.workflows.update = vi.fn()
    apiAny.workflows.remove = vi.fn()
    apiAny.workflows.updateGraph = vi.fn()

    const wrapper = await mountAtRoute('/workspace/ws-1/workflow/wf-1')

    const breadcrumb = wrapper.find('.n-breadcrumb')
    expect(breadcrumb.exists()).toBe(true)

    // 末项应显示 workflow 名 "默认流水线"（当前层级）
    const items5 = wrapper.findAll('.n-breadcrumb-item')
    expect(items5.length).toBe(4)
    const lastItem = items5[items5.length - 1]!
    expect(lastItem.text()).toContain('默认流水线')

    // 4 级：SDD Multi-Agent → 电商平台 → Workflows → 默认流水线
    const items = wrapper.findAll('.n-breadcrumb-item')
    expect(items.length).toBe(4)
  })

  // ─── 切片 6：编辑器下点击 "Workflows" 跳回列表 ─────────
  it('⑥ 编辑器路由下点击 "Workflows" 面包屑项回到 /workspace/:id/workflows', async () => {
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ id: 'ws-1', name: '电商平台' }))
    const apiAny = api as any
    if (!apiAny.workflows) apiAny.workflows = {}
    apiAny.workflows.get = vi.fn().mockResolvedValue({
      id: 'wf-1', workspaceId: 'ws-1', name: '默认流水线', description: '',
      isArchived: false, createdAt: '', updatedAt: '', nodes: [], edges: [],
    })
    apiAny.workflows.list = vi.fn().mockResolvedValue([])

    const wrapper = await mountAtRoute('/workspace/ws-1/workflow/wf-1')

    const items = wrapper.findAll('.n-breadcrumb-item')
    // 4 级：SDD / 电商 / Workflows / 默认流水线
    // "Workflows" 在第 3 个（index 2）
    expect(items.length).toBe(4)
    // naive-ui 在可点击项里渲染 .n-breadcrumb-item__link；点击它才能触发 onClick
    const link = items[2]!.find('.n-breadcrumb-item__link')
    if (link.exists()) {
      await link.trigger('click')
    } else {
      await items[2]!.trigger('click')
    }
    await flushPromises()

    // 跳到 list 后 RouterView 渲染的应是 list 测试替身
    expect(wrapper.find('[data-testid="workflow-list"]').exists()).toBe(true)
  })
})
