<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { api, type AgentsYamlRaw, type RuntimeRaw, type AgentRaw, type DetectedRuntime } from '@/api'
import { defineAsyncComponent } from 'vue'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NText, NEmpty,
  NTabs, NTabPane, NTag, NSpin,
  NModal, NCard, NForm, NFormItem, NInput, NSelect, NCheckbox, NInputNumber,
  NList, NListItem, NThing, NCollapse, NCollapseItem, useMessage,
} from 'naive-ui'
const MarkdownEditor = defineAsyncComponent(() => import('@/components/MarkdownEditor.vue'))
// Implements: .scratch/agent-ports-editor/PRD.md
const PortsEditor = defineAsyncComponent(() => import('@/components/PortsEditor.vue'))

const router = useRouter()
const message = useMessage()

// ─── 数据 ──────────────────────────────────────────────
const config = ref<AgentsYamlRaw>({ runtimes: [], global: { base_layers: [] }, agents: [] })
const saving = ref(false)
const activeTab = ref<'agents' | 'global' | 'runtimes'>('agents')

// ─── 运行时编辑 ────────────────────────────────────────
const runtimeModal = ref(false)
const editingRuntime = ref<RuntimeRaw | null>(null)
const runtimeForm = reactive<RuntimeRaw>({ id: '', type: 'claude-cli', command: 'claude' })

// ─── 自动检测 ──────────────────────────────────────────
const detecting = ref(false)
const detectedList = ref<DetectedRuntime[]>([])
const detectModal = ref(false)

async function runDetect() {
  detecting.value = true
  detectModal.value = true
  detectedList.value = []
  try {
    detectedList.value = await api.config.detectRuntimes()
  } finally {
    detecting.value = false
  }
}

function addDetected(rt: DetectedRuntime) {
  const exists = config.value.runtimes.find((r) => r.id === rt.id)
  if (exists) {
    Object.assign(exists, { type: rt.type, command: rt.command })
  } else {
    config.value.runtimes.push({ id: rt.id, type: rt.type, command: rt.command })
  }
}

function addAllDetected() {
  for (const rt of detectedList.value.filter((r) => r.available)) {
    addDetected(rt)
  }
  detectModal.value = false
}

// ─── Agent 编辑 ────────────────────────────────────────
const agentModal = ref(false)
const editingAgent = ref<AgentRaw | null>(null)
const agentForm = reactive<AgentRaw>({
  id: '', name: '', runtime: 'claude',
  instruction: '', output_file: '', outputs: [],
  memory_sediment: false,
  config: { runtimeId: '', env: {}, cwd: '', timeoutMs: undefined },
})
// Implements: .scratch/agent-ports-editor/PRD.md
// ports 用 PortsEditor 组件编辑，内部 state 直接是 string[]（不再 split 文本）
const agentInputs = ref<string[]>([])
const agentOutputs = ref<string[]>([])
// Phase 2: env 字段以 k/v 数组形式编辑，保存时合成 Record
interface EnvEntry { key: string; value: string }
const agentEnvList = ref<EnvEntry[]>([])

// ─── 全局基础层 ────────────────────────────────────────
const globalSelectedIdx = ref<number | null>(null)

const globalSelectedContent = computed({
  get: () =>
    globalSelectedIdx.value !== null
      ? (config.value.global.base_layers[globalSelectedIdx.value]?.content ?? '')
      : '',
  set: (val: string) => {
    const idx = globalSelectedIdx.value
    if (idx !== null) {
      // Implements: tasks.md#T032.2
      // noUncheckedIndexedAccess 下 base_layers[idx] 为 BaseLayer | undefined，
      // 加 layer 存在性守卫让类型与运行时双侧安全（与 getter 的 ?. 对齐）
      const layer = config.value.global.base_layers[idx]
      if (layer) layer.content = val
    }
  },
})

function addBaseLayer() {
  config.value.global.base_layers.push({ name: '新基础层', content: '' })
  globalSelectedIdx.value = config.value.global.base_layers.length - 1
}

async function removeBaseLayer(idx: number) {
  config.value.global.base_layers.splice(idx, 1)
  if (globalSelectedIdx.value === idx) globalSelectedIdx.value = null
  else if (globalSelectedIdx.value !== null && globalSelectedIdx.value > idx) globalSelectedIdx.value--
  await saveConfig()
}

// ─── 计算属性 ──────────────────────────────────────────
const runtimeIds = computed(() => config.value.runtimes.map((r) => r.id))
const runtimeOptions = computed(() => runtimeIds.value.map((id) => ({ label: id, value: id })))

onMounted(async () => {
  const cfg = await api.config.agents()
  config.value = {
    runtimes: (cfg.runtimes ?? []).map((r) => ({ id: r.id, type: r.type, command: (r as any).command ?? '' })),
    global: { base_layers: cfg.global?.base_layers ?? [] },
    agents: cfg.agents ?? [],
  }
})

// ─── 保存整体配置 ──────────────────────────────────────
async function saveConfig() {
  saving.value = true
  try {
    await api.config.saveAgents(config.value)
    message.success('配置已保存')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}

// ─── 运行时操作 ────────────────────────────────────────
function openAddRuntime() {
  editingRuntime.value = null
  Object.assign(runtimeForm, { id: '', type: 'claude-cli', command: 'claude' })
  runtimeModal.value = true
}

function openEditRuntime(rt: RuntimeRaw) {
  editingRuntime.value = rt
  Object.assign(runtimeForm, { ...rt })
  runtimeModal.value = true
}

function saveRuntime() {
  if (!runtimeForm.id.trim()) return
  if (editingRuntime.value) {
    Object.assign(editingRuntime.value, { ...runtimeForm })
  } else {
    config.value.runtimes.push({ ...runtimeForm })
  }
  runtimeModal.value = false
}

function deleteRuntime(idx: number) {
  config.value.runtimes.splice(idx, 1)
}

// ─── Agent 操作 ────────────────────────────────────────
function openAddAgent() {
  editingAgent.value = null
  Object.assign(agentForm, {
    id: '', name: '', runtime: runtimeIds.value[0] ?? 'claude',
    instruction: '', output_file: '', outputs: [], inputs: [],
    memory_sediment: false,
  })
  agentInputs.value = []
  agentOutputs.value = []
  agentEnvList.value = []
  agentForm.config = { runtimeId: '', env: {}, cwd: '', timeoutMs: undefined }
  agentModal.value = true
}

function openEditAgent(agent: AgentRaw) {
  editingAgent.value = agent
  Object.assign(agentForm, {
    id: agent.id,
    name: agent.name,
    runtime: agent.runtime,
    instruction: agent.instruction ?? '',
    output_file: agent.output_file,
    outputs: agent.outputs ? [...agent.outputs] : [],
    memory_sediment: agent.memory_sediment ?? false,
  })
  agentInputs.value = agent.inputs ? [...agent.inputs] : []
  agentOutputs.value = agent.outputs ? [...agent.outputs] : []
  // 把后端 Record<k, v> 拆回 k/v 数组，便于 NDynamicInput 编辑
  const cfg = agent.config ?? {}
  agentEnvList.value = Object.entries(cfg.env ?? {}).map(([key, value]) => ({ key, value }))
  agentForm.config = {
    runtimeId: cfg.runtimeId ?? '',
    env: cfg.env ?? {},
    cwd: cfg.cwd ?? '',
    timeoutMs: cfg.timeoutMs,
  }
  agentModal.value = true
}

async function saveAgent() {
  if (!agentForm.id.trim() || !agentForm.name.trim()) return

  // 把 env 数组合成 Record，跳过空 key
  const envRecord: Record<string, string> = {}
  for (const e of agentEnvList.value) {
    const k = e.key.trim()
    if (k) envRecord[k] = e.value
  }
  const cfg: AgentRaw['config'] = {
    runtimeId: agentForm.config?.runtimeId?.trim() || undefined,
    env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
    cwd: agentForm.config?.cwd?.trim() || undefined,
    timeoutMs: agentForm.config?.timeoutMs,
  }
  // 全部为空时不写入 config 字段
  const hasConfig = cfg.runtimeId || cfg.env || cfg.cwd || cfg.timeoutMs

  const parseList = (raw: string) => raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  // Implements: .scratch/agent-ports-editor/PRD.md
  // ports 已是 string[]（PortsEditor 维护），空数组不写入（与之前 "field absent" 语义一致）
  const data: AgentRaw = {
    id: agentForm.id,
    name: agentForm.name,
    runtime: agentForm.runtime,
    instruction: agentForm.instruction,
    output_file: agentForm.output_file,
    outputs: agentOutputs.value.length > 0 ? [...agentOutputs.value] : undefined,
    inputs: agentInputs.value.length > 0 ? [...agentInputs.value] : undefined,
    memory_sediment: agentForm.memory_sediment ?? false,
    config: hasConfig ? cfg : undefined,
  }

  if (editingAgent.value) {
    Object.assign(editingAgent.value, data)
  } else {
    config.value.agents.push(data)
  }

  await saveConfig()
  // 重置 dirty 快照（保存后的状态即新基线）
  initialSnapshot.value = snapshotForm()
  agentModal.value = false
}

function deleteAgent(idx: number) {
  config.value.agents.splice(idx, 1)
}

// Implements: .scratch/agent-ports-editor/PRD.md
// output_file 与 outputs 正交，但允许一键对齐到 outputs[0]（显式可逆操作）。
const canAlignOutputFile = computed(
  () => !!agentOutputs.value[0] && agentOutputs.value[0] !== agentForm.output_file,
)
function alignOutputFileToOutputs() {
  const first = agentOutputs.value[0]
  if (first) agentForm.output_file = first
}

// Implements: .scratch/agent-ports-editor/PRD.md
// 「未保存」状态：snapshot 字符串对比。
// 打开 modal 后 nextTick 拍快照；任意字段变化 → dirty=true；保存成功 → dirty=false。
// 这样比 watch + flag 更稳（不依赖 deep watch 的初始化触发）。
const initialSnapshot = ref('')
function snapshotForm(): string {
  return JSON.stringify({
    id: agentForm.id,
    name: agentForm.name,
    runtime: agentForm.runtime,
    output_file: agentForm.output_file,
    memory_sediment: !!agentForm.memory_sediment,
    inputs: [...agentInputs.value],
    outputs: [...agentOutputs.value],
    env: agentEnvList.value.map((e) => ({ key: e.key, value: e.value })),
    config: {
      runtimeId: agentForm.config?.runtimeId ?? '',
      cwd: agentForm.config?.cwd ?? '',
      timeoutMs: agentForm.config?.timeoutMs ?? null,
    },
  })
}
const isDirty = computed(() => {
  // modal 未打开时永远 false（避免打开前 computed 误判）
  if (!agentModal.value) return false
  // 初始快照未拍到之前不报错
  if (!initialSnapshot.value) return false
  return snapshotForm() !== initialSnapshot.value
})

watch(agentModal, async (open) => {
  if (!open) return
  // 等 openAddAgent / openEditAgent 的所有 reactive 赋值跑完再拍快照
  await nextTick()
  initialSnapshot.value = snapshotForm()
})

// 「运行时配置」section 默认折叠；字段计数做 badge，给用户决定是否展开的线索
const runtimeCfgFieldCount = computed(() => {
  const c = agentForm.config
  let n = 0
  if (c?.runtimeId) n++
  if (c?.cwd) n++
  if (c?.timeoutMs != null) n++
  if (agentEnvList.value.some((e) => e.key.trim().length > 0)) n++
  return n
})

// Implements: tasks.md#T032.2 + .scratch/agent-ports-editor/PRD.md
// 单测入口：这些函数放在 script 顶层（setupState），不要放进 defineExpose，
// 否则 wrapper.vm 拿不到——defineExpose 只挂到「parent ref 可见的 exposed 对象」上。
// 同时：setter 走 ref.value，不要让测试直接赋值整个 ref（替换 ref 自身会让
// script 闭包里的原 ref 失联，saveAgent 读到的还是旧值）。
function setAgentInputs(v: string[]) { agentInputs.value = v }
function setAgentOutputs(v: string[]) { agentOutputs.value = v }

defineExpose({
  config,
  globalSelectedIdx,
  globalSelectedContent,
  agentForm,
  canAlignOutputFile,
  isDirty,
  runtimeCfgFieldCount,
  setAgentInputs,
  setAgentOutputs,
})
</script>

<template>
  <NLayout style="height: 100vh;">
    <NLayoutHeader style="padding: 0 20px; border-bottom: 1px solid #efeff5; background: #fff;">
      <NSpace justify="space-between" align="center" style="height: 56px;">
        <NSpace align="center">
          <NButton text @click="router.push('/')">← 返回</NButton>
          <NText strong style="font-size:16px;">Agent 配置</NText>
        </NSpace>
        <NButton type="primary" :loading="saving" @click="saveConfig">保存配置</NButton>
      </NSpace>
    </NLayoutHeader>

    <NLayoutContent style="overflow: auto;">
      <NTabs v-model:value="activeTab" type="line" animated style="padding: 0 20px;">

        <!-- ─── Agent 列表 ─── -->
        <NTabPane name="agents" tab="Agent 列表">
          <div style="padding: 16px 0;">
            <NSpace justify="space-between" align="center" style="margin-bottom: 14px;">
              <NText depth="3" style="font-size:13px;">配置 Agent 的名称、运行时与指令。流转顺序即为列表顺序。</NText>
              <NButton @click="openAddAgent">+ 新增 Agent</NButton>
            </NSpace>

            <NEmpty v-if="config.agents.length === 0" description="还没有 Agent，点击新增" />

            <NList v-else bordered>
              <NListItem v-for="(agent, idx) in config.agents" :key="agent.id">
                <NThing>
                  <template #avatar>
                    <div style="width:28px;height:28px;border-radius:50%;background:#ede9fe;color:#6d28d9;
                                display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;">
                      {{ idx + 1 }}
                    </div>
                  </template>
                  <template #header>
                    <NSpace align="center" :size="6">
                      <NText strong>{{ agent.name }}</NText>
                      <NTag size="small" type="info">{{ agent.id }}</NTag>
                      <NTag size="small" type="warning">{{ agent.runtime }}</NTag>
                      <NTag size="small" type="success">→ {{ agent.output_file || '(无文件)' }}</NTag>
                      <!--
                        Implements: .scratch/agent-ports-editor/PRD.md
                        列表上的 ports 用 mini 端口胶囊展示（与画布 AgentNode 同色 token），
                        超过 3 个折叠为 +N，hover 显示全部。
                      -->
                      <span
                        v-for="p in (agent.inputs ?? []).slice(0, 3)"
                        :key="`li-${agent.id}-i-${p}`"
                        class="port-mini port-mini--in"
                        :title="`输入 · ${p}`"
                      >◐ {{ p }}</span>
                      <span
                        v-if="(agent.inputs ?? []).length > 3"
                        class="port-mini port-mini--in port-mini--more"
                        :title="(agent.inputs ?? []).slice(3).join(', ')"
                      >+{{ (agent.inputs ?? []).length - 3 }}</span>
                      <span
                        v-for="p in (agent.outputs ?? []).slice(0, 3)"
                        :key="`lo-${agent.id}-o-${p}`"
                        class="port-mini port-mini--out"
                        :title="`输出 · ${p}`"
                      >● {{ p }}</span>
                      <span
                        v-if="(agent.outputs ?? []).length > 3"
                        class="port-mini port-mini--out port-mini--more"
                        :title="(agent.outputs ?? []).slice(3).join(', ')"
                      >+{{ (agent.outputs ?? []).length - 3 }}</span>
                      <!--
                        Implements: tasks.md#T028 / plan.md#D-03
                        列表上的 memory_sediment 指示标签（开启=沉淀，关闭=隐藏）
                      -->
                      <NTag v-if="agent.memory_sediment" size="small" type="info">沉淀</NTag>
                      <!--
                        Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
                        列表上的 runtime config 指示标签（任意字段非空时显示）
                      -->
                      <NTag v-if="agent.config && (agent.config.runtimeId || agent.config.cwd || agent.config.timeoutMs || (agent.config.env && Object.keys(agent.config.env).length))"
                        size="small" type="warning">runtime cfg</NTag>
                    </NSpace>
                  </template>
                  <template #description>
                    <div style="font-size:12px;color:#888;margin-top:4px;">
                      <span v-if="agent.instruction?.trim()">
                        {{ agent.instruction.slice(0, 80) }}{{ agent.instruction.length > 80 ? '…' : '' }}
                      </span>
                      <span v-else style="color:#ccc;">未配置指令</span>
                    </div>
                  </template>
                  <template #header-extra>
                    <NSpace>
                      <NButton size="small" @click="openEditAgent(agent)">✎ 编辑</NButton>
                      <NButton size="small" type="error" ghost @click="deleteAgent(idx)">✕</NButton>
                    </NSpace>
                  </template>
                </NThing>
              </NListItem>
            </NList>
          </div>
        </NTabPane>

        <!-- ─── 全局基础层 ─── -->
        <NTabPane name="global" tab="全局基础层">
          <div style="padding: 16px 0;">
            <NSpace justify="space-between" align="center" style="margin-bottom: 14px;">
              <NText depth="3" style="font-size:13px;">
                每次新对话都会将以下内容<strong>按顺序</strong>注入到所有 Agent 系统提示最前面
              </NText>
              <NButton @click="addBaseLayer">+ 添加基础层</NButton>
            </NSpace>

            <div style="display:flex;gap:0;border:1px solid #efeff5;border-radius:8px;overflow:hidden;height:calc(100vh - 200px);">
              <!-- 左：基础层列表 -->
              <div style="width:240px;flex-shrink:0;border-right:1px solid #efeff5;overflow-y:auto;">
                <NEmpty v-if="config.global.base_layers.length === 0" description="未配置" style="padding:32px 0;" />
                <div
                  v-for="(layer, idx) in config.global.base_layers"
                  :key="idx"
                  :style="{
                    display:'flex',alignItems:'center',gap:'8px',padding:'10px 12px',
                    cursor:'pointer',borderBottom:'1px solid #f5f5f5',
                    background: globalSelectedIdx === idx ? '#f0f0ff' : 'transparent',
                  }"
                  @click="globalSelectedIdx = idx"
                >
                  <div :style="{
                    width:'20px',height:'20px',borderRadius:'50%',flexShrink:0,
                    display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:'700',
                    background: globalSelectedIdx === idx ? '#6366f1' : '#e5e5e5',
                    color: globalSelectedIdx === idx ? '#fff' : '#666',
                  }">{{ idx + 1 }}</div>
                  <input
                    v-model="layer.name"
                    style="flex:1;border:none;background:transparent;font-size:13px;color:#374151;outline:none;padding:0;"
                    placeholder="层名称"
                    @click.stop
                  />
                  <NButton size="tiny" type="error" ghost @click.stop="removeBaseLayer(idx)">✕</NButton>
                </div>
              </div>

              <!-- 右：编辑器 -->
              <div style="flex:1;display:flex;flex-direction:column;background:#1e1e2e;">
                <div v-if="globalSelectedIdx === null"
                  style="flex:1;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px;">
                  ← 点击左侧基础层查看/编辑内容
                </div>
                <template v-else>
                  <div style="display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid #2d2d3f;background:#1a1a2e;">
                    <NText style="color:#94a3b8;font-size:13px;">
                      {{ config.global.base_layers[globalSelectedIdx]?.name || '未命名' }}
                      <span style="color:#555;font-size:11px;margin-left:8px;">（修改后点击「保存配置」生效）</span>
                    </NText>
                  </div>
                  <div style="flex:1;overflow:hidden;">
                    <MarkdownEditor v-model="globalSelectedContent" style="height:100%;border-radius:0;border:none;" />
                  </div>
                </template>
              </div>
            </div>
          </div>
        </NTabPane>

        <!-- ─── 运行时 ─── -->
        <NTabPane name="runtimes" tab="运行时">
          <div style="padding: 16px 0;">
            <NSpace justify="space-between" align="center" style="margin-bottom: 14px;">
              <NText depth="3" style="font-size:13px;">配置 CLI 运行时（claude、codex 等）。Agent 在此选择使用哪个运行时。</NText>
              <NSpace>
                <NButton @click="runDetect">🔍 自动检测</NButton>
                <NButton @click="openAddRuntime">+ 手动新增</NButton>
              </NSpace>
            </NSpace>

            <NEmpty v-if="config.runtimes.length === 0"
              description="还没有运行时，点击「自动检测」从本机发现可用工具" />

            <NList v-else bordered>
              <NListItem v-for="(rt, idx) in config.runtimes" :key="rt.id">
                <NThing>
                  <template #header>
                    <NSpace align="center" :size="8">
                      <NText strong>{{ rt.id }}</NText>
                      <NTag size="small">{{ rt.type }}</NTag>
                      <code style="font-size:12px;background:#f0f0f5;padding:2px 8px;border-radius:4px;">{{ rt.command }}</code>
                    </NSpace>
                  </template>
                  <template #header-extra>
                    <NSpace>
                      <NButton size="small" @click="openEditRuntime(rt)">✎ 编辑</NButton>
                      <NButton size="small" type="error" ghost @click="deleteRuntime(idx)">✕</NButton>
                    </NSpace>
                  </template>
                </NThing>
              </NListItem>
            </NList>
          </div>
        </NTabPane>

      </NTabs>
    </NLayoutContent>
  </NLayout>

  <!-- ─── 自动检测弹窗 ─── -->
  <NModal v-model:show="detectModal">
    <NCard title="本机运行时检测" closable style="width:600px;background:#fff;"
      @close="detectModal = false">
      <div v-if="detecting" style="display:flex;align-items:center;gap:12px;padding:24px 0;">
        <NSpin size="small" />
        <NText depth="3">正在扫描本机已安装的 AI CLI 工具...</NText>
      </div>
      <template v-else>
        <NEmpty v-if="detectedList.length === 0" description="未检测到可用工具" />
        <NList v-else bordered style="max-height:360px;overflow-y:auto;">
          <NListItem v-for="rt in detectedList" :key="rt.id" :style="{ opacity: rt.available ? 1 : 0.5 }">
            <NThing>
              <template #avatar>
                <NTag :type="rt.available ? 'success' : 'error'" size="small" round>
                  {{ rt.available ? '✓' : '✗' }}
                </NTag>
              </template>
              <template #header>
                <NSpace align="center" :size="6">
                  <NText strong>{{ rt.id }}</NText>
                  <NTag size="small">{{ rt.type }}</NTag>
                  <NTag v-if="rt.source === 'daemon'" size="small" type="warning">
                    daemon :{{ rt.daemonPort }}
                    <span :style="{ display:'inline-block',width:'7px',height:'7px',borderRadius:'50%',
                      background:rt.daemonRunning?'#18a058':'#aaa',marginLeft:'4px' }" />
                  </NTag>
                </NSpace>
              </template>
              <template #description>
                <NSpace :size="8">
                  <code style="font-size:12px;">{{ rt.command }}</code>
                  <NText v-if="rt.version" type="success" style="font-size:12px;">{{ rt.version }}</NText>
                  <NText v-else-if="!rt.available" type="error" style="font-size:12px;">未在 PATH 中找到</NText>
                </NSpace>
              </template>
              <template #header-extra>
                <NButton v-if="rt.available" size="small"
                  :type="config.runtimes.some(r => r.id === rt.id) ? 'default' : 'primary'"
                  @click="addDetected(rt)">
                  {{ config.runtimes.some(r => r.id === rt.id) ? '已添加（更新）' : '+ 添加' }}
                </NButton>
              </template>
            </NThing>
          </NListItem>
        </NList>
      </template>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="detectModal = false">关闭</NButton>
          <NButton v-if="detectedList.some(r => r.available)" type="primary" @click="addAllDetected">
            全部添加（{{ detectedList.filter(r => r.available).length }} 个）
          </NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>

  <!-- ─── 运行时编辑弹窗 ─── -->
  <NModal v-model:show="runtimeModal">
    <NCard :title="editingRuntime ? '编辑运行时' : '新增运行时'" closable
      style="width:440px;background:#fff;" @close="runtimeModal = false">
      <NForm label-placement="top" :show-feedback="false">
        <NFormItem label="ID *">
          <NInput v-model:value="runtimeForm.id" placeholder="如 claude、codex" :disabled="!!editingRuntime" />
        </NFormItem>
        <NFormItem label="类型">
          <NSelect v-model:value="runtimeForm.type" :options="[
            { label: 'claude-cli（Claude Code）', value: 'claude-cli' },
            { label: 'codefree-cli（CodeFree）', value: 'codefree-cli' },
          ]" />
        </NFormItem>
        <NFormItem label="CLI 命令">
          <NInput v-model:value="runtimeForm.command" placeholder="如 claude" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="runtimeModal = false">取消</NButton>
          <NButton type="primary" :disabled="!runtimeForm.id.trim()" @click="saveRuntime">保存</NButton>
        </NSpace>
      </template>
    </NCard>
  </NModal>

  <!--
    Agent 编辑弹窗（节点配置 drawer 风格，参考 LangGraph Studio / n8n）：
    - 顶部 sticky header: 标识当前编辑对象 + 「未保存」指示 + 关闭
    - 左 sidebar (380px): 4 个 collapsible section + 底部 sticky action bar
    - 右 editor: MarkdownEditor + 顶部字符计数
    Implements: .scratch/agent-ports-editor/PRD.md
  -->
  <NModal v-model:show="agentModal">
    <div class="agent-modal">
      <!-- 顶 header -->
      <header class="agent-modal__header">
        <div class="agent-modal__title-group">
          <span class="agent-modal__crumb">
            {{ editingAgent ? '编辑 Agent' : '新增 Agent' }}
          </span>
          <span v-if="editingAgent" class="agent-modal__id">· {{ editingAgent.id }}</span>
          <span v-else class="agent-modal__badge agent-modal__badge--new">NEW</span>
          <span v-if="isDirty" class="agent-modal__dirty">● 未保存</span>
        </div>
        <button
          class="agent-modal__close"
          aria-label="关闭"
          @click="agentModal = false"
        >✕</button>
      </header>

      <div class="agent-modal__body">
        <!-- 左 sidebar：分组配置 -->
        <aside class="agent-modal__sidebar">
          <NCollapse
            :default-expanded-names="['basic', 'ports', 'behavior']"
            arrow-placement="right"
            class="agent-modal__collapse"
          >
            <!-- ─── 基础信息 ─── -->
            <NCollapseItem name="basic">
              <template #header>
                <div class="agent-modal__section-header">
                  <span class="agent-modal__section-title">基础信息</span>
                  <span class="agent-modal__section-hint">ID 与名称不可在流水线中修改</span>
                </div>
              </template>
              <NForm label-placement="top" :show-feedback="false" class="agent-modal__form">
                <div class="agent-modal__row" style="display:flex;gap:10px;">
                  <NFormItem label="ID *" style="flex:1;">
                    <NInput
                      v-model:value="agentForm.id"
                      placeholder="如 spec"
                      :disabled="!!editingAgent"
                    />
                  </NFormItem>
                  <NFormItem label="名称 *" style="flex:1;">
                    <NInput v-model:value="agentForm.name" placeholder="如 Spec Agent" />
                  </NFormItem>
                </div>
                <div class="agent-modal__row" style="display:flex;gap:10px;">
                  <NFormItem label="运行时类型" style="flex:1;">
                    <NSelect
                      v-model:value="agentForm.runtime"
                      :options="runtimeOptions"
                    />
                  </NFormItem>
                  <!--
                    Implements: .scratch/agent-ports-editor/PRD.md
                    物理输出文件名（与 outputs 正交）；可一键对齐到 outputs[0]（显式可逆）。
                    复测入口：ConfigView.test.ts ②「物理输出文件名」+ 与 outputs 正交。
                  -->
                  <NFormItem label="物理输出文件名" style="flex:1;">
                    <div class="agent-modal__input-group">
                      <NInput
                        v-model:value="agentForm.output_file"
                        placeholder="如 spec.md"
                        style="flex:1;"
                      />
                      <NButton
                        size="tiny"
                        type="tertiary"
                        :disabled="!canAlignOutputFile"
                        @click="alignOutputFileToOutputs"
                      >对齐 outputs[0]</NButton>
                    </div>
                  </NFormItem>
                </div>
                <NText depth="3" class="agent-modal__helper">
                  写到 <code>storage/&lt;ws&gt;/&lt;featureId&gt;/此文件名</code>，与 outputs 正交：outputs 是逻辑端口名（用于画布连接和 prompt 引用）
                </NText>
              </NForm>
            </NCollapseItem>

            <!-- ─── 端口契约 ─── -->
            <NCollapseItem name="ports">
              <template #header>
                <div class="agent-modal__section-header">
                  <span class="agent-modal__section-title">端口契约</span>
                  <span class="agent-modal__section-hint">
                    画布上的连接点；prompt 里可用 inputs.X / outputs.X 引用
                  </span>
                </div>
              </template>
              <PortsEditor
                v-model:inputs="agentInputs"
                v-model:outputs="agentOutputs"
                style="width:100%;"
              />
            </NCollapseItem>

            <!--
              Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
              per-agent runtime config（YAML 级默认；workflow_nodes.config_json 覆盖）。
              默认折叠 + 字段计数 badge：避免一上来 5 个子项占满首屏。
            -->
            <NCollapseItem name="runtime">
              <template #header>
                <div class="agent-modal__section-header">
                  <span class="agent-modal__section-title">运行时配置</span>
                  <span
                    v-if="runtimeCfgFieldCount > 0"
                    class="agent-modal__section-badge"
                  >{{ runtimeCfgFieldCount }}</span>
                  <span class="agent-modal__section-hint">每 Agent 独立覆盖运行行为</span>
                </div>
              </template>
              <NForm label-placement="top" :show-feedback="false" class="agent-modal__form">
                <NFormItem label="运行时 ID（覆盖 default）">
                  <NSelect
                    :value="agentForm.config?.runtimeId ?? ''"
                    :options="[{ label: '（使用默认）', value: '' }, ...runtimeOptions]"
                    @update:value="(v: string) => { agentForm.config = { ...(agentForm.config ?? {}), runtimeId: v } }"
                  />
                </NFormItem>
                <NFormItem label="环境变量">
                  <div class="agent-modal__env-list">
                    <div
                      v-for="(entry, i) in agentEnvList"
                      :key="i"
                      class="agent-modal__env-row"
                    >
                      <NInput
                        :value="entry.key"
                        placeholder="KEY"
                        size="small"
                        style="flex:1;"
                        @update:value="(v: string) => { entry.key = v }"
                      />
                      <NInput
                        :value="entry.value"
                        placeholder="value"
                        size="small"
                        style="flex:1;"
                        @update:value="(v: string) => { entry.value = v }"
                      />
                      <NButton
                        size="tiny"
                        type="error"
                        ghost
                        @click="agentEnvList.splice(i, 1)"
                      >✕</NButton>
                    </div>
                    <NButton
                      size="tiny"
                      @click="agentEnvList.push({ key: '', value: '' })"
                    >+ 添加变量</NButton>
                  </div>
                </NFormItem>
                <NFormItem label="工作目录 (cwd)">
                  <NInput
                    :value="agentForm.config?.cwd ?? ''"
                    placeholder="留空则使用 <localPath>/repo"
                    @update:value="(v: string) => { agentForm.config = { ...(agentForm.config ?? {}), cwd: v } }"
                  />
                </NFormItem>
                <NFormItem label="超时 (ms)">
                  <NInputNumber
                    :value="agentForm.config?.timeoutMs"
                    placeholder="留空则不超时"
                    :min="1"
                    style="width:100%;"
                    @update:value="(v: number | null) => { agentForm.config = { ...(agentForm.config ?? {}), timeoutMs: v ?? undefined } }"
                  />
                </NFormItem>
              </NForm>
            </NCollapseItem>

            <!--
              Implements: tasks.md#T028 / plan.md#D-03
              memory_sediment：开启后该 Agent 在阶段执行结束时把状态摘要沉淀到 memory/MEMORY.md
            -->
            <NCollapseItem name="behavior">
              <template #header>
                <div class="agent-modal__section-header">
                  <span class="agent-modal__section-title">行为选项</span>
                  <span class="agent-modal__section-hint">执行时副作用</span>
                </div>
              </template>
              <NFormItem label="记忆沉淀">
                <NCheckbox v-model:checked="agentForm.memory_sediment">
                  完成后把状态摘要写入 memory/MEMORY.md
                </NCheckbox>
              </NFormItem>
            </NCollapseItem>
          </NCollapse>

          <!-- 操作栏：sticky 在 sidebar 底部 -->
          <div class="agent-modal__actions">
            <NButton @click="agentModal = false">取消</NButton>
            <NButton
              type="primary"
              :loading="saving"
              :disabled="!agentForm.id.trim() || !agentForm.name.trim()"
              @click="saveAgent"
            >保存 Agent</NButton>
          </div>
        </aside>

        <!-- 右 editor -->
        <section class="agent-modal__editor">
          <div class="agent-modal__editor-bar">
            <span class="agent-modal__editor-title">指令内容</span>
            <span class="agent-modal__editor-meta">
              {{ agentForm.instruction.length.toLocaleString() }} 字符
              <span v-if="isDirty" class="agent-modal__editor-dirty">· 未保存</span>
            </span>
          </div>
          <div class="agent-modal__editor-host">
            <MarkdownEditor
              v-model="agentForm.instruction"
              style="height:100%;border-radius:0;border:none;"
            />
          </div>
        </section>
      </div>
    </div>
  </NModal>
</template>

<!--
  Implements: .scratch/agent-ports-editor/PRD.md
  列表卡片上的 mini 端口胶囊：颜色 token 与 AgentNode / PortsEditor 共用。
-->
<style scoped>
/*
  Implements: agent 编辑弹层视觉（LangGraph / n8n 节点 drawer 风）
  - 暗色 header 与亮色 sidebar 形成 step-down 视觉层级
  - collapsible section header 用小一号灰字 + hint；active 时左侧 2px 强调条
  - dirty chip 用品牌橙，与「未保存」语义一致
  - 排版间距统一 8/12/16，section 内表单 12px gap，与全局 8px 栅格对齐
*/
.agent-modal {
  display: flex;
  flex-direction: column;
  width: 92vw;
  max-width: 1180px;
  height: 84vh;
  overflow: hidden;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 20px 50px rgba(15, 23, 42, 0.18);
}

/* 顶 header */
.agent-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 48px;
  padding: 0 16px 0 20px;
  background: #18181b;
  color: #e4e4e7;
  flex-shrink: 0;
}
.agent-modal__title-group {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.agent-modal__crumb {
  font-size: 13px;
  font-weight: 600;
  color: #e4e4e7;
}
.agent-modal__id {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  color: #a1a1aa;
}
.agent-modal__badge {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: 3px;
  background: #2563eb;
  color: #fff;
}
.agent-modal__dirty {
  font-size: 11px;
  color: #fb923c;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.agent-modal__close {
  width: 28px;
  height: 28px;
  border: none;
  background: transparent;
  color: #a1a1aa;
  cursor: pointer;
  font-size: 14px;
  border-radius: 4px;
}
.agent-modal__close:hover {
  background: #27272a;
  color: #fff;
}

/* 主体 */
.agent-modal__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

/* 左 sidebar */
.agent-modal__sidebar {
  width: 400px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid #efeff5;
  background: #fafafa;
}
.agent-modal__collapse {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}
.agent-modal__collapse :deep(.n-collapse-item__header-main) {
  flex: 1;
  min-width: 0;
}
.agent-modal__collapse :deep(.n-collapse-item) {
  --n-title-text-color: #27272a;
  --n-title-font-weight: 600;
  --n-header-padding: 10px 16px;
}
.agent-modal__collapse :deep(.n-collapse-item__content-inner) {
  padding: 4px 16px 16px;
}

.agent-modal__section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.agent-modal__section-title {
  font-size: 13px;
  font-weight: 600;
  color: #27272a;
  flex-shrink: 0;
}
.agent-modal__section-hint {
  font-size: 11px;
  color: #71717a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.agent-modal__section-badge {
  font-size: 10px;
  font-weight: 700;
  background: #e4e4e7;
  color: #3f3f46;
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
  min-width: 18px;
  text-align: center;
}

/* 表单内部 */
.agent-modal__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.agent-modal__row {
  display: flex;
  gap: 10px;
}
.agent-modal__input-group {
  display: flex;
  gap: 6px;
  width: 100%;
  align-items: center;
}
.agent-modal__helper {
  font-size: 11px;
  line-height: 1.5;
}
.agent-modal__helper code {
  background: #f4f4f5;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10.5px;
}

.agent-modal__env-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.agent-modal__env-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

/* 操作栏：sticky 底部 */
.agent-modal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #efeff5;
  background: #fff;
  flex-shrink: 0;
}

/* 右 editor */
.agent-modal__editor {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #1e1e2e;
}
.agent-modal__editor-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 16px;
  height: 36px;
  border-bottom: 1px solid #2d2d3f;
  background: #18181b;
  flex-shrink: 0;
}
.agent-modal__editor-title {
  font-size: 12px;
  font-weight: 600;
  color: #d4d4d8;
}
.agent-modal__editor-meta {
  font-size: 11px;
  color: #71717a;
  font-family: ui-monospace, monospace;
}
.agent-modal__editor-dirty {
  color: #fb923c;
}
.agent-modal__editor-host {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/*
  列表卡片上的 mini 端口胶囊：颜色 token 与 AgentNode / PortsEditor 共用。
*/
.port-mini {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  padding: 1px 6px;
  border-radius: 3px;
  background: #f4f4f5;
  color: #3f3f46;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.port-mini--in { color: var(--port-in-color); }
.port-mini--out { color: var(--port-out-color); }
.port-mini--more {
  background: transparent;
  color: #71717a;
}
</style>
