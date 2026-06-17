export interface SendResult {
  sessionId: string
  stream: AsyncIterable<string>
}

export interface RuntimeAdapter {
  createSession(systemPrompt: string, firstMessage: string, cwd?: string): Promise<SendResult>
  resumeSession(sessionId: string, message: string, cwd?: string): AsyncIterable<string>
}
