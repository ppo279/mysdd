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
          └─ adapter: PrismaPg({ connectionString: env.DATABASE_URL })
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

### 7. 登录防枚举的占位 hash 必须用真 hash，不能硬编字符串

`POST /auth/login` 在"邮箱不存在"分支里仍要跑一次 `bcrypt.compare`，让两条失败路径耗时一致（防止通过响应时间枚举已注册邮箱）。最 naive 的写法是硬编一串看上去像 hash 的字符串：

```ts
// ❌ 千万别这样
await bcrypt.compare(password, '$2b$12$............................................................');
```

坑：合法 bcrypt 是 60 字符（`$2b$XX$` + 22 盐 + 31 hash），而这串点数量 = 60 但**是无效字符**。它"能工作"完全是因为你用的 bcrypt 实现碰巧容忍了畸形输入、照样按 cost=12 跑完 KDF。换成 `bcryptjs`、或 bcrypt 升级、或换实现路径，**可能直接短路返回 false，耗时归零**——防御静默失效，没有任何报错。

✅ 正确写法：模块加载时用 `bcrypt.hashSync` 预生成一个真 hash，cost 与生产一致：

```ts
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', BCRYPT_ROUNDS);

// 用户不存在分支：
await bcrypt.compare(password, DUMMY_HASH);
throw new UnauthorizedException('邮箱或密码错误');
```

代价：模块加载多花 ~250ms（一次性）。收益：合法 hash、同 cost、不依赖任何实现对畸形串的容忍度。

回归测试思路：bcrypt 是 native 模块，`jest.spyOn(bcrypt, 'compare')` 会报 `TypeError: Cannot redefine property: compare`。改用 wall-clock 时间做粗略校验（3 次 not-found login 总耗时 > 150ms），见 `test/auth/auth.e2e-spec.ts` 的 `timing defense` 用例。

## 尚未完成的工作

- ❌ **业务模块仍空**：除 `AuthModule` 外没有其他业务路由（无 child/problem/solution CRUD）。

## 已完成

- ✅ PG 容器启动 + 三个扩展安装（pgcrypto/citext/pg_trgm）
- ✅ 首份 Prisma 迁移 `20260625075017_init` 已 apply，User/Child/Problem/Solution 四张表已建
- ✅ Nest 启动验证通过（PrismaService 用 `@prisma/adapter-pg` 适配器模式连上 PG）
- ✅ **Auth 实现**：`register` + `login` + `me` 三个端点全过，e2e 16 项全绿。详见下文「Auth 实现」。

## Auth 实现（已落地）

### 文件结构
```
src/auth/
├── auth.module.ts             ← @Module 注册 controller + service + JwtModule
├── auth.controller.ts         ← @Controller('auth') + POST /register / POST /login / GET /me
├── auth.service.ts            ← register / login / me + DUMMY_HASH 防枚举
├── dto/
│   ├── register.dto.ts        ← class-validator 装饰器 + 中文消息
│   └── login.dto.ts           ← 复用 RegisterDto 形状（email + password）
└── guards/
    └── jwt-auth.guard.ts      ← 验证 Authorization: Bearer，挂 req.user
```

### 关键约定

| 关注点 | 选择 | 备注 |
|---|---|---|
| 密码哈希 | bcrypt，12 rounds | `$2b$12$...` 前缀，长度 60 |
| 重复邮箱 | 捕获 Prisma `P2002` 错误码 → 抛 `ConflictException` (409) | 不先查再插（避免 TOCTOU） |
| 校验位置 | 全局 `ValidationPipe`（`src/common/validation.ts` 工厂） + `forbidNonWhitelisted: true` | 防止传额外字段污染；main.ts 和 e2e 测试共用同一工厂，保证错误格式一致 |
| 错误消息 | 中文，DTO 装饰器里 inline 写 | 简单粗暴，将来 i18n 再抽 |
| JWT | `@nestjs/jwt`，HS256，secret 来自 `process.env.JWT_SECRET` | expiresIn 来自 `JWT_EXPIRES_IN`（默认 7d） |
| JWT payload | 只放 `userId` + `email` | **绝不**放 password / passwordHash |
| 防邮箱枚举 | login 的 "user not found" / "wrong password" 两条分支：① 同样的中文错误消息 `邮箱或密码错误`；② 同样的 bcrypt.compare 时长 | 关键：占位 hash 必须用 `bcrypt.hashSync` 预生成真 hash（见陷阱 #7） |

### 端点速查
| 方法 | 路径 | 入参 | 成功 | 失败 |
|---|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | 201 `{id,email,createTime}` | 400 / 409 / 500 |
| POST | `/auth/login` | `{ email, password }` | 200 `{accessToken}` | 400 / 401 |
| GET | `/auth/me` | `Authorization: Bearer <jwt>` | 200 `{id,email,createTime}` | 401 |

### 全局 ValidationPipe 配置（`src/common/validation.ts`）

单点真相：main.ts 和 e2e 测试的 bootstrap 都调用 `buildValidationPipe()`，保证两边的错误格式完全一样（否则会出现"测试过、生产挂"的尴尬）。

```ts
new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  exceptionFactory: (errors) => {
    const messages = errors
      .map((err) => {
        const field = err.property;
        const reasons = Object.values(err.constraints ?? {}).join('；');
        return `${field}：${reasons}`;
      })
      .join('\n');
    return new BadRequestException(messages);
  },
});
```

### e2e 验证清单（16 项全绿，`test/auth/auth.e2e-spec.ts`）

#### POST /auth/register（4 项）
| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 1 | 正常注册 | 201 + 用户，不含 passwordHash | ✅ |
| 2 | 邮箱格式错 | 400 中文提示 | ✅ |
| 3 | 密码太弱 | 400 列出所有规则违反 | ✅ |
| 4 | 重复邮箱 | 409 中文提示 | ✅ |

#### POST /auth/login（7 项）
| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 5 | 正确凭证 | 200 + accessToken（JWT 三段式） | ✅ |
| 6 | JWT payload 含 userId+email，不含 password | ✅ |
| 7 | 错密码 | 401 `邮箱或密码错误` | ✅ |
| 8 | 不存在的邮箱 | 401 **同样** `邮箱或密码错误`（防枚举） | ✅ |
| 9 | 缺 password | 400 | ✅ |

#### 防枚举时序防御（1 项）
| # | 场景 | 实测 |
|---|---|---|
| 10 | 3 次 not-found 登录总耗时 > 150ms（说明占位 hash 是真 hash、不是被畸形短路） | ✅ |

#### GET /auth/me（5 项）
| # | 场景 | 期望 | 实测 |
|---|---|---|---|
| 11 | 合法 Bearer | 200 + 当前用户（不含 passwordHash） | ✅ |
| 12 | 缺 Authorization | 401 中文 | ✅ |
| 13 | Authorization 无 Bearer 前缀 | 401 中文 | ✅ |
| 14 | 篡改签名 | 401 `token 无效或已过期` | ✅ |
| 15 | 乱码 token | 401 `token 无效或已过期` | ✅ |

> 密码 DB 验证：`hash_prefix = $2b$12$`、`hash_len = 60` ✅

> **一个原本想加但跑不通的测试**：`jest.spyOn(bcrypt, 'compare')` 试图验证 not-found 路径"真的调了 bcrypt.compare"——失败抛 `TypeError: Cannot redefine property: compare`，因为 `bcrypt` 是 native 模块，导出属性 non-configurable。改用 wall-clock 时间做粗略回归（见 #10）。真要"严格"验证，应该把 `bcrypt` 抽成 Nest provider 注入——目前没做。

## 关键文件路径

| 文件 | 作用 |
|---|---|
| `prisma/schema.prisma` | 业务模型定义 |
| `prisma.config.ts` | Prisma 7 新配置入口 |
| `src/prisma/prisma.service.ts` | Nest 端 Prisma 单例（`@prisma/adapter-pg`） |
| `src/prisma/prisma.module.ts` | 全局模块 |
| `src/common/validation.ts` | `buildValidationPipe()` 工厂（main.ts 和 e2e 共用） |
| `src/app.module.ts` | 根模块（`ConfigModule` + `PrismaModule` + `AuthModule`） |
| `src/main.ts` | bootstrap + 全局 `ValidationPipe` |
| `src/auth/*` | Auth 模块（DTO + Service + Controller + JwtModule + Guard） |
| `test/auth/auth.e2e-spec.ts` | 16 项 e2e 测试 |
| `docker-compose.yml` | PG 容器编排 |
| `db/init/01-extensions.sql` | 首次启动装扩展 |
| `.env` / `.env.example` | 环境变量（前者 gitignored） |
| `pnpm-workspace.yaml` | workspace + allowBuilds（`prisma` / `@prisma/engines` / `bcrypt` / `unrs-resolver`） |

## Agent skills

### Issue tracker

GitHub Issues on `ppo279/mysdd`. External PRs are NOT a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles with default strings: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

> Local PRD / issue drafts: see `docs/prd/*.md` and `docs/issues/*.md` — these are the source material published to GitHub Issues (do not double-write).