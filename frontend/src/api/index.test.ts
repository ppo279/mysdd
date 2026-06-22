// Implements: tasks.md#T019 / plan.md#D-04
// api.workspaces.reinit 的 SSE 解析单测：mock fetch 返回 SSE 帧，
// 断言 onChunk({ text, done, error? }) 回调顺序与 done/error 透传。
// 本期先写测试（RED 阶段），T020 实现对应代码（GREEN）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api } from './index'

// ── 工具：构造 SSE Response（模拟后端 stream-json 输出） ──
function sseResponse(frames: Array<Record<string, unknown>>): Response {
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

// 客户端回调收到的 chunk 形状（与 T020 接口契约对齐）
// M0 envelope 化后 error 由 boolean 改为消息字符串（兼容旧 boolean truthy 判等）
type ReinitChunk = { text?: string; done?: boolean; error?: string | boolean; code?: number }

describe('api.workspaces.reinit SSE 解析（T019 / plan.md#D-04）', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('happy: 正常流 → onChunk 按顺序收到 text / done:true 帧', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { text: '🔧 创建 memory/\n' },
        { text: '🔧 创建 tmp/\n' },
        { text: '📦 移动既有内容到 repo/\n' },
        { text: '\n✅ 迁移完成！\n', done: true },
      ]),
    )

    const calls: ReinitChunk[] = []
    await api.workspaces.reinit('ws-1', (chunk: ReinitChunk) => {
      calls.push(chunk)
    })

    // 回调顺序与内容完全一致
    expect(calls).toEqual([
      { text: '🔧 创建 memory/\n' },
      { text: '🔧 创建 tmp/\n' },
      { text: '📦 移动既有内容到 repo/\n' },
      { text: '\n✅ 迁移完成！\n', done: true },
    ])

    // fetch 调用参数：POST + body 含 confirm: true
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]!
    const [url, opts] = call as unknown as [string, RequestInit]
    expect(url).toBe('http://localhost:3001/api/workspaces/ws-1/reinit')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body as string)).toEqual({ confirm: true })
  })

  it('sad: error:true 帧 → onChunk 收到 done:true + error:true', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          text: '\n❌ 目标目录 ... 已存在且非空，无法迁移。\n',
          done: true,
          error: true,
        },
      ]),
    )

    const calls: ReinitChunk[] = []
    await api.workspaces.reinit('ws-1', (chunk: ReinitChunk) => {
      calls.push(chunk)
    })

    expect(calls).toHaveLength(1)
    const last = calls[0]!
    expect(last.text).toContain('目标目录')
    expect(last.done).toBe(true)
    expect(last.error).toBe(true)
  })
})
