import { Readable } from 'stream';

/**
 * Storage abstraction for problem images.
 *
 * Phase 1 ships one implementation (`LocalDiskStorageService`) that writes
 * to `./uploads/problems/<userId>/<uuid>.<ext>`. Phase 2 may add an OSS/S3
 * implementation behind the same interface — business code never imports
 * the concrete class.
 *
 * Locked decisions (see `docs/issues/001-problems-upload-read-image.md`):
 * - `put` receives `userId` explicitly from the caller (the ProblemsService
 *   gets it from the JWT). We deliberately do NOT use AsyncLocalStorage /
 *   implicit injection — the dependency is visible at the call site.
 * - `put` returns `{ url, key }` where both are RELATIVE paths
 *   (`problems/<userId>/<uuid>.<ext>`). Callers prepend `baseURL` if they
 *   need an absolute URL. We never embed the host inside the storage layer
 *   so tests can override the base.
 * - `delete` is BEST-EFFORT: failures are logged with `warn` and swallowed.
 *   In the DB-first create order, `delete` only runs on the rare step-4
 *   failure path (DB update with the real key failed after the file was
 *   already written). The corresponding `Problem` row is marked
 *   `status: 'failed'`, so the file is reconciled by a Phase 2 janitor.
 */
export interface PutInput {
  /** File bytes (already in memory via multer.memoryStorage()). */
  buffer: Buffer;
  /** MIME type as sniffed by multer. Used for extension fallback. */
  mime: string;
  /** Original filename from the upload — used for extension if non-empty. */
  originalName?: string;
  /**
   * Owning user. The ProblemsService gets this from `req.user.userId` and
   * passes it explicitly so the storage layer stays request-scoped unaware.
   */
  userId: number;
}

export interface PutResult {
  /** Same value as `key` — kept separate so a future signed-URL impl can
   *  diverge (e.g. `url` = presigned URL, `key` = storage path). */
  url: string;
  /** Storage key, relative to the storage root. */
  key: string;
}

export interface StorageService {
  /**
   * Persist bytes and return the relative key/URL. Throws on filesystem
   * errors (caller is responsible for marking the DB row `failed` and
   * for any best-effort cleanup of partial writes).
   */
  put(input: PutInput): Promise<PutResult>;

  /**
   * Best-effort delete. Failures are logged at `warn` and swallowed —
   * callers MUST NOT rely on this for correctness. The DB-first create
   * order means a missed delete only leaks a file paired with a
   * `status: 'failed'` row, sweepable by a Phase 2 cron.
   */
  delete(key: string): Promise<void>;

  /**
   * Open a stream over the stored bytes. Used by the authenticated image
   * endpoint (`GET /problems/:id/image`) which streams the file directly
   * to the client without ever exposing a public URL.
   */
  read(key: string): Readable;
}
