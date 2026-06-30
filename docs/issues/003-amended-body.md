## What to build

Problems 模块的第一片 vertical slice：把题目图传上来、能再读回去。**不接 LLM**，stream 端点本片不建。

**端到端路径**：

```
client → JwtAuthGuard → Multer 内存解析
       → ProblemsController.POST
       → ProblemsService.create
         ├─ childId IDOR 校验（不属于我 → 404 `child 不存在`）
         ├─ prisma.problem.create({ imageUrl: '', status: 'pending' })
         ├─ StorageService.put → ./uploads/problems/<userId>/<uuid>.<ext>
         ├─ prisma.problem.update({ imageUrl: <key> })
         └─ 失败回滚：status='failed' + best-effort storage.delete
       → 201 { id, childId, imageUrl: '/problems/${id}/image', status: 'pending', createTime }
```

**新增/扩展**：

- `StorageService` 接口（`put / delete / read`）+ `LocalDiskStorageService` + `StorageModule`
- `ProblemsController`（3 端点）+ `ProblemsService.create / getOne / getImage`
- Multer `FileInterceptor`：`limits.fileSize = 10 * 1024 * 1024`、`fileFilter` 限 JPEG/PNG/WEBP、`LIMIT_FILE_SIZE` 转中文 `图片过大，最大 10MB`、坏 MIME 转 `不支持的图片格式: <mimetype>，仅允许 JPEG/PNG/WEBP`
- 测试脚手架：`test/problems/fixtures/{user,child}.ts`、`tiny.png`（≈70 字节 1×1 白 PNG）、`afterEach` 清理 `./uploads/problems/<userId>/`

**沿用**（已就位，不要改）：`@RawResponse()` 装饰器、`WrapResponseInterceptor`、`AllExceptionsFilter`、`JwtAuthGuard`、`PrismaModule`、`ConfigModule`。

**IDOR 策略**：任何"不属于当前用户"的资源都返回 `404 <资源> 不存在`（不复用 403，避免枚举）。

**响应里的 `imageUrl`**：始终是 API 路径 `/problems/${id}/image`（**不是** DB 列里的 storage key）。DB 列是内部细节，对外屏蔽。

**`getImage` 状态守卫**：若 `problem.status === 'failed'` → 404 `problem 不存在`（兜底 POST 第 4 步失败后留下的 imageUrl 占位）。

## Locked decisions（来自 PRD + CONTEXT.md，已修订对齐）

| 关注点 | 值 |
|---|---|
| 存储路径 | `./uploads/problems/<userId>/<uuid>.<ext>`（`process.cwd()` 相对） |
| MIME 白名单 | `image/jpeg`、`image/png`、`image/webp`（**无 GIF**，对齐 CONTEXT.md Q2/G1/§5 D4 已合入） |
| 文件大小上限 | 10 MB |
| `childId` 校验 | 非整数 → 400 `childId 必须是整数`；≤0 → 400 `childId 必须大于 0` |
| `child 不存在`（含 IDOR miss） | 404 `child 不存在` |
| `problem 不存在`（含 IDOR miss + failed 状态） | 404 `problem 不存在` |
| DB-first 顺序 | create → storage.put → update；任何中间步骤失败 → `status='failed'` |
| 图片 URL 在响应里的形态 | API 路径 `/problems/${id}/image`（不是 DB 列） |
| 子模块所有权 | `StorageService` / `StorageModule` 本片引入并独占 |
| 全局性 | **已 lift `@Global()`**（commit `03873cb`）。门控条件 ChildrenModule 已落地（commit `11f4967`）→ CONTEXT.md §1.3 字面条件满足；JanitorModule 是第二个 consumer（commit `aa43e98`），PRD §Deferred Items #3 的 intent 也满足。 |
| `StorageService.put` 签名 | `put({ buffer, mime, originalName?, userId }): Promise<{ url, key }>` | **偏离 PRD 签名**：PRD 第 152-156 行未含 `userId`，但 key 路径 `problems/<userId>/<uuid>.<ext>` 需 userId。**由 `ProblemsService.create` 显式传入**（从 JWT 拿），不要走 AsyncLocalStorage 或隐式注入 |
| `StorageService.put` 返回值 | `{ url: 'problems/<userId>/<uuid>.<ext>', key: 同左 }` | 相对路径（不含 host），调用方按需拼 `baseURL` |
| `StorageService.delete` 错误处理 | 失败 → warn 日志，**不抛** | best-effort；DB 行 `status='failed'` 是兜底 |
| Multer 类型 | `@types/multer` 加到 `devDependencies` | multer 运行时由 `@nestjs/platform-express` 传递依赖，**不需要**显式装；类型需单独装 |

## Children fixture 策略

PRD 明确规定 `ChildrenModule` 尚未落地。e2e 测试 **直接** `prisma.child.create({ data: { name, grade, userId } })`（默认 name `'测试娃'`、grade `5`），`afterEach` 清理。**不要**试图走 HTTP 端点创建 child。

> 注：ChildrenModule 现已落地（commit `11f4967`），后续 e2e 可切换到 `POST /children`。本片未做切换属于历史债务，不影响 slice 1 验收。

## Acceptance criteria

- [x] `pnpm test:e2e -- --testPathPattern=problems` 中以下用例全过：#1, #2, #3, #4, #5, #6, #7, #9, #12（含后续补的 #8 写盘失败 + #11c/d stream 扩展）
- [x] `pnpm test:e2e -- --testPathPattern=auth` 仍全过（无回归）
- [x] `pnpm lint` 干净，`pnpm build` 干净，`pnpm exec tsc --noEmit` 干净
- [x] 手工 smoke：注册 → 建 Child（直接 prisma）→ 上传 tiny.png → 收到 201 + `data.id` + `data.imageUrl='/problems/<id>/image'` → `GET /problems/:id` 看到 `status: 'pending'` → `GET /problems/:id/image` 拿到原始 bytes + 正确 `Content-Type`
- [x] 上传 11 MB 文件 → 400 `图片过大，最大 10MB`
- [x] 上传 HEIC MIME → 400 `不支持的图片格式: image/heic，仅允许 JPEG/PNG/WEBP`（**GIF 也在拒绝白名单**，code 在 `src/problems/upload/multer-options.ts:29-33`）
- [x] 上传无 `image` 字段 → 400 `请上传题目图片`
- [x] 用别人的 childId 上传 → 404 `child 不存在`（不是 403）
- [x] `GET /problems/<不存在的id>` → 404 `problem 不存在`
- [x] `GET /problems/<别人的id>` → 404 `problem 不存在`（不是 403）
- [x] 写盘失败路径存在（e2e case #8 覆盖）：DB 行落 `status=failed`、文件不残留、`storage.delete` best-effort（warn 日志即可）
- [x] 测试每次 `afterEach` 清理 `./uploads/problems/<userId>/*`（不污染下一次用例）
- [x] `.gitignore` 增加 `uploads/` 避免本地测试产物入库

## Blocked by

None —— `AuthModule` 已落地、`Prisma schema` 已就位、`@RawResponse` 装饰器已就位。

---

## Amendment log

- **2026-06-30**：按 CONTEXT.md（项目 canonical source per `docs/agents/domain.md`）校准本 issue body 的两处 stale locked decision：
  - **MIME 白名单移除 GIF** — CONTEXT.md Q2/G1/§4 drift 表（line 149，明确标注「⚠️ CONTEXT 砍 GIF（待 PRD 同步修订）」）+ §5 推进清单 D4（line 166，✅ 已合入）。代码自 `433d43b` 起即拒绝 GIF（`src/problems/upload/multer-options.ts:29-33`、`src/problems/problem-solver.service.ts` 的 MIME union）。
  - **`@Global()` 决策标为「已 lift」** — 实际 lift 在 commit `03873cb`（理由：JanitorModule 是第二个 consumer），CONTEXT.md §1.3/§6 字面门控条件 ChildrenModule 在 commit `11f4967` 落地后亦满足（晚于 lift 1.5h）。inline 注释（`storage.module.ts:17`、`anthropic.module.ts:9`）、backlog 文件 `docs/issues/003-problems-phase-2-backlog.md`、commit message 三处记录 override。
- **2026-06-30**：acceptance criteria 全部勾上（24/24 problems e2e pass，auth 回归 15/15 pass，lint 0 errors，build clean）。