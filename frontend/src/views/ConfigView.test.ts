// Implements: tasks.md#T032.2 + .scratch/agent-ports-editor/issues/01-ports-editor-ux.md
// ConfigView 组件测试：
// 1. globalSelectedContent computed setter 的存在性守卫（T032.2）
// 2. ports editor UX（slice 9）：PortsEditor 接入、output_file 字段重命名 + 对齐按钮、列表卡片 mini 端口胶囊

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import { defineComponent, h } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider } from 'naive-ui'
import ConfigView from './ConfigView.vue'
import PortsEditor from '@/components/PortsEditor.vue'
import { api, type AgentsYamlRaw } from '@/api'

// mock 整个 @/api：ConfigView onMounted 调 api.config.agents
vi.mock('@/api', () => ({
  api: {
    config: {
      agents: vi.fn(),
      saveAgents: vi.fn(),
    },
  },
}))

const baseRuntimes = [{ id: 'claude', type: 'claude-cli' as const, command: 'claude' }]
const initialConfig: AgentsYamlRaw = {
  runtimes: baseRuntimes,
  global: { base_layers: [{ name: 'L1', content: 'original' }] },
  agents: [],
}

// 每次挂载返回一份深拷贝的 config，避免用例间共享引用污染
function freshConfig(agents: AgentsYamlRaw['agents'] = []): AgentsYamlRaw {
  return {
    runtimes: initialConfig.runtimes.map((r) => ({ ...r })),
    global: {
      base_layers: initialConfig.global.base_layers.map((l) => ({ ...l })),
    },
    agents: agents.map((a) => ({ ...a })),
  }
}

const Host = defineComponent({
  components: { NConfigProvider, NMessageProvider, NDialogProvider, NNotificationProvider, ConfigView },
  template: `<NConfigProvider><NMessageProvider><NDialogProvider><NNotificationProvider><ConfigView /></NNotificationProvider></NDialogProvider></NMessageProvider></NConfigProvider>`,
})

async function mountConfigView(agents: AgentsYamlRaw['agents'] = []): Promise<VueWrapper> {
  vi.mocked(api.config.agents).mockResolvedValue(freshConfig(agents))
  vi.mocked(api.config.saveAgents).mockResolvedValue({ ok: true })
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { template: '<div/>' } }],
  })
  await router.push('/')
  await router.isReady()
  const wrapper = mount(Host, {
    global: { plugins: [createPinia(), router] },
  })
  await flushPromises()   // 等 onMounted → config.value 赋值
  return wrapper
}

// Implements: slice 9 清理 — NModal 跨测试污染防御。
// 同一个 describe 块内 track 过的 wrapper 会在 afterEach 中统一 unmount。
// 必须在 describe 块内部声明，因为要用到块作用域里的 `track` / `trackedWrappers`。

// 打开「编辑 Agent」弹窗：传入 wrapper + 列表里第 N 个 agent
async function openEditAgentModal(wrapper: VueWrapper, agentIndex = 0) {
  const cv = wrapper.findComponent(ConfigView)
  cv.vm.config.agents[agentIndex] // touch
  await cv.findAll('button').find((b) => b.text().includes('编辑'))!.trigger('click')
  await flushPromises()
}

// NModal 用 Teleport 把内容挂到 document.body：
// - wrapper.text() / wrapper.findAll('button') 只看宿主树，看不到弹窗内容
// - 用 document.body 直接 query 才能命中弹窗里的元素
function bodyText(): string {
  return document.body.textContent ?? ''
}

function findModalButton(text: string): HTMLButtonElement | undefined {
  const btns = Array.from(document.body.querySelectorAll('button'))
  return btns.find((b) => (b.textContent ?? '').includes(text))
}

describe('ConfigView (T032.2) - globalSelectedContent setter 索引守卫', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.config.agents).mockReset()
    vi.mocked(api.config.saveAgents).mockReset()
  })

  it('① 选中 base_layer 后写 setter → 对应层 content 被更新', async () => {
    const wrapper = await mountConfigView()
    const cv = wrapper.findComponent(ConfigView)
    // 初始时 globalSelectedIdx=null；点击第一层（idx=0）模拟选中
    cv.vm.globalSelectedIdx = 0
    await flushPromises()
    // 通过 setter 写新内容
    cv.vm.globalSelectedContent = 'updated content'
    await flushPromises()
    // 关键断言：base_layers[0].content 已被更新
    expect(cv.vm.config.global.base_layers[0]?.content).toBe('updated content')
  })

  it('② 未选中（globalSelectedIdx=null）时写 setter → 静默忽略，不抛错', async () => {
    const wrapper = await mountConfigView()
    const cv = wrapper.findComponent(ConfigView)
    // 关键状态：未选中
    expect(cv.vm.globalSelectedIdx).toBeNull()
    // 写 setter 不应抛错
    expect(() => { cv.vm.globalSelectedContent = 'should be ignored' }).not.toThrow()
    // 关键断言：原 base_layers[0].content 未被改写
    expect(cv.vm.config.global.base_layers[0]?.content).toBe('original')
  })
})

// Implements: .scratch/agent-ports-editor/PRD.md
// slice 9 落地：ConfigView 接入 PortsEditor、output_file 字段重命名 + 对齐按钮、列表 mini 端口胶囊。
describe('ConfigView (slice 9) — 端口契约编辑入口', () => {
  // Implements: NModal 的内容 Teleport 到 document.body。
  // vitest 不会自动 unmount 上一个 wrapper，导致前一个测试的 modal 仍残留在 DOM，
  // findModalButton() 误命中旧 modal 的按钮。统一在 afterEach 清理。
  const trackedWrappers: VueWrapper[] = []
  function track(w: VueWrapper) {
    trackedWrappers.push(w)
    return w
  }
  // trackMount 与 track 必须在同一作用域（闭包共享 trackedWrappers）
  async function trackMount(agents: AgentsYamlRaw['agents'] = []): Promise<VueWrapper> {
    return track(await mountConfigView(agents))
  }
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.mocked(api.config.agents).mockReset()
    vi.mocked(api.config.saveAgents).mockReset()
  })
  afterEach(() => {
    for (const w of trackedWrappers) w.unmount()
    trackedWrappers.length = 0
  })

  it('① 编辑弹窗渲染 PortsEditor 组件（不再有 outputs/inputs 文本框）', async () => {
    const agent = {
      id: 'spec', name: 'Spec Agent', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['default'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    // 找 PortsEditor 组件（mock 后通过 findComponent 能命中）
    const editor = w.findComponent(PortsEditor)
    expect(editor.exists()).toBe(true)
    // 关键：原来的两个 NInput（placeholder 含「逗号分隔」）不应再存在
    const placeholders = w.findAll('input,textarea').map((i) => i.attributes('placeholder') ?? '')
    expect(placeholders.some((p) => p.includes('逗号分隔'))).toBe(false)
  })

  it('② output_file 字段标签变为「物理输出文件名」+ 含 helper 反馈', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['default'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const text = bodyText()
    expect(text).toContain('物理输出文件名')
    expect(text).toContain('与 outputs 正交')
  })

  it('③ 「对齐到 outputs[0]」按钮在 outputs 为空时 disabled', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: [], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const alignBtn = findModalButton('对齐到 outputs[0]')!
    expect(alignBtn).toBeDefined()
    expect(alignBtn?.disabled).toBe(true)
  })

  it('④ 「对齐到 outputs[0]」按钮在 outputs[0] !== output_file 时 enabled，点击后复制', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'old-name.md',
      outputs: ['spec.md'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const alignBtn = findModalButton('对齐到 outputs[0]')!
    expect(alignBtn?.disabled).toBe(false)
    alignBtn?.click()
    await flushPromises()
    const cv = w.findComponent(ConfigView)
    expect(cv.vm.agentForm.output_file).toBe('spec.md')
  })

  it('⑤ 「对齐到 outputs[0]」按钮在 outputs[0] === output_file 时 disabled', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['spec.md'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const alignBtn = findModalButton('对齐到 outputs[0]')!
    expect(alignBtn?.disabled).toBe(true)
  })

  it('⑥ 列表卡片用 mini 端口胶囊展示 ports（颜色 token 与画布一致）', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['spec.md', 'plan.md'], inputs: ['default'],
    } as any
    const w = await trackMount([agent])
    await flushPromises()
    // 列表卡片上应有 port-mini--in / port-mini--out 元素
    expect(w.find('.port-mini.port-mini--in').exists()).toBe(true)
    expect(w.find('.port-mini.port-mini--out').exists()).toBe(true)
    // 文本包含端口名
    expect(w.text()).toContain('default')
    expect(w.text()).toContain('spec.md')
    expect(w.text()).toContain('plan.md')
  })

  it('⑦ 列表卡片超过 3 个 ports 时折叠为 +N', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['a', 'b', 'c', 'd', 'e'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await flushPromises()
    // 4 个之后折叠为 +2
    expect(w.text()).toContain('+2')
  })

  it('⑧ 保存 agent 时 outputs/inputs 写入为 string[]（不是字符串）', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['default'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const cv = w.findComponent(ConfigView)
    // 模拟用户编辑：通过暴露的 setXxx 改 ref（直接赋值不替换 ref 本身）
    cv.vm.setAgentOutputs(['spec.md', 'plan.md'])
    cv.vm.setAgentInputs(['spec.md'])
    await flushPromises()
    // 点保存
    const saveBtn = findModalButton('保存 Agent')!
    saveBtn?.click()
    await flushPromises()
    // 关键断言：PUT body 里 outputs/inputs 是数组
    const saveCall = vi.mocked(api.config.saveAgents).mock.calls[0]?.[0] as any
    expect(Array.isArray(saveCall.agents[0].outputs)).toBe(true)
    expect(Array.isArray(saveCall.agents[0].inputs)).toBe(true)
    expect(saveCall.agents[0].outputs).toEqual(['spec.md', 'plan.md'])
    expect(saveCall.agents[0].inputs).toEqual(['spec.md'])
  })

  it('⑨ 编辑后空 outputs/inputs 不写入 body（保留 "field absent" 语义）', async () => {
    const agent = {
      id: 'spec', name: 'Spec', runtime: 'claude',
      instruction: '', output_file: 'spec.md',
      outputs: ['default'], inputs: [],
    } as any
    const w = await trackMount([agent])
    await openEditAgentModal(w)
    const cv = w.findComponent(ConfigView)
    cv.vm.setAgentOutputs([])
    cv.vm.setAgentInputs([])
    await flushPromises()
    const saveBtn = findModalButton('保存 Agent')!
    saveBtn?.click()
    await flushPromises()
    const saveCall = vi.mocked(api.config.saveAgents).mock.calls[0]?.[0] as any
    expect(saveCall.agents[0].outputs).toBeUndefined()
    expect(saveCall.agents[0].inputs).toBeUndefined()
  })
})
