# ADR-0004: Problems 模块采用异步 + SSE 流式 AI 求解

- **Date**: 2026-06-29
- **Status**: Accepted
- **Source**: `/grill-with-docs` Q1 + Q7（G2 补丁）

---

## Context（背景）

`POST /problems` 接收家长上传的题目图后，需要让 AI（`MiniMax-M3` 多模态）生成解题思路。AI 求解耗时长（实测 5–180s，含 thinking 阶段），且家长希望看到 AI 逐步推理（而非黑盒等待）。

面临三种架构选择：

| 候选 | 描述 |
|---|---|
| A. 同步 | POST 等 AI 完成再返，HTTP 长连接 30–180s |
| B. 异步 + 轮询 | POST 立刻返，客户端 `setInterval(2s)` GET `/problems/:id` |
| C. 异步 + SSE | POST 立刻返，客户端订阅 `GET /problems/:id/stream`，服务端推 `reasoning_delta` / `content_delta` / `done` |

同步方案的问题：HTTP 中间层（nginx/ALB）默认 60s 超时；同步阻塞 Nest worker；用户关页面无法取消；OCR/AI 失败语义错位（5xx 但资源已建）。

异步方案的子选型（轮询 vs SSE）：轮询实现简单但实时性差；SSE 实现复杂但体验好。

---

## Decision（决定）

**采用方案 C：异步 + SSE 流式。**

### 关键约束

1. **POST /problems 立刻返 201**（不预启动 AI），仅创建 Problem 行（status='pending'）
2. **GET /problems/:id/stream 触发 AI 求解**，返回 `Content-Type: text/event-stream`
3. **SSE 事件 schema**（locked）：
   - `status` — 首帧 `{status: 'pending' | 'solving' | 'done' | 'failed'}`（(Q6) 锁：late-arrival 透传真实 status，不再 fold 成 `already_processing` 标记 — see 002 issue / Q6 实施 commit）
   - `reasoning_delta` — 多帧 `{text}`
   - `content_delta` — 多帧 `{text}`
   - `done` — 末帧 `{problemId, solutionId, usage}`（`usage` 是 SDK `finalMessage().usage` 全量 JSON，与 DB `Solution.usage` 1:1 mirror — 见 (γ) 锁 / 002 issue）
   - `error` — 异常分支 `{message, code, reason}`（(Q7) 锁：`code` 是 `EnumFailureCode` 中枚举值，与 DB `Problem.failureCode` 1:1；`reason` 是底层异常 message，与 `Problem.failureReason` 1:1 — see 002 issue / Q7 实施 commit）
4. **180s 硬超时**（`SOLVER_TIMEOUT_MS`），`AbortController.timeout` 套 stream
5. **不自叠 retry**：信任 `@anthropic-ai/sdk` 内置网络重试（外加会和 SDK 退避冲突）
6. **失败语义**：`prisma.problem.update({ status: 'failed', failureCode, failureReason })` → SSE 发 `event: error` → 流关闭（(Q7) 锁：DB 落 classification，SSE 同步推 code+reason）
7. **并发抢占**：`updateMany({ where: { id, status: 'pending' } })` 原子锁；`count === 0` → `findUnique` 读真实 status → 发 `status: <real>` 后立即关闭（避免双开 stream 重复烧钱）— (Q6) 锁后行为
8. **断线兜底**：`GET /problems/:id` 返回当前 status + 终态 solution + `failureCode`/`failureReason`（failed 行）；**不重放过去的 delta**（PRD 第 406 行明确）

### 客户端 transport

**用 `fetch` + `ReadableStream`，**不**用 `EventSource` API**。原因：`EventSource` 不支持自定义 header，无法发送 JWT。

---

## Consequences（影响）

### 收益
- ✅ 家长看到 AI 实时思考，体验显著优于黑盒
- ✅ POST 立即返，HTTP 层不阻塞
- ✅ 失败语义清晰（status=failed + SSE error 事件）
- ✅ 用户断线可重连看 `GET /problems/:id` 终态，不丢结果

### 代价
- ❌ SSE 实现比轮询复杂（需 fake stream server 测试，需 `@RawResponse()` 装饰器跳过全局信封）
- ❌ 单元测试要构造 Observable<MessageEvent>，心智负担
- ❌ mid-stream 崩溃会留 status='solving' 卡死行 → 需 phase 2 加 sweeper cron

### 反向条件（何时推翻）
- 客户端明确改为原生 EventSource（需要 cookie 鉴权重构）
- MiniMax-M3 推理速度显著提升到 < 5s 且不再需要 thinking 可视化 → 可考虑改回同步

---

## References

- 父 PRD：`docs/prd/problems.md` 第 36–44 行（路由表）、第 219–253 行（SSE schema）、第 286–301 行（并发守卫）
- Issue：`docs/issues/002-problems-solve-stream.md`
- 决策来源：`CONTEXT.md` §2 Q1 / Q7 / G2