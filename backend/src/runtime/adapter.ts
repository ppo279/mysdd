// AskUserQuestion 工具的选项与问题结构（与 Claude Code 保持一致）
export interface QuestionOption {
  label: string
  description?: string
}
export interface QuestionItem {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
}

// ── 流式 chunk 类型 ───────────────────────────────────────────────
// 贯穿 spawnCliStream → service → SSE → 前端的统一事件载荷
export type StreamChunk =
  | { kind: 'text'; text: string }
  | {
      kind: 'thinking'
      text?: string
      tokensDelta?: number
      tokensTotal?: number
    }
  | {
      kind: 'tool'
      phase: 'start' | 'end'
      name: string
      toolUseId?: string
      input?: unknown
    }
  | {
      kind: 'question'
      questions: QuestionItem[]
    }

export interface SendResult {
  sessionId: string
  stream: AsyncIterable<StreamChunk>
}

// Implements: docs/adr/0001-workflow-execution-model.md (Phase 2)
// 可选的 per-session runtime 控制：
// - env: 透传给 spawn env（与 process.env 合并，session 值优先）
// - cwd: 覆盖默认工作目录（已由 routes 层 assertWithinWorkspaceBase 守卫）
// - timeoutMs: 子进程硬超时；超时触发后由 spawnCliStream 调 proc.kill()
//
// cwd 保留在独立位置上而不是塞进 SessionOptions——旧代码签名不变
// （createSession(systemPrompt, firstMessage, cwd?)），env / timeoutMs 是新参数。
export interface SessionOptions {
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal  // 外部中止信号：abort() → SIGTERM 子进程
}

export interface RuntimeAdapter {
  createSession(
    systemPrompt: string,
    firstMessage: string,
    cwd?: string,
    options?: SessionOptions,
  ): Promise<SendResult>
  resumeSession(
    sessionId: string,
    message: string,
    cwd?: string,
    options?: SessionOptions,
    /**
     * Implements: .scratch/agent-contract-db/issues/04-runtime-contract.md
     * slice 04：可选的 snapshot-based system prompt，从 stage_runs.instruction_snapshot 拼出。
     * claude 的 --resume 自身保留原 session 的 system prompt，本参数被忽略；
     * codefree 无独立 system 标志位，把 snapshot prompt 与 user message 一起送 stdin。
     * 缺省（undefined）保持向后兼容——老调用方不需要改。
     */
    resumeSystemPrompt?: string,
  ): AsyncIterable<StreamChunk>
}
