import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { StreamIdorGuard } from '../../src/problems/guards/stream-idor.guard';
import { ProblemsService } from '../../src/problems/problems.service';

/**
 * Unit tests for StreamIdorGuard — the guard that runs BEFORE the
 * `@Sse()` handler on `GET /problems/:id/stream`.
 *
 * The guard has three observable branches:
 *  1. Non-integer id → returns true and lets ParseIntPipe produce
 *     the 400 (don't double-handle).
 *  2. Integer id, not owned → assertOwnedByUser throws
 *     `NotFoundException('problem 不存在')`, which flows through
 *     `AllExceptionsFilter` as a standard 404 envelope.
 *  3. Integer id, owned → returns true so the handler runs.
 *
 * We mock ProblemsService with a Jest spy — the guard's only
 * collaborator — and craft an ExecutionContext by hand.
 */
describe('StreamIdorGuard', () => {
  const userId = 42;
  const user = { userId, email: 'parent@example.test' };

  function makeContext(params: Record<string, string>): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ user, params }),
      }),
    } as unknown as ExecutionContext;
  }

  it('returns true for a non-integer id and does NOT call assertOwnedByUser', async () => {
    // The route's @Param('id', ParseIntPipe) will reject "abc" with
    // 400 — the guard's job is to avoid a duplicate, friendlier
    // error path. Skipping the DB lookup also saves a roundtrip.
    const assertOwned = jest.fn();
    const guard = new StreamIdorGuard({
      assertOwnedByUser: assertOwned,
    } as unknown as ProblemsService);

    const ok = await guard.canActivate(makeContext({ id: 'abc' }));

    expect(ok).toBe(true);
    expect(assertOwned).not.toHaveBeenCalled();
  });

  it('returns true for a non-positive integer id and does NOT call assertOwnedByUser', async () => {
    // Same as the non-integer case: 0 or -1 are not valid resource
    // ids. The pipe produces a 400; the guard steps aside.
    const assertOwned = jest.fn();
    const guard = new StreamIdorGuard({
      assertOwnedByUser: assertOwned,
    } as unknown as ProblemsService);

    const ok = await guard.canActivate(makeContext({ id: '0' }));

    expect(ok).toBe(true);
    expect(assertOwned).not.toHaveBeenCalled();
  });

  it('propagates NotFoundException when the problem is not owned by the current user', async () => {
    // The service throws the same `problem 不存在` exception used
    // everywhere else — anti-enumeration, IDOR-safe. The guard
    // does NOT swallow it; the global filter shapes the response.
    const assertOwned = jest
      .fn()
      .mockRejectedValue(new NotFoundException('problem 不存在'));
    const guard = new StreamIdorGuard({
      assertOwnedByUser: assertOwned,
    } as unknown as ProblemsService);

    await expect(guard.canActivate(makeContext({ id: '7' }))).rejects.toThrow(
      NotFoundException,
    );
    expect(assertOwned).toHaveBeenCalledWith(userId, 7);
  });

  it('returns true when the problem is owned by the current user', async () => {
    const assertOwned = jest.fn().mockResolvedValue({
      id: 7,
      status: 'pending' as const,
    });
    const guard = new StreamIdorGuard({
      assertOwnedByUser: assertOwned,
    } as unknown as ProblemsService);

    const ok = await guard.canActivate(makeContext({ id: '7' }));

    expect(ok).toBe(true);
    expect(assertOwned).toHaveBeenCalledWith(userId, 7);
  });
});
