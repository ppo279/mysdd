import { ExecutionContext, InternalServerErrorException } from '@nestjs/common';
import { extractCurrentUser } from '../../../src/auth/decorators/current-user.decorator';

/**
 * Build a minimal ExecutionContext stub. Only `switchToHttp().getRequest()`
 * is exercised by extractCurrentUser, so the rest of the surface is `any`.
 */
const mockCtx = (user: unknown): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as unknown as ExecutionContext;

describe('extractCurrentUser', () => {
  it('returns req.user when JwtAuthGuard has populated it', () => {
    const user = { userId: 42, email: 'parent@example.com' };
    expect(extractCurrentUser(mockCtx(user))).toEqual(user);
  });

  it('throws InternalServerErrorException when req.user is undefined', () => {
    // Scenario: a controller uses @CurrentUser() but the route was NOT
    // protected by @UseGuards(JwtAuthGuard), so req.user was never set.
    // The decorator should fail loud with a self-explanatory error rather
    // than letting the controller dereference undefined.
    expect(() => extractCurrentUser(mockCtx(undefined))).toThrow(
      InternalServerErrorException,
    );
  });
});