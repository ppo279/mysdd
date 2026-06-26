import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, map } from 'rxjs';
import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';

/**
 * Wraps every successful response in `{ code: 0, message: 'ok', data: T }`.
 *
 * - `code: 0` is the discriminator the frontend uses to distinguish success
 *   from `{ code: <HTTP status>, ... }` errors.
 * - `data` is whatever the controller returned. If the controller returned
 *   nothing (e.g. a DELETE that just removes the row), `data` becomes `null`
 *   so the shape stays consistent — clients never have to do `if ('data' in
 *   resp)`.
 *
 * Opt-out: methods/classes decorated with `@RawResponse()` skip wrapping
 * (used for file downloads, SSE, health checks, etc.). Class-level is the
 * default, method-level overrides.
 */
@Injectable()
export class WrapResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isRaw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isRaw) {
      return next.handle();
    }

    return next.handle().pipe(
      map((data: unknown) => ({
        code: 0,
        message: 'ok',
        data: data === undefined ? null : data,
      })),
    );
  }
}
