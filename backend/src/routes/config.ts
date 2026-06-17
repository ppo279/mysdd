import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { fileURLToPath } from 'url'
import { z } from 'zod'
import { detectRuntimes } from '../services/detect.js'

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
  output_file: z.string().min(1),
  upstream: z.array(z.string()).default([]),
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
  app.get('/api/config/agents', async () => {
    return readYaml()
  })

  // 保存完整配置（覆盖写 agents.yaml）
  app.put('/api/config/agents', async (req, reply) => {
    const body = AgentsYamlSchema.parse(req.body)
    writeYaml(body)
    // 清除模块缓存，让下次 loadAgentsConfig 重新读文件
    const { clearCache } = await import('../config/agents.js')
    clearCache()
    const { clearRuntimeCache } = await import('../runtime/registry.js')
    clearRuntimeCache()
    return { ok: true }
  })

  // 检测本机可用的 AI CLI 运行时
  app.get('/api/config/detect-runtimes', async () => {
    return detectRuntimes()
  })
}
