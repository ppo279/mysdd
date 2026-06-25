import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { buildValidationPipe } from '../../src/common/validation';

/**
 * E2E tests for AuthModule.
 *
 * Strategy:
 * - Real Postgres (the dev container). Each test uses a unique email so
 *   cases are independent and we don't need to TRUNCATE between runs.
 * - Uses supertest to drive the HTTP layer (mimics real client).
 */

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;

const VALID_PASSWORD = 'Abc12345';

/**
 * Decode a JWT payload (middle segment) without verifying signature.
 * We only use this to ASSERT the payload shape, not for auth.
 */
const decodeJwtPayload = (token: string): Record<string, unknown> => {
  const segment = token.split('.')[1];
  // base64url -> base64
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
};

describe('AuthModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    // Use the SAME validation pipe as production (shared in src/common).
    app.useGlobalPipes(buildValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────
  // POST /auth/register
  // ─────────────────────────────────────────────────────────────
  describe('POST /auth/register', () => {
    it('201 — valid input creates user and returns id/email/createTime', async () => {
      const email = uniqueEmail('reg-ok');
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(201);

      expect(res.body).toMatchObject({ email });
      expect(res.body).toHaveProperty('id');
      expect(res.body).toHaveProperty('createTime');
      // passwordHash MUST NOT be returned
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('400 — invalid email format returns Chinese validation message', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'not-an-email', password: VALID_PASSWORD })
        .expect(400);

      expect(res.body.message).toMatch(/邮箱格式不正确/);
    });

    it('400 — weak password returns multiple rule violations', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: uniqueEmail('weak'), password: 'abc' })
        .expect(400);

      expect(res.body.message).toMatch(/密码至少 8 位/);
    });

    it('409 — duplicate email returns conflict message', async () => {
      const email = uniqueEmail('dup');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(409);

      expect(res.body.message).toMatch(/已被注册/);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // POST /auth/login
  // ─────────────────────────────────────────────────────────────
  describe('POST /auth/login', () => {
    let existingEmail: string;

    beforeAll(async () => {
      existingEmail = uniqueEmail('login');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: existingEmail, password: VALID_PASSWORD })
        .expect(201);
    });

    it('200 — correct credentials return accessToken', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: existingEmail, password: VALID_PASSWORD })
        .expect(200);

      expect(typeof res.body.accessToken).toBe('string');
      expect(res.body.accessToken.split('.').length).toBe(3); // valid JWT shape
    });

    it('payload — JWT contains userId + email, NEVER password', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: existingEmail, password: VALID_PASSWORD })
        .expect(200);

      const payload = decodeJwtPayload(res.body.accessToken);

      expect(payload).toHaveProperty('userId');
      expect(payload).toHaveProperty('email', existingEmail);
      expect(payload).not.toHaveProperty('password');
      expect(payload).not.toHaveProperty('passwordHash');
      // sanity: payload is not the bcrypt hash either
      expect(JSON.stringify(payload)).not.toMatch(/\$2[aby]\$/);
    });

    it('401 — wrong password returns generic error', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: existingEmail, password: 'WrongPass1' })
        .expect(401);

      expect(res.body.message).toBe('邮箱或密码错误');
    });

    it('401 — non-existent email returns SAME message (anti-enumeration)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: uniqueEmail('ghost'), password: VALID_PASSWORD })
        .expect(401);

      expect(res.body.message).toBe('邮箱或密码错误');
    });

    it('timing defense — not-found path STILL calls bcrypt.compare', async () => {
      // Regression guard: someone might "optimize" by removing the
      // bcrypt.compare in the user-not-found branch, which would re-enable
      // email-enumeration via response-time analysis.
      //
      // We can't spy on bcrypt (native module, not redefinable), so we
      // measure wall-clock time as a proxy. If a future change replaces
      // DUMMY_HASH with a hard-coded malformed string, some bcrypt
      // implementations may short-circuit and return false in <1ms,
      // which this test would catch.
      //
      // 3 not-found logins should each take ≥50ms (bcrypt at cost=12
      // is ~150-250ms; 50ms is a conservative lower bound).
      const t = Date.now();
      for (let i = 0; i < 3; i++) {
        await request(app.getHttpServer())
          .post('/auth/login')
          .send({
            email: uniqueEmail(`ghost-timing-${i}`),
            password: VALID_PASSWORD,
          })
          .expect(401);
      }
      const elapsed = Date.now() - t;
      // 3 logins × ~180ms each ≈ 540ms; allow generous lower bound
      expect(elapsed).toBeGreaterThan(150);
    });

    it('400 — missing password', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: existingEmail })
        .expect(400);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // GET /auth/me (JWT protected)
  // ─────────────────────────────────────────────────────────────
  describe('GET /auth/me', () => {
    let token: string;
    let meEmail: string;

    beforeAll(async () => {
      meEmail = uniqueEmail('me');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: meEmail, password: VALID_PASSWORD })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: meEmail, password: VALID_PASSWORD })
        .expect(200);
      token = res.body.accessToken;
    });

    it('200 — valid Bearer token returns current user', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({ email: meEmail });
      expect(res.body).toHaveProperty('id');
      expect(res.body).not.toHaveProperty('passwordHash');
    });

    it('401 — missing Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me').expect(401);
      expect(res.body.message).toMatch(/缺少 Authorization/);
    });

    it('401 — malformed Authorization header (no Bearer prefix)', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'justatoken')
        .expect(401);
      expect(res.body.message).toMatch(/缺少 Authorization Bearer/);
    });

    it('401 — invalid signature', async () => {
      const tampered = token.split('.').slice(0, 2).join('.') + '.invalidsig';
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${tampered}`)
        .expect(401);
      expect(res.body.message).toMatch(/token 无效或已过期/);
    });

    it('401 — garbage token', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer abc.def.ghi')
        .expect(401);
      expect(res.body.message).toMatch(/token 无效或已过期/);
    });
  });
});