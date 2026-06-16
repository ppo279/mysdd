<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { api, type AgentsYamlRaw, type RuntimeRaw, type AgentRaw, type DetectedRuntime } from '@/api'

const router = useRouter()

// ─── 数据 ──────────────────────────────────────────────
const config = ref<AgentsYamlRaw>({ runtimes: [], agents: [] })
const promptFiles = ref<string[]>([])
const saving = ref(false)
const saveMsg = ref('')
const activeTab = ref<'runtimes' | 'agents'>('agents')

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
    // 覆盖更新
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
// 多技术栈配置的中间状态
const multiPromptEntries = ref<{ key: string; value: string }[]>([])

// ─── Prompt 编辑器 ─────────────────────────────────────
const promptEditor = ref(false)
const promptEditorFile = ref('')
const promptEditorContent = ref('')
const promptEditorSaving = ref(false)
// 当前正在编辑哪个 agent 的哪个 tech_stack key（multi 模式）
const promptEditorContext = ref<{ agentIdx: number; techKey?: string } | null>(null)

// ─── 计算属性 ──────────────────────────────────────────
const runtimeIds = computed(() => config.value.runtimes.map((r) => r.id))
const agentIds = computed(() => config.value.agents.map((a) => a.id))

onMounted(async () => {
  const [cfg, files] = await Promise.all([api.config.agents(), api.config.promptFiles()])
  config.value = {
    runtimes: (cfg.runtimes ?? []).map((r) => ({ id: r.id, type: r.type, command: (r as any).command ?? '' })),
    agents: cfg.agents ?? [],
  }
  promptFiles.value = files
})

// ─── 保存整体配置 ──────────────────────────────────────
async function saveConfig() {
  saving.value = true
  saveMsg.value = ''
  try {
    await api.config.saveAgents(config.value)
    saveMsg.value = '✓ 已保存'
    setTimeout(() => (saveMsg.value = ''), 2000)
  } catch (e: any) {
    saveMsg.value = '✗ ' + e.message
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
  agentModal.value = true
}

function openEditAgent(agent: AgentRaw) {
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
  agentModal.value = true
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

// ─── Prompt 编辑器 ─────────────────────────────────────
async function openPromptEditor(filePath: string, context?: { agentIdx: number; techKey?: string }) {
  if (!filePath.trim()) { alert('请先填写文件路径'); return }
  promptEditorFile.value = filePath
  promptEditorContext.value = context ?? null
  try {
    const result = await api.config.getPrompt(filePath)
    promptEditorContent.value = result.content
  } catch {
    promptEditorContent.value = ''
  }
  promptEditor.value = true
}

async function savePromptEditor() {
  promptEditorSaving.value = true
  try {
    await api.config.savePrompt(promptEditorFile.value, promptEditorContent.value)
    promptEditor.value = false
  } catch (e: any) {
    alert('保存失败: ' + e.message)
  } finally {
    promptEditorSaving.value = false
  }
}

// 从文件列表选择文件（填入输入框）
function selectFile(file: string) {
  // 如果 prompt editor 的文件选择器打开，直接设置
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
</script>

<template>
  <div class="config-view">
    <!-- 顶栏 -->
    <div class="topbar">
      <div class="topbar-left">
        <span class="back-link" @click="router.push('/')">← 返回</span>
        <h1>Agent 配置</h1>
      </div>
      <div class="topbar-right">
        <span v-if="saveMsg" class="save-msg" :class="{ error: saveMsg.startsWith('✗') }">
          {{ saveMsg }}
        </span>
        <button class="btn-primary" :disabled="saving" @click="saveConfig">
          {{ saving ? '保存中...' : '保存配置' }}
        </button>
      </div>
    </div>

    <!-- 标签页 -->
    <div class="tabs">
      <button :class="['tab', activeTab === 'agents' ? 'active' : '']" @click="activeTab = 'agents'">
        Agent 列表
      </button>
      <button :class="['tab', activeTab === 'runtimes' ? 'active' : '']" @click="activeTab = 'runtimes'">
        运行时
      </button>
    </div>

    <!-- ─── Agent 列表 ─────────────────────────────────── -->
    <div v-if="activeTab === 'agents'" class="section">
      <div class="section-header">
        <p class="section-tip">配置 Agent 的名称、运行时与指令文件。流转顺序即为列表顺序。</p>
        <button class="btn-secondary" @click="openAddAgent">+ 新增 Agent</button>
      </div>

      <div class="agent-list">
        <div v-for="(agent, idx) in config.agents" :key="agent.id" class="agent-card">
          <div class="agent-order">{{ idx + 1 }}</div>
          <div class="agent-info">
            <div class="agent-name">{{ agent.name }}</div>
            <div class="agent-meta">
              <span class="tag">{{ agent.id }}</span>
              <span class="tag tag-runtime">{{ agent.runtime }}</span>
              <span class="tag tag-out">→ {{ agent.output_file }}</span>
              <span v-if="agent.upstream?.length" class="tag tag-up">
                依赖: {{ agent.upstream.join(', ') }}
              </span>
            </div>
            <div class="agent-prompt">
              <template v-if="agent.prompt">
                <span class="prompt-path">{{ agent.prompt }}</span>
                <button class="btn-link" @click="openPromptEditor(agent.prompt!)">编辑指令</button>
              </template>
              <template v-else-if="agent.prompts">
                <div v-for="(path, key) in agent.prompts" :key="key" class="prompt-multi-row">
                  <span class="prompt-key">{{ key }}:</span>
                  <span class="prompt-path">{{ path }}</span>
                  <button class="btn-link" @click="openPromptEditor(path)">编辑</button>
                </div>
              </template>
              <span v-else class="no-prompt">未配置指令</span>
            </div>
          </div>
          <div class="agent-actions">
            <button class="btn-icon" @click="openEditAgent(agent)" title="编辑">✎</button>
            <button class="btn-icon danger" @click="deleteAgent(idx)" title="删除">✕</button>
          </div>
        </div>
        <div v-if="config.agents.length === 0" class="empty">还没有 Agent，点击右上角新增</div>
      </div>
    </div>

    <!-- ─── 运行时列表 ──────────────────────────────────── -->
    <div v-if="activeTab === 'runtimes'" class="section">
      <div class="section-header">
        <p class="section-tip">配置 CLI 运行时（claude、codex 等）。Agent 在此选择使用哪个运行时。</p>
        <div class="header-btns">
          <button class="btn-secondary" @click="runDetect">
            {{ detecting ? '检测中...' : '🔍 自动检测' }}
          </button>
          <button class="btn-secondary" @click="openAddRuntime">+ 手动新增</button>
        </div>
      </div>

      <div class="runtime-list">
        <div v-for="(rt, idx) in config.runtimes" :key="rt.id" class="runtime-card">
          <div class="runtime-info">
            <span class="runtime-id">{{ rt.id }}</span>
            <span class="tag">{{ rt.type }}</span>
            <code class="runtime-cmd">{{ rt.command }}</code>
          </div>
          <div class="agent-actions">
            <button class="btn-icon" @click="openEditRuntime(rt)" title="编辑">✎</button>
            <button class="btn-icon danger" @click="deleteRuntime(idx)" title="删除">✕</button>
          </div>
        </div>
        <div v-if="config.runtimes.length === 0" class="empty">
          还没有运行时，点击"自动检测"从本机发现可用工具
        </div>
      </div>
    </div>

    <!-- ─── 自动检测结果弹窗 ──────────────────────────── -->
    <div v-if="detectModal" class="modal-overlay" @click.self="detectModal = false">
      <div class="modal modal-wide">
        <h2>本机运行时检测</h2>

        <div v-if="detecting" class="detect-loading">
          <span class="spinner" />
          正在扫描本机已安装的 AI CLI 工具...
        </div>

        <template v-else>
          <div class="detect-list">
            <div
              v-for="rt in detectedList"
              :key="rt.id"
              class="detect-item"
              :class="{ unavailable: !rt.available }"
            >
              <div class="detect-left">
                <span class="detect-status" :title="rt.available ? '可用' : '未检测到'">
                  {{ rt.available ? '✓' : '✗' }}
                </span>
                <div class="detect-info">
                  <div class="detect-name">
                    <strong>{{ rt.id }}</strong>
                    <span class="tag">{{ rt.type }}</span>
                    <span v-if="rt.source === 'daemon'" class="tag tag-daemon">
                      daemon :{{ rt.daemonPort }}
                      <span v-if="rt.daemonRunning" class="dot-green" title="daemon 运行中" />
                      <span v-else class="dot-gray" title="daemon 未运行" />
                    </span>
                  </div>
                  <div class="detect-sub">
                    <code>{{ rt.command }}</code>
                    <span v-if="rt.version" class="detect-version">{{ rt.version }}</span>
                    <span v-else-if="!rt.available" class="detect-miss">未在 PATH 中找到</span>
                  </div>
                </div>
              </div>
              <button
                v-if="rt.available"
                class="btn-secondary btn-sm"
                :class="{ 'already-added': config.runtimes.some(r => r.id === rt.id) }"
                @click="addDetected(rt)"
              >
                {{ config.runtimes.some(r => r.id === rt.id) ? '已添加（更新）' : '+ 添加' }}
              </button>
            </div>
          </div>

          <div v-if="detectedList.filter(r => r.available).length === 0" class="empty">
            未检测到可用的 AI CLI 工具
          </div>

          <div class="modal-actions">
            <button class="btn-secondary" @click="detectModal = false">关闭</button>
            <button
              v-if="detectedList.some(r => r.available)"
              class="btn-primary"
              @click="addAllDetected"
            >
              全部添加（{{ detectedList.filter(r => r.available).length }} 个）
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- ─── 运行时编辑弹窗 ─────────────────────────────── -->
    <div v-if="runtimeModal" class="modal-overlay" @click.self="runtimeModal = false">
      <div class="modal">
        <h2>{{ editingRuntime ? '编辑运行时' : '新增运行时' }}</h2>

        <label>ID *</label>
        <input v-model="runtimeForm.id" placeholder="如 claude、codex" :disabled="!!editingRuntime" />

        <label>类型</label>
        <input v-model="runtimeForm.type" placeholder="如 claude-cli、openai-cli" />

        <label>CLI 命令</label>
        <input v-model="runtimeForm.command" placeholder="如 claude" />

        <div class="modal-actions">
          <button class="btn-secondary" @click="runtimeModal = false">取消</button>
          <button class="btn-primary" :disabled="!runtimeForm.id.trim()" @click="saveRuntime">
            保存
          </button>
        </div>
      </div>
    </div>

    <!-- ─── Agent 编辑弹窗 ────────────────────────────── -->
    <div v-if="agentModal" class="modal-overlay" @click.self="agentModal = false">
      <div class="modal modal-wide">
        <h2>{{ editingAgent ? '编辑 Agent' : '新增 Agent' }}</h2>

        <div class="form-row">
          <div class="form-col">
            <label>ID *</label>
            <input v-model="agentForm.id" placeholder="如 spec、plan" :disabled="!!editingAgent" />
          </div>
          <div class="form-col">
            <label>名称 *</label>
            <input v-model="agentForm.name" placeholder="如 Spec Agent" />
          </div>
        </div>

        <div class="form-row">
          <div class="form-col">
            <label>运行时</label>
            <select v-model="agentForm.runtime">
              <option v-for="rt in runtimeIds" :key="rt" :value="rt">{{ rt }}</option>
            </select>
          </div>
          <div class="form-col">
            <label>输出文件</label>
            <input v-model="agentForm.output_file" placeholder="如 spec.md" />
          </div>
        </div>

        <label>上游依赖（依赖的 Agent 产物会注入系统提示）</label>
        <div class="upstream-checks">
          <label
            v-for="aid in agentIds.filter(id => id !== agentForm.id)"
            :key="aid"
            class="check-label"
          >
            <input
              type="checkbox"
              :checked="agentForm.upstream.includes(aid)"
              @change="toggleUpstream(aid)"
            />
            {{ aid }}
          </label>
          <span v-if="agentIds.filter(id => id !== agentForm.id).length === 0" class="muted">
            无其他 Agent 可选
          </span>
        </div>

        <!-- 指令配置 -->
        <label>指令模式</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" v-model="agentForm.promptMode" value="single" />
            单一指令文件（不区分技术栈）
          </label>
          <label class="radio-label">
            <input type="radio" v-model="agentForm.promptMode" value="multi" />
            按技术栈配置（ts / java / python 等）
          </label>
        </div>

        <!-- 单一模式 -->
        <template v-if="agentForm.promptMode === 'single'">
          <label>指令文件路径（相对项目根）</label>
          <div class="file-input-row">
            <input v-model="agentForm.prompt" placeholder="如 SDDInAction/2.spec/spec-prompt.md" />
            <button class="btn-secondary btn-sm" @click="openFilePicker('single')">浏览</button>
            <button
              class="btn-secondary btn-sm"
              :disabled="!agentForm.prompt?.trim()"
              @click="openPromptEditor(agentForm.prompt!)"
            >
              编辑内容
            </button>
          </div>
        </template>

        <!-- 多技术栈模式 -->
        <template v-else>
          <label>技术栈 → 指令文件路径</label>
          <div
            v-for="(entry, idx) in multiPromptEntries"
            :key="idx"
            class="multi-entry-row"
          >
            <input v-model="entry.key" placeholder="技术栈（如 ts、java）" class="key-input" />
            <span>→</span>
            <input v-model="entry.value" placeholder="文件路径" class="flex-1" />
            <button class="btn-secondary btn-sm" @click="openFilePicker(idx)">浏览</button>
            <button
              class="btn-secondary btn-sm"
              :disabled="!entry.value.trim()"
              @click="openPromptEditor(entry.value)"
            >
              编辑
            </button>
            <button class="btn-icon danger" @click="removeMultiEntry(idx)">✕</button>
          </div>
          <button class="btn-link" @click="addMultiEntry">+ 添加技术栈</button>
        </template>

        <div class="modal-actions">
          <button class="btn-secondary" @click="agentModal = false">取消</button>
          <button
            class="btn-primary"
            :disabled="!agentForm.id.trim() || !agentForm.name.trim()"
            @click="saveAgent"
          >
            保存
          </button>
        </div>
      </div>
    </div>

    <!-- ─── 文件浏览器弹窗 ─────────────────────────────── -->
    <div v-if="filePickerOpen" class="modal-overlay" @click.self="filePickerOpen = false">
      <div class="modal modal-wide">
        <h2>选择提示词文件</h2>
        <input
          v-model="filePickerFilter"
          class="filter-input"
          placeholder="输入关键字过滤..."
          autofocus
        />
        <div class="file-list">
          <div
            v-for="f in filteredFiles"
            :key="f"
            class="file-item"
            @click="selectFile(f)"
          >
            {{ f }}
          </div>
          <div v-if="filteredFiles.length === 0" class="empty">无匹配文件</div>
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" @click="filePickerOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- ─── MD 指令编辑器弹窗 ──────────────────────────── -->
    <div v-if="promptEditor" class="modal-overlay" @click.self="promptEditor = false">
      <div class="modal modal-full">
        <div class="prompt-editor-header">
          <div>
            <h2>编辑指令文件</h2>
            <code class="prompt-file-path">{{ promptEditorFile }}</code>
          </div>
          <div class="prompt-editor-actions">
            <button class="btn-secondary" @click="promptEditor = false">取消</button>
            <button class="btn-primary" :disabled="promptEditorSaving" @click="savePromptEditor">
              {{ promptEditorSaving ? '保存中...' : '保存文件' }}
            </button>
          </div>
        </div>
        <textarea
          v-model="promptEditorContent"
          class="prompt-textarea"
          placeholder="输入 Markdown 格式的 Agent 指令..."
          spellcheck="false"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.config-view { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }

/* 顶栏 */
.topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 14px 24px; border-bottom: 1px solid #e2e8f0;
  background: #fff; flex-shrink: 0;
}
.topbar-left { display: flex; align-items: center; gap: 16px; }
.topbar h1 { font-size: 1.1rem; font-weight: 700; color: #1a1a2e; }
.back-link { color: #6366f1; cursor: pointer; font-size: 0.9rem; }
.back-link:hover { text-decoration: underline; }
.topbar-right { display: flex; align-items: center; gap: 10px; }
.save-msg { font-size: 0.85rem; color: #16a34a; }
.save-msg.error { color: #dc2626; }

/* 标签页 */
.tabs {
  display: flex; gap: 0; border-bottom: 1px solid #e2e8f0;
  background: #f8fafc; flex-shrink: 0; padding: 0 24px;
}
.tab {
  padding: 10px 20px; border: none; background: none; cursor: pointer;
  font-size: 0.9rem; color: #64748b; border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab.active { color: #6366f1; border-bottom-color: #6366f1; font-weight: 600; }

/* 区域 */
.section { flex: 1; overflow-y: auto; padding: 20px 24px; }
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.header-btns { display: flex; gap: 8px; }
.section-tip { font-size: 0.85rem; color: #64748b; }
.empty { text-align: center; color: #94a3b8; padding: 40px 0; font-size: 0.9rem; }

/* Agent 卡片 */
.agent-list { display: flex; flex-direction: column; gap: 8px; }
.agent-card {
  border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px;
  display: flex; align-items: flex-start; gap: 12px; background: #fff;
}
.agent-order {
  width: 28px; height: 28px; border-radius: 50%; background: #ede9fe; color: #6d28d9;
  display: flex; align-items: center; justify-content: center; font-size: 0.85rem;
  font-weight: 700; flex-shrink: 0; margin-top: 2px;
}
.agent-info { flex: 1; min-width: 0; }
.agent-name { font-weight: 600; font-size: 0.95rem; margin-bottom: 6px; }
.agent-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.tag {
  background: #f1f5f9; color: #475569; padding: 2px 8px;
  border-radius: 4px; font-size: 0.75rem;
}
.tag-runtime { background: #ede9fe; color: #6d28d9; }
.tag-out { background: #dcfce7; color: #15803d; }
.tag-up { background: #fef3c7; color: #92400e; }
.agent-prompt { font-size: 0.8rem; color: #64748b; }
.prompt-path { color: #475569; font-family: monospace; }
.prompt-multi-row { display: flex; gap: 8px; align-items: center; margin-bottom: 2px; }
.prompt-key { color: #6366f1; font-weight: 600; font-family: monospace; }
.no-prompt { color: #94a3b8; font-style: italic; }
.agent-actions { display: flex; gap: 6px; flex-shrink: 0; }

/* 运行时卡片 */
.runtime-list { display: flex; flex-direction: column; gap: 8px; }
.runtime-card {
  border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px 16px;
  display: flex; justify-content: space-between; align-items: center; background: #fff;
}
.runtime-info { display: flex; align-items: center; gap: 10px; }
.runtime-id { font-weight: 700; font-size: 0.95rem; }
.runtime-cmd { background: #f1f5f9; padding: 2px 8px; border-radius: 4px; font-size: 0.82rem; color: #0f172a; }

/* 按钮 */
.btn-primary {
  background: #6366f1; color: #fff; border: none; padding: 8px 16px;
  border-radius: 6px; cursor: pointer; font-size: 0.9rem;
}
.btn-primary:hover { background: #4f46e5; }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary {
  background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0;
  padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 0.9rem;
}
.btn-secondary:hover { background: #e2e8f0; }
.btn-sm { padding: 5px 10px; font-size: 0.8rem; }
.btn-icon {
  background: none; border: 1px solid #e2e8f0; padding: 4px 8px;
  border-radius: 4px; cursor: pointer; color: #64748b; font-size: 0.85rem;
}
.btn-icon:hover { background: #f1f5f9; }
.btn-icon.danger { color: #dc2626; }
.btn-icon.danger:hover { background: #fef2f2; border-color: #fecaca; }
.btn-link { background: none; border: none; color: #6366f1; cursor: pointer; font-size: 0.82rem; padding: 0; }
.btn-link:hover { text-decoration: underline; }

/* 弹窗 */
.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center; z-index: 200;
}
.modal {
  background: #fff; border-radius: 12px; padding: 24px; width: 460px;
  max-height: 85vh; overflow-y: auto;
  display: flex; flex-direction: column; gap: 10px;
}
.modal-wide { width: 620px; }
.modal-full { width: 80vw; max-width: 960px; height: 80vh; max-height: 80vh; }
.modal h2 { font-size: 1rem; font-weight: 700; margin-bottom: 4px; }
.modal label { font-size: 0.82rem; color: #64748b; }
.modal input, .modal select, .modal textarea {
  border: 1px solid #e2e8f0; border-radius: 6px; padding: 7px 10px;
  font-size: 0.88rem; width: 100%; box-sizing: border-box; outline: none;
}
.modal input:focus, .modal select:focus { border-color: #6366f1; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }

/* 表单布局 */
.form-row { display: flex; gap: 12px; }
.form-col { flex: 1; display: flex; flex-direction: column; gap: 4px; }

/* 上游依赖 */
.upstream-checks { display: flex; flex-wrap: wrap; gap: 8px; }
.check-label { display: flex; align-items: center; gap: 4px; font-size: 0.85rem; cursor: pointer; }
.muted { font-size: 0.82rem; color: #94a3b8; }

/* 指令模式 */
.radio-group { display: flex; flex-direction: column; gap: 6px; }
.radio-label { display: flex; align-items: center; gap: 6px; font-size: 0.88rem; cursor: pointer; }

/* 文件选择行 */
.file-input-row { display: flex; gap: 6px; align-items: center; }
.file-input-row input { flex: 1; }

/* 多技术栈行 */
.multi-entry-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.key-input { width: 100px; flex-shrink: 0; }
.flex-1 { flex: 1; }

/* 文件浏览器 */
.filter-input { margin-bottom: 8px; }
.file-list { max-height: 320px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px; }
.file-item {
  padding: 8px 12px; cursor: pointer; font-size: 0.82rem; font-family: monospace;
  border-bottom: 1px solid #f1f5f9; color: #374151;
}
.file-item:last-child { border-bottom: none; }
.file-item:hover { background: #ede9fe; color: #4f46e5; }

/* Prompt 编辑器 */
.prompt-editor-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  margin-bottom: 10px; flex-shrink: 0;
}
.prompt-file-path { font-size: 0.78rem; color: #64748b; display: block; margin-top: 2px; }
.prompt-editor-actions { display: flex; gap: 8px; }
.prompt-textarea {
  flex: 1; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px;
  font-size: 0.875rem; font-family: 'Courier New', Consolas, monospace;
  resize: none; outline: none; line-height: 1.6; color: #1e293b;
  min-height: 0;
}
.prompt-textarea:focus { border-color: #6366f1; }

/* 自动检测弹窗 */
.detect-loading {
  display: flex; align-items: center; gap: 12px; padding: 24px 0;
  color: #64748b; font-size: 0.9rem;
}
.spinner {
  width: 18px; height: 18px; border: 2px solid #e2e8f0;
  border-top-color: #6366f1; border-radius: 50%;
  animation: spin 0.8s linear infinite; flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

.detect-list { display: flex; flex-direction: column; gap: 8px; max-height: 380px; overflow-y: auto; }
.detect-item {
  display: flex; justify-content: space-between; align-items: center;
  padding: 12px 14px; border: 1px solid #e2e8f0; border-radius: 8px; background: #fff;
}
.detect-item.unavailable { opacity: 0.5; background: #fafafa; }
.detect-left { display: flex; align-items: center; gap: 10px; }
.detect-status {
  width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 0.75rem; font-weight: 700; flex-shrink: 0;
  background: #dcfce7; color: #16a34a;
}
.detect-item.unavailable .detect-status { background: #fee2e2; color: #dc2626; }
.detect-info { display: flex; flex-direction: column; gap: 3px; }
.detect-name { display: flex; align-items: center; gap: 6px; font-size: 0.9rem; }
.detect-sub { display: flex; align-items: center; gap: 8px; font-size: 0.8rem; color: #64748b; }
.detect-version { color: #16a34a; font-size: 0.75rem; }
.detect-miss { color: #dc2626; font-size: 0.75rem; }
.tag-daemon { background: #fef3c7; color: #92400e; display: flex; align-items: center; gap: 4px; }
.dot-green { width: 7px; height: 7px; border-radius: 50%; background: #16a34a; }
.dot-gray  { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; }
.already-added { border-color: #86efac; color: #15803d; background: #f0fdf4; }
</style>
