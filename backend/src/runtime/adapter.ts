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

export interface SendResult {
  sessionId: string
  stream: AsyncIterable<StreamChunk>
}

export interface RuntimeAdapter {
  createSession(
    systemPrompt: string,
    firstMessage: string,
    cwd?: string,
  ): Promise<SendResult>
  resumeSession(
    sessionId: string,
    message: string,
    cwd?: string,
  ): AsyncIterable<StreamChunk>
}
