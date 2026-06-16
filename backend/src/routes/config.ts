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
  // single prompt file
  prompt: z.string().optional(),
  // per-tech-stack prompts
  prompts: z.record(z.string()).optional(),
  output_file: z.string().min(1),
  upstream: z.array(z.string()).default([]),
})

const AgentsYamlSchema = z.object({
  runtimes: z.array(RuntimeSchema),
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
    return { ok: true }
  })

  // 读取提示词文件内容（相对于项目根）
  app.get('/api/config/prompt', async (req, reply) => {
    const { file } = req.query as { file?: string }
    if (!file) return reply.code(400).send({ error: 'file query required' })

    const fullPath = path.resolve(ROOT, file)
    // 安全检查：只允许读 ROOT 内的文件
    if (!fullPath.startsWith(ROOT)) return reply.code(403).send({ error: 'Forbidden' })

    if (!fs.existsSync(fullPath)) return reply.code(404).send({ error: 'File not found' })
    return { content: fs.readFileSync(fullPath, 'utf-8'), path: file }
  })

  // 写入提示词文件内容
  app.put('/api/config/prompt', async (req, reply) => {
    const { file, content } = req.body as { file: string; content: string }
    if (!file) return reply.code(400).send({ error: 'file required' })

    const fullPath = path.resolve(ROOT, file)
    if (!fullPath.startsWith(ROOT)) return reply.code(403).send({ error: 'Forbidden' })

    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content, 'utf-8')
    return { ok: true }
  })

  // 列出 SDDInAction 下的 md 文件（给文件选择器用）
  app.get('/api/config/prompt-files', async () => {
    const sddDir = path.join(ROOT, 'SDDInAction')
    const files: string[] = []

    function walk(dir: string) {
      if (!fs.existsSync(dir)) return
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(fullPath)
        } else if (entry.name.endsWith('.md')) {
          files.push(path.relative(ROOT, fullPath))
        }
      }
    }

    walk(sddDir)
    return files
  })

  // 检测本机可用的 AI CLI 运行时
  app.get('/api/config/detect-runtimes', async () => {
    return detectRuntimes()
  })
}
