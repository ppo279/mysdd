# PRD: Problems — Upload, AI-Solve, Stream

> Status: Ready for agent
> Label: `ready-for-agent`
> Source: `/grill-me` + `/ask-matt` review on 2026-06-26

---

## Problem Statement

Parents have registered, logged in, and built child profiles (Auth module shipped). They have no way to:

1. Capture a homework problem from a phone camera and submit it to the app.
2. Receive an AI-generated explanation tailored to their child's grade level.
3. Watch the AI think through the problem in real time, instead of waiting for a black box.
4. Recover state if their connection drops mid-stream.
5. See their uploaded image again later (the "拍糊了怎么办" relink flow).

The app currently stops at login. There is no path from "拍一道题" to "看到解题思路".

---

## Prerequisites

This PRD assumes two things exist before `ProblemsModule` ships:

1. **`AuthModule`** — already shipped (see CLAUDE.md "Auth 实现"). Provides `JwtAuthGuard`, `@CurrentUser()` decorator, and user-scoped request context.
2. **`ChildrenModule`** — **NOT YET SHIPPED**. This PRD does not implement Children CRUD. The `Child` table exists in the database (Prisma model `prisma/schema.prisma`) and can be read and written directly via `PrismaService`, but there is no `POST /children` / `GET /children/:id` HTTP endpoint yet. Children CRUD lives in a separate PRD and will be tracked as a follow-up.

**For this PRD's e2e tests**, child records are created directly via `prisma.child.create({ data: { name, grade, userId } })` in the test setup, with cleanup in `afterEach` or `beforeEach`. The same `Test.createTestingModule` pattern from `test/auth/auth.e2e-spec.ts` is used. **Do not** attempt to create children via an HTTP endpoint — it does not exist yet, and adding a test-only endpoint would leak production code paths. When `ChildrenModule` lands, the test seed switches from direct `prisma.child.create` to `POST /children` with no other changes.

---

## Solution

A new `problems` module exposes four endpoints behind `JwtAuthGuard`:

| Method | Path | Purpose |
|---|---|---|
| `POST /problems` | multipart (image + childId) | Upload a problem, kick off async solve |
| `GET /problems/:id` | — | Read current status + solution (REST fallback) |
| `GET /problems/:id/stream` | SSE | Stream AI reasoning + answer in real time |
| `GET /problems/:id/image` | — | Authenticated image bytes (no public static hosting) |

**Flow**:

```
parent                client                 Nest                      MiniMax-M3
  │ 拍题 → upload     │                       │                            │
  │                   │  POST /problems       │                            │
  │                   │ ─────────────────────▶│  validate + IDOR check     │
  │                   │                       │  prisma.problem.create     │
  │                   │                       │   (imageUrl: '', pending)  │
  │                   │                       │  storage.put (local disk)  │
  │                   │                       │  prisma.problem.update     │
  │                   │                       │   (imageUrl = key)         │
  │                   │ ◀────── 201 ──────────│                            │
  │                   │                       │                            │
  │                   │  GET /problems/:id/stream                          │
  │                   │ ─────────────────────▶│  updateMany(status: pending→solving)
  │                   │ ◀── event: status ────│  buildSystemPrompt(grade)
  │                   │                       │  anthropic.messages.stream({thinking, image})
  │                   │ ◀── event: reasoning_delta ─ delta ─ delta ─────▶│
  │                   │                       │ ◀── thinking_delta ────────│
  │                   │ ◀── event: reasoning_delta ─ delta ─ delta ─────▶│
  │                   │                       │ ◀── text_delta ────────────│
  │                   │ ◀── event: content_delta ─ delta ─ delta ───────▶│
  │                   │                       │ ◀── text_delta ────────────│
  │                   │                       │  $transaction([solution.create, problem.update(status: done)])
  │                   │ ◀── event: done ──────│                            │
  │                   │                       │  sse.complete()            │
  │                   │  GET /problems/:id    │                            │
  │                   │ ─────────────────────▶│  returns {...,solution:{...}}
  │                   │ ◀────── 200 ──────────│
```

If the user closes the tab mid-stream, `GET /problems/:id` returns the current status (and `solution: null` until `done`). They can re-open the SSE stream, but **only new deltas from the current point are emitted** — any `reasoning_delta` / `content_delta` events that were streamed before the reconnection are lost (not replayed, not buffered server-side). The client is expected to buffer received deltas locally to survive reconnections; this is the same pattern as every other PoC-scale SSE consumer. See [Out of Scope](#out-of-scope) for the design rationale.

---

## User Stories

### Upload

1. As a **parent**, I want to **upload a problem image with one tap**, so that I can submit homework faster than typing it out.
2. As a **parent**, I want to **pick which child the problem is for**, so that the explanation matches the right grade level.
3. As a **parent**, I want to **get an immediate acknowledgement** (HTTP 201 with a problem id), so that the UI can move on without waiting for the AI.
4. As a **parent**, I want to **see the file size and format error in plain Chinese**, so that I know whether to retry or re-shoot.
5. As a **parent**, I want to **be told my file is too large (>10 MB)** rather than have the upload silently fail, so that I know to compress it.
6. As a **parent**, I want to **be told my image format isn't supported**, so that I know to convert HEIC → JPG.

### Authentication and authorization

7. As an **authenticated parent**, I want to **see a 401 if my token expires** during upload, so that I know to re-login.
8. As a **parent**, I want to **be unable to upload a problem for another parent's child**, so that family data stays private.
9. As a **parent**, I want to **be unable to view another parent's problem**, so that family data stays private.
10. As a **parent**, I want to **be unable to view another parent's problem image**, so that family data stays private.
11. As a **parent**, I want to **be unable to subscribe to another parent's problem stream**, so that I can't eavesdrop on their AI session.

### Streaming the solution

12. As a **parent**, I want to **watch the AI think through the problem step by step**, so that I can learn the reasoning, not just the answer.
13. As a **parent**, I want to **see the final answer in real time as it's generated**, so that I don't have to wait for the entire token stream to land.
14. As a **parent**, I want to **know when the stream finishes successfully** (a `done` event), so that the UI can mark the answer as complete.
15. As a **parent**, I want to **be told if the AI failed or timed out**, so that I know to retry instead of staring at a frozen screen.
16. As a **parent**, I want to **see the SSE connection stay alive during long thinking periods** (keepalive every 15s), so that mobile networks don't silently drop me.
17. As a **parent**, I want **the AI to time out after a generous 180 seconds** rather than hang forever, so that I can re-upload with confidence.
18. As a **parent**, I want the **explanation language and depth to match my child's grade level**, so that a 2nd-grader doesn't get calculus and a 12th-grader doesn't get counting-on-fingers.

### Status and history

19. As a **parent**, I want to **check the current status of any problem I uploaded**, so that if the SSE drops I can see whether the AI is still working or already finished.
20. As a **parent**, I want to **read the final answer from the REST endpoint** without re-subscribing to the stream, so that I can read the answer in my own time.
21. As a **parent**, I want to **view my uploaded problem image later** to remember what I asked, so that I can refer back to it when reviewing with my child.

### Concurrent safety

22. As a **parent**, I want to **get a clean "already processing" signal if I double-tap the "watch the AI think" (stream) button**, so that I don't accidentally trigger two parallel AI requests and burn tokens. (Note: "double-tap submit" on the upload screen is a different case — it would create two distinct `Problem` rows by design, see [Further Notes](#further-notes) → "Upload idempotency".)
23. As a **parent**, I want **two simultaneous SSE subscribers on the same problem to not both trigger a solve**, so that we don't double-bill MiniMax.

### Failure modes

24. As a **parent**, I want **the problem status to flip to `failed` if the AI errors**, so that I can see something went wrong and retry.
25. As a **parent**, I want **my uploaded image to be cleaned up if the database write fails**, so that I don't leak orphan files.
26. As a **parent**, I want **a 404 (not 403) when I try to access a problem that isn't mine**, so that an attacker can't enumerate other families' problem ids.

### Cross-cutting

27. As a **developer**, I want **the LLM call to use the `MiniMax-M3` model with `thinking: adaptive` enabled**, so that the response includes the reasoning stream.
28. As a **developer**, I want **the storage layer abstracted behind a `StorageService` interface**, so that swapping local disk for OSS in phase 2 doesn't touch business code.
29. As a **developer**, I want **the Anthropic client abstracted behind an `ANTHROPIC_CLIENT` provider token**, so that e2e tests can replace it with a fake without HTTP mocking.
30. As a **developer**, I want **max tokens and stream timeout to be env-configurable**, so that I can tune them per environment without a deploy.

---

## Implementation Decisions

> **LLM provider clarification.** The model is **`MiniMax-M3`** (developed by MiniMax) and the wire protocol is **Anthropic-compatible**. The MiniMax platform exposes an Anthropic-protocol endpoint at `https://api.minimaxi.com/anthropic`, so we use the official `@anthropic-ai/sdk` as the HTTP client and pass `model: 'MiniMax-M3'` in the request body. We are **not** calling Anthropic's own API and we are **not** using any Anthropic-hosted Claude model. Any future reference to "Anthropic" in this PRD means "the Anthropic-compatible protocol served by MiniMax", not the Anthropic SDK vendor.

### Modules

- New module `ProblemsModule` registered in `AppModule`.
- New infrastructure module `AnthropicModule` exporting `ANTHROPIC_CLIENT` (factory provider; reads `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` from `ConfigService`).
- New infrastructure module `StorageModule` exporting `STORAGE_SERVICE` (factory provider; default implementation `LocalDiskStorageService`).
- `ProblemsModule` imports `AnthropicModule`, `StorageModule`, and (transitively) `PrismaModule` (already global).

### Interfaces

**`StorageService`** (lives in `src/storage/`):

```ts
interface StorageService {
  put(input: { buffer: Buffer; mime: string; originalName?: string }): Promise<{ url: string; key: string }>;
  delete(key: string): Promise<void>;
  read(key: string): Readable;
}
```

- `put` writes to `./uploads/problems/<userId>/<uuid>.<ext>` and returns the relative `url` and `key` (userId + uuid + ext).
- `delete` swallows errors with a warn log. In the DB-first create order (see [Controllers and services](#controllers-and-services)), `delete` is only called on the rare step-4 failure path (DB update with the real key fails after the file is already written); its best-effort nature is acceptable because the corresponding `Problem` row is marked `status: 'failed'`, and a Phase 2 janitor cron can sweep `status: 'failed'` rows that still have a corresponding file.
- `read` returns a `Readable` for the auth-protected image endpoint to stream back.

**`ANTHROPIC_CLIENT`** (lives in `src/integrations/anthropic/`):

- Provider token `Symbol('ANTHROPIC_CLIENT')`.
- Wraps the `@anthropic-ai/sdk` `Anthropic` instance configured with:
  - `apiKey = ConfigService.getOrThrow('ANTHROPIC_API_KEY')`
  - `baseURL = 'https://api.minimaxi.com/anthropic'`

### Controllers and services

- `ProblemsController` exposes the four endpoints. All guarded by `JwtAuthGuard`.
  - `POST /problems` and `GET /problems/:id` use the default success envelope `{code: 0, message: 'ok', data: T}` (handled by the global `WrapResponseInterceptor`).
  - `GET /problems/:id/stream` and `GET /problems/:id/image` are decorated with `@RawResponse()` to opt out of the success envelope (SSE bytes and binary image bytes cannot be JSON-wrapped). The `@RawResponse()` decorator (`src/common/decorators/raw-response.decorator.ts`) sets the `RAW_RESPONSE_KEY` metadata that the interceptor checks.
- `ProblemsService` handles `create`, `getOne`, `getImage`:
  - `create` does (DB-first; rationale in [Further Notes](#further-notes) → "DB-first create order"):
    1. **IDOR check** — verify the requested `childId` belongs to `currentUser` via `prisma.child.findFirst({ where: { id: childId, userId } })`. If miss, throw `NotFoundException('child 不存在')` (IDOR-safe, no enumeration).
    2. **DB create with placeholder** — `prisma.problem.create({ data: { childId, imageUrl: '', status: 'pending' } })`. Captures `problem.id`. The empty `imageUrl` is a transient sentinel that no reader ever sees (the API response uses the API path `/problems/${id}/image`, derived from `id`, not from this column).
    3. **Storage write** — `storage.put({ buffer, mime, originalName })` returns `{ url, key }` (key shape unchanged: `problems/<userId>/<uuid>.<ext>`).
    4. **DB update with real key** — `prisma.problem.update({ where: { id: problem.id }, data: { imageUrl: key } })`. From this point on, `getImage` can resolve the file by `problem.id` → `imageUrl` (storage key) → `storage.read(key)`.
    5. **Failure handling:**
       - Step 2 (create) fails → bubble up `500` (no file written, nothing to clean up).
       - Step 3 (storage.put) fails → `prisma.problem.update({ status: 'failed' })`, then throw `500`. The DB row is the audit trail; the file does not exist. **No orphan file possible.**
       - Step 4 (update with real key) fails → `prisma.problem.update({ status: 'failed' })`, then attempt `storage.delete(key)` (best effort, warn log on failure — matches existing `StorageService.delete` contract). The DB row + the file are inconsistent; the failed status surfaces the issue, and a janitor cron (Phase 2) can sweep `status=failed` rows that still have a corresponding file.
  - `getOne` does: IDOR check via `findFirst({ where: { id, child: { userId } } })` → return shape (with `imageUrl` mapped to `/problems/${id}/image` in the response).
  - `getImage` does: IDOR check → **status guard: if `problem.status === 'failed'`, throw `404 'problem 不存在'`** (this rejects the rare case where POST step 4 failed, leaving the DB row with an empty `imageUrl` placeholder) → `storage.read(problem.imageUrl)` → wrap as `StreamableFile` (image URL in response is the API path, not the storage key).
- `ProblemSolverService` handles `solve(problemId, sse)`:
  - Atomic status guard via `updateMany({ where: { id, status: 'pending' } })` → reject if `count === 0`.
  - Loads `problem` with `include: { child: { select: { grade: true } } }` to avoid N+1.
  - Streams to MiniMax-M3 with `thinking: { type: 'adaptive' }`, max_tokens from env, AbortController at env-configured timeout (default 180s).
  - On `thinking_delta` → SSE `event: reasoning_delta`, payload `{ text }`.
  - On `text_delta` → SSE `event: content_delta`, payload `{ text }`.
  - On stream end → `prisma.$transaction([solution.create, problem.update({ status: 'done' })])` → SSE `event: done`.
  - On any throw → `prisma.problem.update({ status: 'failed' })` → SSE `event: error` → `sse.complete()`.

### Schema decisions

- **No schema migration.** `ocrText` column is kept, marked `@deprecated` (OCR-era artifact, never written or read). All six `EnumStatus` values retained; code uses only `pending`, `solving`, `done`, `failed`. `ocr_processing` and `ocr_done` remain as zombies in case OCR is ever revived. PG ENUM does not support DROP VALUE, so we don't try.

### API contracts

**`POST /problems`** (multipart/form-data, JwtAuthGuard):

- Form fields: `image` (file, required), `childId` (string of int, required).
- 201 → `{ code: 0, message: 'ok', data: { id, childId, imageUrl, status: 'pending', createTime } }`
  - `data.imageUrl` is the **API path** `/problems/${id}/image` (NOT the local disk path stored in the DB column). The DB column is internal; the service maps it to the API path at response time. Frontend can prepend `baseURL` directly.
- 400 → `{ code: 400, message: <Chinese validation errors>, traceId }`
- 401 → `{ code: 401, message: ..., traceId }` (inherited from `JwtAuthGuard`)
- 404 → `{ code: 404, message: 'child 不存在', traceId }` (covers both "doesn't exist" and "not yours", IDOR-safe)
- 500 → `{ code: 500, message: '服务器内部错误', traceId }` (with rollback confirmed in storage layer)

**`GET /problems/:id`** (JwtAuthGuard):

- 200 → `{ code: 0, message: 'ok', data: { id, childId, imageUrl, status, createTime, solution: null | { id, content, model, token, createTime } } }`
  - `data.imageUrl` is the same API path as above.
- 401 → `{ code: 401, ..., traceId }`
- 404 → `{ code: 404, message: 'problem 不存在', traceId }` (IDOR-safe; covers both not-found and not-yours)

**`GET /problems/:id/stream`** (JwtAuthGuard, SSE, **decorated with `@RawResponse()`**):

- `Content-Type: text/event-stream`
- Events in order: `status` (initial `solving`), `reasoning_delta` (zero or more), `content_delta` (zero or more), `done`, then stream closes.
- On error: `status` (`failed`), `error` (Chinese message), then stream closes.
- 15-second `: keep-alive\n\n` heartbeat comments.
- 401 / 404 before stream opens (still wrapped in `{code, message, traceId}` error envelope — raw response only applies to the 200 stream body).
- The success response (SSE bytes) bypasses the success envelope — the existing `WrapResponseInterceptor` would otherwise `JSON.stringify` the event stream and corrupt it.

**`GET /problems/:id/image`** (JwtAuthGuard, **decorated with `@RawResponse()`**):

- 200 → image bytes with `Content-Type` matching the original upload. Bypasses the success envelope (raw binary bytes cannot be JSON-wrapped).
- 401 / 404 → standard `{code, message, traceId}` error envelope (envelope is fine here because the 4xx throws before any bytes are written).

### SSE transport (locked)

**Decision: the client uses `fetch` + `ReadableStream`, NOT the browser's `EventSource` API.** Rationale: `EventSource` (the WHATWG-standard streaming API) does **not** support custom request headers, which means the JWT in `Authorization: Bearer <token>` cannot be sent. The workarounds are all bad — query-param token leaks into access logs, Referer headers, and CDN caches; cookies would require a same-site session refactor that doesn't fit the existing JWT architecture.

`fetch(url, { headers: { Authorization: \`Bearer ${token}\` } })` returns a `Response` whose `.body` is a `ReadableStream<Uint8Array>`. The client reads chunks, decodes UTF-8, splits on `\n\n` (event boundary), parses `event:` and `data:` lines, and dispatches. Node 24's built-in `fetch` does the same thing, which is why the test strategy uses it.

**For the e2e test in [Cases](#cases-10-passing--1-deferred) #11**, `test/problems/helpers/consume-sse.ts` exports `consumeSse(url, token): AsyncIterable<{ event, data }>`. It uses `fetch` + a chunk decoder. SSE parsing is a small piece of code (~30 lines) and is **not** shared with the production frontend — the test only needs to assert event order and payload shape, which the helper provides.

**For the production frontend** (out of scope for this PRD, but a follow-up consumer of this contract): an H5 app or RN app on the same Nest backend will use `fetch` + `ReadableStream`. A web SPA uses the same. There is no consumer of this API that needs `EventSource`.

### SSE event schema (final)

| Event name | Payload | Notes |
|---|---|---|
| `status` | `{ status: 'pending' \| 'solving' \| 'done' \| 'failed' }` | First event sent on subscribe |
| `reasoning_delta` | `{ text: string }` | Multiple; concatenate to render thinking |
| `content_delta` | `{ text: string }` | Multiple; concatenate to render answer |
| `done` | `{ problemId, solutionId, totalTokens }` | Stream closes immediately after |
| `error` | `{ message: string }` | Chinese, user-facing; stream closes after |

Heartbeat: every 15s, a comment line `: keep-alive\n\n`. No `event` field, ignored by client.

### Error messages (locked)

| Trigger | Message |
|---|---|
| Missing `image` | `请上传题目图片` |
| Bad MIME | `不支持的图片格式: ${mimetype}，仅允许 JPEG/PNG/WEBP` |
| File > 10 MB | `图片过大，最大 10MB` |
| childId non-int | `childId 必须是整数` |
| childId ≤ 0 | `childId 必须大于 0` |
| childId not found | `child 不存在` |
| childId not yours | `child 不存在` (same as above, IDOR-safe) |
| Problem not found / not yours | `problem 不存在` |
| Solver timeout (>180s) | `解题超时，请稍后重试` |
| Solver generic error | `解题失败，请稍后重试` |
| Auth | Inherited from existing `JwtAuthGuard` |

### Configuration (.env additions)

```
ANTHROPIC_API_KEY=                 # required
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
SOLVER_TIMEOUT_MS=180000           # 180s default; tune per env
SOLVER_MAX_TOKENS=8192             # answer token ceiling; thinking is separate budget
```

### Dependency

- Add `@anthropic-ai/sdk` to dependencies, pinned to a specific minor version (e.g. `^0.30.0`). Avoid `latest` to prevent SDK breaks from silently shifting response event types.

### Concurrency guard

The solve path uses an atomic guard before any side effects:

```ts
const claimed = await prisma.problem.updateMany({
  where: { id: problemId, status: 'pending' },
  data: { status: 'solving' },
});
if (claimed.count === 0) {
  // another solve in flight, or already done/failed
  sse.emit('status', { status: 'already_processing' });
  sse.complete();
  return;
}
```

`updateMany` is preferred over `update` because it returns `count` instead of throwing on no-match. The status transition `pending → solving` is the lock.

### Image transport

Base64 inline. MiniMax-M3 supports `image_url.source.type: 'base64'`; we avoid public-HTTP requirements since the local disk upload URL isn't reachable from MiniMax's network. Buffer is already in memory from `multer.memoryStorage()`, so no extra disk read.

### Image hosting (security)

**No `app.useStaticAssets`**. Every image access goes through `GET /problems/:id/image` with `JwtAuthGuard` + IDOR. Image URLs stored in the DB are internal paths (`/uploads/problems/<userId>/<uuid>.<ext>`); they're never directly reachable.

### System prompt

Hardcoded in code as `buildSystemPrompt(grade: number): string`. Variables: grade number → injected into a teaching-coach system prompt that constrains tone, depth, and output structure (think then answer). No external prompt file; no DB storage; prompt is treated as code, version-controlled.

### Solver concurrency limit

No global concurrency limit. The Anthropic SDK has its own rate-limit handling (5xx and network errors retry internally). The MiniMax base URL's rate-limit policy is unknown — PoC accepts that bursty uploads may hit 429s and surface them as `failed`.

---

## Testing Decisions

### Seams

**One conceptual seam: HTTP boundary.** All tests drive the full Nest request pipeline (`ValidationPipe` → `JwtAuthGuard` → controller → service → Prisma / Storage / Solver → response).

**Two mechanical implementations of that seam:**

1. **`supertest` + `app.getHttpServer()`** (existing Auth pattern) — covers POST, GET single, GET image.
2. **Node 24 built-in `fetch`** — covers SSE, because supertest's stream support is brittle. A small `consumeSse(url, token)` helper yields parsed events for assertions.

### Fake Anthropic client

`test/problems/fakes/fake-anthropic-client.ts` exports a class that mimics the subset of `Anthropic` we use (`messages.stream()` returning an async iterable of `RawMessageStreamEvent`-shaped objects). Tests inject it via:

```ts
Test.createTestingModule({
  imports: [AppModule],
})
  .overrideProvider(ANTHROPIC_CLIENT)
  .useValue(new FakeAnthropicClient())
  .compile();
```

### What makes a good test

- Asserts only **observable HTTP behavior**: status codes, response shapes, SSE event payloads and order, side effects (DB rows, files on disk).
- Does **not** assert internal state machine details, mock call counts, or provider wiring.
- Treats `Problem.status` as observable through `GET /problems/:id`.

### Prior art

- `test/auth/auth.e2e-spec.ts` — established pattern for: `Test.createTestingModule` + supertest + auth-aware test helpers + Chinese assertion messages.
- `test/common/response-shape.e2e-spec.ts` — established pattern for: success envelope `{ code: 0, message, data }`, error envelope `{ code, message, traceId }` via `AllExceptionsFilter`.

### Test fixtures

**User fixture:** `registerAndLogin(app, supertest, prisma)` helper in `test/problems/fixtures/user.ts`. Creates a `User` via `prisma.user.create`, registers through `POST /auth/register`, logs in to obtain a JWT, and returns `{ user, accessToken }`. Idempotent cleanup via `prisma.user.delete` in `afterEach`.

**Child fixture:** `createChild(prisma, { userId, name?, grade? })` helper in `test/problems/fixtures/child.ts`. Creates a `Child` row directly via `prisma.child.create` (no HTTP call — see [Prerequisites](#prerequisites)). Default name `'测试娃'`, default grade `5`. Cleanup is the parent's responsibility (delete children before deleting the user to satisfy the FK).

**Sample image fixture:** A 1×1 white PNG (≈ 70 bytes) is committed at `test/problems/fixtures/tiny.png` and reused for size/MIME/happy-path cases. For the 11 MB test case (#5), the test buffers an 11 MB payload in memory and posts it as a raw `Buffer` via supertest's `.attach('image', buffer, 'huge.png')` — no 11 MB file is committed to the repo.

**Storage cleanup:** Every test that writes to `LocalDiskStorageService` must `rmSync` the corresponding `./uploads/problems/<userId>/` directory in `afterEach`. A global guard test or shared `afterEach` hook handles this.

### Cases (10 passing + 1 deferred)

| # | Case | Expected | Status |
|---|---|---|---|
| 1 | POST /problems no token | 401 | ✅ |
| 2 | POST /problems childId = "abc" | 400 `childId 必须是整数` | ✅ |
| 3 | POST /problems childId not yours | 404 `child 不存在` | ✅ |
| 4 | POST /problems image/heic MIME | 400 `不支持的图片格式` | ✅ |
| 5 | POST /problems image 11 MB | 400 `图片过大，最大 10MB` | ✅ |
| 6 | POST /problems missing image | 400 `请上传题目图片` | ✅ |
| 7 | POST /problems happy path (mock LLM emits one thinking + one text delta, then end) | 201 + DB row, status `pending` | ✅ |
| 8 | POST /problems storage.put failure (DB row created with placeholder, then mock storage throws) | 500 + `Problem.status` = `failed` (no file on disk) | ⏸️ skip, Phase 6 |
| 9 | GET /problems/:id auth + IDOR | 401 / 404 | ✅ |
| 10 | GET /problems/:id/stream auth + IDOR | 401 / 404 | ✅ |
| 11 | GET /problems/:id/stream full flow (collects status → reasoning_delta → content_delta → done in order) | All events received, payload valid | ✅ |
| 12 | GET /problems/:id/image auth + IDOR (hit + miss) | 401 / 404 / 200 with bytes | ✅ |

The rollback case (#8) requires overriding `PrismaService` to throw, which is mechanically possible but not blocking for the PoC delivery. Deferred.

### Out-of-scope test cases (intentionally not written)

- Network retry behavior (Anthropic SDK internal; trust upstream).
- 10 MB boundary precision (boundary case test is brittle and adds little value).
- Real MiniMax integration tests (require live API key, network, and non-determinism).
- Stream timeout behavior (env-configurable; manual smoke test sufficient for PoC).

---

## Out of Scope

- **OCR pipeline.** Explicitly cancelled. MiniMax-M3 is multimodal; we hand it the image directly.
- **`Problem.ocrText` column drop.** Kept as deprecated; no migration.
- **PG `EnumStatus` value removal.** PG ENUM can't drop values; we live with the two zombie values.
- **Static image hosting.** Removed for security. Image access goes through `GET /problems/:id/image` only.
- **`GET /problems` list endpoint.** Not in this PRD.
- **Edit / delete problem endpoints.** Not in this PRD.
- **Multi-image upload.** One image per problem for PoC.
- **Retry endpoint.** User re-uploads to retry; no server-side retry button.
- **OSS / S3 storage migration.** `StorageService` is abstracted; PoC ships with local-disk implementation only.
- **Rate limiting / per-user upload quotas.** Anthropic SDK handles upstream rate limits; no application-layer quota.
- **SSE `Last-Event-ID` / reconnection replay.** Past reasoning deltas are not replayed if a client reconnects mid-stream. **Rationale:** a faithful replay would require persisting the full reasoning text per problem (a new `Problem.reasoning` column) AND reading it back during the `updateMany` guard race window AND handling partial mid-flight state. The complexity is high, the value at PoC is low (the parent is the only viewer; if they refresh, the answer is also in the final `done` event and the `GET /problems/:id` response). Client-side buffering is the standard fix for this category of problem. **Phase 2 enhancement:** add an `id:` field to each event (the monotonic `delta` counter) so a future client can request "all deltas since id N" if/when a `Problem.reasoning` column lands. The current PRD does not commit to the column.
- **Persistent `Problem.reasoning` column.** Reasoning is SSE-only. If a future PRD requires durable reasoning, add a column then.
- **Versioned system prompts.** Prompt is hardcoded.
- **Localization of error messages.** Chinese only for PoC.
- **Prompt engineering iterations.** Single system prompt; future work.

---

## Further Notes

- **SDK version pinning**: lock `@anthropic-ai/sdk` to a specific minor version (e.g. `^0.30.0`) rather than `latest`. Event types (`content_block_delta.delta.type: 'thinking_delta' | 'text_delta'`) are part of the SDK contract; a major bump could shift them silently.

- **`app.useStaticAssets` was removed** because public image hosting bypasses IDOR. Anyone with a guessed or leaked URL could view any image. UUID makes guessing hard but referer headers, server logs, and screenshot sharing leak URLs reliably.

- **Mock strategy for the LLM**: replacing `ANTHROPIC_CLIENT` with `FakeAnthropicClient` (a fake that emits a hand-crafted event stream) is cleaner than mocking the SDK at the method level, and it covers any future Anthropic call site added inside `ProblemSolverService` without re-mocking.

- **The Anthropic SDK's built-in retry handles transient 5xx / network errors.** We do not layer our own retry on top; that risks fighting the SDK's exponential backoff. We only add a hard timeout (`AbortController`) because the SDK has no concept of "give up after N seconds of silence on a stream."

- **No DB transaction wrapping the AI call.** The stream runs for up to 180s; we don't hold a DB transaction open that long. The atomic state transition `pending → solving` (via `updateMany`) is the synchronization primitive; the final write is a short `$transaction` of `solution.create` + `problem.update({ status: 'done' })`.

- **DB-first create order in `POST /problems`** (see the service flow above): the DB row is created **before** the file is written, with `imageUrl: ''` as a transient placeholder. The file write is step 3; if it fails, the row is updated to `status: 'failed'` and the throw happens. If the process dies between step 2 and step 3, a janitor cron (Phase 2) sweeps `status: 'pending'` rows older than 5 minutes with empty `imageUrl` and marks them `failed`. **No orphan file can exist** in this design, because the file write only happens after the DB row exists. The trade-off is a brief window where the `imageUrl` column is empty; no reader ever sees this because the API response uses `/problems/${id}/image` (derived from `id`, not the column).

- **Reasoning text is intentionally not persisted.** Storing it would add a large nullable column to every problem and force every reader to decide whether to include it. The stream is the only delivery channel for PoC.

- **The two zombie enum values (`ocr_processing`, `ocr_done`)** are documented in the schema with comments. Future migrations to clean them up would require a PG ENUM rebuild (rename → new type → alter column → drop old type), which is doable but not worth the complexity at PoC.

- **The `POST /problems` flow is idempotent at the upload level only.** Submitting the same image twice produces two distinct `Problem` rows. True idempotency (a request id) is out of scope.

- **`process.cwd()`-relative upload paths** mean the working directory must be the project root when `pnpm start` runs. `pnpm start:dev` does this by default; if the production launch is different (e.g. running from `dist/`), the path resolution must be revisited.

---

## Deferred Items (Phase 2 / issue backlog)

The following items from the review report were intentionally **not** applied in this PRD pass. They are valid concerns but expand the scope of the PoC. Track them as separate issues in Phase 2.

| # | Item | Reason deferred | Where to track |
|---|---|---|---|
| 1 | **`Child.grade` range constraint** (clarification 3 from review) | PoC accepts any `Int`. `buildSystemPrompt(grade)` is documented to fall back to a default for out-of-range values. | Phase 2 — add `@Min(1) @Max(12)` to `Child.grade` DTO + a schema migration. |
| 2 | **Multer limits / fileFilter config** (clarification 5 from review) | The error messages and 10 MB limit are documented. The exact `FileInterceptor` configuration (limits object, fileFilter function, error message translation for `LIMIT_FILE_SIZE`) is mechanical and fits better in `/implement` than in the PRD. | Issue: "Configure multer FileInterceptor with limits + Chinese error message translation" |
| 3 | **`AnthropicModule` and `StorageModule` as `@Global()`** (review gap) | The PRD says "imports `AnthropicModule`, `StorageModule`" in `ProblemsModule`. If a future module (e.g. Children) also needs LLM calls, it must re-import. Promoting to `@Global()` (like `PrismaModule`) is a one-line change. | Issue: "Promote AnthropicModule + StorageModule to @Global() when a second consumer appears" |
| 4 | **`grade → teaching language mapping table`** (review gap) | `buildSystemPrompt(grade)` is documented as hardcoded. The exact mapping (e.g. grade 1–6 vs 7–12 vs 13+) is a prompt-engineering concern, not an API contract. | Phase 2 — "Iterate on system prompt per grade band" |

These items do **not** block `/implement` of the current PRD.

---

## Acceptance Criteria

- All 12 e2e cases above pass (`pnpm test:e2e`).
- `pnpm test:e2e -- --testPathPattern=auth` continues to pass (no regression).
- `pnpm lint` and `pnpm build` are clean.
- Manual smoke test with curl: POST → 201 with `data.id` (envelope shape `{code: 0, message: 'ok', data: { id, ... }}`); GET /problems/:id/stream with `curl -N -H "Authorization: Bearer $TOKEN"` returns the raw SSE event stream (no envelope); GET /problems/:id/image returns the uploaded PNG bytes with the correct `Content-Type`.
- After a solver failure, `GET /problems/:id` returns `{ status: 'failed', imageUrl: '/problems/${id}/image', solution: null }`; `GET /problems/:id/image` for the same problem returns `404 'problem 不存在'` (status guard rejects failed problems).

---

*End of PRD.*
