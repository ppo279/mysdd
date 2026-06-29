# PRD: Children — 孩子档案 CRUD

> Status: `ready-for-agent`
> Triage: `ready-for-agent`
> Source: `/grill-with-docs` 14 题（2026-06-29），全部 A 选项达成共识
> Parents: `docs/prd/problems.md` §Prerequisites + `CONTEXT.md` §6 "ChildrenModule CRUD（独立 PRD）"

---

## Problem Statement

家长注册账号后，需要先**建好孩子的档案**（姓名 + 年级），才能在 Problems 模块里"为这个孩子拍题"。当前的问题：

1. **HTTP 端点不存在**。`Child` 表在 Prisma 里、`Child.grade` 1–12 的 DB CHECK 也已加（迁移 `20260629110000_add_child_grade_range_check`），但**没有** `POST /children` / `GET /children` 等端点。前端必须用别的方式建档案（直接 prisma 写入、admin 脚本、或者干脆不能用）。
2. **e2e 测试在绕路**。`test/problems/problems.e2e-spec.ts` 通过 `prisma.child.create({ data: { name, grade, userId } })` 直接插库——这等于"测试代码用了一条生产代码不走的路径"，是个慢慢恶化的技术债。`fixtures/child.ts:5-9` 的注释自己写了"once [ChildrenModule] lands, this helper switches to POST /children"。
3. **children PRD 是个承诺**。`docs/prd/problems.md` §Prerequisites 明确说："Children CRUD lives in a separate PRD and will be tracked as a follow-up"——这条 follow-up 现在是悬空的。
4. **003 #4 阻塞解除**。`CONTEXT.md` §5 写明：`StorageModule` / `AnthropicModule` 是否升级 `@Global()` 的决策**门控**在 Children 落地之后（"等第二个 consumer"）；Children 不落地，那个决策就一直挂着。

## Solution

引入一个 `ChildrenModule`，暴露 4 个端点（都在 `JwtAuthGuard` 之后），把"建 / 列 / 读 / 删"孩子档案做成完整的 HTTP 路径。

| Method | Path | 用途 | 成功码 |
|---|---|---|---|
| `POST` | `/children` | 建一份新档案 | 201 + `{code:0, message:'ok', data: ChildView}` |
| `GET` | `/children` | 列当前用户的所有孩子（分页） | 200 + `{code:0, message:'ok', data: {items, total, page, pageSize}}` |
| `GET` | `/children/:id` | 读单个孩子的详情 | 200 + `{code:0, message:'ok', data: ChildView}` |
| `DELETE` | `/children/:id` | 硬删除一份档案 | 204（无 body，装饰 `@RawResponse()`） |

**数据契约**：
- `ChildView = { id, name, grade, createTime }` —— 跟 Prisma `Child` 字段 1:1，**去掉** `userId`（永远等于 JWT 里的 userId，重复）。
- list 用信封 `{items: ChildView[], total, page, pageSize}`，默认 `page=1, pageSize=20`，`pageSize` 上限 100。
- 排序默认 `createTime: 'asc'`（老大在前，跟"长幼"直觉一致；分页硬约束"必须有稳定排序"）。
- 删除策略：硬删除；**有题目时拒绝（409）**——不级联、不软删（见 Out of Scope）。

**复用既有约定**（不发明新机制）：
- `JwtAuthGuard` + `@CurrentUser() user.userId`（沿用 `AuthModule`）。
- 全局 `ValidationPipe`（`buildValidationPipe()` 工厂）+ 全局 `WrapResponseInterceptor` + 全局 `AllExceptionsFilter` —— success 自动包 `{code:0, message:'ok', data}`，error 自动包 `{code, message, traceId}`。
- ADR-0005 的 IDOR 策略：`findFirst({where:{id, userId}})` + 404 `<资源> 不存在`（**不**用 403，不分 not-found vs not-yours）。
- `PrismaModule` 是 `@Global()`，`ChildrenService` 直接 inject `PrismaService`。
- `AuthModule` re-export 了 `JwtAuthGuard`，`ChildrenModule.imports` 显式 import `AuthModule`（跟 `ProblemsModule` 保持一致）。

## User Stories

### POST /children — 创建档案

1. As a **parent**, I want to **create a child profile with a name and grade**, so that the AI can explain problems at the right level.
2. As a **parent**, I want a **400 with a Chinese error if I leave `name` empty**, so that I know what to fix without consulting English docs.
3. As a **parent**, I want a **400 if I send `name` longer than 50 characters**, so that the UI can preemptively cap the input.
4. As a **parent**, I want a **400 if I send `grade` outside 1–12**, so that the application layer rejects bad input before the DB CHECK throws.
5. As a **parent**, I want a **400 if I send `grade` as a non-integer** (e.g. `"5"` when JSON, `5.5`, `NaN`), so that I can't slip malformed data into my own account.
6. As a **parent**, I want a **400 if I send unknown fields** (e.g. typo'd `grde` instead of `grade`), so that the API doesn't silently accept and ignore them.
7. As a **parent**, I want a **401 if my token is missing or expired**, so that I can re-login and retry.
8. As a **parent**, I want the **created child's `id` and `createTime` echoed back in the response**, so that the UI can immediately show the new profile without a second GET.

### GET /children — 列出档案

9. As a **parent**, I want to **see all my children in a list**, so that I can pick the right one before uploading a problem.
10. As a **parent**, I want the list **sorted by creation order (oldest first)**, so that "firstborn" appears first in the UI.
11. As a **parent**, I want to **pass `?page=1&pageSize=20`** to control pagination, so that the list scales beyond a small screen.
12. As a **parent**, I want **`pageSize` capped at 100**, so that a malicious client cannot exhaust DB connection pool.
13. As a **parent**, I want a **400 if I pass a non-integer `page` or `pageSize`**, so that I get a clear error when my client has a bug.
14. As a **parent**, I want an **empty list (`items: []`, not 404) when I have no children**, so that the UI shows an "add your first child" empty state.
15. As a **parent**, I want **`total` to reflect the user's true row count (not the current page)**, so that the UI can show "3 of 5 children" pagination.
16. As a **parent**, I want **only my own children to appear in the list**, so that other families' data is invisible to me.

### GET /children/:id — 读取单个

17. As a **parent**, I want to **read a specific child by id**, so that I can refresh their profile after editing it elsewhere.
18. As a **parent**, I want a **404 (not 403) when I try to read another parent's child**, so that attackers cannot enumerate ids.
19. As a **parent**, I want a **404 when the child truly does not exist**, with the **same message as the IDOR miss** ("child 不存在"), so that an attacker cannot distinguish "exists but not yours" from "doesn't exist".
20. As a **parent**, I want a **400 if the `:id` is not a valid integer**, so that I get a clear error when my client constructs a bad URL.
21. As a **parent**, I want a **401 if my token is missing or expired**, so that I can re-login and retry.

### DELETE /children/:id — 删除档案

22. As a **parent**, I want to **delete a child profile that has no associated problems**, so that I can clean up the roster when my kids graduate or change grade.
23. As a **parent**, I want a **409 (Conflict) if the child has any `Problem` rows**, so that I cannot accidentally destroy AI history that I already paid tokens for.
24. As a **parent**, I want the **delete to be hard (row removed from DB, no soft-delete column)**, so that the data is genuinely gone after I confirm.
25. As a **parent**, I want **204 No Content on success with no response body**, so that my client can move on without parsing JSON.
26. As a **parent**, I want the **404/400/401 behavior on DELETE to mirror GET /children/:id exactly**, so that the API feels consistent.

### Cross-cutting

27. As a **parent**, I want **every successful response wrapped in the global `{code, message, data}` envelope**, so that my client only needs one parser.
28. As a **parent**, I want **every error response to include a `traceId`**, so that I can give support a single string to debug.
29. As a **developer**, I want `ChildrenService` to expose an `assertOwnedByUser` private helper, **mirroring `ProblemsService.assertOwnedByUser`**'s shape (`findFirst({where:{id, userId}, select:{id:true}})` + 404 throw), so that the IDOR pattern is consistent across modules.
30. As a **developer**, I want the **e2e fixture in `test/problems/fixtures/child.ts` to switch from `prisma.child.create` to `POST /children`**, so that the production path is exercised by all problems tests (no parallel "test-only" code path).
31. As a **developer**, I want the **existing `CreateChildDto` augmented with `@IsNotEmpty` on `name`**, so that empty strings are rejected at the API boundary (currently only rejected by `MaxLength`, which doesn't catch `""`).
32. As a **developer**, I want **service unit tests written in mock style** (matching `test/problems/problems.service.spec.ts`'s use of `prisma.<model>.findFirst = jest.fn().mockResolvedValue(...)`), so that they run in ms without a live DB.
33. As a **developer**, I want **22–25 e2e tests covering happy + validation + IDOR + pagination + auth**, so that the endpoint × error-code matrix is complete (matching the project's "full matrix" tradition).

## Implementation Decisions

### Module composition

- New module `ChildrenModule`, registered in `AppModule` alongside the existing `AuthModule` / `ProblemsModule` / `StorageModule` / `AnthropicModule` / `JanitorModule`.
- `ChildrenModule.imports = [AuthModule]` — explicit, mirroring `ProblemsModule`. Needed because `JwtAuthGuard` is not `@Global()` and lives in `AuthModule`. **`PrismaModule` is `@Global()`** and does not need re-importing.
- `ChildrenModule.providers = [ChildrenService]`. `ChildrenModule.controllers = [ChildrenController]`.
- `ChildrenModule` is **not** `@Global()`. Following ADR-0004 / ADR-0005 / ADR-0006's "second consumer" rule: only the second consumer of a token / module signals a stable boundary. Once both `ProblemsService` and `ChildrenService` use the same infra tokens, the `StorageModule` / `AnthropicModule` `@Global()` decision (CONTEXT.md §5, issue 003 #4) can be re-evaluated.

### Endpoints

All four endpoints are wrapped by the global `JwtAuthGuard` (class-level `@UseGuards(JwtAuthGuard)` on the controller, mirroring `ProblemsController`).

#### `POST /children` — `application/json`, JwtAuthGuard

- Body: `CreateChildDto { name: string, grade: number }`.
- 201 → `{ code: 0, message: 'ok', data: ChildView }` (envelope applied automatically by `WrapResponseInterceptor`).
- 400 → `{ code: 400, message: 'name：... \n grade：...', traceId }` (validation errors from `buildValidationPipe()`'s `exceptionFactory`).
- 401 → `{ code: 401, ..., traceId }` (inherited from `JwtAuthGuard`).

#### `GET /children` — JwtAuthGuard, query: page + pageSize

- Query: `ListChildrenQueryDto { page: number = 1, pageSize: number = 20 }`.
- `pageSize > 100` → 400 `pageSize 必须小于等于 100` (added by `@Max(100)` on the DTO).
- 200 → `{ code: 0, message: 'ok', data: { items: ChildView[], total: number, page: number, pageSize: number } }`.
- 400 / 401 → standard envelope.

#### `GET /children/:id` — JwtAuthGuard, ParseIntPipe on `:id`

- 200 → `{ code: 0, message: 'ok', data: ChildView }`.
- 400 → `:id` non-integer (from `ParseIntPipe`).
- 404 → `child 不存在` (covers both "doesn't exist" and "not yours", per ADR-0005).
- 401 → inherited.

#### `DELETE /children/:id` — JwtAuthGuard, ParseIntPipe on `:id`, **decorated `@RawResponse()`**

- 204 → no body. `WrapResponseInterceptor` skips wrapping (controlled by `RAW_RESPONSE_KEY`).
- 400 → `:id` non-integer.
- 401 → inherited.
- 404 → `child 不存在` (IDOR miss).
- 409 → `该孩子存在题目，无法删除` (when `prisma.problem.count({where:{childId:id}}) > 0`).

### DTOs

`CreateChildDto` (lives in `children/dto/`):
- `name`: `@IsString` + `@IsNotEmpty` + `@MaxLength(50)`. Chinese error messages, inline.
- `grade`: `@IsInt` + `@Min(1)` + `@Max(12)`. No `@Transform` — the request body is `application/json` (not multipart), so JSON-native numbers don't need coercion. The existing file already has `@IsInt @Min(1) @Max(12) @IsString @MaxLength(50)`; this PRD adds `@IsNotEmpty` to `name`.

`ListChildrenQueryDto` (lives in `children/dto/`):
- `page`: `@IsInt` + `@Min(1)` + `@IsOptional` (defaults to 1 in the service if absent).
- `pageSize`: `@IsInt` + `@Min(1)` + `@Max(100)` + `@IsOptional` (defaults to 20 in the service if absent).
- A `@Transform` hook is **not** required: NestJS auto-coerces query strings to numbers when `transform: true` is set on the global `ValidationPipe` (which it is — see `buildValidationPipe()`).

`ChildView` and the list result type live in `children/types.ts` (or `children/interfaces.ts`):
- `ChildView = { id: number; name: string; grade: number; createTime: Date }`.
- `ListChildrenResult = { items: ChildView[]; total: number; page: number; pageSize: number }`.
- **Not** exposed via Prisma raw — both are service-layer projection types, matching the `ProblemView` / `SolutionView` pattern in `ProblemsService`.

### Service

`ChildrenService` (lives in `children/children.service.ts`):

- Constructor injects `PrismaService` only. **Does not** inject storage / anthropic — children is plain data, no file or LLM.
- `async create(userId: number, dto: CreateChildDto): Promise<ChildView>` — single `prisma.child.create({ data: { userId, name: dto.name, grade: dto.grade }, select: { id, name, grade, createTime } })`. No IDOR check needed (the `userId` comes from JWT, not from the body).
- `async list(userId: number, page: number, pageSize: number): Promise<ListChildrenResult>` — two queries: `findMany({ where: { userId }, orderBy: { createTime: 'asc' }, skip: (page-1)*pageSize, take: pageSize, select: { ... } })` and `count({ where: { userId } })`. The `total` field is the `count` result.
- `async getOne(userId: number, childId: number): Promise<ChildView>` — `assertOwnedByUser` then `prisma.child.findFirst({ where: { id: childId, userId }, select: { id, name, grade, createTime } })` (re-fetch with the full select after the assertion).
- `async remove(userId: number, childId: number): Promise<void>` — `assertOwnedByUser` (404 miss) → `prisma.problem.count({ where: { childId } })` (409 if > 0) → `prisma.child.delete({ where: { id: childId } })`. The count + delete are **not** wrapped in a transaction: a race condition (a problem gets created between count and delete) is acceptable — the FK constraint will then fail the delete with `P2003`, which surfaces as a 500. The window is microseconds; a follow-up can add `prisma.$transaction` if real-world races surface.
- `private async assertOwnedByUser(userId: number, childId: number): Promise<{ id: number }>` — `prisma.child.findFirst({ where: { id: childId, userId }, select: { id: true } })`. Throws `NotFoundException('child 不存在')` on miss. Mirrors `ProblemsService.assertOwnedByUser`'s shape.

### IDOR strategy

ADR-0005 governs: every read of a child row (single, list, delete) goes through `findFirst({ where: { ..., userId } })` — never `findUnique({ where: { id } })` followed by a `userId` check (TOCTOU + extra round trip). The 404 message is uniform (`child 不存在`) for both "doesn't exist" and "not yours". Server-side logs do **not** distinguish (per ADR-0005 §"关键约束 3" — "日志也是攻击面").

### Schema

- **No new migration.** `Child` model in `prisma/schema.prisma` is already complete. The grade range 1–12 is enforced by the existing `child_grade_range` CHECK constraint (migration `20260629110000_add_child_grade_range_check`). The DTO's `@Min(1) @Max(12)` mirrors the DB constraint as a defense-in-depth pair: API layer rejects bad payloads (clean 400), DB rejects direct-write bypasses (e.g. an admin script).
- `prisma-client-js` 7.8 still does not surface `@@check` in the schema language (per `CONTEXT.md` and migration comment), so the schema is the documentation; the constraint lives in SQL.

## Testing Decisions

### E2E (`test/children/children.e2e-spec.ts`)

22–25 tests, organized by endpoint. The project's tradition is full matrix coverage (per `test/auth/auth.e2e-spec.ts` 16 项, `test/problems/problems.e2e-spec.ts` 24 项). The global response envelope / 401 / unknown-route 404 / sanitized 500 are already locked in `test/common/response-shape.e2e-spec.ts` and **not** re-tested here.

| Endpoint | Tests |
|---|---|
| `POST /children` | 201 happy / 400 name 缺失 / 400 name 超长 / 400 name 空字符串 / 400 grade 越界 (0, 13) / 400 grade 非整数 / 400 未知字段 / 401 |
| `GET /children` | 200 空 / 200 多条 / 200 翻页 / 400 pageSize > 100 / 400 page 非整数 / 401 |
| `GET /children/:id` | 200 happy / 404 IDOR（别人的 child）/ 404 不存在 / 400 `:id` 非整数 / 401 |
| `DELETE /children/:id` | 204 无 body（child 下面无 problem）/ 409 有 problem / 404 IDOR / 404 不存在 / 400 `:id` 非整数 / 401 |

Total: 8 + 6 + 5 + 6 = **25 tests** (the upper end of Q10's range, justified by the full matrix).

The 409 case requires: `registerAndLogin` → `POST /children` to set up the child → `POST /problems` to set up a problem (via the existing fixture) → `DELETE /children/:id` → assert 409. The fixture migration (next paragraph) makes this self-contained.

### Service unit test (`test/children/children.service.spec.ts`)

Mock style, mirroring `test/problems/problems.service.spec.ts:30-39` (`{ prisma: { <model>: { <method>: jest.fn() } } } as unknown as PrismaService`).

5–6 cases, all on the service directly (no HTTP):
- `create` happy: mock `prisma.child.create` → assert call args + return projection.
- `list` happy: mock `prisma.child.findMany` + `prisma.child.count` → assert envelope shape.
- `getOne` IDOR miss: mock `prisma.child.findFirst` returns `null` → assert `NotFoundException('child 不存在')`.
- `getOne` happy: mock returns row → assert return shape.
- `remove` conflict: mock `prisma.problem.count` returns 1 → assert `ConflictException` is thrown and `prisma.child.delete` is **not** called.
- `remove` happy: mock count returns 0 → assert `prisma.child.delete` is called with the right id.

### Fixture migration

`test/problems/fixtures/child.ts` currently calls `prisma.child.create({...})` directly. After this PRD lands, it switches to:
- Accept an `INestApplication` and an `accessToken: string` (like `registerAndLogin`).
- `POST /children` with `Authorization: Bearer ${accessToken}` body `{name, grade}`.
- Return the parsed child from the response body.
- Cleanup stays the same: `cleanupUser` deletes in FK-safe order (solutions → problems → children → user).

If a problems e2e test case specifically needs to bypass the DTO (e.g. to test what happens with `grade = 13` historically), that test should be updated rather than adding a parallel `createChildDirect` fixture. The 003 backlog #2 closeout already moved the `grade = 13` case to a service unit test (`test/problems/problem-solver.service.spec.ts`).

### What we do not test

- Response envelope shape (covered by `test/common/response-shape.e2e-spec.ts`).
- 401 token mechanics (covered by `test/auth/auth.e2e-spec.ts`).
- Unknown-route 404 / sanitized 500 (covered by `response-shape.e2e-spec.ts`).

## Out of Scope

- **`PATCH /children/:id` / `PUT /children/:id`** — updating `name` or `grade` is rare; `grade` changes also create a mismatch risk with in-flight `Problem` rows that already have the solver running on the old grade. Defer to a follow-up PRD if needed.
- **Soft delete** — no `deletedAt` column; the existing `Child` schema stays as-is. Hard delete is sufficient for PoC.
- **Cascade delete** — Q3 explicitly rejected: a child with problems must be rejected (409), not silently wiped. The cost of cascade is "user accidentally destroys AI history", which is worse than "user has to delete problems first".
- **Name search / filter** — `GET /children?name=...` — no product need; list size is small (typical: 1–3 per family).
- **Sort options** — no `?sort=createTime:desc` or `?sort=name:asc`. The default `createTime: 'asc'` is the only order. Adding sort is a separate concern.
- **Bulk operations** — no `POST /children/bulk` or `DELETE /children/bulk`. The endpoint surface stays simple.
- **Children of children** — no multi-level relationships. `Child` only has `problems` and `user`.
- **Avatar / birthday / school / notes** — none of these are in the Prisma `Child` model, no PRD mentions them, no product ask. Adding them is a schema migration + a separate PRD.
- **Bulk import** — no `POST /children/import` (CSV, etc.). Single-create only.
- **Rate limiting** — no `POST /children` rate limit. Defer to the project-wide rate-limiting PRD that the `StorageModule` / `AnthropicModule` `@Global()` decision is also waiting on.
- **Internationalization of error messages** — error messages stay inline Chinese. The project's "i18n later" decision (per `docs/auth/auth.e2e-spec.ts` comment) is unchanged.

## Further Notes

### Relationship to other PRDs / ADRs

- **Parents**: `docs/prd/problems.md` (Problems module, mostly shipped). Children is a prerequisite for Problems' `POST /problems` body field `childId` to have a clean "create the child first" UX.
- **Unblocks `docs/issues/003-problems-phase-2-backlog.md` #4**: `StorageModule` / `AnthropicModule` `@Global()` decision. The CONTEXT.md §5 决策 was "gated by Children" — once both modules use the tokens, that decision can be revisited. **Not in this PRD's scope**; this PRD just removes the gate.
- **Unblocks the fixture migration comment in `test/problems/fixtures/child.ts:5-9`**: the comment says "once [ChildrenModule] lands, this helper switches to POST /children". This PRD lands the migration.

### Why DELETE 204 instead of 200

- 204 + `@RawResponse()` lets the success path bypass the envelope. The envelope is `{code:0, message:'ok', data: T}` — for DELETE the natural `data` is `null` or `{id, deletedAt}`, both of which add zero information density.
- REST convention (Fielding §5.3.5) puts 204 on "the server has fulfilled the request but does not need to return an entity-body".
- The `@RawResponse()` decorator already exists in `src/common/decorators/raw-response.decorator.ts` and is used by `ProblemsController.getImage` and `ProblemsController.stream`. No new mechanism is invented.
- Error paths (404, 409, 401, 400) **still** go through `AllExceptionsFilter` and return `{code, message, traceId}` — that filter does not consult `@RawResponse()`. So the "no envelope" opt-out applies to success only.

### Why hard delete + 409 (not cascade)

- `Problem` rows under a child contain: an uploaded image (storage cost), a `Solution` row (LLM token cost paid), and the parent's review history. Silently cascade-deleting is data loss that the user did not consent to.
- The 409 message `该孩子存在题目，无法删除` is actionable: the user goes to the Problems list, deletes problems first, then retries. The UX cost is one extra click; the alternative is irrecoverable data loss.
- A follow-up PRD can add a "force delete" path (`?force=true`) if real users complain — out of scope here.

### Why mock-style service unit tests (not real DB)

- `test/problems/problems.service.spec.ts:30-39` is the established pattern: `prisma: { <model>: { <method>: jest.fn() } } as unknown as PrismaService`. The mock lets us assert on call args (e.g. "delete was called with id X but not with id Y") which real-DB tests cannot do cleanly.
- Mock tests run in ms, no Docker dependency, no DB migration pollution.
- The Q3 logic (count → conditional delete) is **only** verifiable with mock: real-DB tests can assert the user-visible 409, but cannot assert that `prisma.child.delete` was **not** called — mock can.

### Risks

- **Fixture migration is a behavior change for problems e2e.** All problems e2e tests go through the new `createChild` fixture. If any case depended on `prisma.child.create` accepting values that the DTO would reject (e.g. `name: ''` or `grade: 0`), it will fail. This is **intended** — it surfaces technical debt that was hidden by the direct-Prisma path. The 003 backlog #2 closeout already moved the only known "weird value" test (`grade = 13`) to a service unit test, so the risk is low.
- **Pagination page-based vs cursor-based.** The PRD uses `?page=&pageSize=` for PoC simplicity. At family-scale data sizes (≤ 5 children per user), the `OFFSET` performance penalty is invisible. If the dataset grows or list-by-foreign-key patterns emerge, switching to `?cursor=` is a localized refactor (controller + service only; DTO changes, no schema change).
- **`@Global()` decision not re-evaluated here.** CONTEXT.md §5 gates it on "second consumer exists". After this PRD, both `ProblemsService` and `ChildrenService` use `PrismaService` (the global) but not yet `StorageService` or `AnthropicClient` (Children doesn't need them). The 003 #4 decision is therefore **not** auto-unblocked — it needs a separate review once Children + Problems both use those two tokens. This PRD does **not** claim to unblock it; it just doesn't add a new blocker.

---

*End of PRD.*
