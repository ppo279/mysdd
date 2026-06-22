// Implements: docs/prds/per-agent-tool-restriction.md (003 — codefree parity)
// Codefree adapter 的工具黑名单翻译测试（path B：prompt 软约束）。
//
// 验收点：
// - disallowedTools 设置 → spawnCliStream 的 stdin 首段含 `## 工具约束` block，
//   且完整列出 CSV 中的每一个工具（一行一个，不被逗号截断）
// - disallowedTools 缺失 / 空串 → 不含该 block
// - createSession 与 resumeSession 两条路径都覆盖
// - 约束 block 出现在 base_layers 内容之前（不被其淹没）
//
// 实现策略：mock spawnCliStream，捕获它在 createSession / resumeSession 中
// 收到的 (args, stdinContent)，断言 stdinContent 的开头是否包含约束 block。
// 不需要真的起 codefree 子进程。

import { describe, it, expect, beforeEach, vi } from 'vitest'

const { mockSpawnCliStream, mockWrapSessionStream } = vi.hoisted(() => ({
  mockSpawnCliStream: vi.fn(),
  mockWrapSessionStream: vi.fn(),
}))

vi.mock('./claude.js', () => ({
  spawnCliStream: mockSpawnCliStream,
  wrapSessionStream: mockWrapSessionStream,
}))

const { CodefreeAdapter, __test__ } = await import('./codefree.js')

beforeEach(() => {
  mockSpawnCliStream.mockReset()
  mockWrapSessionStream.mockReset()
  // 默认 spawnCliStream 返回一个空 async iterable；wrapSessionStream 也返回固定 sessionId
  mockSpawnCliStream.mockImplementation(async function* () {
    // empty
  })
  mockWrapSessionStream.mockResolvedValue({
    sessionId: 'mock-cli-session',
    stream: (async function* () {
      yield { kind: 'text' as const, text: 'mocked' }
    })(),
  })
})

// ── createSession ────────────────────────────────────────────────

describe('CodefreeAdapter.createSession: disallowedTools → prompt injection (path B)', () => {
  it('disallowedTools 设置时 stdin 首段含 `## 工具约束` block + 完整工具列表', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      '# base layer 1\n\n---\n\nagent instruction here',
      'first user msg',
      undefined,
      { disallowedTools: 'Bash,Edit,MultiEdit' },
    )

    // spawnCliStream 第三个参数 = stdinContent
    expect(mockSpawnCliStream).toHaveBeenCalledTimes(1)
    const stdin = mockSpawnCliStream.mock.calls[0][2] as string

    // 验收点 1：含 ## 工具约束 block
    expect(stdin).toContain('## 工具约束')
    // 验收点 2：完整列出每一个工具（一行一个，不被 CSV 截断）
    expect(stdin).toMatch(/^- Bash$/m)
    expect(stdin).toMatch(/^- Edit$/m)
    expect(stdin).toMatch(/^- MultiEdit$/m)
    // 验收点 3：禁用警告句
    expect(stdin).toContain('CLI 会拒绝')
  })

  it('约束 block 必须出现在 base_layers 内容之前（拼接顺序最前）', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      '# base layer 1',
      'first user msg',
      undefined,
      { disallowedTools: 'Bash,Edit' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    const restrictionIdx = stdin.indexOf('## 工具约束')
    const baseLayerIdx = stdin.indexOf('# base layer 1')
    expect(restrictionIdx).toBeGreaterThanOrEqual(0)
    expect(baseLayerIdx).toBeGreaterThan(restrictionIdx)
  })

  it('disallowedTools 缺失时 stdin 不含 `## 工具约束` block', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      'agent instruction',
      'first user msg',
      undefined,
      undefined,
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).not.toContain('## 工具约束')
    // 原始 systemPrompt 应原样保留
    expect(stdin).toContain('agent instruction')
  })

  it('disallowedTools 为空串时 stdin 不含 `## 工具约束` block（归一化兜底）', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      'agent instruction',
      'first user msg',
      undefined,
      { disallowedTools: '' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).not.toContain('## 工具约束')
  })

  it('disallowedTools 为纯空白时 stdin 不含 `## 工具约束` block', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      'agent instruction',
      'first user msg',
      undefined,
      { disallowedTools: '   ' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).not.toContain('## 工具约束')
  })

  it('CSV 不会被逗号截断：单条完整字符串作为一行（不是按逗号拆分在 block 标题前）', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      'sys',
      'msg',
      undefined,
      { disallowedTools: 'Bash,Edit,NotebookEdit,TodoWrite,WebFetch,WebSearch' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    // 6 个独立 bullet
    const bullets = stdin.match(/^- [A-Z][a-zA-Z]+$/gm) ?? []
    expect(bullets).toHaveLength(6)
    expect(bullets.map((b) => b.replace(/^- /, ''))).toEqual([
      'Bash',
      'Edit',
      'NotebookEdit',
      'TodoWrite',
      'WebFetch',
      'WebSearch',
    ])
  })

  it('disallowedTools 含首尾空格 / 多余空格仍能正确列出每个工具', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      'sys',
      'msg',
      undefined,
      { disallowedTools: '  Bash , Edit ,  MultiEdit  ' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).toMatch(/^- Bash$/m)
    expect(stdin).toMatch(/^- Edit$/m)
    expect(stdin).toMatch(/^- MultiEdit$/m)
  })

  it('systemPrompt 为空但 disallowedTools 设置时，约束 block 仍作为伪 systemPrompt 注入', async () => {
    const adapter = new CodefreeAdapter()
    await adapter.createSession(
      '',
      'first user msg',
      undefined,
      { disallowedTools: 'Bash' },
    )

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).toContain('## 工具约束')
    expect(stdin).toContain('- Bash')
    // 用户消息在约束 block 之后
    const restrictionIdx = stdin.indexOf('## 工具约束')
    const msgIdx = stdin.indexOf('first user msg')
    expect(msgIdx).toBeGreaterThan(restrictionIdx)
  })
})

// ── resumeSession ────────────────────────────────────────────────

describe('CodefreeAdapter.resumeSession: disallowedTools → message 前缀注入', () => {
  it('disallowedTools 设置时 message 前缀含 `## 工具约束` block', async () => {
    const adapter = new CodefreeAdapter()
    // resumeSession 不消费 stream，但需要让 mock 提供一个空 generator
    mockSpawnCliStream.mockImplementation(async function* () {
      /* empty */
    })

    const stream = adapter.resumeSession(
      'existing-session-id',
      'follow up question',
      undefined,
      { disallowedTools: 'Bash,Edit' },
    )
    // drain 让 spawnCliStream 被调用
    for await (const _ of stream) { /* */ }

    expect(mockSpawnCliStream).toHaveBeenCalledTimes(1)
    // spawnCliStream 签名：(command, args, stdinContent, cwd, ...) → stdinContent 是第 3 个参数
    const stdin = mockSpawnCliStream.mock.calls[0][2] as string

    expect(stdin).toContain('## 工具约束')
    expect(stdin).toMatch(/^- Bash$/m)
    expect(stdin).toMatch(/^- Edit$/m)
    // 原始 message 在约束 block 之后
    expect(stdin).toContain('follow up question')
    const restrictionIdx = stdin.indexOf('## 工具约束')
    const msgIdx = stdin.indexOf('follow up question')
    expect(msgIdx).toBeGreaterThan(restrictionIdx)
  })

  it('disallowedTools 缺失时 message 不被任何 block 前缀污染', async () => {
    const adapter = new CodefreeAdapter()
    mockSpawnCliStream.mockImplementation(async function* () {
      /* empty */
    })

    const stream = adapter.resumeSession(
      'existing-session-id',
      'plain message',
      undefined,
      undefined,
    )
    for await (const _ of stream) { /* */ }

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).toBe('plain message')
    expect(stdin).not.toContain('## 工具约束')
  })

  it('disallowedTools 为空串时 message 也不被污染（与缺失等价）', async () => {
    const adapter = new CodefreeAdapter()
    mockSpawnCliStream.mockImplementation(async function* () {
      /* empty */
    })

    const stream = adapter.resumeSession(
      'existing-session-id',
      'plain message',
      undefined,
      { disallowedTools: '' },
    )
    for await (const _ of stream) { /* */ }

    const stdin = mockSpawnCliStream.mock.calls[0][2] as string
    expect(stdin).toBe('plain message')
  })
})

// ── 单元测试：buildToolRestrictionBlock ──────────────────────────

describe('buildToolRestrictionBlock (unit)', () => {
  const { buildToolRestrictionBlock } = __test__

  it('disallowedTools 未设置 → 返回空串', () => {
    expect(buildToolRestrictionBlock(undefined)).toBe('')
  })

  it('disallowedTools 空串 → 返回空串', () => {
    expect(buildToolRestrictionBlock('')).toBe('')
  })

  it('disallowedTools 纯空白 → 返回空串', () => {
    expect(buildToolRestrictionBlock('   ')).toBe('')
  })

  it('CSV 全部为空白 token（",, ,,"） → 返回空串（避免空 bullet）', () => {
    expect(buildToolRestrictionBlock(',,, ,  ,')).toBe('')
  })

  it('有效 CSV → 含 `## 工具约束` 标题 + 每个工具一行', () => {
    const out = buildToolRestrictionBlock('Bash,Edit,Write')
    expect(out).toContain('## 工具约束')
    expect(out).toMatch(/^- Bash$/m)
    expect(out).toMatch(/^- Edit$/m)
    expect(out).toMatch(/^- Write$/m)
    expect(out).toContain('CLI 会拒绝')
  })

  it('CSV 含空白 token 时过滤之：只列有效工具', () => {
    const out = buildToolRestrictionBlock('Bash, , Edit')
    // 空格 token 被过滤，只剩 2 个 bullet
    const bullets = out.match(/^- [A-Z][a-zA-Z]+$/gm) ?? []
    expect(bullets).toHaveLength(2)
    expect(bullets.map((b) => b.replace(/^- /, ''))).toEqual(['Bash', 'Edit'])
  })
})