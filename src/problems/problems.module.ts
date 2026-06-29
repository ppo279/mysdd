import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
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
 * - `StorageModule` and `AnthropicModule` are `@Global()` (lifted on
 *   2026-06-29, issue 003/4). Their providers (`STORAGE_SERVICE`,
 *   `ANTHROPIC_CLIENT`) are injectable here without re-importing.
 * - `PrismaModule` is `@Global()`, so we don't re-import it either.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProblemsController],
  providers: [ProblemsService, ProblemSolverService, StreamIdorGuard],
})
export class ProblemsModule {}
