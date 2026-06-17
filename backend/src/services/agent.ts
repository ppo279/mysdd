import { eq, asc } from 'drizzle-orm'
import { db } from '../db/index.js'
import { stageRuns, messages, features, workspaces } from '../db/schema.js'
import { getRuntime } from '../runtime/registry.js'
import { buildSystemPrompt, buildUpstreamContext, getAgentConfig, type FeatureContext } from '../config/agents.js'
import type { StreamChunk } from '../runtime/adapter.js'
import { ArtifactService } from './artifact.js'
import { randomUUID } from 'crypto'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const STORAGE_ROOT = path.resolve(__dirname, '../../../storage')

export class AgentService {
  // 获取某 feature 所有阶段的已批准产物
  static async getApprovedArtifacts(featureId: string): Promise<Record<string, string>> {
    const runs = await db
      .select()
      .from(stageRuns)
      .where(eq(stageRuns.featureId, featureId))

    const result: Record<string, string> = {}
    for (const run of runs) {
      if (run.status === 'approved' && run.artifactContent) {
        result[run.stage] = run.artifactContent
      }
    }
    return result
  }

  // 启动一个新阶段（创建 stageRun，发送第一条消息，返回流）
  static async startStage(
    featureId: string,
    stage: string,
    workspaceId: string,
    techStack: string,
    background: string,
    firstMessage: string,
    runtimeId: string = 'claude',
    localPath?: string,
    featureCtx?: FeatureContext,
  ): Promise<{ stageRunId: string; stream: AsyncIterable<StreamChunk> }> {
    const artifacts = await this.getApprovedArtifacts(featureId)
    const upstreamCtx = buildUpstreamContext(stage, artifacts)
    const systemPrompt = buildSystemPrompt(stage, techStack, background, featureCtx) + upstreamCtx

    const runtime = getRuntime(runtimeId)
    const { sessionId, stream } = await runtime.createSession(systemPrompt, firstMessage, localPath || undefined)

    const stageRunId = randomUUID()
    const now = new Date()

    await db.insert(stageRuns).values({
      id: stageRunId,
      featureId,
      stage,
      runtimeId,
      cliSessionId: sessionId,
      status: 'active',
      artifactContent: '',
      artifactPath: '',
      createdAt: now,
    })

    await db.insert(messages).values({
      id: randomUUID(),
      stageRunId,
      role: 'user',
      content: firstMessage,
      createdAt: now,
    })

    // 包装流：结束时存储 assistant 消息（只持久化 text，thinking/tool 透传不落库）
    const self = this
    async function* wrappedStream(): AsyncIterable<StreamChunk> {
      let fullText = ''
      for await (const chunk of stream) {
        if (chunk.kind === 'text') fullText += chunk.text
        yield chunk
      }
      await db.insert(messages).values({
        id: randomUUID(),
        stageRunId,
        role: 'assistant',
        content: fullText,
        createdAt: new Date(),
      })
    }

    return { stageRunId, stream: wrappedStream() }
  }

  // 续接对话（发送后续消息）
  static async sendMessage(
    stageRunId: string,
    userMessage: string,
  ): Promise<AsyncIterable<StreamChunk>> {
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new Error(`StageRun ${stageRunId} not found`)
    if (!run.cliSessionId) throw new Error(`StageRun ${stageRunId} has no CLI session`)

    // Fetch workspace localPath for the cwd
    const [feature] = await db.select().from(features).where(eq(features.id, run.featureId))
    let localPath: string | undefined
    if (feature) {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, feature.workspaceId))
      localPath = ws?.localPath || undefined
    }

    const runtime = getRuntime(run.runtimeId)
    const stream = runtime.resumeSession(run.cliSessionId, userMessage, localPath)

    const now = new Date()
    await db.insert(messages).values({
      id: randomUUID(),
      stageRunId,
      role: 'user',
      content: userMessage,
      createdAt: now,
    })

    async function* wrappedStream(): AsyncIterable<StreamChunk> {
      let fullText = ''
      for await (const chunk of stream) {
        if (chunk.kind === 'text') fullText += chunk.text
        yield chunk
      }
      await db.insert(messages).values({
        id: randomUUID(),
        stageRunId,
        role: 'assistant',
        content: fullText,
        createdAt: new Date(),
      })
    }

    return wrappedStream()
  }

  // 批准产物，保存内容并写文件，更新 feature 阶段
  static async approveStage(
    stageRunId: string,
    artifactContent: string,
    workspaceId: string,
    featureId: string,
  ): Promise<string> {
    const [run] = await db.select().from(stageRuns).where(eq(stageRuns.id, stageRunId))
    if (!run) throw new Error(`StageRun ${stageRunId} not found`)

    const agentConfig = getAgentConfig(run.stage)
    const artifactPath = ArtifactService.getArtifactPath(workspaceId, featureId, agentConfig.outputFile)

    // 写文件
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, artifactContent, 'utf-8')

    const now = new Date()
    await db
      .update(stageRuns)
      .set({ status: 'approved', artifactContent, artifactPath, approvedAt: now })
      .where(eq(stageRuns.id, stageRunId))

    // 推进 feature 到下一阶段（由调用方决定，这里只返回当前 stage）
    return run.stage
  }

  // 获取 stageRun 的全部消息
  static async getMessages(stageRunId: string) {
    return db
      .select()
      .from(messages)
      .where(eq(messages.stageRunId, stageRunId))
      .orderBy(asc(messages.createdAt))
  }
}
