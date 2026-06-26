import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AnthropicModule } from '../integrations/anthropic/anthropic.module';
import { StorageModule } from '../storage/storage.module';
import { ProblemsController } from './problems.controller';
import { StreamIdorGuard } from './guards/stream-idor.guard';
import { ProblemSolverService } from './problem-solver.service';
import { ProblemsService } from './problems.service';

/**
 * ProblemsModule — vertical slices 1 + 2.
 *
 *  - Slice 1 (issues/001): upload + read state + read image.
 *  - Slice 2 (issues/002): solve + SSE stream.
 *
 * Module composition:
 * - `AuthModule`: gives us `JwtAuthGuard`. Not strictly required as a
 *   direct import (the guard could be re-declared) but keeping it
 *   explicit makes this module self-contained when used standalone.
 * - `StorageModule`: provides `STORAGE_SERVICE` for the image
 *   lifecycle (put on upload, read on stream/image, delete on
 *   rollback). NOT `@Global()` — see Phase 2 backlog.
 * - `AnthropicModule`: provides `ANTHROPIC_CLIENT` for the SSE
 *   solver. NOT `@Global()` — see Phase 2 backlog.
 * - `PrismaModule` is global, so we don't re-import it.
 */
@Module({
  imports: [AuthModule, StorageModule, AnthropicModule],
  controllers: [ProblemsController],
  providers: [ProblemsService, ProblemSolverService, StreamIdorGuard],
})
export class ProblemsModule {}
