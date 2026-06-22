<script setup lang="ts">
import { computed } from 'vue'
import { Handle, Position, type NodeProps } from '@vue-flow/core'

interface AgentNodeData {
  agentId: string
  label?: string
  outputs?: string[]
  inputs?: string[]
}

const props = defineProps<NodeProps<AgentNodeData>>()

const inputs = computed(() => props.data?.inputs ?? ['default'])
const outputs = computed(() => props.data?.outputs ?? ['default'])
const displayName = computed(() => props.data?.label || props.data?.agentId || props.id)
</script>

<script lang="ts">
export function handleTop(idx: number, total: number): string {
  if (total <= 1) return '50%'
  const pct = ((idx + 1) / (total + 1)) * 100
  return `${pct}%`
}
</script>

<template>
  <div
    class="agent-node"
    :class="{ 'agent-node--selected': props.selected }"
    :data-node-id="props.id"
  >
    <!-- 左侧输入 handle + 标签 -->
    <template v-for="(name, idx) in inputs" :key="`in-${name}`">
      <Handle
        type="target"
        :position="Position.Left"
        :id="`${props.id}-in-${name}`"
        :title="name"
        :style="{ top: handleTop(idx, inputs.length) }"
        class="agent-node__handle agent-node__handle--in"
      />
      <span
        class="agent-node__hlabel agent-node__hlabel--in"
        :style="{ top: handleTop(idx, inputs.length) }"
      >{{ name }}</span>
    </template>

    <!-- 居中内容 -->
    <div class="agent-node__body">
      <div class="agent-node__name">{{ displayName }}</div>
      <div v-if="displayName !== props.data?.agentId" class="agent-node__agent-id">
        {{ props.data?.agentId }}
      </div>
    </div>

    <!-- 右侧输出 handle + 标签 -->
    <template v-for="(name, idx) in outputs" :key="`out-${name}`">
      <Handle
        type="source"
        :position="Position.Right"
        :id="`${props.id}-out-${name}`"
        :title="name"
        :style="{ top: handleTop(idx, outputs.length) }"
        class="agent-node__handle agent-node__handle--out"
      />
      <span
        class="agent-node__hlabel agent-node__hlabel--out"
        :style="{ top: handleTop(idx, outputs.length) }"
      >{{ name }}</span>
    </template>
  </div>
</template>

<style scoped>
.agent-node {
  position: relative;
  background: #fff;
  border: 2px solid #18a058;
  border-radius: 8px;
  min-width: 180px;
  padding: 10px 72px; /* 给左右标签留出空间 */
  text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  transition: border-color 0.15s, box-shadow 0.15s;
  cursor: default;
  user-select: none;
}
.agent-node--selected {
  border-color: #6366f1;
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.22), 0 2px 8px rgba(0, 0, 0, 0.1);
}

.agent-node__body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.agent-node__name {
  font-size: 13px;
  font-weight: 600;
  color: #18a058;
  line-height: 1.3;
}
.agent-node__agent-id {
  font-size: 11px;
  color: #aaa;
  font-family: monospace;
}

/* handle 圆点 — 颜色 token 与 PortsEditor 共用（见 port-colors.css） */
.agent-node__handle--in  { background: var(--port-in-color) !important; }
.agent-node__handle--out { background: var(--port-out-color) !important; }

/* handle 行内标签 */
.agent-node__hlabel {
  position: absolute;
  font-size: 10px;
  font-family: monospace;
  transform: translateY(-50%);
  white-space: nowrap;
  pointer-events: none;
  max-width: 64px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-node__hlabel--in {
  left: 10px;
  text-align: left;
  color: var(--port-in-color);
}
.agent-node__hlabel--out {
  right: 10px;
  text-align: right;
  color: var(--port-out-color);
}
</style>
