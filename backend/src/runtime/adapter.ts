export interface SendResult {
  sessionId: string
  stream: AsyncIterable<string>
}

export interface RuntimeAdapter {
  // 创建新会话，返回 sessionId + 响应流
  createSession(systemPrompt: string, firstMessage: string): Promise<SendResult>
  // 续接会话
  resumeSession(sessionId: string, message: string): AsyncIterable<string>
}
