import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'

// 统一响应外壳：成功 {code:0, msg:'ok', data:T}；失败 {code:!=0, msg, data:null, traceId?}
// Implements: M0 统一 JSON 响应格式（envelope）
export type Envelope<T> = {
  code: number
  msg: string
  data: T | null
  traceId?: string
}

// 业务 code 分段：
// 0       = 成功
// 1xxxx   = 参数/通用
// 2xxxx   = 业务资源
// 3xxxx   = 外部依赖（CLI / git 等）
// 4xxxx   = 权限
// 5xxxx   = 兜底
export const Code = {
  OK: 0,
  BAD_REQUEST: 1000,
  ZOD_INVALID: 1001,
  MISSING_CONFIRM: 1002,
  PATH_TRAVERSAL: 1003,
  WORKFLOW_INVALID: 1011,
  NODE_ID_CONFLICT: 1012,
  CYCLE_DETECTED: 1013,
  AGENT_ID_CONFLICT: 1014,
  NODE_ID_MISMATCH: 1015,
  RUNTIME_NOT_REGISTERED: 1201,

  WORKSPACE_NOT_FOUND: 2001,
  FEATURE_NOT_FOUND: 2002,
  STAGERUN_NOT_FOUND: 2003,
  STAGERUN_NO_SESSION: 2004,
  WORKFLOW_NOT_FOUND: 2005,
  // Implements: docs/prd/0001-bug-fix-workflow.md (Issue 04)
  // GET /api/features/:id/audit-report when the gatekeeper has not run yet.
  AUDIT_REPORT_NOT_FOUND: 2006,
  REPO_DIR_EXISTS: 2101,
  REPO_DIR_NOT_EMPTY: 2102,
  REPO_MISSING_FOR_RUN: 2110,

  CLI_SPAWN_FAILED: 3101,
  CLI_EXIT_NONZERO: 3102,
  CLI_NO_SESSION_ID: 3103,
  GIT_CLONE_FAILED: 3201,
  GIT_SPAWN_FAILED: 3202,

  UNAUTHORIZED: 4001,
  FORBIDDEN: 4003,

  INTERNAL: 5000,
  DB_ERROR: 5001,
  FS_WRITE_FAILED: 5002,
  YAML_INVALID: 5101,
} as const
export type CodeNum = (typeof Code)[keyof typeof Code]

// 业务异常：路由里 throw new BizError(...) 后由 registerErrorHandler 统一转 envelope
export class BizError extends Error {
  constructor(
    public code: CodeNum,
    msg: string,
    public httpStatus = 400,
  ) {
    super(msg)
    this.name = 'BizError'
  }
}

export function ok<T>(reply: FastifyReply, data: T, statusCode = 200) {
  return reply.code(statusCode).send({ code: Code.OK, msg: 'ok', data })
}

export function fail(reply: FastifyReply, code: CodeNum, msg: string, httpStatus = 400) {
  return reply.code(httpStatus).send({ code, msg, data: null })
}

// 全局错误处理：识别 ZodError / BizError / 兜底 → envelope
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: any, req: any, reply: any) => {
    const traceId = (req.id as string) || randomUUID()

    if (err instanceof ZodError) {
      return reply.code(400).send({
        code: Code.ZOD_INVALID,
        msg: '参数校验失败',
        data: null,
        traceId,
        issues: err.issues,
      })
    }
    if (err instanceof BizError) {
      return reply.code(err.httpStatus ?? 400).send({
        code: err.code,
        msg: err.message,
        data: null,
        traceId,
      })
    }
    req.log.error({ err, traceId }, 'unhandled error')
    return reply.code(500).send({
      code: Code.INTERNAL,
      msg: '服务器内部错误',
      data: null,
      traceId,
    })
  })
}
