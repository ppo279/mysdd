import { Controller, Get } from '@nestjs/common';
import { RawResponse } from './common/decorators/raw-response.decorator';

/**
 * Liveness/readiness probe for ops (Kubernetes, load balancers).
 *
 * Decorated with `@RawResponse()` because probe consumers expect a specific
 * shape — they don't understand our `{code, message, data}` envelope.
 */
@Controller('health')
export class HealthController {
  @Get()
  @RawResponse()
  check(): { status: 'ok'; timestamp: string } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Deliberately throws a raw (non-HttpException) Error. Used to verify
   * that AllExceptionsFilter sanitizes the response (no leaking internal
   * messages to clients) and logs the original stack with the traceId.
   *
   * Safe in production: no real client should hit this; ops can use it to
   * confirm the error pipeline is wired correctly.
   */
  @Get('boom')
  @RawResponse()
  boom(): never {
    throw new Error('Database connection refused on 10.0.0.5:5432');
  }
}
