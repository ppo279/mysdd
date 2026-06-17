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
// 用后台 IIFE 持续消费 source，将文本放入 buffer，避免因生成器暂停导致 session_id 事件永远读不到
export async function wrapSessionStream(
  source: AsyncIterable<{ sessionId?: string; text?: string }>,
  commandName: string,
): Promise<SendResult> {
  let sessionResolve!: (id: string) => void
  let sessionReject!: (e: Error) => void
  const sessionIdPromise = new Promise<string>((res, rej) => {
    sessionResolve = res
    sessionReject = rej
  })

  const buffer: string[] = []
  let done = false
  let streamError: Error | undefined
  let notify: (() => void) | undefined

  // 后台持续消费 source，不依赖外部是否在读取流
  ;(async () => {
    try {
      let sessionFound = false
      for await (const event of source) {
        if (event.sessionId && !sessionFound) {
          sessionFound = true
          sessionResolve(event.sessionId)
        }
        if (event.text) {
          buffer.push(event.text)
          notify?.()
          notify = undefined
        }
      }
      if (!sessionFound) sessionReject(new Error(`${commandName} CLI did not return a session_id`))
    } catch (e) {
      streamError = e as Error
      sessionReject(e as Error)
    } finally {
      done = true
      notify?.()
      notify = undefined
    }
  })()

  // 等待 session_id（后台 IIFE 正在驱动 source，不会死锁）
  const sessionId = await sessionIdPromise

  // 返回从 buffer 读取的流
  async function* stream(): AsyncIterable<string> {
    let idx = 0
    while (true) {
      while (idx < buffer.length) yield buffer[idx++]
      if (done) break
      await new Promise<void>((r) => { notify = r })
    }
    if (streamError) throw streamError
  }

  return { sessionId, stream: stream() }
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
