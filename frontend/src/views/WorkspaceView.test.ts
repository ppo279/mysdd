// Implements: tasks.md#T024 / plan.md#R-02
// WorkspaceView 组件测试：legacy 工作区操作菜单显示"迁移到新结构…"项。
// 测试目标（来自 spec.md#SCN-06 + plan.md#R-02）：
//   ① detail.isLegacy === true 时操作菜单含"迁移到新结构…"项
//   ② detail.isLegacy === false 时不显示该菜单项
//   ③ 点击该菜单项触发二次确认弹窗打开事件
// 本期先写测试（RED 阶段），T025 实现对应代码（GREEN）。
//
// 关键约定：
// - 通过 defineExpose 暴露的 reinitMenuOption / showReinitConfirm / handleMenuSelect 访问内部状态，
//   这样测试不依赖 NDropdown 弹层渲染（naive-ui 弹层在 jsdom 中需 click trigger 才会渲染）。
// - mock @/api 的 workspaces.get 模拟后端 DTO（含 isLegacy 字段）。
// - 用 NMessageProvider 包裹组件：WorkspaceView 内 useMessage() 依赖该 provider。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h } from 'vue'
import { NConfigProvider, NGlobalStyle, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import WorkspaceView from './WorkspaceView.vue'
import App from '@/App.vue'
import { api, type WorkspaceDetail } from '@/api'

// mock 整个 @/api 模块：T024 只需要 workspaces.get；T026 扩展 reinit
vi.mock('@/api', () => ({
  api: {
    workspaces: {
      get: vi.fn(),
      reinit: vi.fn(),
    },
    features: {
      delete: vi.fn(),
    },
  },
}))

// T026 工具：根据帧数组同步驱动 api.workspaces.reinit 的 onChunk 回调
function mockReinitWithFrames(frames: Array<{ text?: string; done?: boolean; error?: boolean }>) {
  vi.mocked(api.workspaces.reinit).mockImplementation(
    async (_id: string, onChunk: (chunk: { text?: string; done?: boolean; error?: boolean }) => void) => {
      for (const f of frames) onChunk(f)
    },
  )
}

const makeDetail = (overrides: Partial<WorkspaceDetail> = {}): WorkspaceDetail => ({
  id: 'ws-1',
  name: 'test',
  description: '',
  repoUrl: '',
  techStack: 'ts',
  background: '',
  localPath: '/tmp/ws-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  features: [],
  ...overrides,
})

// 包一层 NMessageProvider 的宿主组件，WorkspaceView 内 useMessage() 依赖该 provider
// T024 单元测试不关心 Teleport 行为（Teleport 注入的是 App.vue 全局 header 的事）；
// 把 Teleport stub 成就地渲染，避免 jsdom 里 querySelector 时序问题触发 Vue 内部 vnode.component=null 错误。
const Host = defineComponent({
  components: { NMessageProvider, WorkspaceView },
  template: `<NMessageProvider><WorkspaceView /></NMessageProvider>`,
})

async function mountView(detail: WorkspaceDetail | null): Promise<VueWrapper> {
  if (detail) {
    vi.mocked(api.workspaces.get).mockResolvedValue(detail)
  } else {
    vi.mocked(api.workspaces.get).mockRejectedValue(new Error('Not found'))
  }
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/workspace/:workspaceId', component: WorkspaceView },
      { path: '/workspace/:workspaceId/feature/:featureId', component: { template: '<div/>' } },
    ],
  })
  await router.push(`/workspace/${detail?.id ?? 'ws-1'}`)
  await router.isReady()
  const wrapper = mount(Host, {
    global: {
      plugins: [createPinia(), router],
      stubs: {
        // Teleport stub：让 Teleport 内容就地渲染（不实际搬运到 DOM 别处）。
        // jsdom 里 Teleport 目标的 querySelector 时序不稳定，stub 后避免 Vue 内部
        // vnode.component=null 错误影响测试结果。
        Teleport: { template: '<div><slot /></div>' },
      },
    },
  })
  await flushPromises()   // 等 onMounted → api.workspaces.get → detail.value 赋值
  // 返回内层 WorkspaceView 实例（通过 ref 即可）
  return wrapper
}

describe('WorkspaceView (T024) - legacy 操作菜单项', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workspaces.get).mockReset()
  })

  it('① isLegacy=true 时菜单项 reinitMenuOption = {label: "迁移到新结构…", key: "reinit"}', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)

    // 关键断言：暴露的菜单项对象存在且文案为"迁移到新结构…"
    expect(ws.vm.reinitMenuOption).toEqual({
      label: '迁移到新结构…',
      key: 'reinit',
    })
  })

  it('② isLegacy=false 时不显示 reinitMenuOption（应为 null）', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: false }))
    const ws = wrapper.findComponent(WorkspaceView)

    // 反向断言：非 legacy 工作区不显示迁移菜单项
    expect(ws.vm.reinitMenuOption).toBeNull()
  })

  it('③ 点击"迁移到新结构…" → showReinitConfirm 由 false 变为 true（打开二次确认弹窗）', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)

    // 初始状态：弹窗未开
    expect(ws.vm.showReinitConfirm).toBe(false)

    // 模拟菜单点击（NDropdown 的 onSelect 回调）
    ws.vm.handleMenuSelect('reinit')
    await flushPromises()

    // 关键断言：点击后 showReinitConfirm 变 true（弹窗打开）
    expect(ws.vm.showReinitConfirm).toBe(true)

    // 反向断言：其他 key 不应触发弹窗
    ws.vm.showReinitConfirm = false
    ws.vm.handleMenuSelect('edit')
    await flushPromises()
    expect(ws.vm.showReinitConfirm).toBe(false)
  })

  // ─── T026：二次确认弹窗 + SSE 日志 ────────────────────────
  it('④ 打开迁移 modal 后，渲染"开始迁移"按钮', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)
    ws.vm.showReinitConfirm = true
    await flushPromises()

    // naive-ui 的 NModal 默认 teleport 到 body 外层；document.body 包含 portal 内容
    const allWrapperBtns = wrapper.findAll('button')
    const allDomBtns = Array.from(document.body.querySelectorAll('button')) as HTMLElement[]
    const startBtn = allWrapperBtns.find((b) => b.text().includes('开始迁移'))
      ?? allDomBtns.find((b) => (b.textContent ?? '').includes('开始迁移'))
    expect(startBtn).toBeDefined()
  })

  it('⑤ 点击"开始迁移" → 调用 api.workspaces.reinit；reinitLog 累积收到的 text 帧', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)
    ws.vm.showReinitConfirm = true
    await flushPromises()
    mockReinitWithFrames([
      { text: '🔧 创建 memory/\n' },
      { text: '🔧 创建 tmp/\n' },
      { text: '📦 移动既有内容到 repo/\n' },
    ])
    // 第一次 get 在 mount 时已调用，重置计数便于断言 reload
    vi.mocked(api.workspaces.get).mockClear()
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ isLegacy: true }))

    // 调用 handleStartReinit（与"开始迁移"按钮绑定）
    await ws.vm.handleStartReinit()
    await flushPromises()

    // 关键断言：api.workspaces.reinit 被以正确 id 调用
    expect(api.workspaces.reinit).toHaveBeenCalledTimes(1)
    expect(api.workspaces.reinit).toHaveBeenCalledWith(
      'ws-1',
      expect.any(Function),
    )
    // 关键断言：所有 text 帧按顺序追加到 reinitLog
    expect(ws.vm.reinitLog).toEqual([
      '🔧 创建 memory/\n',
      '🔧 创建 tmp/\n',
      '📦 移动既有内容到 repo/\n',
    ])
    // 关键断言：未完成时 modal 仍打开（保持 streaming 状态）
    expect(ws.vm.showReinitConfirm).toBe(true)
    // 关键断言：未出错时 reinitError 仍为 false
    expect(ws.vm.reinitError).toBe(false)
  })

  it('⑥ done:true 帧到达 → modal 关闭 + reinitBusy=false + 重新拉取 detail（reload）', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)
    ws.vm.showReinitConfirm = true
    await flushPromises()
    mockReinitWithFrames([
      { text: '🔧 创建 memory/\n' },
      { text: '\n✅ 迁移完成！\n', done: true },
    ])
    vi.mocked(api.workspaces.get).mockClear()
    vi.mocked(api.workspaces.get).mockResolvedValue(makeDetail({ isLegacy: true }))

    await ws.vm.handleStartReinit()
    await flushPromises()

    // 关键断言：done 后 modal 自动关闭
    expect(ws.vm.showReinitConfirm).toBe(false)
    // 关键断言：done 后 reinitBusy 变 false（按钮恢复可点）
    expect(ws.vm.reinitBusy).toBe(false)
    // 关键断言：done 后重新拉取 workspace detail（reload 反映新结构）
    expect(api.workspaces.get).toHaveBeenCalledTimes(1)
    expect(api.workspaces.get).toHaveBeenCalledWith('ws-1')
    // 反向断言：done 时 reinitError 应保持 false
    expect(ws.vm.reinitError).toBe(false)
  })

  it('⑦ error:true 帧到达 → modal 保持打开 + reinitError=true + 错误行入 reinitLog', async () => {
    const wrapper = await mountView(makeDetail({ isLegacy: true }))
    const ws = wrapper.findComponent(WorkspaceView)
    ws.vm.showReinitConfirm = true
    await flushPromises()
    mockReinitWithFrames([
      { text: '🔧 创建 memory/\n' },
      { text: '\n❌ 目标目录 ... 已存在且非空，无法迁移。\n', done: true, error: true },
    ])
    // 清空 onMounted 时调用的 get，便于断言 error 时未触发 reload
    vi.mocked(api.workspaces.get).mockClear()

    await ws.vm.handleStartReinit()
    await flushPromises()

    // 关键断言：error 时 modal 保持打开（用户可查看错误）
    expect(ws.vm.showReinitConfirm).toBe(true)
    // 关键断言：error 时 reinitError=true（用于错误样式）
    expect(ws.vm.reinitError).toBe(true)
    // 关键断言：error 行也进入 reinitLog
    expect(ws.vm.reinitLog).toContain('🔧 创建 memory/\n')
    expect(ws.vm.reinitLog).toContain('\n❌ 目标目录 ... 已存在且非空，无法迁移。\n')
    // 关键断言：error 后 reinitBusy=false（用户可关闭弹窗）
    expect(ws.vm.reinitBusy).toBe(false)
    // 反向断言：error 时不应触发 reload
    expect(api.workspaces.get).not.toHaveBeenCalled()
  })
})

// Implements: bug-report 2026-06-18 / slice 6
// 整页只渲染 1 个 .n-breadcrumb（来自 App.vue 全局 header）；
// view 自带 NLayoutHeader 已删除，操作按钮通过 Teleport 注入到 #app-header-actions-slot。
describe('WorkspaceView (bug-report 2026-06-18 / slice 6) - 不再重复渲染 breadcrumb', () => {
  // 装 App.vue（带全局 header）+ 真实的 WorkspaceView 作为 /workspace/:id 路由
  // —— 模拟用户实际看到的整页 DOM
  // 必须把所有 Naive UI providers 在 components 里显式注册，模板里用到的组件才会被解析
  const AppHost = defineComponent({
    components: {
      NConfigProvider, NGlobalStyle, NMessageProvider, NDialogProvider, NNotificationProvider, App,
    },
    template: `<NConfigProvider :theme="null" style="height: 100%">
      <NGlobalStyle />
      <NMessageProvider>
        <NDialogProvider>
          <NNotificationProvider>
            <App />
          </NNotificationProvider>
        </NDialogProvider>
      </NMessageProvider>
    </NConfigProvider>`,
  })

  async function mountWorkspacePage(detail: WorkspaceDetail): Promise<VueWrapper> {
    vi.mocked(api.workspaces.get).mockResolvedValue(detail)
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/', component: { template: '<div/>' } },
        { path: '/workspace/:workspaceId', component: WorkspaceView },
        { path: '/workspace/:workspaceId/feature/:featureId', component: { template: '<div/>' } },
        { path: '/workspace/:workspaceId/workflows', component: { template: '<div/>' } },
        { path: '/workspace/:workspaceId/workflow/:workflowId', component: { template: '<div/>' } },
        { path: '/config', component: { template: '<div/>' } },
      ],
    })
    await router.push(`/workspace/${detail.id}`)
    await router.isReady()
    const wrapper = mount(AppHost, {
      global: { plugins: [createPinia(), router] },
    })
    // 等 App.vue 的 watch(immediate) → loadWorkspace → store 赋值
    // 等 WorkspaceView 的 onMounted → api.workspaces.get
    // 等 Teleport 目标 div 出现 + Teleport 内容挂载
    await flushPromises()
    return wrapper
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workspaces.get).mockReset()
  })

  it('整页只渲染 1 个 .n-breadcrumb（来自 App.vue 全局 header，view 不再自带）', async () => {
    const wrapper = await mountWorkspacePage(makeDetail({ id: 'ws-1', name: '电商平台' }))
    expect(wrapper.findAll('.n-breadcrumb')).toHaveLength(1)
  })
})
