import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { buildValidationPipe } from '../../src/common/validation';

/**
 * Contract tests for the global response envelope.
 *
 * Verifies the SHAPE of every HTTP response (success and error) matches
 * the agreed RESTful-style envelope. These tests guard against regressions
 * where someone adds a controller that bypasses the wrapping layer, or
 * changes the error filter to leak Nest's default `{statusCode, error}` body.
 *
 * Each test exercises a real route via supertest — no mocking — so the
 * filter / interceptor are wired in exactly as production uses them.
 */

const uniqueEmail = (label: string) =>
  `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@e2e.test`;

const VALID_PASSWORD = 'Abc12345';

describe('Response envelope (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(buildValidationPipe());
    app.useGlobalFilters(new AllExceptionsFilter());
    // Success envelope is registered via APP_INTERCEPTOR in AppModule (DI-aware).
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 1: 4xx error body must be { code, message }
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 1 — error body shape', () => {
    it('401 wrong-password login returns { code: 401, message }', async () => {
      // First register a user so the "user exists" branch is exercised.
      const email = uniqueEmail('cycle1');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(201);

      // Now login with wrong password — must yield 401 in the new shape.
      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'WrongPass1' })
        .expect(401);

      expect(res.body).toMatchObject({
        code: 401,
        message: '邮箱或密码错误',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 2: error body must include traceId (UUID v4)
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 2 — error body has traceId', () => {
    it('401 body contains a UUID v4 traceId', async () => {
      const email = uniqueEmail('cycle2');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: 'WrongPass1' })
        .expect(401);

      expect(res.body).toHaveProperty('traceId');
      // RFC 4122 v4: third group starts with 4, fourth group starts with 8/9/a/b
      expect(res.body.traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 3: every response carries X-Trace-Id header
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 3 — X-Trace-Id response header', () => {
    it('201 register response carries X-Trace-Id header (UUID v4)', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: uniqueEmail('cycle3'), password: VALID_PASSWORD })
        .expect(201);

      const traceId = res.headers['x-trace-id'];
      expect(traceId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 4: success responses are wrapped as { code: 0, message, data }
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 4 — success body wrapping', () => {
    it('200 login response is wrapped as { code: 0, message: "ok", data: { accessToken } }', async () => {
      const email = uniqueEmail('cycle4');
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email, password: VALID_PASSWORD })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password: VALID_PASSWORD })
        .expect(200);

      expect(res.body).toMatchObject({
        code: 0,
        message: 'ok',
        data: { accessToken: expect.any(String) },
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 5: @RawResponse() decorator opts a route out of wrapping
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 5 — @RawResponse() opt-out', () => {
    it('GET /health (decorated) returns unwrapped body, no envelope fields', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);

      // Not wrapped — body has direct fields, no code/message envelope
      expect(res.body).toHaveProperty('status', 'ok');
      expect(res.body).not.toHaveProperty('code');
      expect(res.body).not.toHaveProperty('message');
      expect(res.body).not.toHaveProperty('data');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 6: Nest default 404 English message is localized
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 6 — 404 localization', () => {
    it('GET /unknown-route returns { code: 404, message: "接口路径不存在" }', async () => {
      const res = await request(app.getHttpServer())
        .get('/this-route-does-not-exist')
        .expect(404);

      expect(res.body).toMatchObject({
        code: 404,
        message: '接口路径不存在',
      });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Cycle 7: raw (non-HttpException) errors are sanitized to 500
  // ─────────────────────────────────────────────────────────────
  describe('Cycle 7 — 5xx sanitization', () => {
    it('GET /health/boom (throws raw Error) returns sanitized 500, no internal details leaked', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/boom')
        .expect(500);

      expect(res.body).toMatchObject({
        code: 500,
        message: '服务器内部错误',
      });
      // Internal error message must NOT appear in the response body
      expect(JSON.stringify(res.body)).not.toMatch(/10\.0\.0\.5/);
      expect(JSON.stringify(res.body)).not.toMatch(
        /Database connection refused/,
      );
    });
  });
});
