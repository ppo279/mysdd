---
id: 002-problems-solve-stream
title: 'Problems: 求解 + SSE 流（接 LLM）'
status: shipped
triage: ready-for-human
parent_prd: docs/prd/problems.md
blocked_by: [001-problems-upload-read-image]
covers_user_stories: [11, 12, 13, 14, 15, 16, 17, 18, 22, 23, 24, 27, 29, 30]
covers_e2e_cases: [10, 11]
created: 2026-06-26
shipped_commit: a7b6990
last_updated: 2026-06-30
amendments:
  - commit: 6e88a7a
    lock: (β)
    summary: failed-image returns 200 + X-AI-Status: failed header (always serve the image even if AI failed)
  - commit: 41db634
    lock: (C)
    summary: Solution.token → Solution.usage JSONB (full SDK finalMessage().usage, not just output_tokens)
  - commit: 8810bf7
    lock: (γ)
    summary: SSE done payload = usage JSON (1:1 mirror of DB Solution.usage)
  - commit: 31568f8
    lock: (Q6)
    summary: SSE first frame = real status (pending|solving|done|failed), dropped 'already_processing' fold
  - commit: eff5e12
    lock: (A)
    summary: Problem.solution 1:0..1 singleton (UNIQUE on Solution.problemId)
  - commit: bde4349
    lock: (Q7)
    summary: Problem.failureCode (EnumFailureCode, 5 values) + Problem.failureReason; SSE error payload {message, code, reason}
github_issue: 4
---

## What to build

第二片 vertical slice：把"上传的题目"接到 LLM 上，让家长能看到 AI 一步步想。

**端到端路径**：

```
client GET /problems/:id/stream  (Authorization: Bearer ...)
       → JwtAuthGuard
       → IDOR 校验（不属于我 → 404 `problem 不存在`）
       → ProblemSolverService.solve(problemId, sse)
         ├─ prisma.problem.updateMany(
         │    { where: { id, status: 'pending' }, data: { status: 'solving' } }
         │  )
         │    count === 0 → findUnique({ select: { status } })
         │               → sse.emit('status', { status: real })
         │               → sse.complete()
         │    (Q6) 锁：透传真实 status，不再 fold `already_processing`
         ├─ prisma.problem.findUnique({
         │    include: { child: { select: { grade: true } } }
         │  })
         ├─ buildSystemPrompt(grade)
         ├─ Anthropic.messages.stream({
         │    model: 'MiniMax-M3',
         │    max_tokens: env.SOLVER_MAX_TOKENS,
         │    thinking: { type: 'adaptive' },
         │    system,
         │    messages: [{ role: 'user', content: [
         │      { type: 'image', source: { type: 'base64', media_type, data } },
         │      { type: 'text', text: '请解答这道题' },
         │    ]}],
         │  }, { signal: abortController.signal })
         │  on('thinking_delta') → sse.emit('reasoning_delta', { text })
         │  on('text_delta')     → sse.emit('content_delta',    { text })
         ├─ $transaction([
         │    prisma.solution.create({ content, model, usage: final.usage, problemId }),
         │    prisma.problem.update({ status: 'done' }),
         │  ])
         ├─ sse.emit('done', { problemId, solutionId, usage })
         └─ any throw → prisma.problem.update({
                          status: 'failed',
                          failureCode: 'solver_timeout' | 'solver_failed' | 'image_read_failed',
                          failureReason: err.message,
                        })
                    → sse.emit('error', { message, code, reason })
                    → sse.complete()
                    (Q7) 锁：DB 与 SSE 同步推 code+reason
```

**新增/扩展**：

- 依赖：`@anthropic-ai/sdk@^0.106.0`（**pin minor**）。**版本号锁定原因**：本片用 `thinking: { type: 'adaptive' }`（Anthropic 「adaptive thinking」特性），SDK < 0.95 不识别该 type；npm 验证 0.106.0 是当前 latest 且存在。**不要**升 `latest`，也**不要**降 PRD 原建议的 `^0.30.0`（0.30.x 不支持 adaptive）
- `AnthropicModule` + `ANTHROPIC_CLIENT` provider token（**不要**做成 `@Global()` —— Phase 2 评估）
- `ProblemSolverService.solve(problemId, sse)` + `buildSystemPrompt(grade)`
- `ProblemsController.stream` 端点（**复用** `@RawResponse()` —— 已就位）
- AbortController 硬超时：`SOLVER_TIMEOUT_MS` 默认 180000；SDK 自带的网络重试信任上游
- 15 秒心跳：`: keep-alive\n\n` 注释行
- 测试脚手架：`test/problems/fakes/fake-anthropic-client.ts`、`test/problems/helpers/consume-sse.ts`（Node 24 `fetch` + `\n\n` 切分）

**沿用**：slice 1 的 `ProblemsController` / `ProblemsService` / `ProblemsModule` / `StorageModule` / fixtures / `@RawResponse`。

## Locked SSE 事件 schema（来自 PRD，不要改）

| event | payload | 出现位置 |
|---|---|---|
| `status` | `{ status: 'pending' \| 'solving' \| 'done' \| 'failed' }` | 第一帧（(Q6) 锁：late-arrival 透传真实 status，不再 fold `already_processing`） |
| `reasoning_delta` | `{ text: string }` | 零或多条 |
| `content_delta` | `{ text: string }` | 零或多条 |
| `done` | `{ problemId, solutionId, usage }` | 流结束前最后一帧（`usage` 是 SDK `finalMessage().usage` 全量 JSON，与 DB `Solution.usage` 1:1 mirror — 见 (γ) 锁） |
| `error` | `{ message: string, code: EnumFailureCode, reason: string }` | 异常分支（(Q7) 锁：`code` ∈ {`image_read_failed`, `solver_timeout`, `solver_failed`}，与 DB `Problem.failureCode` 1:1；`reason` 是底层异常 message） |

心跳：每 15 秒发一次 `: keep-alive\n\n`（注释行，无 event 字段，被 EventSource/前端解析器忽略）。

`reasoning_delta` / `content_delta` **不持久化**到 DB；SSE 是唯一投递通道。客户端断开重连后只发新 delta（不重放过去的），客户端需本地缓冲。`GET /problems/:id` 提供最终 solution 兜底。

## Locked error messages（来自 PRD）

| 触发 | message（用户面） | code（(Q7) EnumFailureCode） | reason（DB 落 + SSE 推） |
|---|---|---|---|
| 求解超时（>180s） | `解题超时，请稍后重试` | `solver_timeout` | AbortError message |
| 求解其他错误（SDK / parse / network） | `解题失败，请稍后重试` | `solver_failed` | 底层异常 message |
| 图片读取失败（storage throw） | `解题失败，请稍后重试` | `image_read_failed` | 底层 storage error |
| 并发抢占失败（已有 solve in-flight） | SSE `status: <real>`（mid-flight 是 `solving`；已结束是 `done` / `failed`）后立即关闭 — (Q6) 锁透传真实状态 | — | — |

slice 1 的两个失败路径（upload 阶段）也归入 `EnumFailureCode`：

| 触发 | message | code |
|---|---|---|
| storage.put 抛错（upload 期间） | `服务器内部错误` | `upload_storage_failed` |
| DB update after storage.put 抛错 | `服务器内部错误` | `upload_db_update_failed` |

(DB 上 `failureCode` / `failureReason` 由 `ProblemsService.markFailed` 与 `ProblemSolverService.markFailed` 各自在 catch 里写入。)

## Locked concurrency guard（来自 PRD）

```ts
const claimed = await prisma.problem.updateMany({
  where: { id: problemId, status: 'pending' },
  data: { status: 'solving' },
});
if (claimed.count === 0) {
  const real = await prisma.problem.findUnique({
    where: { id: problemId },
    select: { status: true },
  });
  sse.emit('status', { status: real?.status ?? 'failed' });
  sse.complete();
  return;
}
```

`updateMany` 而非 `update` —— 前者返回 `count` 不抛错，后者会抛 `P2025`。

## LLM provider 澄清

模型是 `MiniMax-M3`（MiniMax 开发），传输协议 Anthropic 兼容。HTTP client 用官方 `@anthropic-ai/sdk`，`baseURL = 'https://api.minimaxi.com/anthropic'`，`model: 'MiniMax-M3'` 在请求体里。**不**走 Anthropic 自己的 API。

## Locked technical decisions

| 关注点 | 值 | 理由 |
|---|---|---|
| SDK 版本 | `@anthropic-ai/sdk@^0.106.0`（pin minor） | `thinking: { type: 'adaptive' }` 在 SDK < 0.95 不识别；PRD 原建议 `^0.30.0` 不支持 adaptive。npm 验证 0.106.0 是当前 latest 且存在 |
| `thinking` 配置 | `{ type: 'adaptive' }`（**不带 `display`**） | SDK 默认 `display: 'summarized'`，让客户端看到思考内容 |
| SSE 实现 | Nest `@Sse()` 装饰器 + `Observable<MessageEvent>` | 惯用。Handler 返回 `new Observable<MessageEvent>(subscriber => ...)`，Nest 把每个 emission 当作 SSE 帧推给 `res` |
| `@Sse()` 与 interceptor | `@Sse()` 端点**仍需** `@RawResponse()` | 否则 `WrapResponseInterceptor.map()` 把每个 `MessageEvent` 包成 `{code, message, data}` 损坏 SSE 字节流 |
| 求解器 ↔ SSE 接口 | 自定义 `ProblemSseSink` 对象：`emit(event, data)` / `complete()`，由 `@Sse()` handler 的 Observable 内部构造；`ProblemSolverService.solve(problemId, userId, sink): Promise<void>` 内部把 sink.emit 翻译成 `subscriber.next({type, data})` | 比直接传 `Subject<MessageEvent>` 解耦；sink 只暴露 PRD 锁的 5 个事件名 |

## Configuration（新增到 `.env.example`）

```
ANTHROPIC_API_KEY=                   # required
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
SOLVER_TIMEOUT_MS=180000             # 180s default; tune per env
SOLVER_MAX_TOKENS=8192               # answer token ceiling; thinking is separate budget
```

## Acceptance criteria

- [x] `pnpm test:e2e -- --testPathPattern=problems` 中 #10、#11 全过
- [x] slice 1 的 #1-#7、#9、#12 仍全过（无回归）
- [x] `pnpm test:e2e -- --testPathPattern=auth` 仍全过
- [x] `pnpm lint` 干净，`pnpm build` 干净
- [x] 手工 smoke：用 fake 客户端推一条 `thinking_delta` + 一条 `text_delta` + end，`curl -N -H "Authorization: Bearer $TOKEN" http://localhost:3000/problems/$ID/stream` 看到按顺序的 SSE 帧；流关闭后 `GET /problems/$ID` 返回 `status: 'done'` 且 `solution` 非空
- [x] 触发 fake 客户端抛错 → 流关闭前 SSE 收到 `status: failed` + `error`，DB 行 `status=failed`
- [x] 同一 problem 双开 stream → 第二个收到 `status: <real>`（mid-flight 时是 `solving`）后立即关闭（fake 客户端被调用 1 次，不是 2 次）— (Q6) 锁后行为
- [x] 求解成功路径只调一次 `prisma.solution.create` + `prisma.problem.update({ status: 'done' })`，且在 `$transaction` 内
- [x] 15 秒心跳存在（fake 客户端拖时间时手动观察）
- [x] 180 秒超时存在（手动验证或代码层面留 assertion）

## Blocked by

- [`001-problems-upload-read-image`](./001-problems-upload-read-image.md) —— 共用 `ProblemsModule`、fixtures、`Problem` 行；`@RawResponse` 装饰器在 slice 1 验证可用

---

## Amendment log

- **2026-06-30**：shipped. Commit `a7b6990 feat(problems): solve + SSE stream (issue 002)`. Acceptance criteria all checked (24/24 problems e2e + 15/15 auth regression, lint 0 errors, build clean). Frontmatter status sync (`open` → `shipped`) per housekeeping pass.
- **2026-06-30**：(β) / (C) / (γ) / (Q6) / (A) / (Q7) six follow-up commits, each locked to a §Language entry. Total problems e2e 25/25, auth 15/15, unit 41/41 after all amendments. See frontmatter `amendments[]` for commit-by-commit breakdown. CLAUDE.md "Problems 实现" section reflects the post-amendment schema and SSE contract.
