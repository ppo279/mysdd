/**
 * Result of a single Janitor job run. The JanitorService logs
 * `[janitor] <name> affected=<N> duration=<Ms>ms` for every run
 * (zero-affected runs included) so operators can see at a glance
 * whether the sweep is hitting anything.
 */
export interface JobResult {
  /**
   * Number of rows / files the job touched. For DB jobs this is the
   * Prisma `count` (updateMany / deleteMany). For filesystem jobs
   * this is the count of files deleted. Zero is a valid value (job
   * ran, found nothing to do).
   */
  affected: number;
  /** Wall-clock time the job took, in milliseconds. */
  durationMs: number;
}

/**
 * A Janitor job is a self-contained unit of background cleanup.
 * Jobs run sequentially inside a single tick (not in parallel —
 * see `JanitorService.runOnce` rationale). Each job MUST:
 *
 * - Be safe to run repeatedly (idempotent). Multiple ticks within
 *   the recovery window are normal.
 * - Not throw on empty work — return `{ affected: 0, durationMs }`.
 * - Throw only on truly unexpected errors (DB down, disk on fire).
 *   The runner catches those and continues to the next job so one
 *   broken job can't starve the others.
 */
export interface Job {
  /** Short stable identifier; used in logs. */
  readonly name: string;
  run(): Promise<JobResult>;
}
