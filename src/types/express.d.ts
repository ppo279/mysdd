/**
 * Module augmentation for Express's `Request` interface.
 *
 * Two app-specific properties are added to every `Request`:
 *
 * - `traceId?: string`  — populated by `TraceIdMiddleware` (runs first
 *   in the pipeline) so downstream code (filters, services, logger) can
 *   include it in error bodies and log lines.
 *
 * - `user?: JwtPayload` — populated by `JwtAuthGuard` on protected
 *   routes, read by `@CurrentUser()` and controllers.
 *
 * Both are OPTIONAL because not every code path guarantees they are
 * set:
 * - `traceId` is always set in practice (middleware runs first), but
 *   we keep `?` so the global filter can defensively fall back to a
 *   fresh UUID if some future refactor reorders the middleware.
 * - `user` is only set on routes protected by `@UseGuards(JwtAuthGuard)`.
 *   Public routes (`GET /health`, `POST /auth/login`) intentionally
 *   leave it undefined; `extractCurrentUser` in
 *   `src/auth/decorators/current-user.decorator.ts` throws if a route
 *   reads it without the guard.
 *
 * Implementation note — `declare global { namespace Express }`:
 * `@types/express-serve-static-core` declares an empty `interface
 * Request {}` inside `declare global { namespace Express { ... } }`
 * (line 10 of its index.d.ts), specifically to be the augmentation
 * point. The exported `Request` (with generics) extends that empty
 * global interface, so adding members to `Express.Request` is
 * inherited by `express.Request` via interface extension. This is
 * the canonical DefinitelyTyped-recommended pattern.
 *
 * The top-level `import type` keeps this file a module (not a script),
 * which is required for `declare global` to work correctly. The file
 * is auto-included by tsconfig.json's include glob for src.
 */
import type { JwtPayload } from '../auth/jwt-payload';

declare global {
  namespace Express {
    interface Request {
      traceId?: string;
      user?: JwtPayload;
    }
  }
}