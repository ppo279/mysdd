import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { extname, join, resolve } from 'path';
import { Readable } from 'stream';
import { PutInput, PutResult, StorageService } from './storage.service';

/**
 * MIME → file extension map for the four formats we accept on upload.
 * Multer's `fileFilter` only validates the type; the actual filename
 * extension comes from the user-uploaded file (truncated/sanitized),
 * falling back to the MIME map below.
 *
 * Locked by `docs/prd/problems.md` §"MIME 白名单".
 */
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Filesystem-backed StorageService. Writes to:
 *
 *   <cwd>/uploads/problems/<userId>/<uuid>.<ext>
 *
 * Rationale:
 * - `process.cwd()`-relative keeps the path stable in `pnpm start` /
 *   `pnpm start:dev`. If a future production launch uses `node dist/main`
 *   from a different cwd, this resolution must be revisited (Phase 2).
 * - One directory per user makes per-user cleanup (e2e `afterEach`,
 *   GDPR-delete) a single `rm -rf` instead of a glob walk.
 * - `<uuid>` prevents a malicious upload from clobbering a sibling file
 *   by reusing its filename.
 */
@Injectable()
export class LocalDiskStorageService implements StorageService {
  private readonly logger = new Logger(LocalDiskStorageService.name);

  /** Resolved once at construction; relative paths stay relative. */
  private readonly rootDir = resolve(process.cwd(), 'uploads', 'problems');

  async put(input: PutInput): Promise<PutResult> {
    const ext = this.deriveExtension(input);
    const fileName = `${randomUUID()}${ext}`;
    const userDir = join(this.rootDir, String(input.userId));
    const fullPath = join(userDir, fileName);

    // mkdir with recursive:true is idempotent; safe under concurrent
    // uploads from the same user. fs/promises throws on real I/O errors
    // (disk full, permission denied) which we let bubble — caller is
    // responsible for marking the DB row `failed`.
    await fs.mkdir(userDir, { recursive: true });
    await fs.writeFile(fullPath, input.buffer);

    const key = `problems/${input.userId}/${fileName}`;
    return { url: key, key };
  }

  /**
   * Best-effort delete. Per the `StorageService` contract, failures are
   * logged at `warn` and swallowed — callers MUST NOT depend on this for
   * correctness. The DB row carries `status: 'failed'` as the audit trail.
   */
  async delete(key: string): Promise<void> {
    const fullPath = resolve(this.rootDir, '..', key);
    try {
      await fs.unlink(fullPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOENT = already gone, that's fine for a best-effort delete.
      // Anything else (EBUSY, EACCES, ...) is worth a warn so on-call
      // notices the orphan file.
      if (code !== 'ENOENT') {
        this.logger.warn(
          `best-effort delete failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  read(key: string): Readable {
    const fullPath = resolve(this.rootDir, '..', key);
    return createReadStream(fullPath);
  }

  /**
   * Pick the file extension in this order:
   * 1. The original filename's extension, if it's in our MIME map
   *    (e.g. `photo.PNG` → `.png`). This handles real-world uploads where
   *    the client gave a sensible name.
   * 2. The MIME map fallback for the sniffed `Content-Type`.
   * 3. Empty string — should be unreachable because the controller's
   *    `fileFilter` already rejected unknown MIMEs, but we degrade
   *    gracefully rather than throw.
   */
  private deriveExtension(input: PutInput): string {
    if (input.originalName) {
      const raw = extname(input.originalName).toLowerCase();
      if (raw && raw in this.allowedExtsByMime()) {
        return raw;
      }
    }
    return MIME_TO_EXT[input.mime] ?? '';
  }

  private allowedExtsByMime(): Set<string> {
    return new Set(Object.values(MIME_TO_EXT));
  }
}
