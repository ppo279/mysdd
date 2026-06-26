import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LocalDiskStorageService } from '../../src/storage/local-disk-storage.service';
import { createChild } from './fixtures/child';
import { cleanupUser, registerAndLogin } from './fixtures/user';

/**
 * E2E tests for ProblemsModule — issue 001 vertical slice.
 *
 * Covers cases #1, #2, #3, #4, #5, #6, #7, #9, #12 from the PRD
 * (`docs/prd/problems.md` §"Cases"). Streaming + solve (#10, #11) are
 * out of scope for this slice and live in issue 002.
 *
 * Strategy:
 * - Real Postgres (the dev container). Unique emails + unique child IDs
 *   per test keep cases independent — no TRUNCATE between runs.
 * - Storage is the real LocalDiskStorageService. `afterEach` removes the
 *   per-user upload directory so cases don't bleed into each other.
 */

const TINY_PNG = resolve(__dirname, 'fixtures', 'tiny.png');

describe('ProblemsModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Per-test cleanup. Wipes BOTH the DB rows for the user (and any
   * children/problems/solutions they own) AND the on-disk uploads.
   *
   * Order matters: DB first, then disk — that way if DB cleanup fails
   * we don't silently leak orphan files on the next run, and if disk
   * cleanup fails the DB is already consistent.
   */
  async function cleanupTestUser(userId: number): Promise<void> {
    await cleanupUser(prisma, userId);
    const userDir = resolve(
      process.cwd(),
      'uploads',
      'problems',
      String(userId),
    );
    await fs.rm(userDir, { recursive: true, force: true });
  }

  // ─────────────────────────────────────────────────────────────
  // POST /problems — case #1 (no token)
  // ─────────────────────────────────────────────────────────────
  describe('POST /problems', () => {
    it('case #1 — 401 when no Authorization header', async () => {
      // Note: deliberately NOT attaching an image here. The auth guard
      // runs BEFORE the body parser, so it should reject on the missing
      // header alone. A multipart body + a 401 response can race on the
      // same connection (server closes while client is still uploading),
      // which produces a flaky ECONNRESET in supertest. Testing the guard
      // in isolation is the cleaner signal.
      const res = await request(app.getHttpServer())
        .post('/problems')
        .expect(401);
      expect(res.body.message).toMatch(/缺少 Authorization/);
    });

    // ─────────────────────────────────────────────────────────
    // case #2 — childId non-integer
    // ─────────────────────────────────────────────────────────
    it('case #2 — 400 when childId is not an integer', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-bad-id');
      try {
        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', 'abc')
          .attach('image', TINY_PNG)
          .expect(400);
        expect(res.body.message).toMatch(/childId 必须是整数/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #3 — childId not yours (IDOR safe → 404 not 403)
    // ─────────────────────────────────────────────────────────
    it("case #3 — 404 child 不存在 when uploading to another user's child", async () => {
      const owner = await registerAndLogin(app, 'p-child-owner');
      const attacker = await registerAndLogin(app, 'p-child-attacker');
      try {
        const child = await createChild(prisma, { userId: owner.user.id });

        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(404);
        expect(res.body.message).toBe('child 不存在');
      } finally {
        await cleanupTestUser(attacker.user.id);
        await cleanupTestUser(owner.user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #4 — bad MIME (HEIC) → 400
    // ─────────────────────────────────────────────────────────
    it('case #4 — 400 不支持的图片格式 when MIME is not on whitelist', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-bad-mime');
      try {
        const child = await createChild(prisma, { userId: user.id });

        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG, {
            filename: 'photo.heic',
            contentType: 'image/heic',
          })
          .expect(400);
        expect(res.body.message).toMatch(
          /不支持的图片格式: image\/heic，仅允许 JPEG\/PNG\/GIF\/WEBP/,
        );
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #5 — file > 10 MB → 400 图片过大
    // ─────────────────────────────────────────────────────────
    it('case #5 — 400 图片过大 when file exceeds 10 MB', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-big');
      try {
        const child = await createChild(prisma, { userId: user.id });

        const huge = Buffer.alloc(11 * 1024 * 1024, 0xff);
        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', huge, {
            filename: 'huge.png',
            contentType: 'image/png',
          })
          .expect(400);
        expect(res.body.message).toBe('图片过大，最大 10MB');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #6 — missing `image` field → 400 请上传题目图片
    // ─────────────────────────────────────────────────────────
    it('case #6 — 400 请上传题目图片 when image field is missing', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-no-image');
      try {
        const child = await createChild(prisma, { userId: user.id });

        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .expect(400);
        expect(res.body.message).toBe('请上传题目图片');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #7 — happy path → 201 with mapped imageUrl
    // ─────────────────────────────────────────────────────────
    it('case #7 — 201 happy path creates problem + writes file + maps imageUrl to API path', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-happy');
      try {
        const child = await createChild(prisma, { userId: user.id });

        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);

        // Envelope shape
        expect(res.body.code).toBe(0);
        expect(res.body.message).toBe('ok');
        // Body fields
        expect(res.body.data).toMatchObject({
          childId: child.id,
          status: 'pending',
        });
        expect(res.body.data).toHaveProperty('id');
        expect(res.body.data).toHaveProperty('createTime');
        // CRITICAL: imageUrl in the response is the API path, NOT the
        // storage key. See PRD §"API contracts" and the locked decisions
        // in docs/issues/001.
        expect(res.body.data.imageUrl).toBe(
          `/problems/${res.body.data.id}/image`,
        );
        // And NOT the internal storage key shape
        expect(res.body.data.imageUrl).not.toMatch(/^problems\//);

        // DB sanity — row exists with status pending and imageUrl = storage key.
        const row = await prisma.problem.findUnique({
          where: { id: res.body.data.id },
        });
        expect(row).not.toBeNull();
        expect(row!.status).toBe('pending');
        expect(row!.imageUrl).toMatch(/^problems\/\d+\/.+\.png$/);

        // File actually on disk under the user's directory.
        const filePath = resolve(process.cwd(), 'uploads', row!.imageUrl);
        await expect(fs.access(filePath)).resolves.toBeUndefined();
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /problems/:id — case #9 (auth + IDOR)
  // ─────────────────────────────────────────────────────────────
  describe('GET /problems/:id', () => {
    it('case #9a — 401 when no token', async () => {
      await request(app.getHttpServer()).get('/problems/1').expect(401);
    });

    it("case #9b — 404 problem 不存在 for someone else's problem (IDOR-safe)", async () => {
      const owner = await registerAndLogin(app, 'p-idor-owner');
      const attacker = await registerAndLogin(app, 'p-idor-attacker');
      try {
        const child = await createChild(prisma, { userId: owner.user.id });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const res = await request(app.getHttpServer())
          .get(`/problems/${problemId}`)
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('problem 不存在');
      } finally {
        await cleanupTestUser(attacker.user.id);
        await cleanupTestUser(owner.user.id);
      }
    });

    it('case #9c — 404 for non-existent id', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-ghost');
      try {
        const res = await request(app.getHttpServer())
          .get('/problems/999999999')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('problem 不存在');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #9d — 200 returns the problem with API-mapped imageUrl + null solution', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-read-ok');
      try {
        const child = await createChild(prisma, { userId: user.id });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const res = await request(app.getHttpServer())
          .get(`/problems/${problemId}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(res.body.data).toMatchObject({
          id: problemId,
          childId: child.id,
          status: 'pending',
        });
        expect(res.body.data.imageUrl).toBe(`/problems/${problemId}/image`);
        // No solution yet — solve is issue 002.
        expect(res.body.data.solution).toBeNull();
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /problems/:id/image — case #12 (auth + IDOR + bytes)
  // ─────────────────────────────────────────────────────────────
  describe('GET /problems/:id/image', () => {
    it('case #12a — 401 when no token', async () => {
      await request(app.getHttpServer()).get('/problems/1/image').expect(401);
    });

    it("case #12b — 404 for someone else's problem image (IDOR-safe)", async () => {
      const owner = await registerAndLogin(app, 'p-img-owner');
      const attacker = await registerAndLogin(app, 'p-img-attacker');
      try {
        const child = await createChild(prisma, { userId: owner.user.id });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const res = await request(app.getHttpServer())
          .get(`/problems/${problemId}/image`)
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('problem 不存在');
      } finally {
        await cleanupTestUser(attacker.user.id);
        await cleanupTestUser(owner.user.id);
      }
    });

    it('case #12c — 200 returns the original image bytes with correct Content-Type', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-img-ok');
      try {
        const child = await createChild(prisma, { userId: user.id });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const res = await request(app.getHttpServer())
          .get(`/problems/${problemId}/image`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        // RawResponse() decorator means: no {code, message, data} envelope.
        expect(res.body).not.toHaveProperty('code');
        expect(res.body).not.toHaveProperty('data');

        // Content-Type comes from the MIME sniffed at upload time (image/png).
        expect(res.headers['content-type']).toMatch(/image\/png/);
        // Bytes match the original tiny.png.
        const expected = await fs.readFile(TINY_PNG);
        expect(Buffer.compare(res.body, expected)).toBe(0);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #12d — 404 problem 不存在 for failed-status row (status guard)', async () => {
      // Simulates the rare step-4 failure path: row exists but status=failed.
      // The image endpoint must reject it identically to IDOR miss.
      const { user, accessToken } = await registerAndLogin(app, 'p-img-failed');
      try {
        const child = await createChild(prisma, { userId: user.id });
        const problem = await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl: 'problems/999/missing.png',
            status: 'failed',
          },
        });

        const res = await request(app.getHttpServer())
          .get(`/problems/${problem.id}/image`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('problem 不存在');
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Storage round-trip — proves the wiring works end-to-end
  // ─────────────────────────────────────────────────────────────
  describe('Storage wiring', () => {
    it('LocalDiskStorageService.put writes to ./uploads/problems/<userId>/', async () => {
      const service = app.get(LocalDiskStorageService);
      const buf = Buffer.from([1, 2, 3, 4]);
      const result = await service.put({
        buffer: buf,
        mime: 'image/png',
        originalName: 'sample.png',
        userId: 12345,
      });

      expect(result.key).toMatch(/^problems\/12345\/[\w-]+\.png$/);
      expect(result.url).toBe(result.key);

      const onDisk = resolve(process.cwd(), 'uploads', result.key);
      const contents = await fs.readFile(onDisk);
      expect(Buffer.compare(contents, buf)).toBe(0);

      // Cleanup so this test doesn't leak files.
      await fs.rm(resolve(process.cwd(), 'uploads', 'problems', '12345'), {
        recursive: true,
        force: true,
      });
    });

    it('StorageService.delete is best-effort (returns void on missing key)', async () => {
      const service = app.get(LocalDiskStorageService);
      // No throw on ENOENT — that's the whole point.
      await expect(
        service.delete('problems/999999/never-existed.png'),
      ).resolves.toBeUndefined();
    });
  });
});
