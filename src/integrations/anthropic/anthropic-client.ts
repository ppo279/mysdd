/**
 * Minimal Anthropic client surface used by `ProblemSolverService`.
 *
 * Why a structural interface, not the raw `@anthropic-ai/sdk` `Anthropic` class?
 * - The solver only needs `messages.stream()` and a handful of event
 *   listeners on the returned stream. Importing the full SDK class
 *   for that surface forces fakes to satisfy dozens of unrelated
 *   members.
 * - The fake in `test/problems/fakes/fake-anthropic-client.ts` only
 *   has to satisfy this interface — the real SDK's `MessageStream`
 *   satisfies it structurally because TypeScript checks by shape.
 * - The PRD explicitly mandates this seam ("the Anthropic client
 *   abstracted behind an `ANTHROPIC_CLIENT` provider token, so that
 *   e2e tests can replace it with a fake without HTTP mocking").
 *
 * Wire shape: a `messages.stream()` call returns an `AnthropicStream`
 * whose listeners (`text`, `thinking`, `error`, `end`) translate the
 * wire events to delta strings. The solver translates those to SSE.
 */
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';

/**
 * Anthropic SDK `finalMessage().usage` shape (verbatim from
 * `@anthropic-ai/sdk/resources/messages`). Stored on the Solution
 * row as a JSONB column (`Solution.usage`) and emitted on the SSE
 * `done` event payload — see CONTEXT §Language '解题思路' (C)+(γ).
 *
 * `cache_creation_input_tokens` and `cache_read_input_tokens` are
 * absent when prompt caching isn't in play; the field types in the
 * SDK are nullable so consumers should treat them as optional.
 */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  // The real SDK types these as `number | null` (present but null
  // when prompt caching isn't in play). Match the SDK exactly so
  // the real Anthropic client satisfies this interface structurally.
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
}

/**
 * The events the solver actually subscribes to. The real SDK's
 * `MessageStream` emits more (`signature`, `citation`, `message`,
 * `contentBlock`, etc.) — we ignore them.
 */
export interface AnthropicStream {
  on(
    event: 'thinking',
    listener: (delta: string, snapshot: string) => void,
  ): unknown;
  on(
    event: 'text',
    listener: (delta: string, snapshot: string) => void,
  ): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'end', listener: () => void): unknown;

  /**
   * Resolves to the final assembled message after the stream
   * completes. The solver reads the full `usage` object from it
   * and stores it verbatim on the Solution row's `usage` JSONB
   * column. Per (C) lock, no folding — input/cache fields are
   * preserved end-to-end.
   */
  finalMessage(): Promise<{ usage: Usage }>;
}

/**
 * The subset of `messages.stream` we use. The real SDK type is broader
 * (it also covers `messages.create` non-streaming and several overload
 * shapes) but we only ever stream — the PRD locked this in §"Solver
 * concurrency limit".
 */
export interface AnthropicMessages {
  /**
   * Open a streaming response. Always passes an `AbortSignal` so the
   * solver's `SOLVER_TIMEOUT_MS` upper bound actually aborts the
   * underlying HTTP request instead of letting it run to completion.
   */
  stream(
    body: MessageCreateParamsBase,
    options?: { signal?: AbortSignal },
  ): AnthropicStream;
}

export interface AnthropicClient {
  messages: AnthropicMessages;
}
