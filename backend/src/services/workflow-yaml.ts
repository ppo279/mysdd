// Implements: docs/prd/0001-bug-fix-workflow.md
// 工作流 YAML loader：把 workflows/seed/*.yaml 解析成可种子到 DB 的 plain rows。
// 不直接写 DB；调用方负责把返回的 DTO 落到 workflows / workflow_nodes / workflow_edges 表。
//
// 用途：
// - 启动期/创建工作区时种子 bug-fix workflow
// - 后续可能的"从 YAML 导入"功能复用
import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'
import { z } from 'zod'
import { fileURLToPath } from 'url'
import { BizError, Code } from '../lib/envelope.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const WORKFLOWS_SEED_DIR = path.resolve(__dirname, '../../../workflows/seed')

export const WorkflowInputSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1).default('file'),
  description: z.string().default(''),
  required: z.boolean().default(true),
  // Implements: docs/prd/0001-bug-fix-workflow.md (AC#5)
  // 写到磁盘的扩展名；缺省 `.md`（type='file' 的缺省约定）。
  // type='string' 时不需要扩展名，但仍写盘以便 __intake__ 的产出被 `ls` 一眼看到。
  extension: z.string().optional(),
})

export const WorkflowRejectionEdgeSchema = z.object({
  from: z.string().min(1),
  trigger: z.string().min(1),
  to: z.string().min(1),
  action: z.string().default(''),
  consumesRepairBudget: z.boolean().default(true),
})

export const WorkflowYamlNodeSchema = z.object({
  nodeId: z.string().min(1),
  agentId: z.string().min(1),
  description: z.string().default(''),
  repair_budget: z.number().int().nonnegative().default(0),
})

export const WorkflowYamlEdgeSchema = z.object({
  from: z.string().min(1),
  fromOutput: z.string().min(1).default('default'),
  to: z.string().min(1),
  toInput: z.string().min(1).default('default'),
})

export const WorkflowYamlSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  description: z.string().default(''),
  inputs: z.array(WorkflowInputSchema).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  nodes: z.array(WorkflowYamlNodeSchema).default([]),
  edges: z.array(WorkflowYamlEdgeSchema).default([]),
  rejection_edges: z.array(WorkflowRejectionEdgeSchema).default([]),
  outputs: z.array(z.object({ name: z.string(), type: z.string(), description: z.string().default(''), source: z.string().default('') })).default([]),
})

export type WorkflowYaml = z.infer<typeof WorkflowYamlSchema>
export type WorkflowYamlInput = z.infer<typeof WorkflowInputSchema>
export type WorkflowYamlRejectionEdge = z.infer<typeof WorkflowRejectionEdgeSchema>

export interface LoadedWorkflow {
  yaml: WorkflowYaml
  rawPath: string
}

/**
 * 读取并解析单个 workflow YAML。
 * 文件不存在抛 FILE_NOT_FOUND；YAML 格式错误抛 YAML_INVALID；zod 校验失败抛 WORKFLOW_INVALID。
 */
export function loadWorkflowYaml(filename: string): LoadedWorkflow {
  const filePath = path.join(WORKFLOWS_SEED_DIR, filename)
  if (!fs.existsSync(filePath)) {
    throw new BizError(
      Code.WORKFLOW_NOT_FOUND,
      `Workflow seed file not found: ${filename}`,
      404,
    )
  }
  const raw = fs.readFileSync(filePath, 'utf-8')
  let parsed: unknown
  try {
    parsed = yaml.load(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new BizError(Code.YAML_INVALID, `Failed to parse ${filename}: ${msg}`, 500)
  }
  const result = WorkflowYamlSchema.safeParse(parsed)
  if (!result.success) {
    throw new BizError(
      Code.WORKFLOW_INVALID,
      `Invalid workflow YAML in ${filename}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      400,
    )
  }
  return { yaml: result.data, rawPath: filePath }
}