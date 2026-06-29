import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { join, resolve } from 'path';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';
import { JanitorService } from '../../src/janitor/janitor.service';
import { ANTHROPIC_CLIENT } from '../../src/integrations/anthropic/anthropic.tokens';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeAnthropicClient } from '../problems/fakes/fake-anthropic-client';
import { createChild } from '../problems/fixtures/child';
import { cleanupUser, registerAndLogin } from '../problems/fixtures/user';

// Push the cron interval far out so the auto-fired setInterval can't
// race with the explicit `runOnce()` calls in each test. We still
// need the bootstrap-tick (which fires inside `app.init()`) to NOT
// pick up data from a previous suite — that's why the threshold is
// left at the default 5min: any test row we create has updatedAt ~
// now, so the bootstrap tick finds nothing.
process.env.JANITOR_INTERVAL_MS = '600000'; // 10 min — effectively off
process.env.STUCK_SOLVING_THRESHOLD_MS = '300000'; // 5 min (explicit)

/**
 * E2E tests for the Janitor cron (`docs/issues/009-janitor-cron.md`).
 *
 * Cases:
 * - A: stuck `solving` row >5min → reset to `pending`
 * - B: stuck `solving` row <2min → left alone (false-positive guard)
 * - C: on-disk file with no DB row → deleted (missing-DB orphan)
 * - D: on-disk file with DB row at `pending` → kept
 * - E: on-disk file with DB row at `failed` → deleted (failed-upload residue)
 *
 * Strategy: real Postgres, real filesystem under `./uploads/problems/`,
 * but the cron itself is driven by direct `janitorService.runOnce()`
 * calls. The bootstrap tick fires once during `app.init()` against an
 * empty DB + empty uploads tree, so it's a no-op. The setInterval is
 * pushed to 10min via env so it can't race with the explicit calls.
 */
describe('Janitor (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let janitor: JanitorService;

  beforeAll(async () => {
    const fakeAi = new FakeAnthropicClient();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ANTHROPIC_CLIENT)
      .useValue(fakeAi)
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);

    prisma = app.get(PrismaService);
    janitor = app.get(JanitorService);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Resolve the per-user uploads dir (matches `LocalDiskStorageService`). */
  function userDir(userId: number): string {
    return resolve(process.cwd(), 'uploads', 'problems', String(userId));
  }

  /** Write a fake upload file for the given (userId, fileName). */
  async function writeFakeFile(
    userId: number,
    fileName: string,
  ): Promise<string> {
    const dir = userDir(userId);
    await fs.mkdir(dir, { recursive: true });
    const fullPath = join(dir, fileName);
    await fs.writeFile(fullPath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
    return fullPath;
  }

  /** Test-scoped cleanup: DB rows + disk files for one user. */
  async function cleanupTestUser(userId: number): Promise<void> {
    await cleanupUser(prisma, userId);
    await fs.rm(userDir(userId), { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // StuckSolvingJob
  // ─────────────────────────────────────────────────────────────
  describe('StuckSolvingJob', () => {
    it('case A — row at solving >5min ago gets reset to pending', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'j-stuck-old');
      try {
        const child = await createChild(app, { accessToken });
        const problem = await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl: 'problems/' + user.id + '/seed.png',
            status: 'solving',
          },
        });

        // Backdate updatedAt to 6 minutes ago. We bypass Prisma's
        // `@updatedAt` here because we're simulating a row that was
        // last touched in the past, which `@updatedAt` would
        // overwrite if we used `updateMany`.
        const sixMinAgo = new Date(Date.now() - 6 * 60_000);
        await prisma.$executeRawUnsafe(
          'UPDATE "Problem" SET "updatedAt" = $1 WHERE id = $2',
          sixMinAgo,
          problem.id,
        );

        const results = await janitor.runOnce();
        const stuckResult = results[0]; // jobs run in declared order
        expect(stuckResult.affected).toBeGreaterThanOrEqual(1);

        const after = await prisma.problem.findUniqueOrThrow({
          where: { id: problem.id },
        });
        expect(after.status).toBe('pending');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case B — row at solving <2min ago is NOT touched (false-positive guard)', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'j-stuck-young',
      );
      try {
        const child = await createChild(app, { accessToken });
        const problem = await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl: 'problems/' + user.id + '/seed.png',
            status: 'solving',
          },
        });
        // updatedAt is automatically ~now from @default(now()) + Prisma's
        // update bookkeeping; leave it fresh.

        const results = await janitor.runOnce();
        const stuckResult = results[0];
        // Healthy in-flight solves are never caught: a row <5min old
        // doesn't match the WHERE clause. The `affected` count here is
        // informational (other suites may have left work); the real
        // assertion is that OUR row stays at 'solving' below.
        expect(stuckResult.affected).toBeGreaterThanOrEqual(0);

        const after = await prisma.problem.findUniqueOrThrow({
          where: { id: problem.id },
        });
        expect(after.status).toBe('solving');
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // OrphanFileJob
  // ─────────────────────────────────────────────────────────────
  describe('OrphanFileJob', () => {
    it('case C — file on disk with no matching DB row is deleted (missing-DB orphan)', async () => {
      const { user } = await registerAndLogin(app, 'j-orphan-missing');
      try {
        const fileName = `${randomUUID()}.png`;
        const fullPath = await writeFakeFile(user.id, fileName);

        // Sanity: the file actually exists before the sweep.
        await expect(fs.access(fullPath)).resolves.toBeUndefined();

        const results = await janitor.runOnce();
        // `affected` is shared across all users' dirs, so we don't
        // pin a specific number — the contract for case C is "our
        // specific orphan is gone":
        const orphanResult = results[1];
        expect(orphanResult.affected).toBeGreaterThanOrEqual(1);

        // File should be gone now.
        await expect(fs.access(fullPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case D — file on disk with matching DB row at status=pending is KEPT', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'j-orphan-live',
      );
      try {
        const child = await createChild(app, { accessToken });
        const fileName = `${randomUUID()}.png`;
        const imageUrl = `problems/${user.id}/${fileName}`;
        const fullPath = await writeFakeFile(user.id, fileName);
        await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl,
            status: 'pending',
          },
        });

        await janitor.runOnce();
        // Contract for case D: the live file is preserved.
        await expect(fs.access(fullPath)).resolves.toBeUndefined();
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case E — file on disk with matching DB row at status=failed IS deleted (failed-upload residue)', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'j-orphan-failed',
      );
      try {
        const child = await createChild(app, { accessToken });
        const fileName = `${randomUUID()}.png`;
        const imageUrl = `problems/${user.id}/${fileName}`;
        const fullPath = await writeFakeFile(user.id, fileName);
        await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl,
            status: 'failed',
          },
        });

        await janitor.runOnce();
        // Contract for case E: the failed-upload residue is gone.
        await expect(fs.access(fullPath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });
});
