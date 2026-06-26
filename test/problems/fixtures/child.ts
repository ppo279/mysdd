import type { Child } from '@prisma/client';
import type { PrismaService } from '../../../src/prisma/prisma.service';

/**
 * Create a Child row directly via Prisma — there is no `POST /children`
 * endpoint yet (`ChildrenModule` is tracked as a separate PRD). Tests
 * skip the HTTP layer because none exists; once that lands, this helper
 * switches to `POST /children` and nothing else changes.
 *
 * Defaults: name `'测试娃'`, grade `5`. Override per-test as needed.
 */
export async function createChild(
  prisma: PrismaService,
  args: { userId: number; name?: string; grade?: number },
): Promise<Child> {
  return prisma.child.create({
    data: {
      userId: args.userId,
      name: args.name ?? '测试娃',
      grade: args.grade ?? 5,
    },
  });
}
