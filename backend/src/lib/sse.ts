import { Code } from './envelope.js'

// 合并 workspaces.ts:121 与 stages.ts:24 的本地 sseHeaders（重复实现）
export function sseHeaders(origin: string | undefined) {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Expose-Headers': 'X-Stage-Run-Id',
  }
}

// 写入一帧 `data: <json>\n\n`；workspaces.ts:234 内联 write 与 stages.ts:34 sseWrite 统一
export function sseWrite(res: NodeJS.WritableStream, data: Record<string, unknown>) {
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// 统一 SSE 错误帧：{ error, code? } —— 消除之前 init/reinit 路径 boolean error 漂移
export function writeSseError(
  res: NodeJS.WritableStream,
  err: { message: string; code?: number },
) {
  sseWrite(res, { error: err.message, code: err.code ?? Code.INTERNAL })
}
