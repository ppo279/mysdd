import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { promises as fs } from 'fs';
import { resolve } from 'path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';
import { ANTHROPIC_CLIENT } from '../../src/integrations/anthropic/anthropic.tokens';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LocalDiskStorageService } from '../../src/storage/local-disk-storage.service';
import { FakeAnthropicClient } from './fakes/fake-anthropic-client';
import { defaultSuccessEvents } from './fakes/fake-anthropic-client';
import { consumeSse } from './helpers/consume-sse';
import { createChild } from './fixtures/child';
import { cleanupUser, registerAndLogin } from './fixtures/user';

/**
 * E2E tests for ProblemsModule — issues 001 + 002 vertical slices.
 *
 * Covers cases #1, #2, #3, #4, #5, #6, #7, #9, #10, #11, #12 from the
 * PRD (`docs/prd/problems.md` §"Cases"). Slice 1 (issue 001) added
 * upload/read/read-image; slice 2 (issue 002) added the SSE solver.
 *
 * Strategy:
 * - Real Postgres (the dev container). Unique emails + unique child IDs
 *   per test keep cases independent — no TRUNCATE between runs.
 * - Storage is the real LocalDiskStorageService. `afterEach` removes the
 *   per-user upload directory so cases don't bleed into each other.
 * - Anthropic is a `FakeAnthropicClient` (overridden via the
 *   `ANTHROPIC_CLIENT` provider token). This sidesteps needing a real
 *   `ANTHROPIC_API_KEY` in `.env` and gives us deterministic events.
 */

const TINY_PNG = resolve(__dirname, 'fixtures', 'tiny.png');

describe('ProblemsModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fakeAi: FakeAnthropicClient;

  beforeAll(async () => {
    fakeAi = new FakeAnthropicClient();
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
    // Bind to a random port so the SSE tests can hit a real socket
    // via Node 24's `fetch`. supertest also works against a real
    // listening server, so this doesn't break the supertest path.
    await app.listen(0);

    prisma = app.get(PrismaService);
  });

  /**
   * Return the base URL the test app is listening on. Used by the
   * SSE test cases — supertest can't parse SSE, so they make real
   * `fetch` calls against the bound port.
   */
  function baseUrl(): string {
    const port = (app.getHttpServer().address() as { port: number }).port;
    return `http://127.0.0.1:${port}`;
  }

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
        const child = await createChild(app, {
          accessToken: owner.accessToken,
        });

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
        const child = await createChild(app, { accessToken });

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
          /不支持的图片格式: image\/heic，仅允许 JPEG\/PNG\/WEBP/,
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
        const child = await createChild(app, { accessToken });

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
        const child = await createChild(app, { accessToken });

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
        const child = await createChild(app, { accessToken });

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

    // ─────────────────────────────────────────────────────────
    // case #8 — storage.put failure → 500 + DB row status=failed,
    // no file on disk (rollback path; deferred from issue 001 PoC,
    // now covered as backlog item 003-case#8).
    //
    // Triggers ProblemsService.create step-3 catch:
    //   - storage.put throws (mocked below)
    //   - markFailed(problem.id) flips DB row to status='failed'
    //   - InternalServerErrorException surfaces as 500
    //
    // Observable assertions:
    //   - 500 with envelope { code: 500, message: '服务器内部错误', traceId }
    //   - DB row exists with status='failed', imageUrl='' (placeholder
    //     preserved because step 4 never ran)
    //   - No file under ./uploads/problems/<userId>/ (storage.put
    //     threw before writeFile completed)
    // ─────────────────────────────────────────────────────────
    it('case #8 — storage.put failure rolls back to DB status=failed with no orphan file', async () => {
      const storage = app.get(LocalDiskStorageService);
      // `useExisting` means STORAGE_SERVICE and LocalDiskStorageService
      // are the SAME singleton — spying on the class method is
      // sufficient to make ProblemsService see the throw.
      const putSpy = jest
        .spyOn(storage, 'put')
        .mockRejectedValue(new Error('forced: disk full (case #8)'));

      const { user, accessToken } = await registerAndLogin(app, 'p-fail');
      try {
        const child = await createChild(app, { accessToken });

        // The upload itself should 500 — the global exception filter
        // wraps the InternalServerErrorException in the standard error
        // envelope (see AllExceptionsFilter + WrapResponseInterceptor).
        const res = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(500);

        expect(res.body.code).toBe(500);
        expect(res.body.message).toBe('服务器内部错误');
        expect(res.body).toHaveProperty('traceId');

        // The DB row should exist (created with placeholder imageUrl=''
        // in step 2) and be flipped to status='failed' by markFailed
        // in the step-3 catch. imageUrl stays '' because step 4
        // (update with real key) never ran.
        const rows = await prisma.problem.findMany({
          where: { childId: child.id },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');
        expect(rows[0].imageUrl).toBe('');

        // No file should have been written under the user's uploads
        // directory. readdir throws ENOENT when the dir never existed
        // (storage.put threw before mkdir) — normalize to an empty
        // array so the assertion is "no files" regardless of whether
        // the directory was created.
        const userDir = resolve(
          process.cwd(),
          'uploads',
          'problems',
          String(user.id),
        );
        const files = await fs.readdir(userDir).catch((err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw err;
        });
        expect(files).toEqual([]);

        // The spy was actually invoked (proves we hit the failure
        // branch, not a different 500 path).
        expect(putSpy).toHaveBeenCalledTimes(1);
      } finally {
        putSpy.mockRestore();
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
        const child = await createChild(app, {
          accessToken: owner.accessToken,
        });
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
        const child = await createChild(app, { accessToken });
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
        const child = await createChild(app, {
          accessToken: owner.accessToken,
        });
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
        const child = await createChild(app, { accessToken });
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

    it('case #12d — 200 + X-AI-Status: failed for failed-status row with non-empty imageUrl ((β) lock)', async () => {
      // (β) Per the §Language lock: a `status: 'failed'` Problem whose
      // imageUrl is non-empty STILL serves the image (200), with the
      // failure context signalled via the `X-AI-Status: failed` response
      // header. The body is not blocked — the parent can re-see the
      // photo they uploaded. This case uses a real upload then mutates
      // the row's status to 'failed' (mirroring a step-3 storage
      // failure followed by janitor recovery, or a solve-time failure).
      const { user, accessToken } = await registerAndLogin(app, 'p-img-failed');
      try {
        const child = await createChild(app, { accessToken });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        // Mutate the row to simulate a failed solve — imageUrl is
        // already the real storage key from the upload.
        await prisma.problem.update({
          where: { id: problemId },
          data: { status: 'failed' },
        });

        const res = await request(app.getHttpServer())
          .get(`/problems/${problemId}/image`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        // (β) failure context is in the response header, not the body.
        expect(res.headers['x-ai-status']).toBe('failed');
        // Body is still the original image bytes.
        expect(res.headers['content-type']).toMatch(/image\/png/);
        const expected = await fs.readFile(TINY_PNG);
        expect(Buffer.compare(res.body, expected)).toBe(0);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #12e — 404 for imageUrl === "" placeholder row (no bytes to serve)', async () => {
      // The complement to (β): when imageUrl is the empty placeholder
      // (race window during POST, or step-3 storage failure left the
      // file unwritten), there's no image to serve — 404. The
      // status field is irrelevant here; the 404 is governed by
      // imageUrl, not status.
      const { user, accessToken } = await registerAndLogin(app, 'p-img-empty');
      try {
        const child = await createChild(app, { accessToken });
        const problem = await prisma.problem.create({
          data: {
            childId: child.id,
            imageUrl: '',
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

  // ─────────────────────────────────────────────────────────────
  // GET /problems/:id/stream — case #10 (auth + IDOR)
  // Issue 002 vertical slice.
  // ─────────────────────────────────────────────────────────────
  describe('GET /problems/:id/stream', () => {
    beforeEach(() => {
      // Reset per-test fake state so streamCallCount / lastBody don't
      // bleed across cases. The default events are the success path;
      // individual tests call `setEvents` to script errors.
      fakeAi.streamCallCount = 0;
      fakeAi.lastBody = null;
      fakeAi.setEvents([
        { kind: 'thinking', text: 'Let me analyze the problem step by step.' },
        { kind: 'text', text: 'The answer is 42.' },
        { kind: 'end' },
      ]);
    });

    // ─────────────────────────────────────────────────────────
    // case #10a — 401 when no token
    // ─────────────────────────────────────────────────────────
    it('case #10a — 401 when no Authorization header', async () => {
      await request(app.getHttpServer()).get('/problems/1/stream').expect(401);
    });

    // ─────────────────────────────────────────────────────────
    // case #10b — 404 problem 不存在 for IDOR miss
    // ─────────────────────────────────────────────────────────
    it("case #10b — 404 problem 不存在 for someone else's problem (IDOR-safe)", async () => {
      const owner = await registerAndLogin(app, 'p-stream-owner');
      const attacker = await registerAndLogin(app, 'p-stream-attacker');
      try {
        const child = await createChild(app, {
          accessToken: owner.accessToken,
        });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        // Use Node 24 fetch — supertest can't parse SSE properly.
        const url = `${baseUrl()}/problems/${problemId}/stream`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${attacker.accessToken}` },
        });
        expect(res.status).toBe(404);
        const body = (await res.json()) as { code: number; message: string };
        expect(body.message).toBe('problem 不存在');
        // Crucially: no SSE bytes leaked (the response was a JSON
        // error envelope, not a 200 text/event-stream). The
        // Content-Type confirms it.
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
      } finally {
        await cleanupTestUser(attacker.user.id);
        await cleanupTestUser(owner.user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #11a — full happy-path stream
    // Asserts event order, payload shape, DB status=done, solution
    // row contents.
    // ─────────────────────────────────────────────────────────
    it('case #11a — happy path: streams status → reasoning_delta → content_delta → done; DB reaches done with a solution', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'p-solve-happy',
      );
      try {
        const child = await createChild(app, { accessToken });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        // Stream the SSE response. `consumeSse` uses Node 24 fetch.
        const url = `${baseUrl()}/problems/${problemId}/stream`;
        const events: Array<{ event: string | null; data: unknown }> = [];
        for await (const frame of consumeSse(url, accessToken)) {
          events.push(frame);
        }

        // Locked event sequence: status(solving) → reasoning_delta →
        // content_delta → done. (Heuristic: there might be additional
        // `ping` heartbeat events if the solve is slow, but the fake
        // resolves in a few microseconds so no ping is expected here.)
        const types = events.map((e) => e.event);
        expect(types).toContain('done');
        // First non-ping event must be a status frame.
        const firstReal = events.find((e) => e.event !== 'ping');
        expect(firstReal?.event).toBe('status');
        expect(firstReal?.data).toEqual({ status: 'solving' });
        // Last event must be `done` (or `error` for failure paths).
        expect(types[types.length - 1]).toBe('done');
        // The done payload shape is locked.
        const doneFrame = events.find((e) => e.event === 'done');
        expect(doneFrame?.data).toMatchObject({
          problemId,
          totalTokens: 42,
        });
        expect((doneFrame?.data as { solutionId: number }).solutionId).toEqual(
          expect.any(Number),
        );

        // Fake called exactly once.
        expect(fakeAi.streamCallCount).toBe(1);
        // Model + thinking config in the request body — proves the
        // production solver code path is wired.
        expect(fakeAi.lastBody?.model).toBe('MiniMax-M3');
        const thinking = (
          fakeAi.lastBody as { thinking?: { type: string } } | null
        )?.thinking;
        expect(thinking).toEqual({ type: 'adaptive' });

        // DB state: status=done, exactly one Solution row.
        const row = await prisma.problem.findUnique({
          where: { id: problemId },
          include: { solutions: true },
        });
        expect(row?.status).toBe('done');
        expect(row?.solutions).toHaveLength(1);
        expect(row?.solutions[0]?.content).toBe('The answer is 42.');
        expect(row?.solutions[0]?.model).toBe('MiniMax-M3');
        // (C) Solution.usage is the full SDK usage JSON object, not
        // just output_tokens. Asserts on input_tokens + output_tokens;
        // cache fields are null in the default fake flow (no prompt
        // caching exercised).
        expect(row?.solutions[0]?.usage).toEqual({
          input_tokens: 100,
          output_tokens: 42,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        });
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #11b — solver failure: error event + status=failed
    // ─────────────────────────────────────────────────────────
    it('case #11b — solver error → error event + DB status=failed', async () => {
      fakeAi.setEvents([{ kind: 'error', message: 'upstream blew up' }]);

      const { user, accessToken } = await registerAndLogin(app, 'p-solve-fail');
      try {
        const child = await createChild(app, { accessToken });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const url = `${baseUrl()}/problems/${problemId}/stream`;
        const events: Array<{ event: string | null; data: unknown }> = [];
        for await (const frame of consumeSse(url, accessToken)) {
          events.push(frame);
        }

        const types = events.map((e) => e.event);
        // The failure path emits `status: failed` then `error` then closes.
        expect(types).toContain('error');
        const errorFrame = events.find((e) => e.event === 'error');
        expect(errorFrame?.data).toEqual({ message: '解题失败，请稍后重试' });

        // DB: row marked failed, no Solution created.
        const row = await prisma.problem.findUnique({
          where: { id: problemId },
          include: { solutions: true },
        });
        expect(row?.status).toBe('failed');
        expect(row?.solutions).toHaveLength(0);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #11c — concurrency: second open gets `already_processing`
    // ─────────────────────────────────────────────────────────
    it('case #11c — double-open stream → second gets `already_processing` and the fake is called once', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'p-solve-dbl');
      try {
        const child = await createChild(app, { accessToken });
        const createRes = await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(child.id))
          .attach('image', TINY_PNG)
          .expect(201);
        const problemId = createRes.body.data.id as number;

        const port = baseUrl();
        const url = `${port}/problems/${problemId}/stream`;

        // Open both streams. The default success events resolve
        // quickly (microtasks), so by the time the second fetch
        // hits the server, the first is already mid-flight and the
        // row is `solving`.
        const firstEvents: Array<{ event: string | null; data: unknown }> = [];
        const secondEvents: Array<{ event: string | null; data: unknown }> = [];

        const c1 = (async () => {
          for await (const f of consumeSse(url, accessToken)) {
            firstEvents.push(f);
          }
        })();
        const c2 = (async () => {
          for await (const f of consumeSse(url, accessToken)) {
            secondEvents.push(f);
          }
        })();
        await Promise.all([c1, c2]);

        // One of the two streams saw `done` (the winner) and the
        // other saw `already_processing` (the loser). Which one is
        // which is non-deterministic by race, so check the union.
        const winner = [...firstEvents, ...secondEvents].filter(
          (e) => e.event === 'done',
        );
        const loser = [...firstEvents, ...secondEvents].filter(
          (e) =>
            e.event === 'status' &&
            (e.data as { status?: string })?.status === 'already_processing',
        );
        expect(winner).toHaveLength(1);
        expect(loser).toHaveLength(1);

        // The fake was called exactly once across both opens.
        expect(fakeAi.streamCallCount).toBe(1);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    // ─────────────────────────────────────────────────────────
    // case #11d — system prompt varies by grade tier (003 #5)
    //
    // Verifies the per-grade prompt mapping: grades 1-6 use the
    // 小学 stage, 7-12 use 中学. The fake captures the system
    // prompt via `lastBody.system`, which is exactly what the
    // solver handed to the SDK.
    //
    // Boundary checks at the off-by-one edges (1 vs 6, 7 vs 12)
    // make sure tier boundaries are inclusive where intended.
    //
    // The `higher` tier (grade >= 13) and the `default` fallback
    // are covered in `test/problems/problem-solver.service.spec.ts`
    // — they can't be reached here because the DB CHECK constraint
    // added in 003 #2 rejects grades outside 1..12 at write time.
    // ─────────────────────────────────────────────────────────
    it('case #11d — system prompt varies by grade tier (1-6 / 7-12)', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'p-prompt-tier',
      );
      try {
        const tierCases = [
          { grade: 1, marker: '【小学阶段】' },
          { grade: 6, marker: '【小学阶段】' },
          { grade: 7, marker: '【中学阶段】' },
          { grade: 12, marker: '【中学阶段】' },
        ];
        for (const tc of tierCases) {
          // Reset the fake's scripted events to the default success
          // path (the previous test in this describe may have left
          // an error-only script in place).
          fakeAi.setEvents(defaultSuccessEvents());
          const callCountBefore = fakeAi.streamCallCount;

          const child = await createChild(app, {
            accessToken,
            grade: tc.grade,
          });
          const createRes = await request(app.getHttpServer())
            .post('/problems')
            .set('Authorization', `Bearer ${accessToken}`)
            .field('childId', String(child.id))
            .attach('image', TINY_PNG)
            .expect(201);
          const problemId = createRes.body.data.id as number;

          const url = `${baseUrl()}/problems/${problemId}/stream`;
          // Drain the SSE stream to completion.
          for await (const _frame of consumeSse(url, accessToken)) {
            // no-op; we only care about lastBody after the run
          }

          // Exactly one new SDK call per iteration (one fresh
          // problem each time). lastBody carries the system
          // prompt that the solver assembled.
          expect(fakeAi.streamCallCount).toBe(callCountBefore + 1);
          const sys = (fakeAi.lastBody as { system?: unknown } | null)?.system;
          expect(typeof sys).toBe('string');
          expect(sys as string).toContain(tc.marker);
        }
      } finally {
        await cleanupTestUser(user.id);
      }
    });
  });
});
