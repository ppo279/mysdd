import Fastify from 'fastify'
import cors from '@fastify/cors'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { initDb } from './db/index.js'
import { workspaceRoutes } from './routes/workspaces.js'
import { featureRoutes } from './routes/features.js'
import { stageRoutes } from './routes/stages.js'
import { configRoutes } from './routes/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 确保数据目录存在
const dataDir = path.resolve(__dirname, '../../data')
const storageDir = path.resolve(__dirname, '../../storage')
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(storageDir, { recursive: true })

initDb()

const app = Fastify({ logger: { level: 'info' } })

await app.register(cors, { origin: true })

// 禁用 content-type 校验（兼容 SSE 路由）
app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
  try {
    done(null, JSON.parse(body as string))
  } catch {
    done(null, body)
  }
})

await workspaceRoutes(app)
await featureRoutes(app)
await stageRoutes(app)
await configRoutes(app)

// 健康检查
app.get('/health', async () => ({ ok: true }))

const PORT = Number(process.env.PORT ?? 3001)
await app.listen({ port: PORT, host: '0.0.0.0' })
console.log(`Backend running on http://localhost:${PORT}`)
