import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrphanFileJob } from './jobs/orphan-file.job';
import { StuckSolvingJob } from './jobs/stuck-solving.job';
import { Job, JobResult } from './interfaces/job.interface';

/**
 * JanitorService — orchestrates a fixed set of cleanup jobs on a
 * recurring interval. See `docs/issues/009-janitor-cron.md`.
 *
 * Lifecycle:
 * - `OnModuleInit`: runs `runOnce()` immediately, then schedules a
 *   `setInterval` at `JANITOR_INTERVAL_MS` (default 60s).
 * - `OnModuleDestroy`: clears the interval so Nest shutdown isn't
 *   blocked by a stray timer.
 *
 * Why serial execution (`for (const job of jobs) await job.run()`)
 * instead of `Promise.all`:
 * - The two current jobs (stuck-solving, orphan-file) both hit PG.
 *   Parallel sweeps would multiply connection-pool pressure under
 *   load. Serial keeps it boring and predictable.
 * - If a future job is independent (e.g. a 3rd job that hits Redis),
 *   the JanitorService can grow a `parallel: true` flag on `Job`.
 *   Don't pre-optimize for a hypothetical now.
 *
 * Errors:
 * - A job that throws is logged at `error` and the runner moves on
 *   to the next job. One broken job must not block the others
 *   (the whole point of having multiple jobs in one sweep).
 */
@Injectable()
export class JanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JanitorService.name);
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly stuckSolving: StuckSolvingJob,
    private readonly orphanFile: OrphanFileJob,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Bootstrap tick. Run before scheduling so the first scheduled
    // tick is the *second* observation, not the first. Operators
    // reading the log on startup see real numbers, not just zeros
    // from "nothing was stuck 60s ago".
    await this.runOnce();

    const intervalMs = this.config.get<number>('JANITOR_INTERVAL_MS', 60000);
    this.intervalHandle = setInterval(() => {
      // Fire-and-forget; if it throws, the .catch inside runOnce logs.
      void this.runOnce();
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Run every registered job once, in order. Public so e2e tests
   * (and any future manual-trigger endpoint) can drive a sweep
   * without waiting for the interval.
   */
  async runOnce(): Promise<JobResult[]> {
    const jobs: Job[] = [this.stuckSolving, this.orphanFile];
    const results: JobResult[] = [];
    for (const job of jobs) {
      const start = Date.now();
      try {
        const result = await job.run();
        results.push(result);
        this.logger.log(
          `[janitor] ${job.name} affected=${result.affected} duration=${result.durationMs}ms`,
        );
      } catch (err) {
        const durationMs = Date.now() - start;
        this.logger.error(
          `[janitor] ${job.name} FAILED after ${durationMs}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Swallow — next job still runs. A failing job must not
        // block the others.
      }
    }
    return results;
  }
}
