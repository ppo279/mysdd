import type {
  AnthropicClient,
  AnthropicMessages,
  AnthropicStream,
  Usage,
} from '../../../src/integrations/anthropic/anthropic-client';
import type { MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/messages';

/**
 * One scripted event the fake will emit. Tests compose arrays of
 * these to drive the solver through specific sequences.
 */
export type FakeEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'end' }
  | { kind: 'error'; message: string };

/**
 * Test seam: a fake `AnthropicClient` that emits a hand-scripted list
 * of events when `messages.stream()` is called.
 *
 * Usage:
 *   const fake = new FakeAnthropicClient([
 *     { kind: 'thinking', text: 'let me see...' },
 *     { kind: 'text',     text: '42' },
 *     { kind: 'end' },
 *   ]);
 *   // then `Test.createTestingModule(...).overrideProvider(ANTHROPIC_CLIENT).useValue(fake)`
 *
 * Why not just mock `messages.stream` at the method level? Because
 * the solver is decoupled from the SDK's `MessageStream` class —
 * we depend on the `AnthropicClient` interface, not on Anthropic
 * internals. A fake at the interface level covers future solver
 * call sites without re-mocking.
 *
 * Concurrency tracking: tests assert that the SDK is called exactly
 * once per solve (case #11c "double-open stream → fake called once
 * total"). `streamCallCount` is the inspection handle.
 */
export class FakeAnthropicClient implements AnthropicClient {
  readonly messages: AnthropicMessages;
  private events: FakeEvent[];
  /** Number of times `messages.stream()` was called. */
  streamCallCount = 0;
  /** The body of the most recent `messages.stream()` call. */
  lastBody: MessageCreateParamsBase | null = null;

  constructor(events: FakeEvent[] = defaultSuccessEvents()) {
    this.events = events;
    this.messages = {
      stream: (body, _options) => {
        this.streamCallCount += 1;
        this.lastBody = body;
        return new FakeAnthropicStream(this.events);
      },
    };
  }

  /**
   * Swap the scripted events mid-test. Used by tests that need
   * different behavior (error path, multiple deltas, etc.) without
   * re-bootstrapping the Nest app.
   *
   * NOTE: in-flight streams keep their original script — only NEW
   * `messages.stream()` calls see the new events. That's exactly
   * what the issue 002 acceptance criteria for the double-open
   * test wants.
   */
  setEvents(events: FakeEvent[]): void {
    this.events = events;
  }
}

/**
 * The success-path default: one thinking delta, one text delta, end.
 * This is the "happy path" used by the case #11 test and the default
 * fake injected for slice 1's tests (so they pass without an SDK).
 */
export function defaultSuccessEvents(): FakeEvent[] {
  return [
    { kind: 'thinking', text: 'Let me analyze the problem step by step.' },
    { kind: 'text', text: 'The answer is 42.' },
    { kind: 'end' },
  ];
}

/**
 * Default `usage` object returned from `finalMessage()`. Mirrors the
 * Anthropic SDK's shape so the fake's `usage` field is structurally
 * identical to what the real SDK would emit — important for (C)
 * lock tests that assert on `Solution.usage` shape end-to-end.
 *
 * `cache_creation_input_tokens` / `cache_read_input_tokens` are
 * absent by default (prompt caching isn't in play in the default
 * fake flow); tests that exercise caching pass them explicitly.
 */
export function defaultUsage(outputTokens = 42): Usage {
  return {
    input_tokens: 100,
    output_tokens: outputTokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  };
}

/**
 * Stream-shaped object that emits the scripted events asynchronously.
 *
 * Listeners register via `.on('thinking' | 'text' | 'error' | 'end', fn)`
 * exactly like the real `MessageStream`. `finalMessage()` resolves
 * with a tiny `usage.output_tokens` value once the script reaches
 * `{kind: 'end'}` (or rejects if it sees an error event first).
 */
class FakeAnthropicStream implements AnthropicStream {
  private readonly listeners = {
    thinking: new Set<(delta: string, snapshot: string) => void>(),
    text: new Set<(delta: string, snapshot: string) => void>(),
    error: new Set<(err: unknown) => void>(),
    end: new Set<() => void>(),
  };

  private thinkingSnapshot = '';
  private textSnapshot = '';
  private finalResolve?: (value: { usage: Usage }) => void;
  private finalReject?: (err: unknown) => void;
  private finalPromise: Promise<{ usage: Usage }>;
  private started = false;

  constructor(private readonly events: FakeEvent[]) {
    this.finalPromise = new Promise((resolve, reject) => {
      this.finalResolve = resolve;
      this.finalReject = reject;
    });
  }

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
  // Implementation signature is widened with `any` so the overloads
  // above are assignable to it. The fake dispatches per event name
  // with the right arg shape — see the switch below. The solver only
  // ever registers listeners whose types match the corresponding
  // overload, so this widening is safe at the call sites we use.
  on(event: string, listener: (...args: any[]) => any): unknown {
    switch (event) {
      case 'thinking':
        this.listeners.thinking.add(listener as (d: string, s: string) => void);
        break;
      case 'text':
        this.listeners.text.add(listener as (d: string, s: string) => void);
        break;
      case 'error':
        this.listeners.error.add(listener as (e: unknown) => void);
        break;
      case 'end':
        this.listeners.end.add(listener as () => void);
        break;
    }
    this.maybeStart();
    return this;
  }

  finalMessage(): Promise<{ usage: Usage }> {
    this.maybeStart();
    return this.finalPromise;
  }

  /**
   * Kick off the scripted replay on the next microtask. Listeners
   * register synchronously, so we wait one tick before replaying —
   * that way the solver's `.on('thinking', ...)` etc. are all in
   * place before any events fire.
   */
  private maybeStart(): void {
    if (this.started) return;
    this.started = true;
    queueMicrotask(() => void this.replay());
  }

  private replay(): void {
    for (const event of this.events) {
      switch (event.kind) {
        case 'thinking': {
          this.thinkingSnapshot += event.text;
          for (const fn of this.listeners.thinking)
            fn(event.text, this.thinkingSnapshot);
          break;
        }
        case 'text': {
          this.textSnapshot += event.text;
          for (const fn of this.listeners.text)
            fn(event.text, this.textSnapshot);
          break;
        }
        case 'end': {
          for (const fn of this.listeners.end) fn();
          this.finalResolve?.({ usage: defaultUsage() });
          return;
        }
        case 'error': {
          const err = new Error(event.message);
          for (const fn of this.listeners.error) fn(err);
          this.finalReject?.(err);
          return;
        }
      }
    }
    // Script ended without an explicit 'end' or 'error' — close out
    // gracefully so callers awaiting finalMessage() don't hang.
    for (const fn of this.listeners.end) fn();
    this.finalResolve?.({ usage: defaultUsage(0) });
  }
}
