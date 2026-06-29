import { Global, Module } from '@nestjs/common';
import { JanitorService } from './janitor.service';
import { OrphanFileJob } from './jobs/orphan-file.job';
import { StuckSolvingJob } from './jobs/stuck-solving.job';

/**
 * JanitorModule — `docs/issues/009-janitor-cron.md`.
 *
 * `@Global()` so the background sweep runs once per process, not once
 * per module that happens to import it. There is no second consumer
 * today, but unlike `StorageModule`/`AnthropicModule` the rationale
 * is different: the *work* itself is a singleton — running two
 * janitor instances would just delete each other's findings.
 *
 * Job registration is intentionally explicit (constructor parameters
 * on `JanitorService`) rather than a multi-provider token. The set of
 * jobs is small, stable, and lives in this module; the cost of
 * touching `JanitorService` to add a new job is the price of keeping
 * `runOnce`'s serial ordering a code-visible property.
 */
@Global()
@Module({
  providers: [JanitorService, StuckSolvingJob, OrphanFileJob],
  exports: [JanitorService],
})
export class JanitorModule {}
