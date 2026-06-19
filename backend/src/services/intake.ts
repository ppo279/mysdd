// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 01)
// 虚拟 __intake__ 节点：创建 feature 时若其 workflow 声明了 inputs_json，
// 落一个合成 stage_run（status=approved，无 agent 进程），把 input 内容写进
// stage_run_outputs + 磁盘 side output。运行时 collectUpstreamArtifacts 按
// workflow_edges 找到来自 __intake__ 的边并消费这些 side outputs。
import { eq } from 'drizzle-orm'
import { randomUUID } from 'crypto'
import { db } from '../db/index.js'
import { stageRuns, stageRunOutputs, workflows, features } from '../db/schema.js'
import { ArtifactService } from './artifact.js'
import fs from 'fs'
import path from 'path'
import { BizError, Code } from '../lib/envelope.js'
import { AgentService } from './agent.js'
import type { WorkflowYamlInput as WorkflowInput } from './workflow-yaml.js'

export interface CreateSyntheticIntakeResult {
  stageRunId: string
  outputs: Record<string, string>
}

/** 从 workflow.inputs_json 解析出输入声明列表；解析失败按 [] 处理（不抛）。 */
export function parseWorkflowInputs(inputsJson: string | null | undefined): WorkflowInput[] {
  if (!inputsJson) return []
  try {
    const parsed = JSON.parse(inputsJson)
    if (!Array.isArray(parsed)) return []
    return parsed as WorkflowInput[]
  } catch {
    return []
  }
}

/** 取 input 在磁盘上的扩展名：input.extension 优先；type='string' 不写扩展名；其它缺省 .md。 */
function extensionForInput(input: WorkflowInput): string {
  if (input.extension !== undefined) return input.extension
  if (input.type === 'string') return ''
  return '.md'
}

/**
 * 为 feature 创建合成 __intake__ stage_run。
 * Returns null when the workflow declares no inputs.
 */
export async function createSyntheticIntakeRun(
  featureId: string,
  workspaceId: string,
  providedInputs: Record<string, string>,
): Promise<CreateSyntheticIntakeResult | null> {
  const [feature] = await db.select().from(features).where(eq(features.id, featureId))
  if (!feature) throw new BizError(Code.FEATURE_NOT_FOUND, `Feature ${featureId} not found`, 404)
  if (!feature.currentWorkflowId) return null

  const [wf] = await db.select().from(workflows).where(eq(workflows.id, feature.currentWorkflowId))
  if (!wf) return null
  const inputs = parseWorkflowInputs(wf.inputsJson)
  if (inputs.length === 0) return null

  // Pre-validation：required input 缺失时 fail-fast，400 MISSING_CONFIRM。
  // 路由层 routes/features.ts 也做同样校验（feature 行插入前）——这里保留为运行时防线。
  const missing = inputs.filter((i) => i.required && !(i.name in providedInputs))
  if (missing.length > 0) {
    throw new BizError(
      Code.MISSING_CONFIRM,
      `Workflow requires inputs: ${missing.map((m) => m.name).join(', ')}`,
      400,
    )
  }

  const INTAKE_NODE_ID = '__intake__'  // mirrors RESERVED_NODE_IDS[0] in workflow.ts
  const now = new Date()
  const stageRunId = randomUUID()
  await db.insert(stageRuns).values({
    id: stageRunId,
    featureId,
    stage: INTAKE_NODE_ID,
    nodeId: INTAKE_NODE_ID,
    runtimeId: 'synthetic',
    cliSessionId: null,
    status: 'approved',
    artifactContent: '',
    artifactPath: '',
    createdAt: now,
    approvedAt: now,
  })

  const outputs: Record<string, string> = {}
  for (const input of inputs) {
    const content = providedInputs[input.name] ?? ''
    const ext = extensionForInput(input)
    // outputName 不带扩展名——下游工作流边以 input.name 作为 fromOutput 查找（保持契约简单）。
    const outputName = input.name
    outputs[outputName] = content

    const filePath = ArtifactService.getArtifactPath(workspaceId, featureId, INTAKE_NODE_ID, input.name + ext)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')

    await db.insert(stageRunOutputs).values({
      id: randomUUID(),
      stageRunId,
      outputName,
      content,
      approvedAt: now,
    })

    await AgentService.upsertNodeState(featureId, INTAKE_NODE_ID, 'approved', stageRunId)
  }

  return { stageRunId, outputs }
}

export const INTAKE = { NODE_ID: '__intake__' } as const