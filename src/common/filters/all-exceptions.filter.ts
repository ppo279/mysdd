import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

/**
 * Global exception filter — wraps every error response in
 * `{ code, message, traceId }`.
 *
 * Behavior matrix:
 * | exception type                       | status | message              | logged? |
 * |--------------------------------------|--------|----------------------|---------|
 * | HttpException (e.g. 401, 409)        | status | exception.message    | no      |
 * | Nest default 404 (Cannot GET /...)   | 404    | 接口路径不存在       | no      |
 * | Nest default 405 (Method Not Allowed)| 405    | 请求方法不被允许      | no      |
 * | PayloadTooLargeException (multer)    | 413    | 图片过大，最大 10MB   | no      |
 * | Non-HttpException (raw Error)        | 500    | 服务器内部错误        | YES     |
 *
 * 5xx logging: writes `[traceId] <error message>` with the full stack.
 * The traceId joins the response body to the log line so on-call can grep
 * the traceId from a user report and find the matching log entry.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const traceId =
      (request as Request & { traceId?: string }).traceId ?? randomUUID();

    let status: number;
    let message: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.message;

      // Localize Nest's built-in English defaults. We only rewrite when the
      // message MATCHES the known Nest default — business-thrown
      // NotFoundException('孩子不存在') etc. are left untouched.
      if (status === 404 && message.startsWith('Cannot ')) {
        message = '接口路径不存在';
      } else if (status === 405) {
        message = '请求方法不被允许';
      } else if (exception instanceof PayloadTooLargeException) {
        // Multer raises this when a FileInterceptor's limits.fileSize is
        // exceeded. Per `docs/issues/001-problems-upload-read-image.md`
        // acceptance criteria, the locked response is 400 (not the
        // semantically-correct 413) so we override both status AND
        // message here.
        status = 400;
        message = '图片过大，最大 10MB';
      }
    } else {
      status = 500;
      message = '服务器内部错误';

      const errMessage =
        exception instanceof Error ? exception.message : String(exception);
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`[${traceId}] ${errMessage}`, stack);
    }

    response.status(status).json({
      code: status,
      message,
      traceId,
    });
  }
}
