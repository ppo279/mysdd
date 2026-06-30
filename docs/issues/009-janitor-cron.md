# Problems: Janitor cron 框架（solving 卡死 + orphan file 双 job）

> GitHub: [#9](https://github.com/ppo279/mysdd/issues/9) | 状态: `shipped` (commit `aa43e98`, 2026-06-29)

## Parent

- `docs/prd/problems.md`（父 PRD）
- `docs/issues/002-problems-solve-stream.md`（slice 2，引入 'solving' 状态）
- `CONTEXT.md` §1.2 + §2 Q7c（solving 卡死决策）
- `docs/adr/0004-async-sse-ai-solve.md` §"反向条件"（mid-stream 崩溃）
- `docs/adr/0006-storage-interface-local-disk.md` §"Consequences"（orphan file 风险）

> **取代**：原 issue #8 "stuck 'solving' sweeper" 已被合并到本 issue 的 job 1。

## What to build

引入一个 **Janitor cron 框架**，跑在 Nest 进程内，统一调度多个清理 job。本 issue 实现 2 个 job：

### Job 1: StuckSolvingJob — 卡死 'solving' 行重置

slice 2 引入 'solving' 状态后，进程被 SIGKILL 时 mid-stream 行的 row 永远卡在 `status='solving'`。Job 1 定期扫：

```sql
UPDATE "Problem"
SET status = 'pending', "updatedAt" = NOW()
WHERE status = 'solving'
  AND "updatedAt" < NOW() - INTERVAL '5 minutes';
```

重置为 'pending' 后，用户重新 `GET /problems/:id/stream` 即触发新一次求解（不主动重跑，避免半夜自动烧 LLM token）。

### Job 2: OrphanFileJob — 孤儿文件清理

`POST /problems` 失败路径可能留 orphan file（DB 行 `status='failed'` 但 disk 仍有文件）。Job 2 扫 disk 上所有文件，对比 DB 是否有对应 Problem 行：

```
For each ./uploads/problems/<userId>/<uuid>.<ext>:
  - 如果 DB 不存在该 Problem 行（按 imageUrl 列匹配）→ 删文件
  - 如果 DB 存在但 status='failed' AND storage.delete 之前失败过 → 删文件（孤儿）
  - 否则保留
```

### 框架设计

```
src/janitor/
├── janitor.module.ts            # @Global()，导出 JanitorService
├── janitor.service.ts           # OnModuleInit/Destroy，统一调度循环
├── interfaces/
│   └── job.interface.ts         # Job { name: string; run(): Promise<JobResult> }
└── jobs/
    ├── stuck-solving.job.ts     # Job 1
    └── orphan-file.job.ts       # Job 2
```

`JanitorService.runOnce()` 串行执行所有注册 job（不并行——避免 DB / disk IO 抖动），记录每个 job 的执行时间和影响行数。

## Acceptance criteria

### 框架
- [x] `JanitorModule` 注册在 `AppModule`
- [x] `JanitorService` 实现 `OnModuleInit`（启动立即跑一次）+ `OnModuleDestroy`（清理 `setInterval`）
- [x] `Job` interface 含 `name` + `run(): Promise<JobResult>` + `JobResult { affected: number; durationMs: number }`
- [x] 统一调度周期 `JANITOR_INTERVAL_MS` env，默认 `60000`
- [x] 每个 job 单独日志：`[janitor] stuck-solving affected=3 duration=42ms`

### Job 1: StuckSolvingJob
- [x] `pnpm test:e2e -- --testPathPattern=problems` 24/24 仍全过
- [x] e2e case A：直接 `prisma.problem.update({ status: 'solving', updatedAt: <6min ago> })` → 等 sweep → 断言 `status='pending'`
- [x] e2e case B：直接 `prisma.problem.update({ status: 'solving', updatedAt: <2min ago> })` → 等 sweep → 断言 `status='solving'`（不被误杀）
- [x] 阈值 `STUCK_SOLVING_THRESHOLD_MS` env，默认 `300000`

### Job 2: OrphanFileJob
- [x] e2e case C：在 `./uploads/problems/<userId>/` 写一个随机 UUID 文件 + DB 无对应行 → 等 sweep → 文件被删
- [x] e2e case D：写文件 + DB 有对应 Problem 行 (`status='pending'`) → 文件保留
- [x] e2e case E：写文件 + DB 有对应 Problem 行 (`status='failed'`) → 文件被删（orphan 兜底）
- [x] 遍历 `uploads/problems/` 用 `fs.readdir`，不递归过深

### 回归
- [x] `pnpm test:e2e -- --testPathPattern=auth` 15/15 全过
- [x] `pnpm test:e2e -- --testPathPattern=response-shape` 7/7 全过
- [x] `pnpm lint` 干净，`pnpm build` 干净

### 配置
- [x] `.env.example` 增加 `JANITOR_INTERVAL_MS`、`STUCK_SOLVING_THRESHOLD_MS` 注释说明

## Blocked by

None — 可以立即开始

## References

- `CONTEXT.md` §1.2 ("仍然需要 stuck sweeper")
- `CONTEXT.md` §2 Q7c (5min 卡死阈值 + 不主动重跑决策)
- `docs/adr/0004-async-sse-ai-solve.md` §"反向条件"（mid-stream 崩溃）
- `docs/adr/0006-storage-interface-local-disk.md` §"Consequences"（orphan file 风险）

---

## Amendment log

- **2026-06-30**：shipped. Commit `aa43e98 feat(jobs): janitor cron — stuck-solving sweeper + orphan file cleanup (issue 009)`. Acceptance criteria all checked (24/24 problems + 15/15 auth + 7/7 response-shape e2e, lint 0 errors, build clean). Status sync (`ready-for-agent` → `shipped`) per housekeeping pass.
