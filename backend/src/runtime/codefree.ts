import type { RuntimeAdapter, SendResult } from './adapter.js'
import { spawnCliStream, wrapSessionStream } from './claude.js'

// CodefreeAdapter：接口与 Claude CLI 兼容（stream-json / --resume），
// 但无 --system 标志，改用 stdin 注入系统提示。
export class CodefreeAdapter implements RuntimeAdapter {
  constructor(private command: string = 'codefree') {}

  async createSession(systemPrompt: string, firstMessage: string): Promise<SendResult> {
    // Codefree has no --system-prompt flag; pipe both parts via stdin to trigger print mode
    const args = ['--output-format', 'stream-json']
    const parts = systemPrompt.trim() ? [systemPrompt, firstMessage] : [firstMessage]
    return wrapSessionStream(spawnCliStream(this.command, args, parts.join('\n\n')), this.command)
  }

  resumeSession(sessionId: string, message: string): AsyncIterable<string> {
    const cmd = this.command
    const args = ['--resume', sessionId, '--output-format', 'stream-json']
    async function* s() {
      for await (const e of spawnCliStream(cmd, args, message)) if (e.text) yield e.text
    }
    return s()
  }
}
