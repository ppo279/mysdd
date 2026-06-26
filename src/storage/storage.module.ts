import { Module } from '@nestjs/common';
import { LocalDiskStorageService } from './local-disk-storage.service';
import { STORAGE_SERVICE } from './storage.tokens';

/**
 * DI token for the `StorageService` interface.
 *
 * Business code depends on this token, NOT on `LocalDiskStorageService`
 * directly, so a future S3/OSS implementation can swap in without
 * touching `ProblemsModule` (or any other consumer).
 */
export { STORAGE_SERVICE } from './storage.tokens';

/**
 * StorageModule.
 *
 * NOT `@Global()` — Phase 1 has exactly one consumer (`ProblemsModule`).
 * Phase 2 backlog says: "promote to @Global() when a second consumer
 * appears" (see `docs/prd/problems.md` §"Deferred Items").
 */
@Module({
  providers: [
    LocalDiskStorageService,
    // Bind the interface token to the concrete implementation.
    {
      provide: STORAGE_SERVICE,
      useExisting: LocalDiskStorageService,
    },
  ],
  exports: [STORAGE_SERVICE],
})
export class StorageModule {}
