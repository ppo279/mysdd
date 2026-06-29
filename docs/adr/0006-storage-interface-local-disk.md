# ADR-0006: Storage 层采用接口 + 本地磁盘实现

- **Date**: 2026-06-29
- **Status**: Accepted
- **Source**: `/grill-with-docs` Q3

---

## Context（背景）

Problems 模块需要存储家长上传的题目图（10MB 上限，MIME 白名单）。架构面临选择：

| 候选 | 描述 |
|---|---|
| A. 直接写 `LocalDiskStorageService` 一个类 | 简单，但调用方耦合具体实现 |
| B. 接口 `IStorageDriver` + `LocalDiskStorageService` 实现 | 多一层抽象，未来切 OSS/S3 只加实现 |
| C. 接口 + 本地 + S3 三个实现 | 一步到位，但当前只需要一个 |

子问题：
- multer 用 `diskStorage` 还是 `memoryStorage`？
- 存储路径结构（flat / 按 userId / 按 userId 分片 / 内容 hash）？
- IDOR miss / 上传失败时，已写盘的文件要不要清理？

---

## Decision（决定）

**采用方案 B：接口 + 本地实现。**

### 接口与实现

```ts
// src/storage/storage.service.ts（接口）
export interface StorageService {
  put(input: { buffer: Buffer; mime: string; originalName?: string; userId: number })
    : Promise<{ url: string; key: string }>;
  delete(key: string): Promise<void>;
  read(key: string): Readable;
}

// src/storage/local-disk-storage.service.ts（实现）
@Injectable()
export class LocalDiskStorageService implements StorageService {
  // 写 ./uploads/problems/<userId>/<uuid>.<ext>
  // url/key 同形（相对路径，不含 host）
}
```

### 关键约束

1. **`multer.memoryStorage()`**：10MB 内存可控；事务边界干净（Buffer 在内存，写盘失败可回滚 DB 行）
2. **存储路径**：`./uploads/problems/<userId>/<uuid>.<ext>`（`process.cwd()` 相对）
   - **`<uuid>` 而非 `<problemId>`**：避免路径泄露递增 ID
3. **`put` 签名显式 `userId`**：从 JWT 拿，**不**走 AsyncLocalStorage / 隐式注入（`001` issue 第 60 行明确）
4. **`put` 返回 `{url, key}`**：相对路径（不含 host），调用方按需拼 `baseURL`
5. **`delete` 错误处理 best-effort**：失败 → warn 日志，**不抛**（DB 行 `status='failed'` 是兜底）
6. **IDOR miss / 上传失败**：`storage.delete(key)` 清理已写盘文件
7. **`@Global()` 决策**：**不**升 `@Global()`，等 Children 落地后真有第二 consumer 再评估（003 #4 阻塞中）
8. **测试 fake**：`MemoryStorageDriver` 实现接口，写内存不碰盘

### 为什么是 `<uuid>` 而非 `<problemId>`

| 命名 | 问题 |
|---|---|
| `<problemId>` | 路径暴露自增 ID 规律，攻击者可枚举；上传→拿 id→写盘的 race window 里另一个请求可能复用路径 |
| `<uuid>` | 无规律；并发安全（每个请求独立 UUID） |

---

## Consequences（影响）

### 收益
- ✅ 切 OSS / S3 时只加 `S3StorageDriver` 实现，DI token 换一下，业务代码零改动
- ✅ 单测 fake `MemoryStorageDriver` 不碰盘，速度快
- ✅ e2e 用真实 `LocalDiskStorageService` 写 tmp 目录，可观察真实行为
- ✅ 路径不泄露自增 ID

### 代价
- ❌ 多 15 行接口代码 + 一个 DI token
- ❌ 路径里 `<uuid>` 比 `<problemId>` 调试不直观（不知道哪个文件对应哪个 problem，要查 DB）
- ❌ 文件清理是 best-effort，可能留 orphan file（DB 行失败 + 文件已写 → 删失败 → 孤儿）。phase 2 加 sweeper cron

### 反向条件（何时推翻）
- 用户量到 100w+，本地磁盘 IO / 备份 / CDN 都成问题 → 切 OSS，**保留接口，换实现**
- 多区域部署 → 跨区域复制需求 → 接口扩展 `region` 字段

---

## References

- 父 PRD：`docs/prd/problems.md` 第 149–162 行（StorageService 接口）、第 176–186 行（DB-first create order）
- Issue：`docs/issues/001-problems-upload-read-image.md` 第 33 行、第 50–63 行（locked decisions）
- 决策来源：`CONTEXT.md` §2 Q3