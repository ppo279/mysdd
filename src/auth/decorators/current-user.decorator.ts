import {
  ExecutionContext,
  InternalServerErrorException,
  createParamDecorator,
} from '@nestjs/common';
import type { Request } from 'express';
import type { JwtPayload } from '../jwt-payload';

/**
 * Extract the JwtPayload that JwtAuthGuard attached to req.user.
 *
 * Exported as a named function so it can be unit-tested directly. The
 * `CurrentUser` decorator is a thin wrapper around it.
 *
 * Throws InternalServerErrorException when `req.user` is missing. That
 * means the decorator was used on a route NOT protected by
 * `@UseGuards(JwtAuthGuard)` — failing loud with a self-explanatory
 * message beats letting the controller dereference undefined and
 * surface as a cryptic English stack at runtime.
 *
 * Usage in a controller:
 *   async me(@CurrentUser() user: JwtPayload) { ... }
 */
export const extractCurrentUser = (ctx: ExecutionContext): JwtPayload => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.user) {
    throw new InternalServerErrorException(
      '@CurrentUser() 必须在 @UseGuards(JwtAuthGuard) 之后使用，但 req.user 为空',
    );
  }
  return req.user;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => extractCurrentUser(ctx),
);