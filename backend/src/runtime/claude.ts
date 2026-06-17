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

// 共享 spawn 工具：支持可选的 stdin 内容（用于无 --system 标志的 CLI）
// Windows 下必须用 shell:true 才能正确执行 .cmd 包装脚本并保持参数完整性
export async function* spawnCliStream(
  command: string,
  args: string[],
  stdinContent?: string,
): AsyncIterable<{ sessionId?: string; text?: string }> {
  const proc = spawn(command, args, {
    stdio: [stdinContent !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  if (stdinContent !== undefined && proc.stdin) {
    proc.stdin.end(stdinContent)
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    proc.once('error', (err) => resolve(err))
    proc.once('spawn', () => resolve(null))
  })
  if (spawnError) throw new Error(`无法启动 "${command}"：${spawnError.message}。请确认已安装并在 PATH 中，或在运行时配置中填写完整路径。`)

  // 持续读 stderr 防止管道缓冲区写满导致子进程阻塞
  const stderrLines: string[] = []
  proc.stderr?.on('data', (chunk: Buffer) => stderrLines.push(chunk.toString()))

  let buffer = ''
  const decoder = new TextDecoder()
  let hasStreamedText = false

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
          hasStreamedText = true
          yield { text: event.delta.text }
        }

        // Only fall back to result text when no streaming deltas were received
        // (--verbose omitted or CLI version that batches output)
        if (event.type === 'result' && event.result && !hasStreamedText) {
          yield { text: event.result }
        }
      } catch {
        // 非 JSON 行，记录供出错时诊断
        stderrLines.push(`[stdout non-json] ${trimmed}`)
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        if (stderrLines.length) process.stderr.write(`[${command} output]\n${stderrLines.join('\n')}\n`)
        reject(new Error(`"${command}" exited with code ${code}`))
      }
    })
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
    // Pipe firstMessage via stdin instead of deprecated -p flag.
    // A non-tty stdin pipe signals non-interactive (print) mode to the CLI,
    // which ensures --output-format stream-json is respected.
    const args: string[] = ['--output-format', 'stream-json', '--verbose']
    if (systemPrompt.trim()) args.push('--system-prompt', systemPrompt)
    return wrapSessionStream(spawnCliStream(this.command, args, firstMessage), this.command)
  }

  resumeSession(sessionId: string, message: string): AsyncIterable<string> {
    const cmd = this.command
    const args = ['--resume', sessionId, '--output-format', 'stream-json', '--verbose']
    async function* s() {
      for await (const e of spawnCliStream(cmd, args, message)) if (e.text) yield e.text
    }
    return s()
  }
}
