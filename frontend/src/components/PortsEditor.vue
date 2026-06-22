<script setup lang="ts">
// Implements: .scratch/agent-ports-editor/PRD.md
// 端口契约的编辑入口：双 panel（输入 / 输出）+ 顶部画布缩略预览。
// 视觉与 AgentNode 一致（颜色由 port-colors.css 提供）。
//
// 校验规则：
//   - name.trim() === ''           → 硬阻断，不 emit
//   - name.length > 64             → 错误边框，emit（warning，backend 是真相之源）
//   - 含空白                       → 错误边框，emit
//   - 与同 list 内已有重名         → 错误边框，emit

import { ref, computed, nextTick } from 'vue'
import { NButton, NTooltip } from 'naive-ui'

interface Props {
  inputs: string[]
  outputs: string[]
}
const props = defineProps<Props>()
const emit = defineEmits<{
  'update:inputs': [string[]]
  'update:outputs': [string[]]
}>()

// ─── 编辑状态 ──────────────────────────────────────────────
const editingSide = ref<'inputs' | 'outputs' | null>(null)
const editingIndex = ref<number | null>(null)  // null = 新增
const editingValue = ref('')
const editingError = ref<string | null>(null)

const isEmpty = computed(() => props.inputs.length === 0 && props.outputs.length === 0)

// 校验（用于在已有 row 上显示错误，也用于编辑中的行）
function rowErrorFor(side: 'inputs' | 'outputs', name: string): string | null {
  if (name.length > 64) return '端口名不能超过 64 字符'
  if (/\s/.test(name)) return '端口名不能含空白'
  const list = side === 'inputs' ? props.inputs : props.outputs
  if (list.filter((n) => n === name).length > 1) return '端口名重复'
  return null
}

function startAdd(side: 'inputs' | 'outputs') {
  editingSide.value = side
  editingIndex.value = null
  editingValue.value = ''
  editingError.value = null
  focusActive()
}

function startRename(side: 'inputs' | 'outputs', index: number) {
  const list = side === 'inputs' ? props.inputs : props.outputs
  editingSide.value = side
  editingIndex.value = index
  editingValue.value = list[index] ?? ''
  editingError.value = null
  focusActive()
}

function focusActive() {
  nextTick(() => {
    const el = document.querySelector<HTMLInputElement>('.port-row--editing input.port-row__input')
    el?.focus()
  })
}

function commit() {
  if (!editingSide.value) return
  const side = editingSide.value
  const value = editingValue.value.trim()
  const list = side === 'inputs' ? [...props.inputs] : [...props.outputs]
  const isNew = editingIndex.value === null

  // 硬阻断：空名字
  if (!value) {
    editingError.value = '端口名不能为空'
    return
  }

  if (isNew) {
    list.push(value)
  } else {
    list[editingIndex.value!] = value
  }

  // emit 仍然发生（warning 不阻断）；错误会在渲染出的 row 上展示
  if (side === 'inputs') {
    emit('update:inputs', list)
  } else {
    emit('update:outputs', list)
  }
  cancel()
}

function cancel() {
  editingSide.value = null
  editingIndex.value = null
  editingValue.value = ''
  editingError.value = null
}

function remove(side: 'inputs' | 'outputs', index: number) {
  const list = side === 'inputs' ? [...props.inputs] : [...props.outputs]
  list.splice(index, 1)
  if (side === 'inputs') {
    emit('update:inputs', list)
  } else {
    emit('update:outputs', list)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    commit()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancel()
  }
}
</script>

<template>
  <div class="ports-editor">
    <!-- 画布缩略预览（mini AgentNode） -->
    <div class="ports-editor__preview" aria-hidden="true">
      <div class="ports-editor__preview-dots ports-editor__preview-dots--in">
        <span
          v-for="(n, i) in inputs"
          :key="`pi-${i}-${n}`"
          class="ports-editor__preview-dot ports-editor__preview-dot--in"
          :title="`输入 · ${n}`"
        />
      </div>
      <div class="ports-editor__preview-name">agent</div>
      <div class="ports-editor__preview-dots ports-editor__preview-dots--out">
        <span
          v-for="(n, i) in outputs"
          :key="`po-${i}-${n}`"
          class="ports-editor__preview-dot ports-editor__preview-dot--out"
          :title="`输出 · ${n}`"
        />
      </div>
    </div>

    <!-- 双 panel -->
    <div class="ports-editor__panels">
      <!-- 输入 -->
      <div class="ports-editor__panel ports-editor__panel--in">
        <div class="ports-editor__panel-header">
          <span class="ports-editor__panel-dot ports-editor__panel-dot--in" />
          输入
        </div>
        <div
          v-for="(name, idx) in inputs"
          :key="`in-${idx}-${name}`"
          class="port-row"
          :class="{ 'port-row--has-error': rowErrorFor('inputs', name) }"
        >
          <span class="port-row__dot port-row__dot--in" />
          <NTooltip v-if="rowErrorFor('inputs', name)" trigger="hover" placement="top">
            <template #trigger>
              <span class="port-row__name" @click="startRename('inputs', idx)">{{ name }}</span>
            </template>
            {{ rowErrorFor('inputs', name) }}
          </NTooltip>
          <span v-else class="port-row__name" @click="startRename('inputs', idx)">{{ name }}</span>
          <button class="port-row__remove" @click="remove('inputs', idx)" :aria-label="`删除输入端口 ${name}`">✕</button>
        </div>
        <!-- 新增行 -->
        <div
          v-if="editingSide === 'inputs' && editingIndex === null"
          class="port-row port-row--editing"
          :class="{ 'port-row--has-error': editingError }"
        >
          <span class="port-row__dot port-row__dot--in" />
          <input
            v-model="editingValue"
            class="port-row__input"
            placeholder="新输入端口名"
            @keydown="onKeydown"
            @blur="commit"
          />
          <button class="port-row__remove" @click="cancel" :aria-label="'取消新增'">✕</button>
        </div>
        <NButton
          v-if="editingSide !== 'inputs'"
          size="tiny"
          ghost
          @click="startAdd('inputs')"
        >+ 添加输入</NButton>
      </div>

      <!-- 输出 -->
      <div class="ports-editor__panel ports-editor__panel--out">
        <div class="ports-editor__panel-header">
          <span class="ports-editor__panel-dot ports-editor__panel-dot--out" />
          输出
        </div>
        <div
          v-for="(name, idx) in outputs"
          :key="`out-${idx}-${name}`"
          class="port-row"
          :class="{ 'port-row--has-error': rowErrorFor('outputs', name) }"
        >
          <span class="port-row__dot port-row__dot--out" />
          <NTooltip v-if="rowErrorFor('outputs', name)" trigger="hover" placement="top">
            <template #trigger>
              <span class="port-row__name" @click="startRename('outputs', idx)">{{ name }}</span>
            </template>
            {{ rowErrorFor('outputs', name) }}
          </NTooltip>
          <span v-else class="port-row__name" @click="startRename('outputs', idx)">{{ name }}</span>
          <button class="port-row__remove" @click="remove('outputs', idx)" :aria-label="`删除输出端口 ${name}`">✕</button>
        </div>
        <!-- 新增行 -->
        <div
          v-if="editingSide === 'outputs' && editingIndex === null"
          class="port-row port-row--editing"
          :class="{ 'port-row--has-error': editingError }"
        >
          <span class="port-row__dot port-row__dot--out" />
          <input
            v-model="editingValue"
            class="port-row__input"
            placeholder="新输出端口名"
            @keydown="onKeydown"
            @blur="commit"
          />
          <button class="port-row__remove" @click="cancel" :aria-label="'取消新增'">✕</button>
        </div>
        <NButton
          v-if="editingSide !== 'outputs'"
          size="tiny"
          ghost
          @click="startAdd('outputs')"
        >+ 添加输出</NButton>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="isEmpty" class="ports-editor__empty">
      未声明任何端口 — 画布上此节点会显示一个 default handle
    </div>

    <!-- helper -->
    <div class="ports-editor__helper">
      端口名是画布上节点的连接点；instruction 里可用
      <code v-pre>{{ inputs.X }}</code> / <code v-pre>{{ outputs.X }}</code> 引用。
    </div>
  </div>
</template>

<style scoped>
.ports-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
}

/* 画布缩略预览 */
.ports-editor__preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 56px;
  background: #fafafa;
  border: 1px dashed #d4d4d8;
  border-radius: 6px;
  padding: 0 40px;
}
.ports-editor__preview-dots {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  padding: 0 8px;
}
.ports-editor__preview-dots--in { left: 0; }
.ports-editor__preview-dots--out { right: 0; }
.ports-editor__preview-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: block;
}
.ports-editor__preview-dot--in { background: var(--port-in-color); }
.ports-editor__preview-dot--out { background: var(--port-out-color); }
.ports-editor__preview-name {
  font-size: 12px;
  color: #71717a;
  font-style: italic;
}

/* 双 panel */
.ports-editor__panels {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ports-editor__panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid #e4e4e7;
  border-radius: 6px;
  padding: 8px;
  background: #fff;
}
.ports-editor__panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: #3f3f46;
  margin-bottom: 2px;
}
.ports-editor__panel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.ports-editor__panel-dot--in { background: var(--port-in-color); }
.ports-editor__panel-dot--out { background: var(--port-out-color); }

/* row */
.port-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: #f4f4f5;
}
.port-row--editing {
  background: #fff;
  border-color: #6366f1;
}
.port-row--has-error {
  border-color: #ef4444;
  background: #fef2f2;
}
.port-row__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.port-row__dot--in { background: var(--port-in-color); }
.port-row__dot--out { background: var(--port-out-color); }
.port-row__name {
  flex: 1;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  cursor: text;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.port-row__input {
  flex: 1;
  font-family: ui-monospace, monospace;
  font-size: 12px;
  border: none;
  outline: none;
  background: transparent;
  padding: 0;
  min-width: 0;
}
.port-row__remove {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: none;
  background: transparent;
  color: #71717a;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  border-radius: 3px;
}
.port-row__remove:hover { background: #e4e4e7; color: #18181b; }

/* 空状态 */
.ports-editor__empty {
  text-align: center;
  padding: 8px 12px;
  font-size: 12px;
  color: #71717a;
  background: #fafafa;
  border-radius: 4px;
}

/* helper */
.ports-editor__helper {
  font-size: 11px;
  color: #71717a;
  line-height: 1.6;
}
.ports-editor__helper code {
  background: #f4f4f5;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10.5px;
}
</style>
