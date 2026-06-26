import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { User } from '@prisma/client';
import { PrismaService } from '../../../src/prisma/prisma.service';

export interface RegisteredUser {
  user: User;
  accessToken: string;
}

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;

const VALID_PASSWORD = 'Abc12345';

/**
 * Register a fresh parent account via the HTTP endpoint and log it in.
 *
 * Why HTTP instead of `prisma.user.create`:
 * - Exercises the real `/auth/register` + `/auth/login` paths so the
 *   password gets hashed through the production code path (bcrypt).
 * - Returns a valid JWT that other fixtures can attach to `Authorization`.
 *
 * Caller is responsible for cleanup — `afterEach` typically calls
 * `cleanupUser(prisma, user)` which deletes child rows first (FK order)
 * and then the user itself.
 */
export async function registerAndLogin(
  app: INestApplication,
  label: string,
): Promise<RegisteredUser> {
  const email = uniqueEmail(label);
  const server = app.getHttpServer();

  await request(server)
    .post('/auth/register')
    .send({ email, password: VALID_PASSWORD })
    .expect(201);

  const loginRes = await request(server)
    .post('/auth/login')
    .send({ email, password: VALID_PASSWORD })
    .expect(200);

  // User row lookup is by email — we don't have the id without re-fetching.
  const prisma = app.get(PrismaService);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });

  return {
    user,
    accessToken: loginRes.body.data.accessToken as string,
  };
}

/**
 * Delete a user and everything that cascades (children, problems, solutions).
 * We delete in FK-safe order so the FK constraints don't trip the test
 * cleanup itself (which would fail the suite even when the test passed).
 */
export async function cleanupUser(
  prisma: PrismaService,
  userId: number,
): Promise<void> {
  await prisma.solution.deleteMany({
    where: { problem: { child: { userId } } },
  });
  await prisma.problem.deleteMany({ where: { child: { userId } } });
  await prisma.child.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}
