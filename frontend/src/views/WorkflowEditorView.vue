<script setup lang="ts">
// Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
//
// vue-flow 画布编辑 workflow。
// - route: /workspace/:workspaceId/workflow/:workflowId  （workflowId === 'new' 表示新建）
// - 工具栏：name/desc 输入框、+ 添加节点、校验、保存、删除节点
// - 节点是 AgentNode（绿框），每节点至少 1 in / 1 out handle（默认 'default'）
// - 拖拽连线：onConnect 时把 sourceHandle/targetHandle 拆出 fromOutput/toInput
// - 校验：本地 detectCycles（与后端 mirror，避免无效请求）
// - defineExpose({ toDto, validateLocal, addNode, removeNode }) 供测试 / SwitchWorkflowDialog 复用
//
// 保存逻辑：
//   - workflowId === 'new'：POST 创建 → 跳到 /workflow/:newId
//   - 否则：PATCH /api/workflows/:id/graph 原地替换 nodes + edges，URL 不变
//     保留 features.current_workflow_id 引用，不触发后端 DELETE 守卫

import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  VueFlow, useVueFlow, Position, MarkerType, type Node, type Edge, type Connection,
} from '@vue-flow/core'

// 浅层类型别名：vue-flow 的 Node/Edge 是深度递归类型，直接推导会触发
// "Type instantiation is excessively deep and possibly infinite" (TS2589)。
// 编辑器本地状态只用浅层字段（id、position、source/target、handle、selected）
// 不展开 data 内的递归结构，因此用 WorkflowNodeLike / WorkflowEdgeLike 即可。
type WorkflowNodeLike = {
  id: string
  position: { x: number; y: number }
  type?: string
  data?: any
  selected?: boolean
  [k: string]: any
}
type WorkflowEdgeLike = {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
  label?: string
  markerEnd?: string
  [k: string]: any
}
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import {
  NSpin, NSpace, NButton, NInput, NCard, NSelect, NModal, NEmpty, NTag,
  useMessage,
} from 'naive-ui'
import { api, type WorkflowCreateInput, type WorkflowDetail } from '@/api'
import { useWorkflowStore } from '@/stores/workflow'
import { detectCycles, type WorkflowNodeRow, type WorkflowEdgeRow } from '@/types/workflow'
import AgentNode from '@/components/AgentNode.vue'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const store = useWorkflowStore()

const workspaceId = computed(() => String(route.params.workspaceId ?? ''))
const workflowId = computed(() => String(route.params.workflowId ?? ''))
const isNew = computed(() => workflowId.value === 'new')

const name = ref('未命名 Workflow')
const description = ref('')
const nodes = ref<WorkflowNodeLike[]>([])
const edges = ref<WorkflowEdgeLike[]>([])
const agents = ref<{ label: string; value: string; outputs: string[]; inputs: string[] }[]>([])
const loading = ref(false)
const saving = ref(false)
const showAddNode = ref(false)
const newNodeAgent = ref<string | null>(null)
const newNodeDisplayName = ref('')
const newNodeOutputs = ref<string[]>(['default'])
const newNodeInputs = ref<string[]>(['default'])

watch(newNodeAgent, (val) => {
  if (!val) return
  const found = agents.value.find((a) => a.value === val)
  if (found) {
    newNodeDisplayName.value = found.label.split(' (')[0] ?? found.label
    newNodeOutputs.value = found.outputs.length > 0 ? found.outputs : ['default']
    newNodeInputs.value = found.inputs.length > 0 ? found.inputs : ['default']
  }
})

const { onConnect, screenToFlowCoordinate, onNodeDoubleClick } = useVueFlow()

// ─── 双击编辑节点 ───────────────────────────────────────
const showEditNode = ref(false)
const editingNodeId = ref('')
const editNodeDisplayName = ref('')
const editNodeOutputsInput = ref('')
const editNodeInputsInput = ref('')

onNodeDoubleClick(({ node }) => {
  editingNodeId.value = node.id
  editNodeDisplayName.value = (node.data as any)?.label || node.id
  editNodeOutputsInput.value = ((node.data as any)?.outputs ?? ['default']).join(', ')
  editNodeInputsInput.value = ((node.data as any)?.inputs ?? ['default']).join(', ')
  showEditNode.value = true
})

function parseHandleList(raw: string): string[] {
  const arr = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return arr.length > 0 ? arr : ['default']
}

function confirmEditNode() {
  const outputs = parseHandleList(editNodeOutputsInput.value)
  const inputs = parseHandleList(editNodeInputsInput.value)
  nodes.value = nodes.value.map((n) =>
    n.id === editingNodeId.value
      ? { ...n, data: { ...(n.data as any), label: editNodeDisplayName.value || n.id, outputs, inputs } }
      : n,
  )
  showEditNode.value = false
}

onConnect((conn: Connection) => {
  if (!conn.source || !conn.target) return
  // sourceHandle / targetHandle 形如 `<nodeId>-out-<output>` / `<nodeId>-in-<input>`
  const fromOutput = parseOutput(conn.sourceHandle)
  const toInput = parseInput(conn.targetHandle)
  const newEdge: WorkflowEdgeLike = {
    id: `e-${conn.source}-${fromOutput}->${conn.target}-${toInput}`,
    source: conn.source,
    target: conn.target,
    sourceHandle: conn.sourceHandle ?? undefined,
    targetHandle: conn.targetHandle ?? undefined,
    // 有非 default 名字才上标签；default→default 是噪声
    label: fromOutput !== 'default' || toInput !== 'default'
      ? (fromOutput === toInput ? fromOutput : `${fromOutput} → ${toInput}`)
      : undefined,
    markerEnd: MarkerType.ArrowClosed as any,
  }
  edges.value = [...edges.value, newEdge]
})

function parseOutput(handleId?: string | null): string {
  if (!handleId) return 'default'
  const m = handleId.match(/-out-(.+)$/)
  return m?.[1] ?? 'default'
}
function parseInput(handleId?: string | null): string {
  if (!handleId) return 'default'
  const m = handleId.match(/-in-(.+)$/)
  return m?.[1] ?? 'default'
}

async function loadAgents() {
  try {
    const cfg = await api.config.agents()
    agents.value = cfg.agents.map((a) => ({
      label: `${a.name} (${a.id})`,
      value: a.id,
      outputs: a.outputs && a.outputs.length > 0
        ? a.outputs
        : a.output_file ? [a.output_file] : ['default'],
      inputs: a.inputs && a.inputs.length > 0 ? a.inputs : ['default'],
    }))
    const firstAgent = agents.value[0]
    if (firstAgent) {
      newNodeAgent.value = firstAgent.value
      newNodeOutputs.value = firstAgent.outputs
      newNodeInputs.value = firstAgent.inputs
    }
  } catch (e: any) {
    message.error(`加载 agents 失败: ${e?.message ?? e}`)
  }
}

async function loadDetail() {
  if (isNew.value) {
    nodes.value = []
    edges.value = []
    return
  }
  loading.value = true
  try {
    const detail: WorkflowDetail = await store.loadOne(workflowId.value)
    name.value = detail.name
    description.value = detail.description
    nodes.value = detail.nodes.map<WorkflowNodeLike>((n) => {
      // 从 configJson 恢复 outputs / inputs（不存在时各 fallback 到 ['default']）
      let outputs: string[] = ['default']
      let inputs: string[] = ['default']
      try {
        const cfg = n.configJson ? JSON.parse(n.configJson) : {}
        if (Array.isArray(cfg.outputs) && cfg.outputs.length > 0) outputs = cfg.outputs
        if (Array.isArray(cfg.inputs) && cfg.inputs.length > 0) inputs = cfg.inputs
      } catch { /* configJson 非法时静默 */ }
      return {
        id: n.nodeId,
        type: 'agent',
        position: { x: n.positionX, y: n.positionY },
        data: { agentId: n.agentId, label: n.displayName || n.nodeId, outputs, inputs },
      }
    })
    edges.value = detail.edges.map<WorkflowEdgeLike>((e) => ({
      id: `e-${e.fromNodeId}-${e.fromOutput}->${e.toNodeId}-${e.toInput}`,
      source: e.fromNodeId,
      target: e.toNodeId,
      sourceHandle: `${e.fromNodeId}-out-${e.fromOutput}`,
      targetHandle: `${e.toNodeId}-in-${e.toInput}`,
      label: e.fromOutput !== 'default' || e.toInput !== 'default'
        ? (e.fromOutput === e.toInput ? e.fromOutput : `${e.fromOutput} → ${e.toInput}`)
        : undefined,
      markerEnd: MarkerType.ArrowClosed,
    }))
  } catch (e: any) {
    message.error(`加载 workflow 失败: ${e?.message ?? e}`)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await loadAgents()
  await loadDetail()
})
watch(workflowId, loadDetail)

function openAddNode() {
  const first = agents.value[0] ?? null
  newNodeAgent.value = first?.value ?? null
  newNodeOutputs.value = first?.outputs ?? ['default']
  newNodeInputs.value = first?.inputs ?? ['default']
  newNodeDisplayName.value = first ? (first.label.split(' (')[0] ?? first.label) : ''
  showAddNode.value = true
}

function confirmAddNode() {
  if (!newNodeAgent.value) {
    message.warning('请选择 agent')
    return
  }
  // 路线 1：nodeId 由 agent id 自动派生——节点 id 必然等于 agent id，user 不再硬记
  const nodeId = newNodeAgent.value
  // 唯一性：每 agent 在 workflow 内最多出现一次
  if (nodes.value.some((n) => n.id === nodeId)) {
    message.error(`agent "${nodeId}" 已被占用`)
    return
  }
  const outputs = newNodeOutputs.value.length > 0 ? newNodeOutputs.value : ['default']
  const inputs = newNodeInputs.value.length > 0 ? newNodeInputs.value : ['default']

  const pos = screenToFlowCoordinate({ x: window.innerWidth / 2 - 100, y: window.innerHeight / 2 - 50 })
  const displayName = newNodeDisplayName.value.trim() || nodeId
  const node: WorkflowNodeLike = {
    id: nodeId,
    type: 'agent',
    position: pos as { x: number; y: number },
    data: { agentId: nodeId, label: displayName, outputs, inputs },
  }
  // 只通过 nodes.value 驱动，v-model:nodes 自动同步到 VueFlow 内部——不再调 addNodes
  nodes.value = [...nodes.value, node]
  showAddNode.value = false
}

function removeSelected() {
  const selectedNodes = nodes.value.filter((n) => n.selected)
  if (selectedNodes.length === 0) {
    message.warning('请先选中要删除的节点（点一下节点）')
    return
  }
  const ids = new Set(selectedNodes.map((n) => n.id))
  // 只通过 nodes.value 驱动，不再调 removeNodes，原因同 addNodes
  nodes.value = nodes.value.filter((n) => !ids.has(n.id))
  edges.value = edges.value.filter((e) => !ids.has(e.source) && !ids.has(e.target))
}

function validateLocal(): { ok: boolean; cycle?: string[]; error?: string } {
  // 路线 1 锁死：nodeId === agentId + 节点必须有 agent 引用
  for (const n of nodes.value) {
    const agentId = (n.data as any)?.agentId as string | undefined
    if (!agentId) {
      return { ok: false, error: `节点 "${n.id}" 缺少 agent 引用` }
    }
    if (n.id !== agentId) {
      return { ok: false, error: `节点 "${n.id}" 与 agent "${agentId}" 不一致（路线 1 锁死）` }
    }
  }
  // 唯一性：agentId 在 workflow 内不重复（路线 1 下等价于 nodeId 唯一）
  const agentIds = new Set<string>()
  for (const n of nodes.value) {
    const agentId = (n.data as any).agentId as string
    if (agentIds.has(agentId)) {
      return { ok: false, error: `agent "${agentId}" 在 workflow 中重复出现` }
    }
    agentIds.add(agentId)
  }
  const nodeRows: WorkflowNodeRow[] = nodes.value.map((n) => ({
    nodeId: n.id,
    agentId: (n.data as any).agentId,
    positionX: n.position.x,
    positionY: n.position.y,
  }))
  const edgeRows: WorkflowEdgeRow[] = edges.value.map((e) => ({
    fromNodeId: e.source,
    fromOutput: parseOutput(e.sourceHandle),
    toNodeId: e.target,
    toInput: parseInput(e.targetHandle),
  }))
  const cycle = detectCycles(nodeRows, edgeRows)
  if (cycle) return { ok: false, cycle }
  if (nodes.value.length === 0) return { ok: false, cycle: ['(empty)'] }
  return { ok: true }
}

function toDto(): WorkflowCreateInput {
  return {
    name: name.value,
    description: description.value,
    nodes: nodes.value.map((n) => ({
      nodeId: n.id,
      agentId: (n.data as any)?.agentId ?? '',
      positionX: n.position.x,
      positionY: n.position.y,
      displayName: (n.data as any)?.label || n.id,
      // outputs/inputs 存入 configJson，加载时反序列化还原多 handle
      configJson: JSON.stringify({
        outputs: (n.data as any)?.outputs ?? ['default'],
        inputs: (n.data as any)?.inputs ?? ['default'],
      }),
    })),
    edges: edges.value.map((e) => ({
      fromNodeId: e.source,
      fromOutput: parseOutput(e.sourceHandle),
      toNodeId: e.target,
      toInput: parseInput(e.targetHandle),
    })),
  }
}

defineExpose({ validateLocal, toDto, addNode: openAddNode, removeNode: removeSelected })

async function save() {
  const v = validateLocal()
  if (!v.ok) {
    if (v.error) {
      message.error(v.error)
    } else if (v.cycle?.length === 1 && v.cycle[0] === '(empty)') {
      message.warning('请至少添加一个节点')
    } else {
      message.error(`检测到环: ${v.cycle!.join(' -> ')}`)
    }
    return
  }
  saving.value = true
  try {
    if (isNew.value) {
      const wf = await api.workflows.create(workspaceId.value, toDto())
      message.success(`已创建「${wf.name}」`)
      router.replace(`/workspace/${workspaceId.value}/workflow/${wf.id}`)
    } else {
      // 双接口：图走 /graph（保留 id，稳住 features.current_workflow_id 引用），
      // name/description 走 /:id 的 PATCH（/graph 的 zod schema 只 pick 了 nodes+edges，
      // 直接把 toDto 整个丢过去会被静默丢弃 metadata——这就是改名不生效的根因）。
      const dto = toDto()
      await api.workflows.updateGraph(workflowId.value, dto)
      await api.workflows.update(workflowId.value, {
        name: dto.name,
        description: dto.description,
      })
      message.success(`已保存「${name.value}」`)
      // URL 不变，不再 router.replace
    }
  } catch (e: any) {
    message.error(`保存失败: ${e?.message ?? e}`)
  } finally {
    saving.value = false
  }
}

const nodeTypes = { agent: AgentNode as any }
</script>

<template>
  <div class="workflow-editor">
    <header class="workflow-editor__header">
      <NSpace align="center" justify="space-between" wrap>
        <NSpace align="center" wrap>
          <NInput v-model:value="name" placeholder="Workflow 名称" style="width: 220px" />
          <NInput v-model:value="description" placeholder="描述（可选）" style="width: 240px" />
        </NSpace>
        <NSpace>
          <NButton size="small" @click="openAddNode">+ 添加节点</NButton>
          <NButton size="small" @click="removeSelected">删除选中节点</NButton>
          <NButton size="small" type="primary" :loading="saving" @click="save">保存</NButton>
        </NSpace>
      </NSpace>
    </header>

    <div class="workflow-editor__canvas">
      <NSpin :show="loading">
        <VueFlow
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :default-edge-options="{
            markerEnd: MarkerType.ArrowClosed,
            style: { strokeWidth: 2, stroke: '#94a3b8' },
            labelStyle: { fontSize: '11px', fill: '#555', fontFamily: 'monospace' },
            labelBgStyle: { fill: '#fff', fillOpacity: 0.9 },
            labelBgPadding: [4, 3],
            labelBgBorderRadius: 3,
          }"
          fit-view-on-init
        >
          <Background pattern-color="#aaa" :gap="16" />
          <Controls />
          <MiniMap pannable zoomable />
        </VueFlow>
        <NEmpty
          v-if="!loading && nodes.length === 0"
          description="空 Workflow：点击「+ 添加节点」开始"
          style="position: absolute; top: 40%; left: 50%; transform: translate(-50%, -50%)"
        />
      </NSpin>
    </div>

    <!-- 双击编辑节点弹窗 -->
    <NModal v-model:show="showEditNode" preset="card" title="编辑节点" style="width: 440px">
      <NSpace vertical :size="14">
        <div>
          <div style="margin-bottom: 4px; font-size: 12px; color: #666">显示名称</div>
          <NInput v-model:value="editNodeDisplayName" placeholder="例如 写规格 / 出方案" />
        </div>
        <div>
          <div style="margin-bottom: 4px; font-size: 12px; color: #666">
            输出 handle（逗号分隔）— 对应右侧连线接口
          </div>
          <NInput v-model:value="editNodeOutputsInput" placeholder="如 spec.md 或 code, tests" />
        </div>
        <div>
          <div style="margin-bottom: 4px; font-size: 12px; color: #666">
            输入 handle（逗号分隔）— 对应左侧连线接口
          </div>
          <NInput v-model:value="editNodeInputsInput" placeholder="如 default 或 spec.md, plan.md" />
        </div>
        <NSpace justify="end">
          <NButton @click="showEditNode = false">取消</NButton>
          <NButton type="primary" @click="confirmEditNode">保存</NButton>
        </NSpace>
      </NSpace>
    </NModal>

    <NModal v-model:show="showAddNode" preset="card" title="添加节点" style="width: 480px">
      <NSpace vertical>
        <div>
          <div style="margin-bottom: 4px; font-size: 12px; color: #666">agent</div>
          <NSelect v-model:value="newNodeAgent" :options="agents" placeholder="选择一个 agent" />
        </div>
        <div>
          <div style="margin-bottom: 4px; font-size: 12px; color: #666">显示名称（画布上展示）</div>
          <NInput v-model:value="newNodeDisplayName" placeholder="例如 写规格 / 出方案" />
        </div>
        <div style="display: flex; gap: 16px;">
          <div style="flex: 1;">
            <div style="margin-bottom: 4px; font-size: 12px; color: #666">输出 handle（来自 Agent 配置）</div>
            <div style="display: flex; gap: 4px; flex-wrap: wrap; padding: 4px 0;">
              <NTag v-for="o in newNodeOutputs" :key="o" size="small" type="success">{{ o }}</NTag>
            </div>
          </div>
          <div style="flex: 1;">
            <div style="margin-bottom: 4px; font-size: 12px; color: #666">输入 handle（来自 Agent 配置）</div>
            <div style="display: flex; gap: 4px; flex-wrap: wrap; padding: 4px 0;">
              <NTag v-for="i in newNodeInputs" :key="i" size="small" type="info">{{ i }}</NTag>
            </div>
          </div>
        </div>
        <div style="font-size: 11px; color: #aaa;">
          在 <a href="/config" target="_blank" style="color: #6366f1;">Agent 配置</a> 里修改，或添加节点后双击微调。
        </div>
        <NSpace justify="end">
          <NButton @click="showAddNode = false">取消</NButton>
          <NButton type="primary" @click="confirmAddNode">添加</NButton>
        </NSpace>
      </NSpace>
    </NModal>
  </div>
</template>

<style scoped>
.workflow-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.workflow-editor__header {
  padding: 12px 16px;
  border-bottom: 1px solid #eee;
  background: #fafafa;
}
.workflow-editor__canvas {
  flex: 1;
  position: relative;
  /* 给绝对定位的子层提供包含块 */
}
/* NSpin 生成的两层 wrapper 不继承 flex 子元素的拉伸高度，
   用 inset:0 撑满包含块是最可靠的方式 */
.workflow-editor__canvas :deep(.n-spin-container) {
  position: absolute;
  inset: 0;
}
.workflow-editor__canvas :deep(.n-spin-content) {
  height: 100%;
}
</style>
