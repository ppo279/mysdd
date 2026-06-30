/**
 * SseSink — a thin abstraction the solver uses to push SSE frames.
 *
 * The solver does not know about Nest's `Observable` / `Subscriber` /
 * `MessageEvent`. It only knows about five PRD-locked event names
 * (`status`, `reasoning_delta`, `content_delta`, `done`, `error`) and
 * a `complete()` call. The controller's `@Sse()` handler bridges the
 * sink into the observable world:
 *
 *   `sink.emit('reasoning_delta', { text: 'foo' })`
 *     → `subscriber.next({ type: 'reasoning_delta', data: { text: 'foo' } })`
 *
 * Why bother with this seam?
 * - The solver is unit-testable with a 5-line in-memory sink. No
 *   need to spin up a Nest app just to assert "on text delta, emit
 *   content_delta".
 * - The PRD's `event` names are public API. Centralizing them here
 *   means a typo like `reasioning_delta` can't sneak in across the
 *   solver + controller + tests — there's one typed union.
 * - The controller stays small: the @Sse() handler is mostly
 *   "translate sink events into observable events" and not much else.
 */
import type { Usage } from '../integrations/anthropic/anthropic-client';

export type SseEventName =
  | 'status'
  | 'reasoning_delta'
  | 'content_delta'
  | 'done'
  | 'error';

/**
 * The five PRD-locked event payloads. Adding a new event = adding a
 * case here + bumping the solver. The `status` payload has the union
 * of all Problem statuses the stream can announce — (Q6) lock dropped
 * `already_processing`, so late-arrival clients now see the real
 * status (`solving` / `done` / `failed`) instead of a folded marker.
 *
 * (γ) `done` payload carries the full SDK `usage` JSON (not a
 * derived number) so the SSE channel and DB `Solution.usage`
 * are 1:1 mirror — clients can do cost analysis from
 * accumulated SSE events without a follow-up GET.
 */
export type SseEventPayload =
  | { status: 'pending' | 'solving' | 'done' | 'failed' }
  | { text: string }
  | { problemId: number; solutionId: number; usage: Usage }
  | { message: string };

export interface SseSink {
  /**
   * Push an SSE frame. Multiple calls to the same event are allowed
   * (e.g. dozens of `reasoning_delta` frames during a long think).
   * Calls after `complete()` are silently dropped — by then the
   * observable has terminated and the client has already disconnected.
   */
  emit(event: SseEventName, data: SseEventPayload): void;

  /**
   * Close the stream. Idempotent. The controller's observable runs
   * `subscriber.complete()` synchronously, then drops any further
   * `emit()` calls. The solver calls this from a `finally` so
   * error paths and success paths both end the stream cleanly.
   */
  complete(): void;
}
