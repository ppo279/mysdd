import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { detectRuntimes } from '../services/detect.js'
import { ok } from '../lib/envelope.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const YAML_PATH = path.join(ROOT, 'agents.yaml')

// ─── Schema ──────────────────────────────────────────────────
const RuntimeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  command: z.string().default(''),
})

const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: z.string().min(1),
  instruction: z.string().default(''),
  output_file: z.string().default(''),
  outputs: z.array(z.string()).optional(),
  inputs: z.array(z.string()).optional(),
  // Implements: tasks.md#T028 / plan.md#D-03
  memory_sediment: z.boolean().optional(),
})

const BaseLayerSchema = z.object({
  name: z.string().default(''),
  content: z.string().default(''),
})

const GlobalSchema = z.object({
  base_layers: z.array(BaseLayerSchema).default([]),
})

const AgentsYamlSchema = z.object({
  runtimes: z.array(RuntimeSchema),
  global: GlobalSchema.default({ base_layers: [] }),
  agents: z.array(AgentSchema),
})

function readYaml() {
  const raw = fs.readFileSync(YAML_PATH, 'utf-8')
  return yaml.load(raw) as Record<string, unknown>
}

function writeYaml(data: unknown) {
  const content = yaml.dump(data, { indent: 2, lineWidth: -1 })
  fs.writeFileSync(YAML_PATH, content, 'utf-8')
}

export async function configRoutes(app: FastifyInstance) {
  // 读取完整配置（含提示词路径）
  // Implements: M0 统一响应外壳；GET 也需包 ok() 才能与前端 request<T> envelope 解析器对齐
  app.get('/api/config/agents', async (_req, reply) => {
    return ok(reply, readYaml())
  })

  // 保存完整配置（覆盖写 agents.yaml）
  // zod parse 失败由 registerErrorHandler 转 envelope 1001
  app.put('/api/config/agents', async (req, reply) => {
    const body = AgentsYamlSchema.parse(req.body)
    writeYaml(body)
    // 清除模块缓存，让下次 loadAgentsConfig 重新读文件
    const { clearCache } = await import('../config/agents.js')
    clearCache()
    const { clearRuntimeCache } = await import('../runtime/registry.js')
    clearRuntimeCache()
    // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
    // YAML 变更后跑一次 agent-sweep：扫所有 workflow，把引用了已删 agent 的
    // workflow 归档（is_archived=1），并把对应 feature_node_states 标 rejected。
    // 失败不回滚（best-effort；下次 YAML 保存或重启再跑一次即可）。
    try {
      const { runAgentSweep } = await import('../services/workflow-bootstrap.js')
      const result = await runAgentSweep()
      if (result.archivedWorkflows > 0 || result.rejectedNodeStates > 0) {
        req.log.info(
          { ...result },
          'agent-sweep archived workflows after agents.yaml change',
        )
      }
    } catch (e: any) {
      req.log.warn({ err: e?.message }, 'agent-sweep failed (non-fatal)')
    }
    return ok(reply, null)
  })

  // 检测本机可用的 AI CLI 运行时
  // Implements: M0 统一响应外壳；裸数组会让前端 request<T> 抛 ApiError
  app.get('/api/config/detect-runtimes', async (_req, reply) => {
    return ok(reply, await detectRuntimes())
  })
}
