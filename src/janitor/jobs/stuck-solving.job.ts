import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Job, JobResult } from '../interfaces/job.interface';

/**
 * StuckSolvingJob — reset rows stuck in `status='solving'` longer than
 * `STUCK_SOLVING_THRESHOLD_MS` back to `status='pending'`.
 *
 * Background: when a `solve()` is mid-stream and the process gets
 * SIGKILLed (or the pod OOMs, or the box reboots), the row stays at
 * `status='solving'` forever. No consumer ever picks it up again —
 * `solve()` is only triggered by `GET /problems/:id/stream`, and the
 * concurrency guard (`updateMany(pending→solving)`) rejects any
 * attempt to re-solve a non-pending row. So the row is stranded.
 *
 * This job resets stranded rows to `pending`. The user re-streams and
 * a fresh `solve()` runs. We deliberately do NOT auto-retry inside
 * the job — that would burn LLM tokens at 3am with no human in the
 * loop. The user opts in by reopening the stream.
 *
 * Threshold: `STUCK_SOLVING_THRESHOLD_MS`, default 5 minutes. The 5
 * min window is intentionally larger than the normal solve latency
 * (≤3s for tiny models, up to 180s for `SOLVER_TIMEOUT_MS`). A row
 * at `solving` for >5min is by definition not a healthy in-flight
 * solve.
 */
@Injectable()
export class StuckSolvingJob implements Job {
  readonly name = 'stuck-solving';

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async run(): Promise<JobResult> {
    const start = Date.now();
    const thresholdMs = this.config.get<number>(
      'STUCK_SOLVING_THRESHOLD_MS',
      300000, // 5 minutes
    );
    const cutoff = new Date(Date.now() - thresholdMs);

    const result = await this.prisma.problem.updateMany({
      where: {
        status: 'solving',
        updatedAt: { lt: cutoff },
      },
      data: {
        status: 'pending',
        // `updatedAt` is `@updatedAt` in the schema; Prisma auto-bumps
        // it on update. We don't set it explicitly to avoid the
        // type-cast dance with `Prisma.InputJsonValue` etc.
      },
    });

    return { affected: result.count, durationMs: Date.now() - start };
  }
}
