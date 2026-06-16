<script setup lang="ts">
import { ref, reactive, onMounted, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, type AgentsYamlRaw, type RuntimeRaw, type AgentRaw, type DetectedRuntime } from '@/api'
import { defineAsyncComponent } from 'vue'
import {
  NLayout, NLayoutHeader, NLayoutContent, NSpace, NButton, NText, NEmpty,
  NTabs, NTabPane, NTag, NSpin, NAlert,
  NModal, NForm, NFormItem, NInput, NSelect, NCheckbox, NRadioGroup, NRadio,
  NList, NListItem, NThing, NDivider, useMessage,
  NScrollbar,
} from 'naive-ui'
const MarkdownEditor = defineAsyncComponent(() => import('@/components/MarkdownEditor.vue'))

const router = useRouter()
const message = useMessage()

// ─── 数据 ──────────────────────────────────────────────
const config = ref<AgentsYamlRaw>({ runtimes: [], global: { base_prompts: [] }, agents: [] })
const promptFiles = ref<string[]>([])
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
const agentForm = reactive<AgentRaw & { promptMode: 'single' | 'multi' }>({
  id: '', name: '', runtime: 'claude',
  prompt: '', prompts: {}, output_file: '', upstream: [],
  promptMode: 'single',
})
const multiPromptEntries = ref<{ key: string; value: string }[]>([])

const inlinePromptContent = ref('')
const inlinePromptSaving = ref(false)
const activeMultiIdx = ref<number | null>(null)

async function loadInlinePrompt(filePath: string) {
  if (!filePath.trim()) { inlinePromptContent.value = ''; return }
  try {
    const result = await api.config.getPrompt(filePath)
    inlinePromptContent.value = result.content
  } catch {
    inlinePromptContent.value = ''
  }
}

watch(() => agentForm.prompt, (val) => {
  if (agentForm.promptMode === 'single') loadInlinePrompt(val ?? '')
})

async function selectMultiEntry(idx: number) {
  activeMultiIdx.value = idx
  await loadInlinePrompt(multiPromptEntries.value[idx]?.value ?? '')
}

async function saveInlinePrompt() {
  let filePath = ''
  if (agentForm.promptMode === 'single') {
    filePath = agentForm.prompt ?? ''
  } else if (activeMultiIdx.value !== null) {
    filePath = multiPromptEntries.value[activeMultiIdx.value]?.value ?? ''
  }
  if (!filePath.trim()) return
  inlinePromptSaving.value = true
  try {
    await api.config.savePrompt(filePath, inlinePromptContent.value)
    message.success('文件已保存')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    inlinePromptSaving.value = false
  }
}

// ─── 全局基础层 ────────────────────────────────────────
const globalPreviewIdx = ref<number | null>(null)
const globalPreviewContent = ref('')
const globalPreviewSaving = ref(false)

async function loadGlobalPreview(idx: number) {
  globalPreviewIdx.value = idx
  const filePath = config.value.global?.base_prompts?.[idx] ?? ''
  if (!filePath) { globalPreviewContent.value = ''; return }
  try {
    const result = await api.config.getPrompt(filePath)
    globalPreviewContent.value = result.content
  } catch {
    globalPreviewContent.value = ''
  }
}

async function saveGlobalPreview() {
  const idx = globalPreviewIdx.value
  if (idx === null) return
  const filePath = config.value.global?.base_prompts?.[idx] ?? ''
  if (!filePath) return
  globalPreviewSaving.value = true
  try {
    await api.config.savePrompt(filePath, globalPreviewContent.value)
    message.success('文件已保存')
  } catch (e: any) {
    message.error(e.message)
  } finally {
    globalPreviewSaving.value = false
  }
}

function addBasePrompt() {
  config.value.global.base_prompts.push('')
}

function removeBasePrompt(idx: number) {
  config.value.global.base_prompts.splice(idx, 1)
  if (globalPreviewIdx.value === idx) { globalPreviewIdx.value = null; globalPreviewContent.value = '' }
}

// ─── 计算属性 ──────────────────────────────────────────
const runtimeIds = computed(() => config.value.runtimes.map((r) => r.id))
const agentIds = computed(() => config.value.agents.map((a) => a.id))
const runtimeOptions = computed(() => runtimeIds.value.map((id) => ({ label: id, value: id })))

onMounted(async () => {
  const [cfg, files] = await Promise.all([api.config.agents(), api.config.promptFiles()])
  config.value = {
    runtimes: (cfg.runtimes ?? []).map((r) => ({ id: r.id, type: r.type, command: (r as any).command ?? '' })),
    global: { base_prompts: cfg.global?.base_prompts ?? [] },
    agents: cfg.agents ?? [],
  }
  promptFiles.value = files
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
    prompt: '', prompts: {}, output_file: '', upstream: [], promptMode: 'single',
  })
  multiPromptEntries.value = []
  inlinePromptContent.value = ''
  activeMultiIdx.value = null
  agentModal.value = true
}

async function openEditAgent(agent: AgentRaw) {
  editingAgent.value = agent
  const hasMulti = !!agent.prompts && Object.keys(agent.prompts).length > 0
  Object.assign(agentForm, {
    ...agent,
    promptMode: hasMulti ? 'multi' : 'single',
    prompt: agent.prompt ?? '',
    prompts: agent.prompts ?? {},
  })
  multiPromptEntries.value = hasMulti
    ? Object.entries(agent.prompts!).map(([key, value]) => ({ key, value }))
    : [{ key: '', value: '' }]
  activeMultiIdx.value = null
  inlinePromptContent.value = ''
  agentModal.value = true

  if (!hasMulti && agent.prompt) {
    await loadInlinePrompt(agent.prompt)
  }
}

function saveAgent() {
  if (!agentForm.id.trim() || !agentForm.name.trim()) return

  const data: AgentRaw = {
    id: agentForm.id,
    name: agentForm.name,
    runtime: agentForm.runtime,
    output_file: agentForm.output_file,
    upstream: agentForm.upstream,
  }

  if (agentForm.promptMode === 'single') {
    data.prompt = agentForm.prompt
  } else {
    const prompts: Record<string, string> = {}
    for (const entry of multiPromptEntries.value) {
      if (entry.key.trim()) prompts[entry.key.trim()] = entry.value
    }
    data.prompts = prompts
  }

  if (editingAgent.value) {
    Object.assign(editingAgent.value, data)
  } else {
    config.value.agents.push(data)
  }
  agentModal.value = false
}

function deleteAgent(idx: number) {
  config.value.agents.splice(idx, 1)
}

function toggleUpstream(agentId: string) {
  const idx = agentForm.upstream.indexOf(agentId)
  if (idx === -1) agentForm.upstream.push(agentId)
  else agentForm.upstream.splice(idx, 1)
}

function addMultiEntry() {
  multiPromptEntries.value.push({ key: '', value: '' })
}

function removeMultiEntry(idx: number) {
  multiPromptEntries.value.splice(idx, 1)
}

// ─── 文件浏览器 ─────────────────────────────────────────
const filePickerOpen = ref(false)
const filePickerFilter = ref('')
const selectingFor = ref<'single' | number | null>(null)
const filteredFiles = computed(() =>
  promptFiles.value.filter((f) => f.toLowerCase().includes(filePickerFilter.value.toLowerCase()))
)

function openFilePicker(target: 'single' | number) {
  selectingFor.value = target
  filePickerFilter.value = ''
  filePickerOpen.value = true
}

function selectFile(file: string) {
  if (selectingFor.value === 'single') {
    agentForm.prompt = file
  } else if (selectingFor.value !== null) {
    const idx = selectingFor.value as number
    if (multiPromptEntries.value[idx]) {
      multiPromptEntries.value[idx].value = file
    }
  }
  selectingFor.value = null
  filePickerOpen.value = false
}
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
              <NText depth="3" style="font-size:13px;">配置 Agent 的名称、运行时与指令文件。流转顺序即为列表顺序。</NText>
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
                      <NTag size="small" type="success">→ {{ agent.output_file }}</NTag>
                      <NTag v-if="agent.upstream?.length" size="small">
                        依赖: {{ agent.upstream.join(', ') }}
                      </NTag>
                    </NSpace>
                  </template>
                  <template #description>
                    <div style="font-size:12px;color:#888;font-family:monospace;margin-top:4px;">
                      <template v-if="agent.prompt">{{ agent.prompt }}</template>
                      <template v-else-if="agent.prompts">
                        <span v-for="(path, key) in agent.prompts" :key="key" style="margin-right:12px;">
                          <NText type="info" style="font-size:11px;">{{ key }}:</NText> {{ path }}
                        </span>
                      </template>
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
                每次对话都会将以下文件<strong>按顺序</strong>注入到系统提示最前面（如 constitution.md、AGENTS.md）
              </NText>
              <NButton @click="addBasePrompt">+ 添加文件</NButton>
            </NSpace>

            <div style="display:flex;gap:0;border:1px solid #efeff5;border-radius:8px;overflow:hidden;height:calc(100vh - 200px);">
              <!-- 左：文件列表 -->
              <div style="width:300px;flex-shrink:0;border-right:1px solid #efeff5;overflow-y:auto;">
                <NEmpty v-if="config.global.base_prompts.length === 0" description="未配置" style="padding:32px 0;" />
                <div v-for="(filePath, idx) in config.global.base_prompts" :key="idx"
                  :style="{
                    display:'flex',alignItems:'center',gap:'8px',padding:'10px 12px',
                    cursor:'pointer',borderBottom:'1px solid #f5f5f5',
                    background: globalPreviewIdx === idx ? '#f0f0ff' : 'transparent',
                  }"
                  @click="loadGlobalPreview(idx)"
                >
                  <div :style="{
                    width:'20px',height:'20px',borderRadius:'50%',flexShrink:0,
                    display:'flex',alignItems:'center',justifyContent:'center',fontSize:'11px',fontWeight:'700',
                    background: globalPreviewIdx === idx ? '#6366f1' : '#e5e5e5',
                    color: globalPreviewIdx === idx ? '#fff' : '#666',
                  }">{{ idx + 1 }}</div>
                  <input
                    v-model="config.global.base_prompts[idx]"
                    style="flex:1;border:none;background:transparent;font-size:12px;font-family:monospace;color:#374151;outline:none;padding:0;"
                    placeholder="文件路径（相对项目根）"
                    @click.stop
                    @change="globalPreviewIdx === idx && loadGlobalPreview(idx)"
                  />
                  <NButton size="tiny" type="error" ghost @click.stop="removeBasePrompt(idx)">✕</NButton>
                </div>
              </div>

              <!-- 右：编辑器 -->
              <div style="flex:1;display:flex;flex-direction:column;background:#1e1e2e;">
                <div v-if="globalPreviewIdx === null"
                  style="flex:1;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px;">
                  ← 点击左侧文件查看/编辑内容
                </div>
                <template v-else>
                  <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid #2d2d3f;background:#1a1a2e;">
                    <code style="font-size:11px;color:#94a3b8;">{{ config.global.base_prompts[globalPreviewIdx] }}</code>
                    <NButton size="small" type="primary" :loading="globalPreviewSaving" @click="saveGlobalPreview">
                      保存文件
                    </NButton>
                  </div>
                  <div style="flex:1;overflow:hidden;">
                    <MarkdownEditor v-model="globalPreviewContent" style="height:100%;border-radius:0;border:none;" />
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
  <NModal v-model:show="detectModal" preset="card" title="本机运行时检测" style="width: 600px;">
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
  </NModal>

  <!-- ─── 运行时编辑弹窗 ─── -->
  <NModal v-model:show="runtimeModal" preset="card"
    :title="editingRuntime ? '编辑运行时' : '新增运行时'" style="width: 440px;">
    <NForm label-placement="top" :show-feedback="false">
      <NFormItem label="ID *">
        <NInput v-model:value="runtimeForm.id" placeholder="如 claude、codex" :disabled="!!editingRuntime" />
      </NFormItem>
      <NFormItem label="类型">
        <NInput v-model:value="runtimeForm.type" placeholder="如 claude-cli、openai-cli" />
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
  </NModal>

  <!-- ─── Agent 编辑弹窗（左右分栏）─── -->
  <NModal v-model:show="agentModal" :show-icon="false"
    style="width:90vw;max-width:1100px;height:82vh;padding:0;overflow:hidden;">
    <div style="display:flex;height:82vh;overflow:hidden;">
      <!-- 左：配置区 -->
      <div style="width:340px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid #efeff5;overflow-y:auto;padding:20px;gap:12px;">
        <NText strong style="font-size:15px;">{{ editingAgent ? '编辑 Agent' : '新增 Agent' }}</NText>

        <NForm label-placement="top" :show-feedback="false" style="gap:10px;display:flex;flex-direction:column;">
          <div style="display:flex;gap:10px;">
            <NFormItem label="ID *" style="flex:1;">
              <NInput v-model:value="agentForm.id" placeholder="如 spec" :disabled="!!editingAgent" />
            </NFormItem>
            <NFormItem label="名称 *" style="flex:1;">
              <NInput v-model:value="agentForm.name" placeholder="如 Spec Agent" />
            </NFormItem>
          </div>

          <div style="display:flex;gap:10px;">
            <NFormItem label="运行时" style="flex:1;">
              <NSelect v-model:value="agentForm.runtime" :options="runtimeOptions" />
            </NFormItem>
            <NFormItem label="输出文件" style="flex:1;">
              <NInput v-model:value="agentForm.output_file" placeholder="如 spec.md" />
            </NFormItem>
          </div>

          <NFormItem label="上游依赖">
            <NSpace wrap>
              <NCheckbox
                v-for="aid in agentIds.filter(id => id !== agentForm.id)"
                :key="aid"
                :checked="agentForm.upstream.includes(aid)"
                @update:checked="toggleUpstream(aid)"
              >{{ aid }}</NCheckbox>
              <NText v-if="!agentIds.filter(id => id !== agentForm.id).length" depth="3" style="font-size:12px;">无其他 Agent</NText>
            </NSpace>
          </NFormItem>

          <NFormItem label="指令模式">
            <NRadioGroup v-model:value="agentForm.promptMode">
              <NSpace>
                <NRadio value="single" @click="loadInlinePrompt(agentForm.prompt ?? '')">单一文件</NRadio>
                <NRadio value="multi" @click="() => { inlinePromptContent = ''; activeMultiIdx = null }">按技术栈</NRadio>
              </NSpace>
            </NRadioGroup>
          </NFormItem>

          <!-- single 模式 -->
          <template v-if="agentForm.promptMode === 'single'">
            <NFormItem label="指令文件路径">
              <NSpace :wrap="false">
                <NInput v-model:value="agentForm.prompt" placeholder="SDDInAction/2.spec/spec-prompt.md" style="flex:1;" />
                <NButton size="small" @click="openFilePicker('single')">浏览</NButton>
              </NSpace>
            </NFormItem>
          </template>

          <!-- multi 模式 -->
          <template v-else>
            <NFormItem label="技术栈 → 指令文件">
              <div style="display:flex;flex-direction:column;gap:6px;width:100%;">
                <div v-for="(entry, idx) in multiPromptEntries" :key="idx" style="display:flex;gap:4px;align-items:center;">
                  <NInput v-model:value="entry.key" placeholder="ts" style="width:60px;flex-shrink:0;" />
                  <span style="color:#aaa;font-size:12px;">→</span>
                  <NInput v-model:value="entry.value" placeholder="文件路径" style="flex:1;" />
                  <NButton size="tiny" @click="openFilePicker(idx)">浏览</NButton>
                  <NButton size="tiny"
                    :type="activeMultiIdx === idx ? 'primary' : 'default'"
                    @click="selectMultiEntry(idx)">✎</NButton>
                  <NButton size="tiny" type="error" ghost @click="removeMultiEntry(idx)">✕</NButton>
                </div>
                <NButton text style="font-size:12px;" @click="addMultiEntry">+ 添加技术栈</NButton>
              </div>
            </NFormItem>
          </template>
        </NForm>

        <div style="margin-top:auto;padding-top:12px;">
          <NSpace justify="end">
            <NButton @click="agentModal = false">取消</NButton>
            <NButton type="primary"
              :disabled="!agentForm.id.trim() || !agentForm.name.trim()"
              @click="saveAgent">保存 Agent</NButton>
          </NSpace>
        </div>
      </div>

      <!-- 右：指令内容编辑器 -->
      <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;background:#1e1e2e;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid #2d2d3f;background:#1a1a2e;flex-shrink:0;">
          <NText style="color:#94a3b8;font-size:13px;">
            指令内容
            <span v-if="agentForm.promptMode === 'multi' && activeMultiIdx !== null" style="color:#818cf8;margin-left:4px;">
              [{{ multiPromptEntries[activeMultiIdx!]?.key || '未命名' }}]
            </span>
          </NText>
          <NButton size="small" type="primary"
            :loading="inlinePromptSaving"
            :disabled="!inlinePromptContent"
            @click="saveInlinePrompt">保存文件</NButton>
        </div>
        <div style="flex:1;overflow:hidden;">
          <div v-if="agentForm.promptMode === 'multi' && activeMultiIdx === null"
            style="height:100%;display:flex;align-items:center;justify-content:center;color:#555;font-size:14px;">
            ← 点击左侧 ✎ 按钮编辑对应技术栈的指令文件
          </div>
          <MarkdownEditor v-else v-model="inlinePromptContent" style="height:100%;border-radius:0;border:none;" />
        </div>
      </div>
    </div>
  </NModal>

  <!-- ─── 文件浏览器弹窗 ─── -->
  <NModal v-model:show="filePickerOpen" preset="card" title="选择提示词文件" style="width: 580px;">
    <NInput v-model:value="filePickerFilter" placeholder="输入关键字过滤..." style="margin-bottom:10px;" />
    <div style="border:1px solid #efeff5;border-radius:6px;max-height:320px;overflow-y:auto;">
      <NEmpty v-if="filteredFiles.length === 0" description="无匹配文件" style="padding:24px 0;" />
      <div v-for="f in filteredFiles" :key="f"
        style="padding:8px 12px;cursor:pointer;font-size:12px;font-family:monospace;color:#374151;border-bottom:1px solid #f5f5f5;"
        @click="selectFile(f)"
        @mouseover="($event.target as HTMLElement).style.background='#f0f0ff'"
        @mouseleave="($event.target as HTMLElement).style.background='transparent'"
      >{{ f }}</div>
    </div>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="filePickerOpen = false">取消</NButton>
      </NSpace>
    </template>
  </NModal>
</template>
