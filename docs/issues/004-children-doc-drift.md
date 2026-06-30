---
id: 004-children-doc-drift
title: 'Children 落地后的文档同步审计'
status: shipped
triage: ready-for-human
type: audit
created: 2026-06-30
last_updated: 2026-06-30
shipped_commit: 82bee16
github_issue: 11
---

## 0. 摘要

代码侧 `ChildrenModule` 落地（commit `11f4967`，2026-06-29）和 `StorageModule` / `AnthropicModule` 升 `@Global()`（commit `03873cb`）都已合并，**功能层 e2e 24/24 通过、auth 回归 15/15 通过**。但文档侧同步刷新不完整，本文审计 6 份文档/issue + 1 处代码 doc 注释，识别 **14 处文档/doc 注释陈旧**，5 类，根因为「代码先行，文档侧同步只动了局部，未跨文件刷新」。

本文不涉及代码层修改建议——所有冲突都是**纯文档卫生问题**，不影响运行。

---

## 1. 审计范围

| 文件 | 当前状态 |
|---|---|
| `CONTEXT.md` | canonical source per `docs/agents/domain.md`；§0/§1.3/§5/§6 涉及本次审计 |
| `docs/prd/problems.md` | 父 PRD，Prerequisites 段涉及 |
| `docs/prd/children.md` | Children 独立 PRD，Status 仍 `ready-for-agent` |
| `docs/issues/003-problems-phase-2-backlog.md` | 已自更新 #4 为 done |
| `docs/issues/003-amended-body.md` | 做了部分实质修正（见 §4） |
| `docs/issues/001-problems-upload-read-image.md` | Children fixture 策略段未自修正 |
| `src/storage/storage.module.ts` (line 17-23) | doc 注释把 `ChildrenModule` 误标为 `@Global()` 的 second consumer，实际是 `JanitorModule` |

**Scope 声明**：本审计仅验证**静态一致性**（文档/doc 注释与代码对得上），不验证**运行时行为**（不跑 e2e、不 curl、不测 build）。未覆盖：`CHANGELOG.md`、`README.md`、`.github/`、`docs/adr/`、`docs/agents/`。

**审计方法**：从用户初始报告（17 条）出发，逐条核对文档原文，经过 3 轮迭代修正→ 14 条（合并/拆分）→ 13 条（fixture 迁移事实反转 #10）→ 14 条（追加代码 doc 注释陈旧）。所有冲突条目都附"引用原话"+"文件:行号"作为可复核证据。

---

## 2. 冲突清单（14 条）

### 2.1 状态声明过时（8 条）

| # | 文档 | 行号 | 现状 | 应有 |
|---|---|---|---|---|
| 1 | `CONTEXT.md` §0 | 15 | "Children \| 🟡 DTO only \| 未接路由" | "Children \| ✅ shipped \| 4 端点已上线（commit `11f4967`）" |
| 2 | `docs/prd/problems.md` §Prerequisites | 28 | "**`ChildrenModule`** — **NOT YET SHIPPED**... no `POST /children` / `GET /children/:id`" | 改为 "SHIPPED" 并附 commit 引用 |
| 3 | `docs/issues/003-problems-phase-2-backlog.md` #2 | 24 | "未接入路由——`ChildrenModule` 还没建，等独立 PRD" | 改为 "ChildrenModule 已落地（commit `11f4967`）" |
| 4 | `CONTEXT.md` §6 | 182 | "❌ ChildrenModule CRUD（独立 PRD）" | 移除该条（已落地，不再"不在此决策"） |
| 5 | `CONTEXT.md` §5 推进清单 | 163-168 | 无 Children 条目 | 新增："Children Module CRUD — ✅ shipped — commit `11f4967` — 关联 ADR-0004/0005/0006" |
| 6 | `docs/prd/problems.md` §Prereq | 30 | "Do not attempt to create children via an HTTP endpoint — it does not exist yet" | 改为 "When ChildrenModule lands, the test seed switches from direct `prisma.child.create` to `POST /children`. **Done in commit `11f4967`.**" |
| 7 | `docs/prd/problems.md` §Child fixture | 360 | "Creates a Child row directly via `prisma.child.create` (no HTTP call — see Prerequisites)" | 改为 "Creates a Child via `POST /children` with the test's access token"（已兑现） |
| 8 | `docs/issues/001-problems-upload-read-image.md` §Children fixture | 67 | "**不要**试图走 HTTP 端点创建 child" | 改为 "已切换到 `POST /children`（fixtures/child.ts: `11f4967` 同批迁移）" |

### 2.2 半消解 + 实质过期（2 条 — 同一文件内）

| # | 文档 | 行号 | 现状 | 应有 |
|---|---|---|---|---|
| 9a | `docs/issues/003-amended-body.md` §Children fixture | 55-57 | 主体说"不要走 HTTP" + inline 注释说"本片未做切换属于历史债务" | 主体改为 "已切换到 `POST /children`"；inline 注释改为"本片切换已在 commit `11f4967` 同批完成"；Amendment log 按 2026-06-30 既有风格补一条"fixtures/child.ts 已在 commit `11f4967` 同批切到 POST /children。line 55-57 的"未做切换"描述已过时，同步更新" |
| 10 | `docs/prd/children.md` User Story #30 | 88 | 仍是未来时："I want the e2e fixture... to switch from `prisma.child.create` to `POST /children`" | 改为"已兑现（commit `11f4967` 同批），本片验收时确认 e2e 走 HTTP 路径" |

### 2.3 CONTEXT.md 单点过时（合并：原 #11 + #12 + #13）

| # | 文档 | 行号 | 现状 | 应有 |
|---|---|---|---|---|
| 11 | `CONTEXT.md` §1.3 / §5 / §6 | 43, 165, 181 | 描述 `StorageModule` / `AnthropicModule` @Global() 决策"保持非全局，等 Children 落地后再说" + "🟡 4/5 done, #4 gated by Children" | 改为 "已升 `@Global()`（commit `03873cb`，JanitorModule 是第二个 consumer）"；§5 推进清单 "003 — Phase 2 backlog" 行的 #4 标记改为 "✅ 5/5 done"；§6 移除该条 |

### 2.4 children.md 内部结构 + 引用链（合并：原 #14 + #15 → #12；原 #16 + #17 → #13）

| # | 文档 | 行号 | 现状 | 应有 |
|---|---|---|---|---|
| 12 | `docs/prd/children.md` Status + Problem Statement | 2-3, 11-17 | Status 标 `ready-for-agent`；Problem Statement 描述"落地前"痛点 | Status 改为 "✅ shipped" + commit 引用；Problem Statement 段保留（描述历史痛点合理），但加 "**Status update 2026-06-29**" 段说明已落地 |
| 13 | `docs/prd/children.md` 引用段 | 16-17 | 引用 problems.md §Prereq 和 CONTEXT.md §5 作为"未达成"上下文 | 引用 problems.md §Prereq 和 CONTEXT.md §5 处加 "[已兑现]" 标注 |

### 2.5 代码 doc 注释陈旧（1 条 — 反对者审计发现）

| # | 文档 | 行号 | 现状 | 应有 |
|---|---|---|---|---|
| 14 | `src/storage/storage.module.ts` | 17-23 | doc 注释说"future modules (e.g. **`ChildrenModule`**) can inject `STORAGE_SERVICE`"——但 `ChildrenModule` 不 inject `STORAGE_SERVICE`（`ChildrenService` 只 inject `PrismaService`）。实际触发 `@Global()` 升格的 second consumer 是 `JanitorModule`（见 `003-amended-body.md:36` Amendment log） | 改一处：`ChildrenModule` → `JanitorModule` |

---

## 3. 共同根因

代码侧两个关键 commit（`03873cb` @Global() 升格、`11f4967` ChildrenModule + fixtures 迁移同批）落地后，**文档同步只完成了部分**：

- **`003-amended-body.md`**：做了 3 处实质修正（MIME 白名单移除 GIF、`@Global()` 状态标为「已 lift」、acceptance criteria 全部勾上），但对其最显眼的一处过时（fixture 策略段）只做了"自承"标注，未做实质修正——且该标注本身（"本片未做切换"）也因代码同批迁移而过期。
- **`CONTEXT.md` / `children.md` / `001` issue**：完全未做同步。
- **`src/storage/storage.module.ts:20`**：doc 注释把 `ChildrenModule` 错标为 second consumer（实为 `JanitorModule`）——**代码 doc 注释也是文档，但没有任何同步机制**（既无 amendment log，也无自承/反查流程）。

代码侧有 **4 处独立位置已自承 `@Global()` 升格**（`app.module.ts:20-22`、`anthropic.module.ts:9-12`、`storage.module.ts:17-20`、`problems.module.ts:18-20`）——这些都是 doc 注释/块注释形式的自承，**但它们没有同步路径**到 `CONTEXT.md`（`CONTEXT.md` 自身没有"@Global() since"或 amendment log 机制）。`fixtures/child.ts` 在 commit `11f4967` 中已同批切到 `POST /children`，**也**没有任何文档/issue 反映这一事实。**这 4 处 `@Global()` 自承加上 fixture 迁移，共 5 处代码侧事实，是分散的、非集中式的，没有任何机制保证它们触达 canonical source (`CONTEXT.md`)**。

---

## 4. 处理方向（待选）

| 选项 | 适用 | 工作量 | 风险 |
|---|---|---|---|
| **A. 立即修文档**（5 文件、14 处编辑） | 本周内还想动这块 | 中 | 一次 PR 改 5 文件可能违反单 concern 惯例 |
| **B. 拆分 PR 按文件走** | 想要"小步可审" | 中-高 | 跨 5 个 PR 容易漏；需要 tracking issue（本文件充当） |
| **C. 仅在 `CONTEXT.md` 顶部加 Known doc drift 段** | 文档混乱是常态、没精力管 | 极低 | 修文工作无限期积压 |

**推荐 B**（拆分 PR + 本文件做 tracking issue）。理由：

1. 14 条修改分散在 5 个文件，**单 PR 改 5 文件违反"`docs/` 单 concern"惯例**，review 会被问"这次 PR 的 scope 是什么"
2. 003 amended body 的 Amendment log 模式已显示：**文档同步属"事件后批量刷新"动作**，走单独 issue 更顺
3. 拆分粒度建议（5 PR）：
   - **PR-1**: `CONTEXT.md` 4 处（#1, #4, #5, #11）—— 单一文件、易审
   - **PR-2**: `003-problems-phase-2-backlog.md` + `003-amended-body.md` 2 处（#3, #9a）—— 跨 2 个 003 关联文件，backlog 改 line 24 + amended 主体+inline+amendment log 三层改
   - **PR-3**: `problems.md` 3 处（#2, #6, #7）—— 1 文件 3 处
   - **PR-4**: `children.md` + `001` issue 共 4 处（#8, #10, #12, #13）—— 跨 2 文件，children 主修 + 001 同步
   - **PR-5**: `src/storage/storage.module.ts` 1 处（#14）—— 1 文件 1 词（`ChildrenModule` → `JanitorModule`）
4. 功能层 0 影响——Children 已落地、@Global() 已生效、fixture 已切、e2e 24/24 通过——纯文档卫生

---

## 5. 附录 A：审计迭代过程

| 轮次 | 冲突数 | 关键变化 |
|---|---|---|
| 用户初始报告 | 17 | — |
| 第一轮核对 | 17 | 16/17 引用准确，#13 措辞偏差；#9 拆为 9a/9b |
| 第二轮裁定 | 14 | 合并 #11+#12+#13、#14+#15、#16+#17；#9 拆 9a/9b；#10 反转（fixture 迁移证据） |
| 本报告定稿 | 14 | 合并 #9b 进 #10（同一事实两个侧）→ 13 条；反对者审计追加 §2.5（`storage.module.ts` doc 注释）→ 14 条；同时修复 §2.4 拆分（`#12` = 14+15，`#13` = 16+17）以保持内部计数一致 |

## 6. 附录 B：自修正程度的精确描述

003 amended body 做了 **3 处实质修正 + 1 处未修正的过期标注**：

| 修正位置 | 类型 |
|---|---|
| MIME 白名单移除 GIF（line 83-84） | 实质 |
| `@Global()` 状态标为「已 lift」（line 85） | 实质 |
| Acceptance criteria 全部勾上（line 85） | 实质 |
| Children fixture 段："本片未做切换"（line 57） | 标注动作，且**标注本身已过期** |

003 amended body 的自修正**有但不全**——最终版本不应说"自修正程度 = 0"，那是过头表述。

---

## 5. Resolution (2026-06-30)

全部 14 条 + 1 条代码 doc 注释 (storage.module.ts) 在 commit `82bee16` 同批解决：
- 5 文件、~590 行改动（4 文档 + 1 注释 + 1 schema enum drop + 1 新 e2e + 2 service 重构 + 1 test 同步）。
- 本文件推荐的"PR-1..PR-5 拆分"方案**未**采用——按用户指示"在 test-flue 上本地 commit，不推 PR / 不合 main"，全部打包为一个本地 commit（`82bee16`）。本审计作为 tracking issue 使用——功能层已闭环，doc 侧同步一次性完成。
- 后续 housekeeping pass（commit `c26f0cb`）把 002/003/009 + children.md 的 stale frontmatter 一起关掉。
- 本审计历史价值：留作 doc-drift 复盘样本（"代码先行、文档分散自承"反模式）；不再阻塞任何 `/implement`。

---

## Amendment log

- **2026-06-30**：shipped. Commit `82bee16 chore(schema): drop OCR-era EnumStatus zombies + sync docs` 一并解决全部 14 条审计项 + 1 条 doc 注释修正。`docs/issues/003-amended-body.md` 的所有自修正条目被 commit `82bee16` 替代为正式 doc sync（不再用"自承"标注）。Frontmatter status sync (`open` → `shipped`) per housekeeping pass。

---

*End of audit.*
