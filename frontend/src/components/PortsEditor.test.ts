// Implements: .scratch/agent-ports-editor/PRD.md
// PortsEditor 单元测试：add / remove / rename / 校验 / canvas 预览。
// 校验规则在 PRD 顶部：
//   - name.trim() === ''           → 错误边框，**不 emit**
//   - name.length > 64             → 错误边框，emit（backend 是真相之源，UI 是 warning）
//   - 空白字符                     → 错误边框，emit
//   - 同 list 内重名               → 错误边框，emit
// 即：只有"空"是硬阻断（无意义数据），其余是视觉警告。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import { NConfigProvider, NMessageProvider } from 'naive-ui'
import PortsEditor from './PortsEditor.vue'

const Host = defineComponent({
  components: { NConfigProvider, NMessageProvider, PortsEditor },
  template: `<NConfigProvider><NMessageProvider><PortsEditor v-model:inputs="inputs" v-model:outputs="outputs" /></NMessageProvider></NConfigProvider>`,
  props: ['inputs', 'outputs'],
  setup(props) {
    return {
      inputs: ref([...(props.inputs ?? [])]),
      outputs: ref([...(props.outputs ?? [])]),
    }
  },
})

function mountEditor(
  inputs: string[] = [],
  outputs: string[] = [],
): VueWrapper {
  return mount(Host, {
    props: { inputs, outputs },
  })
}

beforeEach(() => {
  // 不需要 ResizeObserver shim（PortsEditor 不依赖 vue-flow）
})

describe('PortsEditor — 空状态', () => {
  it('两个 list 都为空时显示空状态文案', () => {
    const w = mountEditor([], [])
    expect(w.text()).toContain('未声明任何端口')
  })
})

describe('PortsEditor — 添加端口', () => {
  it('点击「+ 添加输入」会让 inputs panel 多一个编辑行', async () => {
    const w = mountEditor([], [])
    const addBtn = w.findAll('button').find((b) => b.text().includes('添加输入'))!
    expect(addBtn).toBeDefined()
    await addBtn.trigger('click')
    await flushPromises()
    // 出现新输入框
    const inputs = w.findAll('input.port-row__input')
    expect(inputs.length).toBe(1)
  })

  it('在 inputs 新行输入名字按 Enter → emit update:inputs', async () => {
    const w = mountEditor([], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('spec.md')
    // @vue/test-utils 的 keydown.enter 发送的是 'enter'（小写），与 DOM 标准 'Enter' 不一致；
    // 用显式 { key } 才能命中 onKeydown 里的 e.key === 'Enter' 分支。
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const emitted = w.findComponent(PortsEditor).emitted('update:inputs')
    expect(emitted).toBeTruthy()
    expect(emitted?.[0]?.[0]).toEqual(['spec.md'])
  })

  it('按 Esc 取消新增 → 没有 emit，input 消失', async () => {
    const w = mountEditor([], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('will-be-cancelled')
    await input.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    const emitted = w.findComponent(PortsEditor).emitted('update:inputs')
    expect(emitted).toBeFalsy()
    expect(w.findAll('input.port-row__input').length).toBe(0)
  })
})

describe('PortsEditor — 校验', () => {
  it('空名字 → 错误边框，不 emit', async () => {
    const w = mountEditor([], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('   ')  // 全空白 → trim 后空
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(w.findComponent(PortsEditor).emitted('update:inputs')).toBeFalsy()
    expect(w.find('.port-row--has-error').exists()).toBe(true)
  })

  it('与已有同名 → 错误边框（warning，不阻断 emit）', async () => {
    const w = mountEditor(['foo'], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('foo')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(w.find('.port-row--has-error').exists()).toBe(true)
    // 重名是 warning：UI 提示但不阻断，让用户保留草稿
    const emitted = w.findComponent(PortsEditor).emitted('update:inputs')
    expect(emitted).toBeTruthy()
  })

  it('含空白字符 → 错误边框', async () => {
    const w = mountEditor([], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('a b')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(w.find('.port-row--has-error').exists()).toBe(true)
  })

  it('长度 > 64 → 错误边框', async () => {
    const w = mountEditor([], [])
    await w.findAll('button').find((b) => b.text().includes('添加输入'))!.trigger('click')
    await flushPromises()
    const input = w.find('input.port-row__input')
    await input.setValue('a'.repeat(65))
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(w.find('.port-row--has-error').exists()).toBe(true)
  })
})

describe('PortsEditor — canvas 预览', () => {
  it('根据 props 渲染对应数量的输入/输出 handle 点', () => {
    const w = mountEditor(['a', 'b'], ['c'])
    const inDots = w.findAll('.ports-editor__preview-dot--in')
    const outDots = w.findAll('.ports-editor__preview-dot--out')
    expect(inDots.length).toBe(2)
    expect(outDots.length).toBe(1)
  })

  it('空 inputs + 非空 outputs → 不显示空状态', () => {
    const w = mountEditor([], ['default'])
    expect(w.text()).not.toContain('未声明任何端口')
  })
})

describe('PortsEditor — 端口颜色 token', () => {
  it('输入/输出预览点带对应的修饰类（颜色由 port-colors.css 解析）', () => {
    const w = mountEditor(['in1'], ['out1'])
    // jsdom 不解析 CSS 变量值，但类名存在即说明模板正确引用了 token；
    // 实际颜色渲染在浏览器里走 AgentNode 与 PortsEditor 共享的 var()。
    expect(w.find('.ports-editor__preview-dot--in').exists()).toBe(true)
    expect(w.find('.ports-editor__preview-dot--out').exists()).toBe(true)
  })

  it('row 上的色点也带对应修饰类（与画布一致）', () => {
    const w = mountEditor(['a'], ['b'])
    expect(w.find('.port-row__dot--in').exists()).toBe(true)
    expect(w.find('.port-row__dot--out').exists()).toBe(true)
  })

  it('panel 头部色点带对应修饰类', () => {
    const w = mountEditor(['a'], ['b'])
    expect(w.find('.ports-editor__panel-dot--in').exists()).toBe(true)
    expect(w.find('.ports-editor__panel-dot--out').exists()).toBe(true)
  })
})
