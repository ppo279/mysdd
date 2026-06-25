import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../guards/jwt-auth.guard';

/**
 * Extract the JwtPayload that JwtAuthGuard attached to req.user.
 *
 * Usage in a controller:
 *   async me(@CurrentUser() user: JwtPayload) { ... }
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
    const req = ctx.switchToHttp().getRequest<Request & { user: JwtPayload }>();
    return req.user;
  },
);