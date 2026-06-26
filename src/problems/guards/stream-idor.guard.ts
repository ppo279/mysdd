import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../../auth/jwt-payload';
import { ProblemsService } from '../problems.service';

/**
 * Guard that runs BEFORE the `@Sse()` handler on `GET /problems/:id/stream`.
 *
 * Why a guard instead of a check inside the SSE handler?
 * - `@Sse()` initializes the response as `200 text/event-stream`
 *   eagerly, BEFORE the handler runs. Any `NotFoundException` thrown
 *   from inside the SSE handler's Observable cannot become a proper
 *   `404 {code, message, traceId}` JSON envelope — the response
 *   status and headers have already been written to the socket.
 * - A guard runs BEFORE the handler. Throwing `NotFoundException` in
 *   `canActivate()` flows through `AllExceptionsFilter` cleanly and
 *   produces the standard error envelope. The user gets a proper
 *   `404 problem 不存在`, not a 200 SSE stream that opens and
 *   immediately closes.
 *
 * Trade-off: guards are coupled to the request lifecycle, so we
 * re-implement the IDOR check here (vs. just calling
 * `problemsService.assertOwnedByUser`). The actual check is one
 * `findFirst` — keeping the duplication small.
 */
@Injectable()
export class StreamIdorGuard implements CanActivate {
  constructor(private readonly problemsService: ProblemsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    // JwtAuthGuard has already attached `req.user` (it's a strict
    // dependency — we don't redeclare it on the route, but the
    // controller-level `@UseGuards(JwtAuthGuard)` is a hard
    // precondition for this guard running).
    const user = req.user as JwtPayload;
    const problemId = Number(req.params['id']);
    if (!Number.isInteger(problemId) || problemId <= 0) {
      // Bad problem id → let the regular ParseIntPipe fail. Return
      // true here so we don't double-handle the error; the pipe's
      // exception produces the right 400.
      return true;
    }
    await this.problemsService.assertOwnedByUser(user.userId, problemId);
    return true;
  }
}
