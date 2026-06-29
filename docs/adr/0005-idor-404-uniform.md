# ADR-0005: IDOR 防御采用 404 统一消息 + 单查询

- **Date**: 2026-06-29
- **Status**: Accepted
- **Source**: `/grill-with-docs` Q4

---

## Context（背景）

多租户家校应用的核心安全风险：**跨家长数据泄露**。攻击者拿到合法 JWT 后，可能通过遍历 `childId` / `problemId` 访问其他家庭的数据（IDOR — Insecure Direct Object Reference）。

面临三种 HTTP 响应策略：

| 候选 | "不存在" 响应 | "存在但不是你的" 响应 |
|---|---|---|
| A. 区分 | 404 | 403 |
| B. 都 403 | 403 | 403 |
| C. 都 404 | 404（统一消息） | 404（统一消息） |

子问题：**单查询 findFirst vs 双查询 findUnique + userId 比较**？

---

## Decision（决定）

**采用方案 C（都 404）+ 单查询 findFirst。**

### 实现

```ts
// childId 校验
const child = await prisma.child.findFirst({
  where: { id: childId, userId: req.user.userId },
});
if (!child) throw new NotFoundException('child 不存在');

// problemId 校验
const problem = await prisma.problem.findFirst({
  where: { id: problemId, child: { userId: req.user.userId } },
});
if (!problem) throw new NotFoundException('problem 不存在');
```

### 关键约束

1. **HTTP 消息**：404 + 中文 `<资源> 不存在`，**不区分**"不存在"和"不属于你"
2. **查询模式**：单条 `findFirst` 带复合 `where`，**不**分两步
3. **服务端日志**：用统一 `outcome: 'not_found_or_forbidden'` 字段，**不**区分 not_found vs forbidden（**日志也是攻击面**—— ELK / Loki 等日志系统如果权限不当，区分字段等于告诉攻击者哪些 id 存在）
4. **不暴露内部字段**：错误消息里**不**含 childId / problemId 的回显

---

## Consequences（影响）

### 收益
- ✅ 攻击者无法通过响应码/消息枚举其他家庭的资源 id
- ✅ 单查询省一半 DB 开销
- ✅ 零 TOCTOU 窗口（先查再验之间 child 可能被删/转户，单查询无此窗口）
- ✅ DB 查询日志的 WHERE 子句是混合条件（`WHERE id=? AND user_id=?`），即使数据库日志泄露，攻击者也无法复盘出"哪些 id 存在"

### 代价
- ❌ 调试时排障略麻烦（404 可能是"id 错"也可能是"权限错"，要靠 server log 区分）
- ❌ 第三方 API 文档工具（Swagger）无法自动生成"403 Forbidden"响应（业务上 403 不存在）
- ❌ 前端要"一律当作不存在处理"，不能根据状态码做不同 UI

### 反向条件（何时推翻）
- 应用从家长端扩展到学校端（多个 userId 共享资源），需要"我认识这个资源但无权"的语义 → 引入 403
- 日志基础设施加固（如日志加密 + 严格访问控制）后，可考虑区分字段辅助运维

---

## References

- 父 PRD：`docs/prd/problems.md` 第 209 / 217 行（404 消息）、第 177 行（单查询示例）
- Issue：`docs/issues/001-problems-upload-read-image.md`（Locked decisions 表）
- 决策来源：`CONTEXT.md` §2 Q4