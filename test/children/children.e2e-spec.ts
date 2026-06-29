import { promises as fs } from 'fs';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { resolve } from 'path';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';
import { ANTHROPIC_CLIENT } from '../../src/integrations/anthropic/anthropic.tokens';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeAnthropicClient } from '../problems/fakes/fake-anthropic-client';
import { cleanupUser, registerAndLogin } from '../problems/fixtures/user';

const TINY_PNG = resolve(__dirname, '..', 'problems', 'fixtures', 'tiny.png');

/**
 * E2E tests for ChildrenModule — 25 cases covering happy + validation
 * + IDOR + pagination + auth for the four endpoints.
 *
 * Strategy:
 * - Real Postgres (dev container). Unique emails per test keep cases
 *   independent — no TRUNCATE between runs.
 * - The fake Anthropic client is needed because ChildrenModule shares
 *   AppModule with ProblemsModule, and the latter would fail to
 *   start without an ANTHROPIC_CLIENT provider. We never trigger the
 *   solver in these tests, but the DI graph still has to resolve.
 *
 * The DELETE 409 case requires a child with a problem — we set that
 * up via the real Problems flow (POST /children → POST /problems)
 * rather than direct Prisma writes, so the "fixture migration"
 * the PRD calls for is exercised by the test setup itself.
 */

describe('ChildrenModule (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

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
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Per-test cleanup: DB rows + on-disk uploads (in case a test
   * created a problem under a child — the storage dir is keyed by
   * the user id, so wiping it is safe across multiple children).
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
  // POST /children
  // ─────────────────────────────────────────────────────────────
  describe('POST /children', () => {
    it('case #1 — 201 happy path creates child with id + createTime, no userId', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'c-create-happy',
      );
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 3 })
          .expect(201);

        // Envelope shape
        expect(res.body.code).toBe(0);
        expect(res.body.message).toBe('ok');
        // Body fields
        expect(res.body.data).toMatchObject({ name: '小红', grade: 3 });
        expect(res.body.data).toHaveProperty('id');
        expect(res.body.data).toHaveProperty('createTime');
        // userId MUST be omitted from the response — it's always
        // the JWT's userId, leaking it adds zero value and shrinks
        // the IDOR surface (a different response shape hints at
        // multi-tenant data).
        expect(res.body.data).not.toHaveProperty('userId');

        // DB sanity — row exists with the right userId.
        const row = await prisma.child.findUnique({
          where: { id: res.body.data.id },
        });
        expect(row).not.toBeNull();
        expect(row!.userId).toBe(user.id);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #2 — 400 when name is missing', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-no-name');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ grade: 3 })
          .expect(400);
        expect(res.body.message).toMatch(/name 必须是字符串/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #3 — 400 when name exceeds 50 characters', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-long-name');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: 'a'.repeat(51), grade: 3 })
          .expect(400);
        expect(res.body.message).toMatch(/name 长度不能超过 50/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #4 — 400 when name is an empty string', async () => {
      // @IsNotEmpty catches this case that @MaxLength(50) alone lets through.
      const { user, accessToken } = await registerAndLogin(app, 'c-empty-name');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '', grade: 3 })
          .expect(400);
        expect(res.body.message).toMatch(/name 不能为空/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #5 — 400 when grade is out of range (0)', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-grade-low');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 0 })
          .expect(400);
        expect(res.body.message).toMatch(/grade 必须大于等于 1/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #6 — 400 when grade is out of range (13)', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-grade-high');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 13 })
          .expect(400);
        expect(res.body.message).toMatch(/grade 必须小于等于 12/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #7 — 400 when grade is a non-integer (5.5)', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'c-grade-float',
      );
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 5.5 })
          .expect(400);
        expect(res.body.message).toMatch(/grade 必须是整数/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #8 — 400 when unknown field is sent', async () => {
      // forbidNonWhitelisted catches typos like `grde` instead of `grade`.
      const { user, accessToken } = await registerAndLogin(app, 'c-unknown');
      try {
        const res = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 3, grde: 3 })
          .expect(400);
        expect(res.body.message).toMatch(/grde/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #9 — 401 when no Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/children')
        .send({ name: '小红', grade: 3 })
        .expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /children
  // ─────────────────────────────────────────────────────────────
  describe('GET /children', () => {
    it('case #10 — 200 returns empty list (items: []) when no children', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-list-empty');
      try {
        const res = await request(app.getHttpServer())
          .get('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(res.body.data).toEqual({
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
        });
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #11 — 200 returns multiple children sorted by createTime:asc', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-list-multi');
      try {
        // Create three children. createTime is monotonic at insertion,
        // so first inserted appears first in the asc-sorted list.
        const c1 = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '老大', grade: 5 })
          .expect(201);
        const c2 = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '老二', grade: 3 })
          .expect(201);
        const c3 = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '老三', grade: 1 })
          .expect(201);

        const res = await request(app.getHttpServer())
          .get('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(res.body.data.items).toHaveLength(3);
        expect(res.body.data.total).toBe(3);
        expect(res.body.data.page).toBe(1);
        expect(res.body.data.pageSize).toBe(20);
        // Insertion order is the visible order
        expect(res.body.data.items[0].id).toBe(c1.body.data.id);
        expect(res.body.data.items[1].id).toBe(c2.body.data.id);
        expect(res.body.data.items[2].id).toBe(c3.body.data.id);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #12 — 200 paginates correctly (page=2, pageSize=2)', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-list-page');
      try {
        // Create 5 children to exercise pagination (3 on page 1, 2 on page 2).
        for (let i = 0; i < 5; i++) {
          await request(app.getHttpServer())
            .post('/children')
            .set('Authorization', `Bearer ${accessToken}`)
            .send({ name: `娃${i}`, grade: 1 })
            .expect(201);
        }

        const res = await request(app.getHttpServer())
          .get('/children?page=2&pageSize=2')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(res.body.data.items).toHaveLength(2);
        expect(res.body.data.total).toBe(5);
        expect(res.body.data.page).toBe(2);
        expect(res.body.data.pageSize).toBe(2);
        // The two children on page 2 are the 3rd and 4th inserted.
        expect(res.body.data.items[0].name).toBe('娃2');
        expect(res.body.data.items[1].name).toBe('娃3');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #13 — 400 when pageSize > 100', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-page-big');
      try {
        const res = await request(app.getHttpServer())
          .get('/children?pageSize=101')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(400);
        expect(res.body.message).toMatch(/pageSize 必须小于等于 100/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #14 — 400 when page is a non-integer', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-page-bad');
      try {
        const res = await request(app.getHttpServer())
          .get('/children?page=abc')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(400);
        expect(res.body.message).toMatch(/page 必须是整数/);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it("case #15 — 200 returns ONLY the caller's children (cross-tenant isolation)", async () => {
      // Family A creates two children, Family B creates one.
      // Family A's GET /children should see only their two.
      const familyA = await registerAndLogin(app, 'c-iso-A');
      const familyB = await registerAndLogin(app, 'c-iso-B');
      try {
        await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${familyA.accessToken}`)
          .send({ name: 'A1', grade: 1 })
          .expect(201);
        await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${familyA.accessToken}`)
          .send({ name: 'A2', grade: 2 })
          .expect(201);
        await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${familyB.accessToken}`)
          .send({ name: 'B1', grade: 1 })
          .expect(201);

        const aRes = await request(app.getHttpServer())
          .get('/children')
          .set('Authorization', `Bearer ${familyA.accessToken}`)
          .expect(200);
        expect(aRes.body.data.total).toBe(2);
        const aNames = aRes.body.data.items.map(
          (c: { name: string }) => c.name,
        );
        expect(aNames).toEqual(['A1', 'A2']);

        const bRes = await request(app.getHttpServer())
          .get('/children')
          .set('Authorization', `Bearer ${familyB.accessToken}`)
          .expect(200);
        expect(bRes.body.data.total).toBe(1);
        expect(bRes.body.data.items[0].name).toBe('B1');
      } finally {
        await cleanupTestUser(familyA.user.id);
        await cleanupTestUser(familyB.user.id);
      }
    });

    it('case #16 — 401 when no Authorization header', async () => {
      await request(app.getHttpServer()).get('/children').expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /children/:id
  // ─────────────────────────────────────────────────────────────
  describe('GET /children/:id', () => {
    it('case #17 — 200 returns the child for the owner', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-get-ok');
      try {
        const created = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 3 })
          .expect(201);
        const childId = created.body.data.id;

        const res = await request(app.getHttpServer())
          .get(`/children/${childId}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(200);

        expect(res.body.data).toMatchObject({
          id: childId,
          name: '小红',
          grade: 3,
        });
        expect(res.body.data).not.toHaveProperty('userId');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it("case #18 — 404 when reading another family's child (IDOR-safe)", async () => {
      // Per ADR-0005, IDOR miss returns 404 with `child 不存在` — NOT
      // 403 — so an attacker can't enumerate ids by status code.
      const owner = await registerAndLogin(app, 'c-idor-owner');
      const attacker = await registerAndLogin(app, 'c-idor-attacker');
      try {
        const created = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ name: 'owner-kid', grade: 3 })
          .expect(201);
        const childId = created.body.data.id;

        const res = await request(app.getHttpServer())
          .get(`/children/${childId}`)
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .expect(404);
        // Same message as the "doesn't exist" case (case #19) — the
        // attacker cannot distinguish "exists but not yours" from
        // "doesn't exist at all".
        expect(res.body.message).toBe('child 不存在');
      } finally {
        await cleanupTestUser(owner.user.id);
        await cleanupTestUser(attacker.user.id);
      }
    });

    it('case #19 — 404 when child truly does not exist (same message as IDOR)', async () => {
      // 999999999 is well above any realistic id — there will never
      // be a row with this id in the dev DB.
      const { user, accessToken } = await registerAndLogin(app, 'c-ghost');
      try {
        const res = await request(app.getHttpServer())
          .get('/children/999999999')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('child 不存在');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #20 — 400 when :id is not a valid integer', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-bad-id');
      try {
        const res = await request(app.getHttpServer())
          .get('/children/abc')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(400);
        // ParseIntPipe's default message is the English Nest string,
        // which the global filter doesn't translate. The body shape
        // is still the standard {code, message, traceId} envelope.
        expect(res.body).toHaveProperty('traceId');
        expect(res.body.code).toBe(400);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #21 — 401 when no Authorization header', async () => {
      await request(app.getHttpServer()).get('/children/1').expect(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // DELETE /children/:id
  // ─────────────────────────────────────────────────────────────
  describe('DELETE /children/:id', () => {
    it('case #22 — 204 no body when child has no problems', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-del-ok');
      try {
        const created = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 3 })
          .expect(201);
        const childId = created.body.data.id;

        const res = await request(app.getHttpServer())
          .delete(`/children/${childId}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(204);

        // 204 has no body — the RawResponse() decorator ensures the
        // success envelope is NOT applied here. `res.text` is empty.
        expect(res.text).toBe('');

        // DB sanity — row is gone (hard delete, no soft-delete column).
        const row = await prisma.child.findUnique({ where: { id: childId } });
        expect(row).toBeNull();
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #23 — 409 when child has associated problems', async () => {
      const { user, accessToken } = await registerAndLogin(
        app,
        'c-del-conflict',
      );
      try {
        // Set up: create child + upload a problem. The storage
        // service is real (LocalDiskStorageService), so we attach a
        // real tiny.png to satisfy the FileInterceptor.
        const created = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({ name: '小红', grade: 3 })
          .expect(201);
        const childId = created.body.data.id;

        await request(app.getHttpServer())
          .post('/problems')
          .set('Authorization', `Bearer ${accessToken}`)
          .field('childId', String(childId))
          .attach('image', TINY_PNG)
          .expect(201);

        const res = await request(app.getHttpServer())
          .delete(`/children/${childId}`)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(409);
        expect(res.body.message).toBe('该孩子存在题目，无法删除');

        // CRITICAL: the row MUST still exist. The 409 is the whole
        // point of this branch — refuse the destructive operation.
        const row = await prisma.child.findUnique({ where: { id: childId } });
        expect(row).not.toBeNull();
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it("case #24 — 404 when deleting another family's child (IDOR-safe)", async () => {
      const owner = await registerAndLogin(app, 'c-del-idor-owner');
      const attacker = await registerAndLogin(app, 'c-del-idor-attacker');
      try {
        const created = await request(app.getHttpServer())
          .post('/children')
          .set('Authorization', `Bearer ${owner.accessToken}`)
          .send({ name: 'owner-kid', grade: 3 })
          .expect(201);
        const childId = created.body.data.id;

        const res = await request(app.getHttpServer())
          .delete(`/children/${childId}`)
          .set('Authorization', `Bearer ${attacker.accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('child 不存在');

        // The owner's row is still there — the attacker can't delete
        // what isn't theirs.
        const row = await prisma.child.findUnique({ where: { id: childId } });
        expect(row).not.toBeNull();
      } finally {
        await cleanupTestUser(owner.user.id);
        await cleanupTestUser(attacker.user.id);
      }
    });

    it('case #25 — 404 when child does not exist (same message as IDOR)', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-del-ghost');
      try {
        const res = await request(app.getHttpServer())
          .delete('/children/999999999')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(404);
        expect(res.body.message).toBe('child 不存在');
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #26 — 400 when :id is not a valid integer', async () => {
      const { user, accessToken } = await registerAndLogin(app, 'c-del-bad');
      try {
        const res = await request(app.getHttpServer())
          .delete('/children/abc')
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(400);
        expect(res.body).toHaveProperty('traceId');
        expect(res.body.code).toBe(400);
      } finally {
        await cleanupTestUser(user.id);
      }
    });

    it('case #27 — 401 when no Authorization header', async () => {
      await request(app.getHttpServer()).delete('/children/1').expect(401);
    });
  });
});
