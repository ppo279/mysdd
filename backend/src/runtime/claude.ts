import { spawn } from 'child_process'
import type { RuntimeAdapter, SendResult } from './adapter.js'

// stream-json 输出的事件结构（claude-code 兼容格式）
interface StreamEvent {
  type: string
  subtype?: string
  session_id?: string
  delta?: { type: string; text: string }
  message?: { content: Array<{ type: string; text: string }> }
  result?: string
}

// Windows 下 .cmd 文件必须通过 cmd.exe 执行。
// 用 cmd.exe /c + 数组 args 形式，Node.js 负责 CreateProcess 级别的转义，
// 比 shell:true（字符串拼接）更安全。
function buildSpawnTarget(command: string, args: string[]): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: command, args }
  // 已有路径或扩展名（如 .exe 全路径）直接执行
  if (command.includes('/') || command.includes('\\') || /\.\w+$/.test(command)) {
    return { file: command, args }
  }
  return { file: 'cmd.exe', args: ['/c', command, ...args] }
}

// 共享 spawn 工具：支持可选的 stdin 内容（用于无 --system 标志的 CLI）
export async function* spawnCliStream(
  command: string,
  args: string[],
  stdinContent?: string,
): AsyncIterable<{ sessionId?: string; text?: string }> {
  const target = buildSpawnTarget(command, args)
  const proc = spawn(target.file, target.args, {
    stdio: [stdinContent !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: false,
  })

  if (stdinContent !== undefined && proc.stdin) {
    proc.stdin.end(stdinContent)
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    proc.once('error', (err) => resolve(err))
    proc.once('spawn', () => resolve(null))
  })
  if (spawnError) throw new Error(`无法启动 "${command}"：${spawnError.message}。请确认已安装并在 PATH 中，或在运行时配置中填写完整路径。`)

  let buffer = ''
  const decoder = new TextDecoder()

  for await (const chunk of proc.stdout!) {
    buffer += decoder.decode(chunk as Buffer, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event: StreamEvent = JSON.parse(trimmed)

        if (event.session_id) yield { sessionId: event.session_id }

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield { text: event.delta.text }
        }

        if (event.type === 'result' && event.result) {
          yield { text: event.result }
        }
      } catch {
        // 非 JSON 行忽略
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`"${command}" exited with code ${code}`))))
  })
}

// 共享的 sessionId 提取 + 流包装逻辑
export async function wrapSessionStream(
  source: AsyncIterable<{ sessionId?: string; text?: string }>,
  commandName: string,
): Promise<SendResult> {
  let resolveSessionId!: (id: string) => void
  let rejectSessionId!: (e: Error) => void
  const sessionIdPromise = new Promise<string>((res, rej) => {
    resolveSessionId = res
    rejectSessionId = rej
  })

  async function* makeStream(): AsyncIterable<string> {
    let gotSession = false
    for await (const event of source) {
      if (event.sessionId && !gotSession) {
        gotSession = true
        resolveSessionId(event.sessionId)
      }
      if (event.text) yield event.text
    }
    if (!gotSession) rejectSessionId(new Error(`${commandName} CLI did not return a session_id`))
  }

  const stream = makeStream()
  const firstChunk = await stream[Symbol.asyncIterator]().next()

  async function* fullStream(): AsyncIterable<string> {
    if (!firstChunk.done && firstChunk.value) yield firstChunk.value
    // @ts-ignore — 继续消费同一迭代器
    for await (const text of stream) yield text
  }

  const sessionId = await sessionIdPromise
  return { sessionId, stream: fullStream() }
}

export class ClaudeAdapter implements RuntimeAdapter {
  constructor(private command: string = 'claude') {}

  async createSession(systemPrompt: string, firstMessage: string): Promise<SendResult> {
    const args: string[] = ['-p', firstMessage]
    if (systemPrompt.trim()) args.push('--system-prompt', systemPrompt)
    args.push('--output-format', 'stream-json', '--verbose')
    return wrapSessionStream(spawnCliStream(this.command, args), this.command)
  }

  resumeSession(sessionId: string, message: string): AsyncIterable<string> {
    const cmd = this.command
    const args = ['--resume', sessionId, '-p', message, '--output-format', 'stream-json', '--verbose']
    async function* s() {
      for await (const e of spawnCliStream(cmd, args)) if (e.text) yield e.text
    }
    return s()
  }
}
