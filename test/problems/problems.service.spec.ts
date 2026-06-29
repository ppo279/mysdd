import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { StorageService } from '../../src/storage/storage.service';
import { ProblemsService } from '../../src/problems/problems.service';

/**
 * Unit tests for ProblemsService.assertOwnedByUser — the lightweight
 * IDOR check used by StreamIdorGuard. The e2e suite covers the
 * "IDOR 404" behavior through `GET /problems/:id/stream`, but the
 * service method is the actual seam, so pinning it down here makes
 * the contract explicit.
 *
 * Three observable branches:
 *  1. The row exists AND belongs to the user → returns `{ id, status }`.
 *  2. The row does not exist at all → `NotFoundException('problem 不存在')`.
 *  3. The row exists but its child belongs to a different user
 *     (the `findFirst` filters on `child: { userId }`) → the same
 *     `NotFoundException`. The status-leaking variant (403, 410, etc.)
 *     is intentionally avoided to keep the endpoint non-enumerable.
 *
 * `findFirst` is the right method to assert on: the service uses
 * `where: { id, child: { userId } }` which collapses "doesn't exist"
 * and "exists but not yours" into a single null result.
 */
describe('ProblemsService.assertOwnedByUser', () => {
  function makeService(
    findFirstResult: { id: number; status: string } | null,
  ): { service: ProblemsService; findFirst: jest.Mock } {
    const findFirst = jest.fn().mockResolvedValue(findFirstResult);
    const prisma = {
      problem: { findFirst },
    } as unknown as PrismaService;
    // assertOwnedByUser doesn't touch storage, but the constructor
    // requires the token — a stub is enough.
    const storage = {} as unknown as StorageService;
    return {
      service: new ProblemsService(prisma, storage),
      findFirst,
    };
  }

  it("returns the problem's id + status when the row exists and is owned by the user", async () => {
    const { service, findFirst } = makeService({ id: 7, status: 'pending' });

    const out = await service.assertOwnedByUser(42, 7);

    expect(out).toEqual({ id: 7, status: 'pending' });
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 7, child: { userId: 42 } },
      select: { id: true, status: true },
    });
  });

  it("throws NotFoundException('problem 不存在') when the row does not exist", async () => {
    const { service } = makeService(null);

    await expect(service.assertOwnedByUser(42, 999)).rejects.toThrow(
      NotFoundException,
    );
    await expect(service.assertOwnedByUser(42, 999)).rejects.toMatchObject({
      message: 'problem 不存在',
    });
  });

  it('throws NotFoundException when the row exists but its child belongs to a different user', async () => {
    // This is the IDOR branch. The same `findFirst` returns null
    // because the `child: { userId }` filter rejects it — the
    // service does not need (and does not have) a separate code
    // path for "not yours" vs "not there".
    const { service } = makeService(null);

    await expect(service.assertOwnedByUser(42, 7)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('narrows the status union — every value the DB can return is mapped through', async () => {
    // The four states the SSE flow uses. Even though the service
    // casts via `as`, the contract is: whatever string Prisma gives
    // back is surfaced verbatim (and the solver is responsible for
    // emitting the right `status` SSE event for it).
    for (const status of ['pending', 'solving', 'done', 'failed'] as const) {
      const { service } = makeService({ id: 1, status });
      const out = await service.assertOwnedByUser(1, 1);
      expect(out.status).toBe(status);
    }
  });
});
