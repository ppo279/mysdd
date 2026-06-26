/**
 * Shape of the JWT payload we issue.
 *
 * Kept minimal — anything put here is publicly decodable (JWT is base64,
 * not encrypted), so no password, hash, or sensitive PII should ever
 * land here.
 *
 * Lives in its own file (separate from JwtAuthGuard) so it can be
 * imported as a pure type by:
 *   - The guard (verifies + attaches)
 *   - The @CurrentUser decorator (reads)
 *   - Controllers (consumer)
 *   - The Express Request module augmentation in src/types/express.d.ts
 *
 * No runtime code here — it's `.ts` only so we get a real type export
 * usable in both runtime positions (`import { JwtPayload }`) and type
 * positions (`import type { JwtPayload }`).
 */
export interface JwtPayload {
  /** numeric user id */
  userId: number;
  /** user's email (handy for logs, not security-critical) */
  email: string;
}