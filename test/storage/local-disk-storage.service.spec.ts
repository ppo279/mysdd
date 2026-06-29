import { promises as fs } from 'fs';
import { resolve } from 'path';
import { Readable } from 'stream';
import { LocalDiskStorageService } from '../../src/storage/local-disk-storage.service';

/**
 * Unit tests for LocalDiskStorageService — the cycle-1 vertical slice
 * covers the four extension-derivation branches of `put()`. The e2e
 * suite already verifies the happy path (writes bytes + returns key);
 * this spec pins down the extension logic that the e2e can't easily
 * reach (uppercase, unknown ext, missing filename).
 *
 * Construction: the class takes no constructor args — it derives its
 * rootDir from `process.cwd()`. We use a unique `userId` per test to
 * keep cases independent and `afterEach` cleans up the per-user
 * upload dir so we don't pollute the working tree.
 */
describe('LocalDiskStorageService.put (extension derivation)', () => {
  const service = new LocalDiskStorageService();
  const cleanupUserIds: number[] = [];

  afterEach(async () => {
    // Wipe any directories the tests wrote to. Each test pushes its
    // userId onto the list; we remove with force:true so a missing
    // dir is a no-op.
    while (cleanupUserIds.length > 0) {
      const userId = cleanupUserIds.pop()!;
      const userDir = resolve(
        process.cwd(),
        'uploads',
        'problems',
        String(userId),
      );
      await fs.rm(userDir, { recursive: true, force: true });
    }
  });

  it('uses the originalName extension when it is on the whitelist (lowercase)', async () => {
    const userId = 900_001;
    cleanupUserIds.push(userId);

    const { key } = await service.put({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mime: 'image/png',
      originalName: 'homework.png',
      userId,
    });

    // Key shape: problems/<userId>/<uuid>.<ext>. We don't assert the
    // uuid (random) — just the trailing extension.
    expect(key).toMatch(/^problems\/900001\/[\w-]+\.png$/);
  });

  it('lowercases an uppercase whitelist extension (photo.PNG → .png)', async () => {
    // Some phone cameras send uppercased extensions. The storage
    // layer normalizes so the on-disk key matches the MIME-to-ext
    // map's casing.
    const userId = 900_002;
    cleanupUserIds.push(userId);

    const { key } = await service.put({
      buffer: Buffer.from([0xff, 0xd8, 0xff]),
      mime: 'image/jpeg',
      originalName: 'PHOTO.JPG',
      userId,
    });

    expect(key).toMatch(/\.jpg$/);
  });

  it('falls back to the MIME map when originalName has an unknown extension', async () => {
    // Multer's fileFilter would normally reject .heic before it gets
    // here, but the extension logic is defensive: if a non-whitelisted
    // ext sneaks through, the file is written with the MIME map's
    // extension so the read-back MIME matches the sniffed type.
    const userId = 900_003;
    cleanupUserIds.push(userId);

    const { key } = await service.put({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mime: 'image/png',
      originalName: 'photo.heic',
      userId,
    });

    expect(key).toMatch(/\.png$/);
  });

  it('falls back to the MIME map when originalName is missing', async () => {
    // Some HTTP clients don't send a filename. The `put` signature
    // already types `originalName?` as optional, and the storage
    // layer must still produce a valid extension.
    const userId = 900_004;
    cleanupUserIds.push(userId);

    const { key } = await service.put({
      buffer: Buffer.from('webp-bytes'),
      mime: 'image/webp',
      // originalName deliberately omitted
      userId,
    });

    expect(key).toMatch(/\.webp$/);
  });
});

/**
 * Cycle C — `read()` returns a Readable that streams the original
 * bytes back. The e2e suite covers this end-to-end through
 * `GET /problems/:id/image`, but a unit test pins down the public
 * contract (Readable shape + byte fidelity) without spinning up Nest.
 */
describe('LocalDiskStorageService.read', () => {
  const service = new LocalDiskStorageService();

  it('streams back the exact bytes that were written by put()', async () => {
    const userId = 900_010;
    const userDir = resolve(
      process.cwd(),
      'uploads',
      'problems',
      String(userId),
    );

    try {
      const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const { key } = await service.put({
        buffer: payload,
        mime: 'image/png',
        originalName: 'x.png',
        userId,
      });

      // The returned object must be a Readable (the image endpoint
      // pipes it straight to the HTTP response).
      const stream = service.read(key);
      expect(stream).toBeInstanceOf(Readable);

      // Drain the stream and compare to the original payload.
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const drained = Buffer.concat(chunks);
      expect(Buffer.compare(drained, payload)).toBe(0);
    } finally {
      await fs.rm(userDir, { recursive: true, force: true });
    }
  });
});

/**
 * Cycle D — `delete()` removes a real file. The e2e only covered the
 * ENOENT branch (deleting a non-existent key returns silently). This
 * test exercises the success path: put → delete → access throws.
 */
describe('LocalDiskStorageService.delete', () => {
  const service = new LocalDiskStorageService();

  it('removes the file from disk and leaves a follow-up access failing', async () => {
    const userId = 900_020;
    const userDir = resolve(
      process.cwd(),
      'uploads',
      'problems',
      String(userId),
    );

    try {
      const { key } = await service.put({
        buffer: Buffer.from('to-be-deleted'),
        mime: 'image/png',
        originalName: 'x.png',
        userId,
      });
      const onDisk = resolve(process.cwd(), 'uploads', key);
      // Sanity — file exists after put.
      await expect(fs.access(onDisk)).resolves.toBeUndefined();

      // delete() is typed as Promise<void> and best-effort; a
      // successful delete resolves without throwing.
      await expect(service.delete(key)).resolves.toBeUndefined();

      // The file should now be gone.
      await expect(fs.access(onDisk)).rejects.toThrow();
    } finally {
      await fs.rm(userDir, { recursive: true, force: true });
    }
  });
});
