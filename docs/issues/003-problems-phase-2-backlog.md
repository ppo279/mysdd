---
id: 003-problems-phase-2-backlog
title: 'Problems: Phase 2 积压（5 项打包）'
status: open
triage: ready-for-human
parent_prd: docs/prd/problems.md
blocked_by: []
covers_user_stories: []
covers_e2e_cases: [8, 11d]
created: 2026-06-26
last_updated: 2026-06-29
---

## Purpose

Problems PRD 里被刻意推迟的 5 项打包成单一积压条目。原始 issue 状态为 "**本 issue 不在本次 PR 中实现**"——本次实现把它当作 "Phase 2 启动" 解读，逐项消化。能动的就动；被外部依赖锁的，落地理由 + 文档。

## Backlog items

- [x] **E2E 用例 #8**：`POST /problems` 写盘失败 → DB 行 `status='failed'`、无残留文件。`jest.spyOn(LocalDiskStorageService.put).mockRejectedValue(...)` 触发 step-3 catch，断言 500 + DB 落 `failed` + imageUrl 占位符保留 + uploads 目录无文件。详见 `test/problems/problems.e2e-spec.ts` case #8（2026-06-26 落地）。

- [x] **`Child.grade` 范围约束**（2026-06-29 落地）：
  - **DB CHECK constraint**：`prisma/migrations/20260629110000_add_child_grade_range_check/migration.sql` 加 `CHECK (grade >= 1 AND grade <= 12)`。已 `prisma migrate deploy` 落地。
  - **DTO 草案**：`src/children/dto/create-child.dto.ts` 含 `@Min(1) @Max(12) @IsInt`，**未接入路由**——`ChildrenModule` 还没建，等独立 PRD。
  - **越界回退文档化**：`buildSystemPrompt(grade)` 的 JSDoc 明确写了 4 档（primary / middle / higher / default）的回退路径；`tierForGrade()` 是导出函数，单测覆盖越界（0、负数、非整数、NaN、>12）。
  - **附带的 schema 限制**：`prisma-client-js` 7.8 不支持 `@@check` schema 声明（已试，加在 schema 里会报 P1012），所以约束只在 migration SQL 里。schema 里有文档注释指向迁移。
  - **e2e 联动**：case #11d 原本想测 grade=13 触发 higher 档，但 DB CHECK 拒了。修改为只测 1-6 / 7-12（in-range），higher + default 由 `test/problems/problem-solver.service.spec.ts` 单测覆盖。

- [x] **Multer 配置明确化**（2026-06-29 落地）：
  - **抽出独立模块**：`src/problems/upload/multer-options.ts` 集中所有上传相关常量（`MAX_FILE_SIZE_BYTES`、`ALLOWED_MIME`）和函数（`multerErrorToMessage`、`problemImageMulterOptions`）。
  - **Controller 简化**：`src/problems/problems.controller.ts` 删了原本 ~40 行 inline 配置，改为 `import { multerErrorToMessage, problemImageMulterOptions } from './upload/multer-options'`。
  - **回归**：24/24 problems e2e 全过，#1-#7 #9 #12 零回归。

- [ ] **`AnthropicModule` / `StorageModule` 升级 `@Global()`**（**未做**——保持阻塞）：
  - **阻塞理由**：PRD 与原 issue 都明确"等出现第二个 consumer 再升"。当前 PoC 阶段没有任何第二模块（`ChildrenModule` 还没建）。在没有真实需求时升 `@Global()` 会让 DI 表面"看起来什么都能用"，掩盖了模块边界。
  - **当前状态**：`src/integrations/anthropic/anthropic.module.ts` 和 `src/storage/storage.module.ts` 注释里都明确写了 `NOT @Global()` 并指向本 issue。
  - **解锁条件**：`ChildrenModule` 落地，且**真的**需要调 LLM 或 Storage（不是 "可能需要"）。
  - **改动量**：一行 `@Global()` + 在 `AppModule` 改 import 顺序。

- [x] **`grade → teaching language` 分级映射表**（2026-06-29 落地）：
  - **三档 + fallback**：`buildSystemPrompt(grade)` 重写为 `primary (1-6)` / `middle (7-12)` / `higher (13+)` / `default (越界)` 四档，每档有自己的 system prompt 模板。带 `【小学阶段】` / `【中学阶段】` / `【高阶阶段】` / `【默认】` marker，方便测试 grep。
  - **E2E 覆盖**：`test/problems/problems.e2e-spec.ts` case #11d 验证 1-6 / 7-12 边界（grade=1、6、7、12 各自命中正确档）。
  - **单测覆盖**：`test/problems/problem-solver.service.spec.ts` 验证 higher (grade=13) + default (0, -1, 1.5, NaN)，并断言 `答案：` 指令存在于每档 prompt。
  - **Prompt 内容**：每档有自己的语气（小学：生活化、糖果打比方；中学：符号+公式；高阶：严格、证明）。可在 Phase 2+ 持续迭代。

## Rationale

PRD 显式说这 5 项**不阻塞** `/implement`，单独建 5 条 issue 只会增加噪音。本次 PR 把 5 项里能动的 4 项消化完，剩余 1 项（#4 `@Global()`）按设计意图保持阻塞。

## References

- 父 PRD：`docs/prd/problems.md` 「Deferred Items (Phase 2 / issue backlog)」段
- 父 PRD 「Out of Scope」段中关于 `Last-Event-ID` / 静态托管 / OSS / 限流等已明确的"不做"决定（与本 backlog 不同：Out of Scope 是设计层面明确否决，Backlog 是有意推迟）
