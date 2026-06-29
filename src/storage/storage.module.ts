import { Global, Module } from '@nestjs/common';
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
 * `@Global()` since 2026-06-29 (overrides backlog item #4 in
 * `docs/issues/003-problems-phase-2-backlog.md`, which originally
 * gated this on "a second consumer appears"). Lifted early on user
 * request so future modules (e.g. `ChildrenModule`) can inject
 * `STORAGE_SERVICE` without re-importing this module.
 *
 * Registered once at the root in `AppModule`.
 */
@Global()
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
