import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

/**
 * Create a Child row via the real `POST /children` endpoint.
 *
 * Why HTTP and not `prisma.child.create`:
 * - Exercises the production code path. The test suite catches
 *   DTO drift (e.g. if `@Min(1) @Max(12)` is ever loosened) before
 *   the API can ship broken validation.
 * - Every problems e2e test goes through the same endpoint a
 *   production parent would hit — there's no longer a parallel
 *   "test-only" path that bypasses validation/IDOR/auditing.
 *
 * The caller is responsible for the resulting child's lifecycle:
 * `cleanupUser` (from `fixtures/user.ts`) deletes in FK-safe order
 * (solutions → problems → children → user), so a child created here
 * is cleaned up when the parent user is dropped.
 */
export interface CreatedChild {
  id: number;
  name: string;
  grade: number;
  createTime: string;
}

export async function createChild(
  app: INestApplication,
  args: { accessToken: string; name?: string; grade?: number },
): Promise<CreatedChild> {
  const res = await request(app.getHttpServer())
    .post('/children')
    .set('Authorization', `Bearer ${args.accessToken}`)
    .send({ name: args.name ?? '测试娃', grade: args.grade ?? 5 })
    .expect(201);

  return res.body.data as CreatedChild;
}
