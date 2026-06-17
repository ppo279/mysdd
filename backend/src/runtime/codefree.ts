import type { RuntimeAdapter, SendResult } from './adapter.js'
import { spawnCliStream, wrapSessionStream } from './claude.js'

// CodefreeAdapter：接口与 Claude CLI 兼容（stream-json / --resume），
// 但无 --system 标志，改用 stdin 注入系统提示。
export class CodefreeAdapter implements RuntimeAdapter {
  constructor(private command: string = 'codefree') {}

  async createSession(systemPrompt: string, firstMessage: string): Promise<SendResult> {
    const args = ['-p', firstMessage, '--output-format', 'stream-json']
    // 通过 stdin 传入系统提示（codefree 会将 stdin 内容拼接在 -p 之前）
    const stdinContent = systemPrompt.trim() ? systemPrompt : undefined
    return wrapSessionStream(spawnCliStream(this.command, args, stdinContent), this.command)
  }

  resumeSession(sessionId: string, message: string): AsyncIterable<string> {
    const cmd = this.command
    const args = ['--resume', sessionId, '-p', message, '--output-format', 'stream-json']
    async function* s() {
      for await (const e of spawnCliStream(cmd, args)) if (e.text) yield e.text
    }
    return s()
  }
}
