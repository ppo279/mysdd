import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { ProblemsController } from './problems.controller';
import { ProblemsService } from './problems.service';

/**
 * ProblemsModule — Phase 1 vertical slice (issues/001).
 *
 * Covers upload, read-state, and read-image. Streaming + solve lives in
 * the follow-up issue (`docs/issues/002-problems-solve-stream.md`).
 *
 * Module composition:
 * - `AuthModule`: gives us `JwtAuthGuard` (already global-ish; imported
 *   here so this module is self-contained when imported standalone).
 * - `StorageModule`: provides `STORAGE_SERVICE`. NOT `@Global()` —
 *   see `src/storage/storage.module.ts` for the rationale.
 * - `PrismaModule` is global, so we don't re-import it.
 */
@Module({
  imports: [AuthModule, StorageModule],
  controllers: [ProblemsController],
  providers: [ProblemsService],
})
export class ProblemsModule {}
