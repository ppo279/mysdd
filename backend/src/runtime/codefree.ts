import type { RuntimeAdapter, SendResult, StreamChunk, SessionOptions } from './adapter.js'
import { spawnCliStream, wrapSessionStream } from './claude.js'

// CodefreeAdapter：接口与 Claude CLI 兼容（stream-json / --resume），
// 但无 --system 标志，改用 stdin 注入系统提示。
export class CodefreeAdapter implements RuntimeAdapter {
  constructor(private command: string = 'codefree') {}

  async createSession(
    systemPrompt: string,
    firstMessage: string,
    cwd?: string,
    options?: SessionOptions,
  ): Promise<SendResult> {
    const args = ['--output-format', 'stream-json']
    const parts = systemPrompt.trim() ? [systemPrompt, firstMessage] : [firstMessage]
    return wrapSessionStream(
      spawnCliStream(this.command, args, parts.join('\n\n'), cwd, undefined, options?.env, options?.timeoutMs),
      this.command,
    )
  }

  resumeSession(
    sessionId: string,
    message: string,
    cwd?: string,
    options?: SessionOptions,
  ): AsyncIterable<StreamChunk> {
    const cmd = this.command
    const args = ['--resume', sessionId, '--output-format', 'stream-json']
    async function* s(): AsyncIterable<StreamChunk> {
      for await (const e of spawnCliStream(cmd, args, message, cwd, undefined, options?.env, options?.timeoutMs)) {
        if ('sessionId' in e) continue
        yield e
      }
    }
    return s()
  }
}
