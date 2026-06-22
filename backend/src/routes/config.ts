// Implements: .scratch/agent-contract-db/issues/02-yaml-to-db.md
// GET /api/config/agents → 读 DB 拼出 yaml 形状返回（ConfigView 无感）
// PUT /api/config/agents → 三张表事务写（DELETE 全表再 INSERT）；FK 不满足时整体回滚
//
// 关键设计：
// - 写路径：DELETE FROM agents → DELETE FROM base_layers → DELETE FROM runtimes
//   → INSERT runtimes → INSERT base_layers → INSERT agents
//   顺序保证 agents.runtime_id 的 FK 在 INSERT 阶段全部满足；
//   任意一步失败 → 整个 transaction 回滚到 PUT 调用前的状态。
// - 读路径：从 DB 三张表拼出 yaml 形状；空 DB 返回空对象（前端可显示「未配置」）。
// - 缓存：clearCache() 同时清掉 config/agents.ts 与 runtime/registry.ts 的 in-memory 缓存。
// - 保留 yaml 字段 output_file / outputs / inputs / config（兼容 PUT 既有形状）：
//   output_file 当前不存（DB 无对应列），PUT 写入时被忽略；outputs/inputs 落到 agents.outputs_json/inputs_json；
//   config（per-agent runtime config）落到 agents.config_json。

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { detectRuntimes } from '../services/detect.js'
import { ok } from '../lib/envelope.js'

// ─── Schema（与 PUT 既有形状一致）─────────────────────────────
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

export async function configRoutes(app: FastifyInstance) {
  // 读取完整配置（含提示词路径）
  // Implements: M0 统一响应外壳；GET 也需包 ok() 才能与前端 request<T> envelope 解析器对齐
  app.get('/api/config/agents', async (_req, reply) => {
    // 读 DB 拼 yaml 形状——与原 yaml 文件形状一致，前端 ConfigView 无感
    const { loadAgentsFromDb } = await import('../services/agent-seed.js')
    const data = loadAgentsFromDb()
    // 去掉 output_file（DB 不存；保留以兼容既有 ConfigView shape）。
    // 注意：这里返回的形状与 PUT 入参一致；ConfigView 用 PUT 后 GET 对比即可。
    const out = {
      runtimes: data.runtimes.map((r) => ({ id: r.id, type: r.type, command: r.command })),
      global: data.global,
      agents: data.agents.map((a) => ({
        id: a.id,
        name: a.name,
        runtime: a.runtime,
        instruction: a.instruction,
        output_file: a.output_file,
        outputs: a.outputs,
        inputs: a.inputs,
        memory_sediment: a.memory_sediment,
        config: a.config,
      })),
    }
    return ok(reply, out)
  })

  // 保存完整配置（写 DB 三张表，事务包住）
  // zod parse 失败由 registerErrorHandler 转 envelope 1001
  app.put('/api/config/agents', async (req, reply) => {
    const body = AgentsYamlSchema.parse(req.body)
    const { db } = await import('../db/index.js')
    const { runtimes, baseLayers, agents } = await import('../db/schema.js')

    const now = new Date()

    // 事务：DELETE 全表再 INSERT。DELETE 顺序 agents 先（FK 引用 runtimes）；
    // INSERT 顺序 runtimes 先（FK 满足）。
    db.transaction((tx) => {
      tx.delete(agents).run()
      tx.delete(baseLayers).run()
      tx.delete(runtimes).run()

      for (const r of body.runtimes) {
        tx.insert(runtimes).values({
          id: r.id,
          type: r.type,
          command: r.command,
        }).run()
      }

      let pos = 0
      for (const b of body.global.base_layers) {
        tx.insert(baseLayers).values({
          id: randomUUID(),
          name: b.name,
          content: b.content,
          position: pos++,
          createdAt: now,
          updatedAt: now,
        }).run()
      }

      for (const a of body.agents) {
        tx.insert(agents).values({
          id: a.id,
          name: a.name,
          runtimeId: a.runtime,
          instruction: a.instruction,
          inputsJson: JSON.stringify(a.inputs ?? ['default']),
          outputsJson: JSON.stringify(a.outputs ?? ['default']),
          memorySediment: a.memory_sediment ? 1 : 0,
          configJson: JSON.stringify({}), // PUT 既有形状不收 config；空 map 默认
          createdAt: now,
          updatedAt: now,
        }).run()
      }
    })

    // 清除两个模块的缓存：下次 loadAgentsConfig 重新读 DB；下次 buildAdapters 重读 runtimes
    const { clearCache } = await import('../config/agents.js')
    clearCache()
    const { clearRuntimeCache } = await import('../runtime/registry.js')
    clearRuntimeCache()

    // Implements: docs/adr/0001-workflow-execution-model.md (Phase 4)
    // DB 变更后跑一次 agent-sweep：扫所有 workflow，把引用了已删 agent 的
    // workflow 归档（is_archived=1），并把对应 feature_node_states 标 rejected。
    // 失败不回滚（best-effort；下次保存或重启再跑一次即可）。
    try {
      const { runAgentSweep } = await import('../services/workflow-bootstrap.js')
      const result = await runAgentSweep()
      if (result.archivedWorkflows > 0 || result.rejectedNodeStates > 0) {
        req.log.info(
          { ...result },
          'agent-sweep archived workflows after agents table change',
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
