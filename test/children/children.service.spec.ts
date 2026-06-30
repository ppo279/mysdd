import { ConflictException, NotFoundException } from '@nestjs/common';
import { ChildrenService } from '../../src/children/children.service';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Unit tests for ChildrenService.
 *
 * Mock style, mirroring `test/problems/problems.service.spec.ts:30-39`
 * (`{ prisma: { <model>: { <method>: jest.fn() } } } as unknown as
 * PrismaService`). Tests run in ms with no Docker / no DB.
 *
 * The 6 cases cover the only branches with non-trivial logic:
 *
 *  1. `create` happy — `prisma.child.create` is called with the right
 *     shape (userId from JWT, name/grade from DTO) and the row is
 *     projected to the `ChildView` shape.
 *  2. `list` happy — `findMany` + `count` are both called, the result
 *     has the envelope shape `{ items, total, page, pageSize }`.
 *  3. `getOne` IDOR miss — `findFirst` returns `null`, the service
 *     throws `NotFoundException('child 不存在')`.
 *  4. `getOne` happy — `findFirst` returns a row, the service passes
 *     it through (verifying the projection stays `ChildView`).
 *  5. `remove` conflict — `problem.count` returns > 0, service throws
 *     `ConflictException` and `child.delete` is **not** called (the
 *     Q3 logic — this is the one assertion that real-DB tests
 *     cannot easily make).
 *  6. `remove` happy — `problem.count` returns 0, `child.delete` is
 *     called with the right id.
 *
 * No `remove` 404 case is added because the IDOR path is identical
 * to `getOne`'s (#3) — duplicate coverage for a shared helper.
 */
describe('ChildrenService', () => {
  function makeService(): {
    service: ChildrenService;
    childCreate: jest.Mock;
    childFindMany: jest.Mock;
    childCount: jest.Mock;
    childFindFirst: jest.Mock;
    childDelete: jest.Mock;
    problemCount: jest.Mock;
  } {
    const childCreate = jest.fn();
    const childFindMany = jest.fn();
    const childCount = jest.fn();
    const childFindFirst = jest.fn();
    const childDelete = jest.fn();
    const problemCount = jest.fn();
    const prisma = {
      child: {
        create: childCreate,
        findMany: childFindMany,
        count: childCount,
        findFirst: childFindFirst,
        delete: childDelete,
      },
      problem: {
        count: problemCount,
      },
    } as unknown as PrismaService;
    return {
      service: new ChildrenService(prisma),
      childCreate,
      childFindMany,
      childCount,
      childFindFirst,
      childDelete,
      problemCount,
    };
  }

  // ────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────
  it('create: inserts the child with userId from JWT and projects the row', async () => {
    const { service, childCreate } = makeService();
    childCreate.mockResolvedValue({
      id: 7,
      name: '小红',
      grade: 3,
      createTime: new Date('2026-06-29T00:00:00Z'),
    });

    const out = await service.create(42, { name: '小红', grade: 3 });

    expect(out).toEqual({
      id: 7,
      name: '小红',
      grade: 3,
      createTime: new Date('2026-06-29T00:00:00Z'),
    });
    // The userId MUST come from the JWT, not from the DTO. The DTO
    // has no userId field — `prisma.child.create` gets it from the
    // service signature.
    expect(childCreate).toHaveBeenCalledWith({
      data: { userId: 42, name: '小红', grade: 3 },
      select: { id: true, name: true, grade: true, createTime: true },
    });
  });

  // ────────────────────────────────────────────────────────────
  // list
  // ────────────────────────────────────────────────────────────
  it('list: returns the page + total with createTime:asc ordering and pagination math', async () => {
    const { service, childFindMany, childCount } = makeService();
    const items = [
      { id: 1, name: '老大', grade: 5, createTime: new Date('2026-01-01') },
      { id: 2, name: '老二', grade: 3, createTime: new Date('2026-02-01') },
    ];
    childFindMany.mockResolvedValue(items);
    childCount.mockResolvedValue(7);

    const out = await service.list(42, 2, 2);

    // Envelope shape: items + total + page + pageSize echo back.
    expect(out).toEqual({
      items,
      total: 7,
      page: 2,
      pageSize: 2,
    });
    // Pagination math: page 2, pageSize 2 → skip 2, take 2.
    expect(childFindMany).toHaveBeenCalledWith({
      where: { userId: 42 },
      orderBy: { createTime: 'asc' },
      skip: 2,
      take: 2,
      select: { id: true, name: true, grade: true, createTime: true },
    });
    // count is filtered on userId too (no cross-family leak).
    expect(childCount).toHaveBeenCalledWith({ where: { userId: 42 } });
  });

  // ────────────────────────────────────────────────────────────
  // getOne — IDOR miss
  // ────────────────────────────────────────────────────────────
  it('getOne: throws NotFoundException("child 不存在") when findFirst returns null', async () => {
    const { service, childFindFirst } = makeService();
    childFindFirst.mockResolvedValue(null);

    await expect(service.getOne(42, 999)).rejects.toThrow(NotFoundException);
    await expect(service.getOne(42, 999)).rejects.toMatchObject({
      message: 'child 不存在',
    });
    // The findFirst filter is `id + userId` — collapsing "not there"
    // and "not yours" into one null result is the IDOR-safe pattern.
    // `getOne` delegates to `assertOwnedByUser` (a cheap `select: { id: true }`
    // probe) BEFORE re-fetching with the full projection, so when the probe
    // returns null the second findFirst never runs. We therefore assert the
    // shape of the probe call only; the full-select call is exercised by the
    // happy-path test below.
    expect(childFindFirst).toHaveBeenCalledWith({
      where: { id: 999, userId: 42 },
      select: { id: true },
    });
  });

  // ────────────────────────────────────────────────────────────
  // getOne — happy
  // ────────────────────────────────────────────────────────────
  it('getOne: returns the row when it exists and belongs to the user', async () => {
    const { service, childFindFirst } = makeService();
    const row = {
      id: 5,
      name: '小明',
      grade: 4,
      createTime: new Date('2026-06-29T00:00:00Z'),
    };
    childFindFirst.mockResolvedValue(row);

    const out = await service.getOne(42, 5);

    expect(out).toEqual(row);
  });

  // ────────────────────────────────────────────────────────────
  // remove — conflict
  // ────────────────────────────────────────────────────────────
  it('remove: throws ConflictException and does NOT call child.delete when problems exist', async () => {
    const { service, childFindFirst, childDelete, problemCount } =
      makeService();
    // assertOwnedByUser passes
    childFindFirst.mockResolvedValue({ id: 7 });
    // problem.count returns > 0 — child has problems
    problemCount.mockResolvedValue(3);

    await expect(service.remove(42, 7)).rejects.toThrow(ConflictException);
    await expect(service.remove(42, 7)).rejects.toMatchObject({
      message: '该孩子存在题目，无法删除',
    });
    // CRITICAL: the delete must NOT have been called. This is the
    // assertion that real-DB tests can't easily make — the whole
    // point of the 409 is to prevent the row from disappearing.
    expect(childDelete).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────
  // remove — happy
  // ────────────────────────────────────────────────────────────
  it('remove: hard-deletes the row when no problems exist', async () => {
    const { service, childFindFirst, childDelete, problemCount } =
      makeService();
    childFindFirst.mockResolvedValue({ id: 7 });
    problemCount.mockResolvedValue(0);
    childDelete.mockResolvedValue(undefined);

    await service.remove(42, 7);

    // The delete targets the child's `id` (not `userId` —
    // `assertOwnedByUser` already verified ownership, so by the
    // time we reach `delete` the row is uniquely identified by id).
    expect(childDelete).toHaveBeenCalledWith({ where: { id: 7 } });
  });
});
