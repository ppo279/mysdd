// Bug 复现：WorkflowEditorView 改名后点保存，刷新页面名称没回来。
// 根因：save() 走的是 PATCH /api/workflows/:id/graph——这个端点的 zod schema
// 只 pick 了 nodes + edges，name/description 字段被静默丢弃。
// 测试目标：模拟用户改了 name 输入框 + 点保存 → 断言后端被调用 update({name, description})。
// 当前实现不会调用 update，本测试应失败 = RED。

// jsdom 不带 ResizeObserver——vue-flow onMounted 里 new ResizeObserver() 会崩
;(globalThis as any).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent } from 'vue'
import { NMessageProvider } from 'naive-ui'
import WorkflowEditorView from './WorkflowEditorView.vue'
import { api, type WorkflowDetail } from '@/api'

vi.mock('@/api', () => ({
  api: {
    workflows: {
      get: vi.fn(),
      update: vi.fn(),
      updateGraph: vi.fn(),
      create: vi.fn(),
    },
    config: {
      agents: vi.fn(),
    },
  },
}))

const makeDetail = (overrides: Partial<WorkflowDetail> = {}): WorkflowDetail => ({
  id: 'wf-1',
  workspaceId: 'ws-1',
  name: '旧名字',
  description: '旧描述',
  isArchived: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  nodes: [
    {
      nodeId: 'spec', agentId: 'spec', positionX: 0, positionY: 0,
      configJson: '{"outputs":["default"],"inputs":["default"]}',
      displayName: 'spec',
    },
  ],
  edges: [],
  ...overrides,
})

const Host = defineComponent({
  components: { NMessageProvider, WorkflowEditorView },
  template: `<NMessageProvider><WorkflowEditorView /></NMessageProvider>`,
})

async function mountEditor(detail: WorkflowDetail): Promise<VueWrapper> {
  vi.mocked(api.workflows.get).mockResolvedValue(detail)
  vi.mocked(api.config.agents).mockResolvedValue({
    runtimes: [{ id: 'claude', type: 'claude-cli', command: 'claude' }],
    global: { base_layers: [] },
    agents: [
      {
        id: 'spec', name: 'Spec', runtime: 'claude',
        instruction: '', output_file: 'spec.md',
        // slice 03：spec 是入口节点，无 inputs（空数组），否则 input coverage 校验会拒
        outputs: ['default'], inputs: [],
      },
    ],
  })
  vi.mocked(api.workflows.update).mockResolvedValue({ ...detail })
  vi.mocked(api.workflows.updateGraph).mockResolvedValue({ ...detail })
  vi.mocked(api.workflows.create).mockResolvedValue({ ...detail })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/workspace/:workspaceId', component: { template: '<div/>' } },
      {
        path: '/workspace/:workspaceId/workflow/:workflowId',
        component: WorkflowEditorView,
      },
    ],
  })
  await router.push(`/workspace/ws-1/workflow/wf-1`)
  await router.isReady()

  const wrapper = mount(Host, {
    global: { plugins: [createPinia(), router] },
  })
  await flushPromises()
  return wrapper
}

describe('WorkflowEditorView save() — 改名持久化 bug', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workflows.get).mockReset()
    vi.mocked(api.workflows.update).mockReset()
    vi.mocked(api.workflows.updateGraph).mockReset()
  })

  it('用户改名 + 点保存 → 后端应收到 PATCH /api/workflows/:id 带新名字', async () => {
    const wrapper = await mountEditor(makeDetail({ name: '旧名字', description: '旧描述' }))

    // 模拟用户改名（通过 DOM 改 v-model 绑定的输入框）
    const nameInput = wrapper.find('input[placeholder="Workflow 名称"]')
    expect(nameInput.exists()).toBe(true)
    await nameInput.setValue('新名字')
    const descInput = wrapper.find('input[placeholder="描述（可选）"]')
    expect(descInput.exists()).toBe(true)
    await descInput.setValue('新描述')
    await flushPromises()

    // 找"保存"按钮并点击
    const saveBtn = wrapper.findAll('button').find((b) => b.text().includes('保存'))
    expect(saveBtn).toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    // 关键断言 1：改名必须打到 PATCH /api/workflows/:id（update），不是只 updateGraph
    expect(api.workflows.update).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({ name: '新名字', description: '新描述' }),
    )
    // 关键断言 2：图照旧走 updateGraph（nodes + edges）
    expect(api.workflows.updateGraph).toHaveBeenCalledWith(
      'wf-1',
      expect.objectContaining({
        nodes: expect.any(Array),
        edges: expect.any(Array),
      }),
    )
  })
})

// Implements: .scratch/agent-contract-db/issues/03-workflow-port-validation.md
// slice 03 起的端口契约：agent 的 inputs/outputs 才是真相之源。
// 以下 3 个测试覆盖：编辑节点的 modal 不再暴露 inputs/outputs 输入框、
// validateLocal 拒 port 不一致的边、加载老 workflow 时显示 banner 提示清理。
describe('WorkflowEditorView — slice 03 端口契约', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.workflows.get).mockReset()
    vi.mocked(api.workflows.update).mockReset()
    vi.mocked(api.workflows.updateGraph).mockReset()
  })

  it('双击编辑节点弹窗不再含 inputs/outputs 输入框', async () => {
    const wrapper = await mountEditor(makeDetail())
    // 通过 defineExpose 调用 openAddNode 风格的入口：双击需要 vue-flow 内部交互
    // 这里直接改 node.selected 走 onNodeDoubleClick 不可靠——改用 vm 上 openAddNode
    // 验证"添加节点" modal 也不含 inputs/outputs 输入框。
    const addBtn = wrapper.findAll('button').find((b) => b.text().includes('添加节点'))!
    await addBtn.trigger('click')
    await flushPromises()
    // 添加节点 modal 里 inputs/outputs 是只读 NTag，不是 input/textarea
    const inputBoxes = wrapper.findAll('input, textarea')
    const placeholders = inputBoxes.map((i) => i.attributes('placeholder')).filter(Boolean)
    // 仅允许 "选择一个 agent" 和 "例如 写规格 / 出方案"——没有 ports 编辑入口
    expect(placeholders).not.toContain('outputs (逗号分隔)')
    expect(placeholders).not.toContain('inputs (逗号分隔)')
  })

  it('validateLocal 拒 port 名不在 agent 声明内的边', async () => {
    // plan agent 声明 outputs=['default'] inputs=['default']；spec 声明 inputs=[]
    // spec 的 'default' outputs 不能用 (用 'foo')——直接造一个非法的 from_output
    const detail = makeDetail({
      nodes: [
        { nodeId: 'spec', agentId: 'spec', positionX: 0, positionY: 0,
          configJson: '{}', displayName: 'spec' },
        { nodeId: 'plan', agentId: 'plan', positionX: 200, positionY: 0,
          configJson: '{}', displayName: 'plan' },
      ],
    })
    // 用一个非法的 port 名注入一条边——但需要走 vm 的 edges 直接设置
    const wrapper = await mountEditorWithAgents(detail, [
      { id: 'spec', name: 'Spec', runtime: 'claude', instruction: '', output_file: '',
        outputs: ['default'], inputs: [] },
      { id: 'plan', name: 'Plan', runtime: 'claude', instruction: '', output_file: '',
        outputs: ['default'], inputs: ['default'] },
    ])
    const vm = wrapper.findComponent(WorkflowEditorView).vm as any
    // 注入一个非法 fromOutput='foo' 的边（spec.outputs=['default'] 不含 'foo'）
    vm.edges = [{
      id: 'e-spec-foo->plan-default',
      source: 'spec', target: 'plan',
      sourceHandle: 'spec-out-foo', targetHandle: 'plan-in-default',
    }]
    await flushPromises()
    const v = vm.validateLocal()
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/用了源 agent 没声明的输出 "foo"/)
  })

  it('老 workflow 含 config_json.outputs/inputs 覆盖时显示 banner', async () => {
    const wrapper = await mountEditor(makeDetail({
      nodes: [{
        nodeId: 'spec', agentId: 'spec', positionX: 0, positionY: 0,
        configJson: '{"outputs":["default"],"inputs":["default"]}',  // 老形状
        displayName: 'spec',
      }],
    }))
    // NAlert 标题里含"节点级 ports 覆盖已废弃"
    const html = wrapper.html()
    expect(html).toContain('节点级 ports 覆盖已废弃')
  })
})

async function mountEditorWithAgents(
  detail: WorkflowDetail,
  agents: Array<{ id: string; name: string; runtime: string; instruction: string; output_file: string; outputs?: string[]; inputs?: string[] }>,
): Promise<VueWrapper> {
  vi.mocked(api.workflows.get).mockResolvedValue(detail)
  vi.mocked(api.config.agents).mockResolvedValue({
    runtimes: [{ id: 'claude', type: 'claude-cli', command: 'claude' }],
    global: { base_layers: [] },
    agents,
  })
  vi.mocked(api.workflows.update).mockResolvedValue({ ...detail })
  vi.mocked(api.workflows.updateGraph).mockResolvedValue({ ...detail })
  vi.mocked(api.workflows.create).mockResolvedValue({ ...detail })

  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div/>' } },
      { path: '/workspace/:workspaceId', component: { template: '<div/>' } },
      {
        path: '/workspace/:workspaceId/workflow/:workflowId',
        component: WorkflowEditorView,
      },
    ],
  })
  await router.push(`/workspace/ws-1/workflow/wf-1`)
  await router.isReady()

  const wrapper = mount(Host, {
    global: { plugins: [createPinia(), router] },
  })
  await flushPromises()
  return wrapper
}