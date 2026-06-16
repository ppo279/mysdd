<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'

const props = defineProps<{
  modelValue: string
  placeholder?: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const container = ref<HTMLElement | null>(null)
let view: EditorView | null = null

onMounted(() => {
  if (!container.value) return

  const updateListener = EditorView.updateListener.of((update) => {
    if (update.docChanged && !props.readonly) {
      emit('update:modelValue', update.state.doc.toString())
    }
  })

  const baseTheme = EditorView.theme({
    '&': { height: '100%', fontSize: '13px' },
    '.cm-scroller': { overflow: 'auto', fontFamily: "'Courier New', Consolas, monospace", lineHeight: '1.7' },
    '.cm-content': { padding: '12px 16px' },
    '.cm-line': { padding: '0' },
  })

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      lineNumbers(),
      drawSelection(),
      highlightActiveLine(),
      markdown(),
      oneDark,
      baseTheme,
      updateListener,
      props.readonly ? EditorState.readOnly.of(true) : [],
      EditorView.lineWrapping,
    ],
  })

  view = new EditorView({ state, parent: container.value })
})

// 外部 modelValue 变化时同步到编辑器（如切换文件）
watch(() => props.modelValue, (newVal) => {
  if (!view) return
  const current = view.state.doc.toString()
  if (current !== newVal) {
    view.dispatch({
      changes: { from: 0, to: current.length, insert: newVal },
    })
  }
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})
</script>

<template>
  <div ref="container" class="md-editor" />
</template>

<style scoped>
.md-editor {
  width: 100%;
  height: 100%;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  overflow: hidden;
}
</style>
