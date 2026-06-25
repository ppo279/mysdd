# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目性质

家长端作业辅导应用。家长注册账号，给孩子建立档案，上传题目图片，后端做 OCR → 调用大模型生成解题思路。**Domain**: EdTech / OCR pipeline / multi-tenant family data。

## 技术选型

| 层 | 选型 | 版本 | 备注 |
|---|---|---|---|
| 框架 | NestJS | 11.x | 装饰器风格 DI |
| ORM | Prisma | 7.8.x | **必须用 `prisma-client-js` generator**（见下方陷阱） |
| 数据库 | PostgreSQL | 18+（`postgres:latest`） | 通过 docker-compose 起 |
| 包管理 | pnpm | 11.x | workspace 配置见 `pnpm-workspace.yaml` |
| 配置 | `@nestjs/config` | 4.x | 全局模式（`isGlobal: true`） |
| Node | Node.js | 24.x | ⚠️ 见下方陷阱 |

## 常用命令

```bash
# 开发
pnpm start:dev               # watch 模式跑 Nest
pnpm start                   # 单次启动

# 测试
pnpm test                    # jest unit tests (rootDir: src)
pnpm test:e2e                # jest e2e (test/jest-e2e.json)
pnpm test:cov                # coverage

# Lint / format
pnpm lint                    # eslint --fix
pnpm format                  # prettier

# 数据库
docker compose up -d         # 启动 PG（容器名 nest-postgres，端口 127.0.0.1:5432）
docker compose down -v       # 停 + 删卷（清空数据）
docker exec nest-postgres psql -U app_user -d nest_app
pnpm exec prisma generate    # 重新生成 Prisma Client
pnpm exec prisma migrate dev --name <name>   # 创建迁移（首次或新增 model）
pnpm exec prisma studio      # GUI 看数据

# Build
pnpm build                   # nest build → dist/
pnpm start:prod              # node dist/main
```

## 架构总览

```
┌─────────────────────┐     ┌────────────────────┐
│  NestJS (host)      │────▶│  Postgres 容器     │
│  pnpm start:dev     │     │  nest-postgres     │
│  localhost:3000     │     │  127.0.0.1:5432    │
└─────────────────────┘     └────────────────────┘
        │                            │
        │ ConfigModule               │ POSTGRES_USER/PASSWORD/DB
        │ (env: .env)                │ (env: 同 .env)
        ▼                            ▼
  PrismaModule (Global)       数据库 nest_app
    └─ PrismaService           + extensions: pgcrypto/citext/pg_trgm
       └─ PrismaClient
          └─ datasourceUrl: env.DATABASE_URL
```

**关键模块**：
- `src/prisma/prisma.module.ts` — `@Global()` 模块，只导出 `PrismaService`
- `src/prisma/prisma.service.ts` — `extends PrismaClient`，构造时通过 `ConfigService.getOrThrow('DATABASE_URL')` 注入；`OnModuleInit/Destroy` 钩子管理 `$connect/$disconnect`
- `src/app.module.ts` — `ConfigModule.forRoot({ isGlobal: true })` + `PrismaModule`（只 imports 一次）
- `prisma/schema.prisma` — datasource 配置在 **`prisma.config.ts`**（不是 schema 里），URL 取 `process.env["DATABASE_URL"]`

## 数据模型

四张核心表，业务关系：**User ──1:N── Child ──1:N── Problem ──1:N── Solution**

| Model | 关键字段 | 说明 |
|---|---|---|
| `User` | id, email (unique), passwordHash, createTime, updatedAt | 家长账号 |
| `Child` | id, name, grade, userId → User | 孩子档案 |
| `Problem` | id, imageUrl, ocrText?, status (EnumStatus), childId → Child | 题目 + OCR 状态机 |
| `Solution` | id, content, model?, token?, problemId → Problem | LLM 生成的解题思路 |
| `EnumStatus` | pending / ocr_processing / ocr_done / solving / done / failed | Problem 的处理流水线状态 |

**字段名拼写注意**：模型叫 `Child`（不是 `Chile`），关联字段叫 `children`（不是 `childs`）—— 这俩名字都容易写错，schema 里已修正。

## .env 文件约定

`.env`（**gitignored**）和 `.env.example`（**提交**）内容同步：

```bash
POSTGRES_USER=app_user            # docker-compose 和 Nest 都读
POSTGRES_PASSWORD=change_me       # 同上
POSTGRES_DB=nest_app              # 同上
DATABASE_URL=postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:5432/${POSTGRES_DB}
NODE_ENV=development
PORT=3000
APP_NAME=nest-app
```

**单一真相源**：`POSTGRES_USER/PASSWORD/DB` 和 `DATABASE_URL` 在 .env 里手写同步（不用变量展开，因为 pnpm/dotenv 默认不展开 ${VAR}）。`localhost` 是因为 Nest 在主机跑、PG 容器把端口映射到主机。

## docker-compose.yml 要点

- 镜像：`postgres:latest`（PG 18+）
- 端口：`127.0.0.1:5432:5432`（只绑本机，不暴露公网）
- 卷：`pgdata`（named volume，由 Docker 管理）
- 重启：`unless-stopped`
- ⚠️ **PG 18+ 数据目录约定变更**：挂 `/var/lib/postgresql`（父目录），不要挂 `/var/lib/postgresql/data`。否则容器循环重启并报错"data in unused mount/volume"。详见 [docker-library/postgres#37](https://github.com/docker-library/postgres/issues/37)
- 初始化：`./db/init:/docker-entrypoint-initdb.d:ro` 挂载，**仅在数据卷为空时**自动执行
- `db/init/01-extensions.sql` 安装：`pgcrypto`、`citext`、`pg_trgm`（都 `IF NOT EXISTS` 幂等）

## ⚠️ 已知陷阱

### 1. Prisma 7 generator 选型

**必须**用 `prisma-client-js`：

```prisma
generator client {
  provider = "prisma-client-js"
}
```

**不要用**新生成器 `prisma-client`（带 `output = "..."` 的那种）。它的产物混用 CJS `exports` 和 ESM `import.meta.url`，Node 24 的模块检测会判为 ESM，导致 `ReferenceError: exports is not defined in ES module scope`。症状：

```
file:///.../dist/generated/prisma/client.js:38
Object.defineProperty(exports, "__esModule", { value: true });
                      ^
ReferenceError: exports is not defined in ES module scope
```

如果未来要用 ESM，需要整个项目切 `"type": "module"`，**那是另一个 PR 的工作**。

### 2. Prisma 7 PrismaClient 必须用 Driver Adapter（不能传 datasourceUrl）

Prisma 7 移除了 `datasourceUrl` 选项。`PrismaClientOptions` 现在是 mutually exclusive：

```ts
type PrismaClientMutuallyExclusiveOptions =
  | { adapter: SqlDriverAdapterFactory; accelerateUrl?: never }
  | { accelerateUrl: string; adapter?: never };
```

正确写法（用 `@prisma/adapter-pg`）：

```ts
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

constructor(config: ConfigService) {
  const connectionString = config.getOrThrow<string>('DATABASE_URL');
  const adapter = new PrismaPg({ connectionString });
  super({ adapter });
}
```

如果传 `datasourceUrl` 会报 TS 错误：

```
error TS2353: Object literal may only specify known properties,
and 'datasourceUrl' does not exist in type 'Subset<PrismaClientOptions, ...>'.
```

并且 `prisma migrate` 也会卡（注意 Prisma 文档当前是过时的）。

### 3. Prisma datasource URL 不在 schema 里

Prisma 7 新架构下，datasource 在 `prisma.config.ts` 里取：

```ts
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
```

`schema.prisma` 的 `datasource db` 块**不要**加 `url = env(...)`，会跟 prisma.config.ts 冲突。

### 4. pnpm workspace 必须显式允许 Prisma build

`pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@prisma/engines': true
  prisma: true
  unrs-resolver: true
```

否则 pnpm 11 拒绝执行 Prisma 的 postinstall（下载 query engine）。

### 5. PG 18+ 卷挂载路径

见上方 docker-compose 要点。

### 6. Prisma 7 Studio 不可用（Node 24 stream bug）

`pnpm exec prisma studio` 会启动 UI 监听 `localhost:51212`，HTML 能加载，但**所有 `/api/*` 端点返回 404**，控制台抛：

```
Error [ERR_STREAM_UNABLE_TO_PIPE]: Cannot pipe to a closed or destroyed stream
```

这是 Prisma 7 Studio（React 重写版）的 Node 24 stream 兼容问题，**目前没有 workaround**。

**替代方案（按推荐顺序）**：

1. **psql**（推荐，零依赖）：

```bash
docker exec -it nest-postgres psql -U app_user -d nest_app
# 在 prompt 里：
\dt                                  # 列表
SELECT * FROM "User";               # 查
\d "User"                           # 表结构
\dx                                  # 扩展
\q                                   # 退出
```

⚠️ Prisma 默认表名是 **PascalCase 单数 + 双引号**：`"User"`、`"Child"`、`"Problem"`、`"Solution"`、字段如 `"passwordHash"`、`"createTime"`。**大小写敏感，必须加引号**。

2. **外部 GUI**（DBeaver / pgAdmin / TablePlus）：连 `localhost:5432`，用户/密码见 `.env`。

3. **降 Prisma 到 v6**（不推荐，会失去 Prisma 7 的新功能）。

## 尚未完成的工作

- ❌ **业务模块仍空**：除 `AuthModule` 外没有其他业务路由（无 `/auth/login`、无 child/problem/solution CRUD）。

## 已完成

- ✅ PG 容器启动 + 三个扩展安装（pgcrypto/citext/pg_trgm）
- ✅ 首份 Prisma 迁移 `20260625075017_init` 已 apply，User/Child/Problem/Solution 四张表已建
- ✅ Nest 启动验证通过（PrismaService 用 `@prisma/adapter-pg` 适配器模式连上 PG）
- ✅ **Auth 实现**：`POST /auth/register` 端到端通过（创建用户、bcrypt 哈希、友好报错、Prisma 唯一约束转 409）。详见下文「Auth 实现」。

## Auth 实现（已落地）

### 文件结构
```
src/auth/
├── auth.module.ts        ← @Module 注册 controller + service
├── auth.controller.ts    ← @Controller('auth') + POST /register
├── auth.service.ts       ← bcrypt.hash + prisma.user.create + 409 错误处理
└── dto/
    └── register.dto.ts   ← class-validator 装饰器 + 中文消息
```

### 关键约定

| 关注点 | 选择 | 备注 |
|---|---|---|
| 密码哈希 | bcrypt，12 rounds | `$2b$12$...` 前缀，长度 60 |
| 重复邮箱 | 捕获 Prisma `P2002` 错误码 → 抛 `ConflictException` (409) | 不先查再插（避免 TOCTOU） |
| 校验位置 | 全局 `ValidationPipe` + `forbidNonWhitelisted: true` | 防止传额外字段污染 |
| 错误消息 | 中文，DTO 装饰器里 inline 写 | 简单粗暴，将来 i18n 再抽 |

### 端点速查
| 方法 | 路径 | 入参 | 成功 | 失败 |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | 201 `{id,email,createTime}` | 400 / 409 / 500 |

### 全局 ValidationPipe 配置（main.ts）
```ts
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) => {
    const messages = errors.map((err) => {
      const field = err.property;
      const reasons = Object.values(err.constraints ?? {}).join('；');
      return `${field}：${reasons}`;
    }).join('\n');
    return new BadRequestException(messages);
  },
});
```

### 验证清单（6 项全部通过）
| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 1 | 正常注册 | 201 + 用户 | ✅ |
| 2 | 邮箱格式错 | 400 中文提示 | ✅ |
| 3 | 密码太弱 | 400 列出所有规则违反 | ✅ |
| 4 | 缺字段 | 400 中文提示 | ✅ |
| 5 | 邮箱重复 | 409 中文提示 | ✅ |
| 6 | 未知字段 | 400 拒绝 | ✅ |

密码 DB 验证：`hash_prefix = $2b$12$`、`hash_len = 60` ✅

## 关键文件路径

| 文件 | 作用 |
|---|---|
| `prisma/schema.prisma` | 业务模型定义 |
| `prisma.config.ts` | Prisma 7 新配置入口 |
| `src/prisma/prisma.service.ts` | Nest 端 Prisma 单例 |
| `src/prisma/prisma.module.ts` | 全局模块 |
| `src/app.module.ts` | 根模块（`ConfigModule` + `PrismaModule` + `AuthModule`） |
| `src/main.ts` | bootstrap + 全局 `ValidationPipe`（友好报错） |
| `src/auth/*` | Auth 模块（DTO + Service + Controller + Module） |
| `docker-compose.yml` | PG 容器编排 |
| `db/init/01-extensions.sql` | 首次启动装扩展 |
| `.env` / `.env.example` | 环境变量（前者 gitignored） |
| `pnpm-workspace.yaml` | workspace + allowBuilds（`prisma` / `@prisma/engines` / `bcrypt`） |