// Implements: docs/prds/per-agent-tool-restriction.md (001)
// ClaudeAdapter 的 CLI 参数翻译测试
// 验证 SessionOptions.disallowedTools → spawn args 数组中包含 --disallowedTools <csv>
// 验证 options.disallowedTools 缺失时 args 中**不**包含 --disallowedTools
// 覆盖 createSession 与 resumeSession 两条路径

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'

// ── mock: child_process.spawn ──
// 捕获调用参数；返回 fake child process 推动 spawnCliStream 走通
const mockSpawn = vi.fn()
const mockSpawnCalls: Array<{ command: string; args: string[]; opts: any }> = []

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    spawn: mockSpawn,
  }
})

// 通用 fake child：emit spawn → 推一行 session_id → close(0)
function makeFakeProc() {
  const proc = new EventEmitter() as any
  const stdout = new Readable({ read() {} })
  const stderr = new Readable({ read() {} })
  proc.stdout = stdout
  proc.stderr = stderr
  proc.stdin = { end: vi.fn(), write: vi.fn(), on: vi.fn() }
  proc.kill = vi.fn()
  proc.pid = 99999

  setTimeout(() => proc.emit('spawn'), 0)
  setTimeout(() => {
    stdout.push(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'cli-test-session' }) + '\n')
    stdout.push(null)
    setTimeout(() => proc.emit('close', 0), 5)
  }, 5)

  return proc
}

beforeEach(() => {
  mockSpawnCalls.length = 0
  mockSpawn.mockReset()
  mockSpawn.mockImplementation((command: string, args: string[], opts: any) => {
    mockSpawnCalls.push({ command, args: [...args], opts })
    return makeFakeProc()
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

// ============== createSession: disallowedTools → args ==============

describe('ClaudeAdapter.createSession: SessionOptions.disallowedTools → CLI args', () => {
  it('options.disallowedTools = "Bash,Edit,MultiEdit" → args 含 --disallowedTools "Bash,Edit,MultiEdit"（整体一个参数，逗号不被拆）', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    await adapter.createSession('sys', 'msg', undefined, {
      disallowedTools: 'Bash,Edit,MultiEdit',
    })

    expect(mockSpawnCalls).toHaveLength(1)
    const call = mockSpawnCalls[0]
    expect(call.args).toContain('--disallowedTools')
    const idx = call.args.indexOf('--disallowedTools')
    expect(call.args[idx + 1]).toBe('Bash,Edit,MultiEdit')
  })

  it('options.disallowedTools 缺失 → args 中**不**包含 --disallowedTools', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    await adapter.createSession('sys', 'msg', undefined, {})

    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0].args).not.toContain('--disallowedTools')
  })

  it('options.disallowedTools = ""（空串）→ args 中**不**包含 --disallowedTools（空串归一化）', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    await adapter.createSession('sys', 'msg', undefined, {
      disallowedTools: '',
    })

    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0].args).not.toContain('--disallowedTools')
  })

  it('options 整体缺失 → args 中**不**包含 --disallowedTools（不 crash）', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    await adapter.createSession('sys', 'msg', undefined, undefined)

    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0].args).not.toContain('--disallowedTools')
  })
})

// ============== resumeSession: disallowedTools → args ==============

describe('ClaudeAdapter.resumeSession: SessionOptions.disallowedTools → CLI args', () => {
  it('options.disallowedTools = "Bash,Edit" → args 含 --disallowedTools "Bash,Edit"', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    // resumeSession 返回 AsyncIterable，需要消费一下让 spawn 真的发生
    const stream = adapter.resumeSession('sess-xyz', 'next msg', undefined, {
      disallowedTools: 'Bash,Edit',
    })
    for await (const _chunk of stream) {
      /* drain */
    }

    expect(mockSpawnCalls).toHaveLength(1)
    const call = mockSpawnCalls[0]
    expect(call.args).toContain('--disallowedTools')
    const idx = call.args.indexOf('--disallowedTools')
    expect(call.args[idx + 1]).toBe('Bash,Edit')
  })

  it('options.disallowedTools 缺失 → args 中**不**包含 --disallowedTools', async () => {
    const { ClaudeAdapter } = await import('./claude.js')
    const adapter = new ClaudeAdapter()
    const stream = adapter.resumeSession('sess-xyz', 'next msg', undefined, {})
    for await (const _chunk of stream) {
      /* drain */
    }

    expect(mockSpawnCalls).toHaveLength(1)
    expect(mockSpawnCalls[0].args).not.toContain('--disallowedTools')
  })
})
