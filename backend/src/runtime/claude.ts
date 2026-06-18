import { spawn } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type {
  RuntimeAdapter,
  SendResult,
  StreamChunk,
  QuestionItem,
} from './adapter.js'
import { BizError, Code } from '../lib/envelope.js'

// stream-json 输出的事件结构（claude-code 兼容格式）
interface StreamEvent {
  type: string
  subtype?: string
  session_id?: string
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string }
  index?: number
  content_block?: {
    type: string
    id?: string
    name?: string
    input?: unknown
  }
  message?: {
    content?: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
  }
  estimated_tokens?: number
  estimated_tokens_delta?: number
  result?: string
}

// dev 模式下打印 CLI 每行输出；生产下只打印 exit code
const DEBUG = process.env.NODE_ENV !== 'production'

function cliLog(...args: string[]) {
  process.stderr.write(args.join(' ') + '\n')
}

// Write content to a temp file and return its path.
// Used to pass system prompts without going through shell argument quoting.
export function writeTempFile(content: string, prefix = 'sdd-'): string {
  const p = path.join(os.tmpdir(), `${prefix}${randomUUID()}.txt`)
  fs.writeFileSync(p, content, 'utf-8')
  return p
}

// 共享 spawn 工具：支持可选的 stdin 内容（用于无 --system 标志的 CLI）
// Windows 下必须用 shell:true 才能正确执行 .cmd 包装脚本并保持参数完整性
//
// Yield 格式：内部协议用 SpawnOutput，把 sessionId 单独作为"meta"事件传出，
// 其余字段遵循 StreamChunk，方便 wrapSessionStream 透传。
export type SpawnOutput = { sessionId: string } | StreamChunk

export async function* spawnCliStream(
  command: string,
  args: string[],
  stdinContent?: string,
  cwd?: string,
  cleanupFiles?: string[], // temp files to delete after the process exits
  env?: Record<string, string>, // session-level env override; merged with process.env
  timeoutMs?: number,          // hard kill after this many ms
  signal?: AbortSignal,        // abort signal: abort() → SIGTERM child process
): AsyncIterable<SpawnOutput> {
  // Default to home dir so the CLI doesn't pick up any project CLAUDE.md.
  // Callers pass the workspace localPath when they want the agent to work inside a project.
  const resolvedCwd = cwd ?? os.homedir()

  if (DEBUG) {
    cliLog(`[CLI] spawn: ${command} ${args.join(' ')}`)
    cliLog(`[CLI] cwd:   ${resolvedCwd}`)
    if (stdinContent)
      cliLog(`[CLI] stdin: ${stdinContent.slice(0, 120).replace(/\n/g, '↵')}`)
    if (env && Object.keys(env).length) cliLog(`[CLI] env overrides: ${Object.keys(env).join(', ')}`)
    if (timeoutMs) cliLog(`[CLI] timeout: ${timeoutMs}ms`)
  }

  // Process env + per-session env (session wins)
  const mergedEnv: NodeJS.ProcessEnv | undefined =
    env && Object.keys(env).length > 0
      ? { ...process.env, ...env }
      : undefined

  const proc = spawn(command, args, {
    stdio: [
      stdinContent !== undefined ? 'pipe' : 'ignore',
      'pipe',
      'pipe',
    ],
    shell: process.platform === 'win32',
    cwd: resolvedCwd,
    env: mergedEnv,
  })

  if (stdinContent !== undefined && proc.stdin) {
    proc.stdin.end(stdinContent)
  }

  // 外部中止信号（停止按钮）：收到 abort → SIGTERM 子进程
  if (signal) {
    const onAbort = () => { try { proc.kill('SIGTERM') } catch { /* already dead */ } }
    signal.addEventListener('abort', onAbort, { once: true })
    proc.once('close', () => signal.removeEventListener('abort', onAbort))
  }

  // Phase 2: 硬超时。计时器在 spawn 成功后挂上；超时后调 proc.kill()，
  // 子进程以非 0 退出 → 走 Code.CLI_EXIT_NONZERO 路径，错误消息加 (killed-by-timeout) 提示
  let killTimer: NodeJS.Timeout | undefined
  if (timeoutMs && timeoutMs > 0) {
    killTimer = setTimeout(() => {
      if (DEBUG) cliLog(`[CLI] timeout (${timeoutMs}ms) reached, killing pid ${proc.pid}`)
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
    }, timeoutMs)
    // 进程退出后清理计时器（写在 close handler 里更安全，但 IIFE 末尾也能关）
  }

  const spawnError = await new Promise<Error | null>((resolve) => {
    proc.once('error', (err) => resolve(err))
    proc.once('spawn', () => resolve(null))
  })
  if (spawnError)
    throw new BizError(
      Code.CLI_SPAWN_FAILED,
      `无法启动 "${command}"：${spawnError.message}。请确认已安装并在 PATH 中，或在运行时配置中填写完整路径。`,
      502,
    )

  if (DEBUG) cliLog(`[CLI] process spawned (pid ${proc.pid})`)

  // 持续读 stderr 防止管道缓冲区写满导致子进程阻塞
  const stderrLines: string[] = []
  proc.stderr?.on('data', (chunk: Buffer) => {
    const txt = chunk.toString()
    stderrLines.push(txt)
    if (DEBUG) process.stderr.write(`[CLI stderr] ${txt}`)
  })

  let buffer = ''
  const decoder = new TextDecoder()
  let hasStreamedText = false
  let lineCount = 0

  // 跟踪正在进行的 tool_use（用 index 区分），把 input_json_delta 累积起来
  const pendingTools = new Map<
    number,
    { id?: string; name?: string; inputParts: string[] }
  >()

  for await (const chunk of proc.stdout!) {
    buffer += decoder.decode(chunk as Buffer, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      lineCount++

      if (DEBUG) {
        const preview =
          trimmed.length > 160 ? trimmed.slice(0, 160) + '…' : trimmed
        cliLog(`[CLI stdout #${lineCount}] ${preview}`)
      }

      try {
        const event: StreamEvent = JSON.parse(trimmed)

        if (event.session_id) yield { sessionId: event.session_id }

        // ── thinking_tokens：累计 token 数（CLI 周期上报） ─────
        if (
          event.type === 'system' &&
          event.subtype === 'thinking_tokens'
        ) {
          yield {
            kind: 'thinking',
            tokensDelta: event.estimated_tokens_delta,
            tokensTotal: event.estimated_tokens,
          }
        }

        // ── content_block_start：开一个新 block（thinking 或 tool_use） ─
        if (event.type === 'content_block_start' && event.content_block) {
          const cb = event.content_block
          const idx = event.index ?? -1
          if (cb.type === 'tool_use') {
            pendingTools.set(idx, {
              id: cb.id,
              name: cb.name,
              inputParts: [],
            })
            yield {
              kind: 'tool',
              phase: 'start',
              name: cb.name ?? '',
              toolUseId: cb.id,
              input: cb.input,
            }
          }
        }

        // ── content_block_delta：text / thinking / input_json ─
        if (event.type === 'content_block_delta' && event.delta) {
          const d = event.delta
          if (d.type === 'text_delta' && d.text) {
            hasStreamedText = true
            if (DEBUG) cliLog(`[CLI delta] "${d.text.slice(0, 60)}"`)
            yield { kind: 'text', text: d.text }
          } else if (d.type === 'thinking_delta' && d.thinking) {
            yield { kind: 'thinking', text: d.thinking }
          } else if (d.type === 'input_json_delta' && d.partial_json) {
            const idx = event.index ?? -1
            const slot = pendingTools.get(idx)
            if (slot) slot.inputParts.push(d.partial_json)
          }
        }

        // ── content_block_stop：关闭一个 block；若是 tool_use，发 end ─
        if (event.type === 'content_block_stop') {
          const idx = event.index ?? -1
          const slot = pendingTools.get(idx)
          if (slot) {
            let input: unknown = slot.inputParts.length
              ? safeParseJsonOrRaw(slot.inputParts.join(''))
              : undefined
            // 如果 input 是空字符串（CLI 偶尔发 ""），降级为 undefined
            if (input === '' || input === null) input = undefined

            // AskUserQuestion：额外发一个 question chunk，供前端渲染结构化问卡
            if (slot.name === 'AskUserQuestion') {
              const qi = (input as { questions?: QuestionItem[] })?.questions
              if (Array.isArray(qi) && qi.length > 0) {
                yield { kind: 'question', questions: qi }
              }
            }

            yield {
              kind: 'tool',
              phase: 'end',
              name: slot.name ?? '',
              toolUseId: slot.id,
              input,
            }
            pendingTools.delete(idx)
          }
        }

        // ── assistant 整体消息：补抓 thinking / tool_use（无 delta 时的兜底） ─
        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'thinking') {
              yield { kind: 'thinking', text: block.thinking }
            }
          }
        }

        // ── result 兜底：未流到 delta 时回填 ───────────────
        if (event.type === 'result' && event.result && !hasStreamedText) {
          if (DEBUG) cliLog(`[CLI result-fallback] ${event.result.slice(0, 80)}`)
          yield { kind: 'text', text: event.result }
        }
      } catch {
        // 非 JSON 行，记录供出错时诊断
        stderrLines.push(`[stdout non-json] ${trimmed}`)
        if (DEBUG) cliLog(`[CLI non-json] ${trimmed}`)
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    proc.on('close', (code) => {
      if (killTimer) clearTimeout(killTimer)
      cliLog(
        `[CLI exit] code=${code}, stdout lines=${lineCount}${stderrLines.length ? `, stderr lines=${stderrLines.length}` : ''}`,
      )
      // Clean up temp files (system prompt etc.) now that the process has finished
      for (const f of cleanupFiles ?? []) {
        try {
          fs.unlinkSync(f)
        } catch {
          /* already gone */
        }
      }
      if (code === 0) {
        resolve()
      } else {
        if (stderrLines.length)
          process.stderr.write(`[${command} stderr]\n${stderrLines.join('')}\n`)
        reject(
          new BizError(
            Code.CLI_EXIT_NONZERO,
            `"${command}" exited with code ${code}`,
            502,
          ),
        )
      }
    })
  })
}

// input_json_delta 拼起来可能不是严格合法 JSON（例如尾逗号、截断），
// 这里尽量解析，失败就回退成字符串。
function safeParseJsonOrRaw(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

// 共享的 sessionId 提取 + 流包装逻辑
// 用后台 IIFE 持续消费 source，将文本放入 buffer，避免因生成器暂停导致 session_id 事件永远读不到
export async function wrapSessionStream(
  source: AsyncIterable<SpawnOutput>,
  commandName: string,
): Promise<SendResult> {
  let sessionResolve!: (id: string) => void
  let sessionReject!: (e: Error) => void
  const sessionIdPromise = new Promise<string>((res, rej) => {
    sessionResolve = res
    sessionReject = rej
  })

  // 按到达顺序缓存所有 chunk；恢复消费时按 FIFO yield
  const queue: StreamChunk[] = []
  let done = false
  let streamError: Error | undefined
  let notify: (() => void) | undefined

  // 后台持续消费 source，不依赖外部是否在读取流
  ;(async () => {
    try {
      let sessionFound = false
      for await (const event of source) {
        // meta 事件：sessionId，不入队
        if ('sessionId' in event) {
          if (!sessionFound) {
            sessionFound = true
            if (DEBUG) cliLog(`[wrap] session_id resolved: ${event.sessionId}`)
            sessionResolve(event.sessionId)
          }
          continue
        }
        if (DEBUG) {
          if (event.kind === 'text')
            cliLog(`[wrap] buffered text len=${event.text.length}`)
          else if (event.kind === 'thinking')
            cliLog(`[wrap] buffered thinking tokens=${event.tokensTotal ?? '-'}`)
          else if (event.kind === 'tool')
            cliLog(`[wrap] buffered tool ${event.phase} ${event.name}`)
        }
        queue.push(event)
        notify?.()
        notify = undefined
      }
      if (!sessionFound)
        sessionReject(
          new BizError(
            Code.CLI_NO_SESSION_ID,
            `${commandName} CLI did not return a session_id`,
            502,
          ),
        )
    } catch (e) {
      streamError = e as Error
      sessionReject(e as Error)
    } finally {
      done = true
      if (DEBUG) cliLog(`[wrap] source done, queue size=${queue.length}`)
      notify?.()
      notify = undefined
    }
  })()

  // 等待 session_id（后台 IIFE 正在驱动 source，不会死锁）
  const sessionId = await sessionIdPromise

  // 返回从 queue 读取的流，按 FIFO 透传所有 chunk
  async function* stream(): AsyncIterable<StreamChunk> {
    let idx = 0
    while (true) {
      while (idx < queue.length) yield queue[idx++]
      if (done) break
      await new Promise<void>((r) => {
        notify = r
      })
    }
    if (streamError) throw streamError
  }

  return { sessionId, stream: stream() }
}

export class ClaudeAdapter implements RuntimeAdapter {
  constructor(private command: string = 'claude') {}

  async createSession(
    systemPrompt: string,
    firstMessage: string,
    cwd?: string,
    options?: import('./adapter.js').SessionOptions,
  ): Promise<SendResult> {
    // Use --print to trigger non-interactive mode (enables stream-json + verbose streaming)
    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]
    const cleanupFiles: string[] = []

    if (systemPrompt.trim()) {
      // Write system prompt to a temp file to avoid Windows cmd.exe argument quoting issues.
      // --system-prompt "<multiline>" breaks on Windows; --system-prompt-file <path> does not.
      const tmpFile = writeTempFile(systemPrompt, 'sdd-system-')
      args.push('--system-prompt-file', tmpFile)
      cleanupFiles.push(tmpFile)
      if (DEBUG) cliLog(`[CLI] system prompt written to temp file: ${tmpFile}`)
    }

    return wrapSessionStream(
      spawnCliStream(this.command, args, firstMessage, cwd, cleanupFiles, options?.env, options?.timeoutMs, options?.signal),
      this.command,
    )
  }

  resumeSession(
    sessionId: string,
    message: string,
    cwd?: string,
    options?: import('./adapter.js').SessionOptions,
  ): AsyncIterable<StreamChunk> {
    const cmd = this.command
    const args = [
      '--print',
      '--resume',
      sessionId,
      '--output-format',
      'stream-json',
      '--verbose',
    ]
    async function* s(): AsyncIterable<StreamChunk> {
      for await (const e of spawnCliStream(cmd, args, message, cwd, undefined, options?.env, options?.timeoutMs, options?.signal)) {
        if ('sessionId' in e) continue
        yield e
      }
    }
    return s()
  }
}
