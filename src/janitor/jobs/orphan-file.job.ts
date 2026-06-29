import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { PrismaService } from '../../prisma/prisma.service';
import { Job, JobResult } from '../interfaces/job.interface';

/**
 * OrphanFileJob — delete files in `./uploads/problems/` that no live
 * `Problem` row references (or whose row is `status='failed'`, the
 * cleanup residue left by a failed upload).
 *
 * Two orphan categories (both deleted):
 *
 * 1. **Missing-DB orphan**: file on disk, no `Problem` row with
 *    matching `imageUrl`. Can happen if a row was deleted out of band
 *    (manual SQL, GDPR cleanup script) but the file wasn't unlinked.
 *
 * 2. **Failed-upload residue**: `Problem` row exists at
 *    `status='failed'` AND the file is still on disk. This is the
 *    normal residue of slice 1's `storage.delete` being
 *    best-effort (`docs/adr/0006-storage-interface-local-disk.md`):
 *    the DB rolls back to `failed`, but `unlink` can fail for
 *    reasons unrelated to the upload itself (file held open by
 *    antivirus, transient EACCES, etc.). Those rows eventually
 *    pass through `failure-recovery` and the row's `imageUrl`
 *    stays, but the file is dead weight.
 *
 * Layout assumption (matches `LocalDiskStorageService.put`):
 *   <cwd>/uploads/problems/<userId>/<uuid>.<ext>
 * Traversal is intentionally shallow — 2 levels max. We do NOT
 * recurse past `<userId>/` because there are no nested dirs in the
 * write path.
 *
 * **Local-disk only.** The walk-and-compare design is fundamentally
 * filesystem-shaped; on S3/OSS the equivalent would be `listObjects`
 * + `headObject` per key. When storage moves off local disk, this
 * job is the part that needs replacing (the cleanup *intent* stays;
 * only the enumeration mechanism changes).
 */
@Injectable()
export class OrphanFileJob implements Job {
  readonly name = 'orphan-file';
  private readonly logger = new Logger(OrphanFileJob.name);

  /** Mirrors `LocalDiskStorageService.rootDir` — see comment there. */
  private readonly rootDir = resolve(process.cwd(), 'uploads', 'problems');

  constructor(private readonly prisma: PrismaService) {}

  async run(): Promise<JobResult> {
    const start = Date.now();

    // ── 1. Snapshot DB: imageUrl → status (only the statuses we care about) ──
    // We select only the rows we might match against, keeping the
    // payload small even at scale (no `id`, no `createTime`).
    const rows = await this.prisma.problem.findMany({
      where: {
        imageUrl: { startsWith: 'problems/' },
      },
      select: { imageUrl: true, status: true },
    });
    const dbIndex = new Map<string, 'failed' | 'live'>();
    for (const row of rows) {
      // 'live' = anything that should still own its file.
      dbIndex.set(row.imageUrl, row.status === 'failed' ? 'failed' : 'live');
    }

    // ── 2. Walk disk, compare, delete orphans ──
    let deleted = 0;
    try {
      const userDirs = await fs.readdir(this.rootDir, {
        withFileTypes: true,
      });
      for (const userDir of userDirs) {
        if (!userDir.isDirectory()) continue;
        const userDirPath = join(this.rootDir, userDir.name);
        const files = await fs.readdir(userDirPath, {
          withFileTypes: true,
        });
        for (const file of files) {
          if (!file.isFile()) continue;

          // imageUrl format: `problems/<userId>/<uuid>.<ext>`
          // Mirrors `LocalDiskStorageService.put`'s `key` field.
          // The separator is forward-slash on purpose: imageUrls are
          // opaque keys that travel through the HTTP layer, and
          // `LocalDiskStorageService.put` always emits forward
          // slashes regardless of host OS. Using `path.sep` here
          // would produce `problems\870\...` on Windows and break
          // the DB lookup.
          const imageUrl = `problems/${userDir.name}/${file.name}`;

          const owner = dbIndex.get(imageUrl);
          const isOrphan =
            owner === undefined /* missing-DB */ ||
            owner === 'failed'; /* failed-upload residue */
          if (!isOrphan) continue;

          const fullPath = join(userDirPath, file.name);
          try {
            await fs.unlink(fullPath);
            deleted++;
          } catch (err) {
            // Don't abort the whole sweep on one file. Surface the
            // error so it shows up in logs but keep going.
            const code = (err as NodeJS.ErrnoException).code;
            this.logger.warn(
              `[janitor] orphan-file: failed to delete ${fullPath} (${code ?? 'unknown'}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      }
    } catch (err) {
      // The rootDir may not exist yet (fresh install, never uploaded).
      // That's a clean zero-affected run, not an error.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        throw err;
      }
    }

    return { affected: deleted, durationMs: Date.now() - start };
  }
}
