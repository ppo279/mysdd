import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChildrenController } from './children.controller';
import { ChildrenService } from './children.service';

/**
 * ChildrenModule — vertical slice for the `/children` endpoints.
 *
 * Module composition:
 * - `AuthModule`: gives us `JwtAuthGuard` (re-exported by AuthModule
 *   so we can `@UseGuards(JwtAuthGuard)` on the controller without
 *   re-declaring). Mirrors `ProblemsModule`'s pattern.
 * - `PrismaModule` is `@Global()`, so we don't re-import it.
 *
 * Not `@Global()` itself: only feature modules with cross-cutting
 * infrastructure get the global marker (per ADR-0004 / ADR-0005 /
 * ADR-0006's "second consumer" rule). Children is a plain CRUD
 * module — no token, no service, no constant that another module
 * would need to inject.
 */
@Module({
  imports: [AuthModule],
  controllers: [ChildrenController],
  providers: [ChildrenService],
})
export class ChildrenModule {}
