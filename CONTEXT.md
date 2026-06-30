# CONTEXT — Problems 模块

> 当前进度：`/grill-with-docs` 完成的工程上下文
> 配套：`docs/adr/0004`、`0005`、`0006`
> 父 PRD：`docs/prd/problems.md`（已 ship，本文档不重复，仅记录差异与决策索引）

---

## 0. 项目现状速览

| 模块 | 状态 | 说明 |
|---|---|---|
| Auth | ✅ shipped | `register / login / me`，16 项 e2e 全过 |
| Prisma | ✅ shipped | User/Child/Problem/Solution 四表；`Child.grade` 1–12 CHECK 已加（003 #2） |
| Children | ✅ shipped | 4 端点已上线（commit `11f4967`） |
| Problems | ✅ all shipped | 父 PRD + 001/002/003/009 全部 shiped（详见 [§Issue sync table](#issue-sync-table--canonical-source-for-issue--commit-status)） |

---

### 0.1. Issue sync table — canonical source for issue / commit status

> 本表是"哪个 issue ship 在哪个 commit"的**唯一真相源**。所有 `docs/issues/*.md` 的 frontmatter（`status` / `shipped_commit` / `github_issue`）都从此表 derive。一次 housekeeping pass 改这一处即可，**不再**挨个 issue body / frontmatter 重复刷状态。

| Issue | Status | shipped_commit | Note |
|---|---|---|---|
| #3 Slice 1 (上传 + 读状态 + 读图) | ✅ shipped | `20b49b3` | — |
| #4 Slice 2 (求解 + SSE 流) | ✅ shipped | `a7b6990` | — |
| #5 Phase 2 backlog (5/5 done) | ✅ shipped | `25394bd` + `03873cb` | #4 `@Global()` 升格由 JanitorModule 触发 |
| #7 Grill 整合 (D4 GIF + D9 auth envelope) | ✅ shipped | `c26f0cb` (housekeeping) | D9 已撤销（已有全局 `WrapResponseInterceptor`） |
| #9 Janitor cron (stuck-solving + orphan file) | ✅ shipped | `aa43e98` | — |
| #11 004 children-doc-drift audit | ✅ shipped | `82bee16` | 14 项 + 1 doc 注释一次性 close |
| Children Module CRUD (无 GitHub issue) | ✅ shipped | `11f4967` | — |

**维护规则**：

1. 当某 issue 的功能 commit 落地（slice shipped），本表加 1 行（status + commit sha + 1 句 note）。
2. housekeeping commit（`c26f0cb` 风格）刷本表 + §5 推进清单的"状态列"。
3. 任何"issue body frontmatter 与本表不一致"的矛盾，以本表为准。

---

## 1. 关键架构事实（写代码前必须知道）

### 1.1 `MiniMax-M3` 是多模态，**没有 OCR 阶段**

父 PRD 第 137–141 行、第 396–398 行明确：OCR pipeline 显式取消。`MiniMax-M3` 直接吃图 + 出解题思路。`ocrText` 列**保留但 `@deprecated`**。`EnumStatus` 早期含 6 值，zombie 值 `ocr_processing` / `ocr_done` 已由迁移 `20260630120000_drop_enum_status_ocr_zombies`（rename → new → alter → drop）清掉；现 schema 与 DB 均为 4 值：`pending` / `solving` / `done` / `failed`。`test/schema/enum-status.e2e-spec.ts` 锁住这条不变量。

> **任何"加 OCR 阶段"的提议都先回到 PRD 改 design**，不在 CONTEXT 层面决策。

### 1.2 Problems 走 SSE 流式，**不是预排队异步**

父 PRD 第 41 行 + `002` issue 第 22 行：客户端 `GET /problems/:id/stream` 才触发 `ProblemSolverService.solve(problemId, sse)`。POST /problems 只创建 Problem 行（status='pending'），**不预启动** AI。意味着：
- 不需要进程内队列（OcrProcessor 的 Q6.2 决策作废）
- 不需要 DB 启动恢复
- **仍然需要** stuck sweeper：mid-stream 崩溃可能留 `status='solving'` 卡死行

### 1.3 存储与 IDOR 走父 PRD

| 项 | 决策 | 来源 |
|---|---|---|
| 存储路径 | `./uploads/problems/<userId>/<uuid>.<ext>`（`process.cwd()` 相对） | PRD 第 159 行 + `001` issue 第 50 行 |
| `imageUrl` 暴露形式 | API 路径 `/problems/${id}/image`（**不**是 DB 列里的 storage key） | PRD 第 178 行 |
| IDOR miss | 统一 404 `child 不存在` / `problem 不存在`（不复用 403，避免枚举） | PRD 第 209/217 行 |
| 存储抽象 | `StorageService` 接口 + `LocalDiskStorageService` 实现 | PRD 第 149–157 行 |
| `@Global()` 决策 | `StorageModule` / `AnthropicModule` 已升 `@Global()`（commit `03873cb`，JanitorModule 是第二个 consumer） | `001/002` issue + 003 backlog |

---

## 2. grill 决策汇总（11 题）

> 锁的来源：`/grill-with-docs` 2026-06-29 全部 11 题达成共识（9 原始题 + G1/G2/G3 三个补丁题）。

### Q1 — 同步 vs 异步 + 推送机制
- **决策**：**异步 + SSE 流式**（PATCH G2）
- POST 返 201 + `{id, status:'pending', ...}`
- 客户端 `GET /problems/:id/stream` 触发求解，订阅 `reasoning_delta` / `content_delta` / `done` 事件
- 退路（未来可加）：客户端断线后用 `GET /problems/:id` 兜底（**不**重放过去的 delta）

### Q2 — 文件类型 + 大小
- **决策**：MIME 白名单 **`image/jpeg` + `image/png` + `image/webp`**（**砍掉 GIF**，PATCH G1）
- 大小上限 **10 MB**，越界 **HTTP 413**
- 严格 **1 张图**，`files.length === 1`

### Q3 — Storage 抽象
- **决策**：`IStorageDriver` 接口 + `LocalStorageDriver` 实现 + `MemoryStorageDriver`（测试用）
- **偏差修正**：PRD 用 `LocalDiskStorageService`（具体类名），CONTEXT 用接口 + 实现命名。**实现命名以 PRD `001` issue 为准**：`LocalDiskStorageService`
- 路径 `./uploads/problems/<userId>/<uuid>.<ext>`（**不**是 grill 假设的 `uploads/<userId>/<problemId>.<ext>`——`<uuid>` 而非 `<problemId>`，避免 path 中泄露递增 ID）
- IDOR miss / 上传失败 → `storage.delete` best-effort + warn 日志

### Q4 — IDOR 防御
- **决策**：统一 **404 + `<资源> 不存在`** 消息（**不**用 403）
- 单查询 `findFirst({ where: { id, child: { userId } } })`，**不**分两步查
- server log 用统一 `outcome: not_found_or_forbidden`，**不**区分 not_found vs forbidden（日志也是攻击面）

### Q5 — LLM 配置
- **决策**：`.env` + `ConfigService.getOrThrow` + **缺失即崩**
- 字段（PRD `002` issue 第 124 行）：
  - `ANTHROPIC_API_KEY` — 必填
  - `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`
  - `SOLVER_TIMEOUT_MS=180000`
  - `SOLVER_MAX_TOKENS=8192`
- **不**自叠 retry：信任 `@anthropic-ai/sdk` 内置网络重试
- e2e：fake client + 1 个 `@skip` 真打 smoke（参考 `test/problems/fakes/fake-anthropic-client.spec.ts` 先例）

### Q6 — 事务边界
- **决策**：**双事务 DB-first**（PRD 第 178 行 + `001` issue 第 23–28 行）
  1. INSERT Problem（status='pending', imageUrl='' 占位）
  2. StorageService.put
  3. UPDATE Problem SET imageUrl=key
- **不**需要进程内队列 / DB 启动恢复（Q1 决定 SSE on-demand，不是预排队；见 §1.2）
- **需要** stuck sweeper：mid-stream 崩溃可能留 status='solving'；phase 2 加 cron

### Q7 — 求解超时 + 失败
- **决策**：
  - **180s 硬超时**（`SOLVER_TIMEOUT_MS`，用 `AbortController.timeout(180000)` 套 SSE 流）
  - **不**自叠 retry（Anthropic SDK 内置；外加会和 SDK 退避冲突）
  - 失败 → `prisma.problem.update({ status: 'failed' })` → SSE 发 `event: error`
  - 卡死 sweeper：scan `status='solving' AND updatedAt < NOW() - INTERVAL '5 minutes'` → 重置 `pending`（**不**主动重跑，留给用户重新触发 stream）

### Q8 — 响应 DTO + 全局信封
- **决策**：全局响应信封 **`{code, message, data}`**（PATCH G3）
  - `code=0` = 成功
  - `code=4xx/5xx` = 错误，带 `traceId`
  - 实现：`WrapResponseInterceptor`（success）+ `AllExceptionsFilter`（error）—— PRD 第 173 行
- **⚠️ 待办代价**：auth 模块当前**没有**这套信封。G3 一致化意味着 auth 三个端点要同步改（`/auth/register` `/auth/login` `/auth/me`），**16 项 e2e 测试要重跑**。Issue 拆出来单做，不要夹在 problems slice 里。
- 字段命名 **camelCase**，日期 **ISO 8601**
- DTO 含字段：`{id, childId, imageUrl, status, ocrText?, failureReason?, createTime, solution: null|{id, content, model, token, createTime}}`
- 错误码分流：**413** size / **415** mime / **400** dto / **401** jwt / **404** IDOR miss / **500** server

### Q9 — OCR 文本边界
- **决策**：**已删除**（OCR 阶段不存在，见 §1.1）

### G1 — GIF 白名单
- **决策**：**砍掉**（对齐 grill 原 Q2 决定；GIF 不能 OCR、不是手机拍照格式）

### G2 — SSE vs 轮询
- **决策**：**SSE**（对齐 PRD + 002 issue 锁定）

### G3 — 全局响应信封
- **决策**：**加** `{code, message, data}` 信封（对齐 PRD；auth 同步改代价见 Q8）

---

## 3. 决策依赖图

```
Q1 async+SSE ─┬─→ Q5 LLM config (SDK+key+timeout)
              ├─→ Q6 事务边界（DB-first）
              ├─→ Q7 超时（180s, 不自叠 retry）
              └─→ Q8 响应（异步返 201 不返流）

Q2 文件限制 ────→ 单独；影响 Q3 multer 内存/磁盘（memoryStorage 已定）
Q3 存储 ───────→ 单独；Q4 IDOR miss 时调 delete
Q4 IDOR ───────→ 单独；和 Q8 错误码分流衔接
Q8 全局信封 ──→ ⚠️ 触发 auth 模块同步改动（新 issue）

G1 ───→ Q2 子补丁
G2 ───→ Q1 子补丁
G3 ───→ Q8 子补丁；触发新 issue（auth 信封化）
```

---

## 4. 与父 PRD 的差异矩阵

| 项 | CONTEXT | 父 PRD | 一致？ |
|---|---|---|---|
| OCR 阶段 | 删除 | 删除 | ✅ |
| 状态机 | `pending / solving / done / failed` | 同 | ✅ |
| 异步推送 | SSE | SSE | ✅ |
| 文件 MIME | jpeg/png/webp（砍 GIF） | jpeg/png/gif/webp | ⚠️ CONTEXT 砍 GIF（待 PRD 同步修订） |
| 大小 | 10MB | 10MB | ✅ |
| Storage 命名 | 接口 + `LocalDiskStorageService` | `StorageService` 接口 | ✅（命名细节以 PRD 为准） |
| IDOR 404 统一 | 是 | 是 | ✅ |
| `failureReason` 字段 | 未引入（PRD 也没） | 未引入 | ✅（无） |
| 响应信封 | 加 `{code, message, data}` | 加 | ✅ |
| Auth 信封化 | 触发新 issue | 未明示 | ⚠️ 新增待办 |

---

## 5. 推进清单

| 项 | 状态 | GitHub | 说明 |
|---|---|---|---|
| 001 — Slice 1: 上传 + 读状态 + 读图 | ✅ shipped | [#3](https://github.com/ppo279/mysdd/issues/3) | 关联 ADR-0005 + ADR-0006 |
| 002 — Slice 2: 求解 + SSE 流 | ✅ shipped `a7b6990` | [#4](https://github.com/ppo279/mysdd/issues/4) | 关联 ADR-0004 |
| 003 — Phase 2 backlog | ✅ 5/5 done | [#5](https://github.com/ppo279/mysdd/issues/5) | #4（@Global 决策）已升格（commit `03873cb`） |
| Children Module CRUD | ✅ shipped `11f4967` | — | 关联 ADR-0004/0005/0006 |
| D4 — GIF MIME 移除 | ✅ 已合入 | [#7](https://github.com/ppo279/mysdd/issues/7)（已 close） | 11 处改动，46/46 e2e 全过 |
| D9 — Auth 信封化 | ❌ 已撤销 | [#7](https://github.com/ppo279/mysdd/issues/7) comment | 已有全局 `WrapResponseInterceptor`，无需改动 |
| Janitor cron 框架 + 双 job | ✅ shipped `aa43e98` | [#9](https://github.com/ppo279/mysdd/issues/9) | 整合 solving 卡死 sweeper + orphan file 清理；引用 ADR-0004/0006 |

### 已完成无需再动

- ✅ ADR-0004（异步 SSE AI 求解）、ADR-0005（IDOR 404 统一）、ADR-0006（Storage 接口 + 本地实现）—— 已写、已引用到对应 issue
- ✅ `/to-prd` → 父 PRD 已 ship，D4/D9 已处理
- ✅ `/to-issues` → 001/002/003/009 均已发布、标注、关联 ADR

---

## 6. 不要在这里决策的事项

- ❌ 是否升级 OSS / S3（003 backlog 范围，不动）
- ❌ `Last-Event-ID` SSE 重连重放（PRD 第 406 行明确不做）
- ❌ `Problem.reasoning` 持久化列（同上）
- ❌ 多图上传（一图 = 一题，PRD 第 402 行）

---

*End of CONTEXT.*