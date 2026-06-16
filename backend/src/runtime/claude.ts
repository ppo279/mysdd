import { spawn } from 'child_process'
import type { RuntimeAdapter, SendResult } from './adapter.js'

// stream-json 输出的事件结构（claude CLI）
interface ClaudeStreamEvent {
  type: string
  subtype?: string
  session_id?: string
  delta?: { type: string; text: string }
  message?: { content: Array<{ type: string; text: string }> }
  result?: string
}

async function* spawnClaude(args: string[]): AsyncIterable<{ sessionId?: string; text?: string }> {
  const proc = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })

  let buffer = ''
  let sessionId: string | undefined

  const decoder = new TextDecoder()

  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk as Buffer, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event: ClaudeStreamEvent = JSON.parse(trimmed)

        // 从 init 事件或 result 事件中取 session_id
        if (event.session_id && !sessionId) {
          sessionId = event.session_id
          yield { sessionId }
        }

        // 文本增量
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { text: event.delta.text }
        }

        // 非流式结果（fallback）
        if (event.type === 'result' && event.result) {
          yield { text: event.result }
        }
      } catch {
        // 非 JSON 行忽略
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`claude exited with code ${code}`))))
  })
}

export class ClaudeAdapter implements RuntimeAdapter {
  async createSession(systemPrompt: string, firstMessage: string): Promise<SendResult> {
    const args = [
      '-p', firstMessage,
      '--system', systemPrompt,
      '--output-format', 'stream-json',
    ]

    const source = spawnClaude(args)
    let resolveSessionId!: (id: string) => void
    let rejectSessionId!: (e: Error) => void
    const sessionIdPromise = new Promise<string>((res, rej) => {
      resolveSessionId = res
      rejectSessionId = rej
    })

    // 创建中间流，在流式输出时顺带解析 sessionId
    async function* makeStream(): AsyncIterable<string> {
      let gotSession = false
      for await (const event of source) {
        if (event.sessionId && !gotSession) {
          gotSession = true
          resolveSessionId(event.sessionId)
        }
        if (event.text) {
          yield event.text
        }
      }
      if (!gotSession) {
        rejectSessionId(new Error('Claude CLI did not return a session_id'))
      }
    }

    // 启动流（但不 await，让调用方来消费）
    const stream = makeStream()

    // 读第一个 chunk 以触发 sessionId 解析
    const firstChunk = await stream[Symbol.asyncIterator]().next()

    // 重新拼接：先 yield 已读的 firstChunk，再 yield 剩余
    async function* fullStream(): AsyncIterable<string> {
      if (!firstChunk.done && firstChunk.value) yield firstChunk.value
      // @ts-ignore — 继续消费同一迭代器
      for await (const text of stream) {
        yield text
      }
    }

    const sessionId = await sessionIdPromise
    return { sessionId, stream: fullStream() }
  }

  resumeSession(sessionId: string, message: string): AsyncIterable<string> {
    const args = [
      '--resume', sessionId,
      '-p', message,
      '--output-format', 'stream-json',
    ]

    async function* makeStream(): AsyncIterable<string> {
      for await (const event of spawnClaude(args)) {
        if (event.text) yield event.text
      }
    }

    return makeStream()
  }
}
