import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChildDto } from './dto/create-child.dto';
import type { ChildView, ListChildrenResult } from './types';

/**
 * ChildrenService — CRUD over the `Child` table.
 *
 * Constructor injects `PrismaService` only. No storage, no LLM —
 * children are plain data, no file or AI involvement.
 *
 * IDOR policy: every read of a child row (single, list, delete) goes
 * through `findFirst({ where: { ..., userId } })` — never
 * `findUnique({ where: { id } })` followed by a `userId` check
 * (TOCTOU + extra round trip). The 404 message is uniform
 * (`child 不存在`) for both "doesn't exist" and "not yours" so an
 * attacker cannot enumerate ids by probing different URLs.
 */
@Injectable()
export class ChildrenService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create a new child profile for the calling user.
   *
   * The `userId` comes from the JWT, never from the body — so no
   * IDOR check is needed here (the user can't create a row for
   * someone else, only for themselves).
   */
  async create(userId: number, dto: CreateChildDto): Promise<ChildView> {
    const child = await this.prisma.child.create({
      data: {
        userId,
        name: dto.name,
        grade: dto.grade,
      },
      select: { id: true, name: true, grade: true, createTime: true },
    });
    return child;
  }

  /**
   * List the calling user's children, oldest first, paginated.
   *
   * Two queries: `findMany` for the page, `count` for the total.
   * Both filter on `userId` so other families' rows are invisible.
   * The default sort is `createTime: 'asc'` ("long-lived first" —
   * matches the UI's "long-lived first" rendering intuition). The
   * `skip = (page-1) * pageSize` formula uses 1-based page numbers
   * to match the URL shape.
   */
  async list(
    userId: number,
    page: number,
    pageSize: number,
  ): Promise<ListChildrenResult> {
    const [items, total] = await Promise.all([
      this.prisma.child.findMany({
        where: { userId },
        orderBy: { createTime: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, name: true, grade: true, createTime: true },
      }),
      this.prisma.child.count({ where: { userId } }),
    ]);

    return { items, total, page, pageSize };
  }

  /**
   * Read a single child. Throws `NotFoundException('child 不存在')`
   * for both "doesn't exist anywhere" and "exists but not yours"
   * (IDOR-safe: anti-enumeration).
   *
   * Goes through `assertOwnedByUser` first (cheap `select: { id: true }`)
   * and then re-fetches with the full projection. This mirrors the
   * spec's "re-fetch with the full select after the assertion"
   * pattern and keeps the IDOR check in one place.
   */
  async getOne(userId: number, childId: number): Promise<ChildView> {
    await this.assertOwnedByUser(userId, childId);
    const child = await this.prisma.child.findFirst({
      where: { id: childId, userId },
      select: { id: true, name: true, grade: true, createTime: true },
    });
    // assertOwnedByUser just confirmed existence; the second findFirst
    // uses the same where-clause so this should never be null. The
    // non-null assertion is for the type narrowing.
    return child!;
  }

  /**
   * Hard-delete a child. Rejected with 409 if the child has any
   * `Problem` rows — protects parents from accidentally destroying
   * AI history (uploaded image + LLM token cost) that they didn't
   * consent to lose. The `Problem` rows can be deleted first via
   * the Problems endpoints, then this can be retried.
   *
   * Race condition: a problem could be created between the `count`
   * check and the `delete`. Acceptable — the FK constraint will
   * then fail the delete with `P2003`, which surfaces as a 500.
   * The window is microseconds; a follow-up can wrap in
   * `prisma.$transaction` if real-world races surface.
   */
  async remove(userId: number, childId: number): Promise<void> {
    await this.assertOwnedByUser(userId, childId);

    const problemCount = await this.prisma.problem.count({
      where: { childId },
    });
    if (problemCount > 0) {
      throw new ConflictException('该孩子存在题目，无法删除');
    }

    await this.prisma.child.delete({ where: { id: childId } });
  }

  /**
   * Lightweight IDOR check used by `getOne` and `remove`. Mirrors
   * `ProblemsService.assertOwnedByUser`'s shape: `findFirst` with
   * `select: { id: true }` (cheapest possible query), 404 throw on
   * miss. The caller does its own heavier `findFirst` (or `delete`)
   * after the assertion — we don't return the row from this method
   * because the two callers need different select shapes.
   */
  private async assertOwnedByUser(
    userId: number,
    childId: number,
  ): Promise<{ id: number }> {
    const child = await this.prisma.child.findFirst({
      where: { id: childId, userId },
      select: { id: true },
    });
    if (!child) {
      throw new NotFoundException('child 不存在');
    }
    return child;
  }
}
