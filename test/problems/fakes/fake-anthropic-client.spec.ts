import {
  FakeAnthropicClient,
  defaultSuccessEvents,
} from './fake-anthropic-client';

/**
 * Unit tests for the test infrastructure itself — `FakeAnthropicClient`
 * is consumed by every `pnpm test:e2e` run that reaches the solver, so
 * its behavior is part of the deal we make with the e2e suite. If the
 * fake's contract drifts, dozens of e2e cases silently change.
 *
 * Pinned behaviors:
 *  1. Events fire in the order scripted (no reordering).
 *  2. `finalMessage()` resolves on `{ kind: 'end' }` with the
 *     configured `output_tokens` count.
 *  3. `finalMessage()` rejects on `{ kind: 'error' }` — solver failure
 *     path depends on this rejection (the catch around `finalMessage`
 *     transitions the row to `failed`).
 *  4. `setEvents()` only affects FUTURE `messages.stream()` calls —
 *     in-flight streams keep their original script. The issue 002
 *     double-open acceptance criteria rely on this.
 *  5. `streamCallCount` increments once per `messages.stream()` call
 *     (used by case #11c to assert "fake called once total").
 */
describe('FakeAnthropicClient', () => {
  describe('event replay order', () => {
    it('emits thinking → text → end in the order scripted', async () => {
      const fake = new FakeAnthropicClient([
        { kind: 'thinking', text: 'first' },
        { kind: 'thinking', text: 'second' },
        { kind: 'text', text: 'one' },
        { kind: 'text', text: 'two' },
        { kind: 'end' },
      ]);

      const received: Array<{ kind: string; text?: string }> = [];
      const stream = fake.messages.stream({} as never);
      stream.on('thinking', (delta) =>
        received.push({ kind: 'thinking', text: delta }),
      );
      stream.on('text', (delta) =>
        received.push({ kind: 'text', text: delta }),
      );
      stream.on('end', () => received.push({ kind: 'end' }));

      await stream.finalMessage();

      expect(received).toEqual([
        { kind: 'thinking', text: 'first' },
        { kind: 'thinking', text: 'second' },
        { kind: 'text', text: 'one' },
        { kind: 'text', text: 'two' },
        { kind: 'end' },
      ]);
    });
  });

  describe('finalMessage', () => {
    it('resolves with usage.output_tokens when the script ends with {kind:"end"}', async () => {
      const fake = new FakeAnthropicClient([{ kind: 'end' }]);
      const stream = fake.messages.stream({} as never);
      stream.on('end', () => {});
      const final = await stream.finalMessage();
      expect(final.usage.output_tokens).toBe(42);
    });

    it('rejects with the scripted error when the script hits {kind:"error"}', async () => {
      const fake = new FakeAnthropicClient([
        { kind: 'error', message: 'upstream blew up' },
      ]);
      const stream = fake.messages.stream({} as never);
      stream.on('error', () => {});
      // The fake rejects with an Error carrying the scripted message.
      // The solver catches this in the same try/catch as a network
      // failure, so the contract is "an Error reaches the catch".
      await expect(stream.finalMessage()).rejects.toThrow(/upstream blew up/);
    });
  });

  describe('setEvents isolation', () => {
    it('does not change the script of a stream that was already opened', async () => {
      // Pin the "in-flight streams keep their original script" behavior
      // (referenced in the FakeAnthropicClient setEvents docstring
      // and relied on by e2e case #11c).
      const fake = new FakeAnthropicClient([
        { kind: 'thinking', text: 'A' },
        { kind: 'end' },
      ]);

      // Open stream #1, register listeners, but DO NOT await its
      // finalMessage yet — we want its replay to happen AFTER we
      // swap the script.
      const stream1 = fake.messages.stream({} as never);
      const seenByStream1: string[] = [];
      stream1.on('thinking', (delta) => seenByStream1.push(delta));
      stream1.on('end', () => {});

      // Swap the script. The fake's setEvents docstring claims this
      // only affects FUTURE stream() calls.
      fake.setEvents([{ kind: 'thinking', text: 'B' }, { kind: 'end' }]);

      // Open stream #2 — it sees the new script.
      const stream2 = fake.messages.stream({} as never);
      const seenByStream2: string[] = [];
      stream2.on('thinking', (delta) => seenByStream2.push(delta));
      stream2.on('end', () => {});

      // Drain both. Each stream captured its own array reference in
      // its constructor; the swap replaced the FakeAnthropicClient's
      // `events` field but the streams' copies are unchanged.
      await stream1.finalMessage();
      await stream2.finalMessage();

      expect(seenByStream1).toEqual(['A']);
      expect(seenByStream2).toEqual(['B']);
    });
  });

  describe('streamCallCount', () => {
    it('increments once per messages.stream() call', async () => {
      const fake = new FakeAnthropicClient(defaultSuccessEvents());
      expect(fake.streamCallCount).toBe(0);

      const s1 = fake.messages.stream({} as never);
      s1.on('end', () => {});
      expect(fake.streamCallCount).toBe(1);

      const s2 = fake.messages.stream({} as never);
      s2.on('end', () => {});
      expect(fake.streamCallCount).toBe(2);

      // Drain to keep the test tidy.
      await s1.finalMessage();
      await s2.finalMessage();
    });
  });
});
