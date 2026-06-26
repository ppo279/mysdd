/**
 * SSE test helper — drive a real Nest SSE response from Node and
 * yield parsed `{ event, data }` pairs.
 *
 * Why Node 24's `fetch` instead of `supertest`?
 * - `supertest` wraps the app in a fake HTTP server and pipes the
 *   response through `supertest`'s parser. That parser does NOT
 *   understand SSE's `data:` framing — it tries to JSON-parse the
 *   body and gives up.
 * - Node 24's built-in `fetch` (already a peer dep of Nest 11) gives
 *   us a real `Response` with a real `ReadableStream` body, which
 *   we can split on `\n\n` and parse line-by-line.
 *
 * Usage:
 *   for await (const { event, data } of consumeSse(url, token)) {
 *     if (event === 'done') break;
 *   }
 *
 * The helper uses an `AbortController` so callers can `break` out of
 * the loop and the underlying connection is closed cleanly. Without
 * that, the test would hang on the still-open fetch.
 */
export interface SseFrame {
  /** Event name (e.g. `reasoning_delta`, `done`). `null` for comments
   *  and frames with no `event:` line. */
  event: string | null;
  /** Decoded JSON payload, or raw string if not JSON. */
  data: unknown;
}

const TEXT_DECODER = new TextDecoder();

export async function* consumeSse(
  url: string,
  token: string,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(
      `consumeSse: HTTP ${res.status} ${res.statusText} (no body to stream)`,
    );
  }

  // SSE wire format is UTF-8 text, events separated by a blank line.
  // We accumulate partial chunks until we see `\n\n`, then split into
  // frames. Inside a frame, lines beginning with `event:` and `data:`
  // are the two fields we care about. Comment lines (`:`) and
  // `id:` / `retry:` are ignored (the SDK doesn't emit them).
  const reader = res.body.getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += TEXT_DECODER.decode(value, { stream: true });

      let sepIdx = buffer.indexOf('\n\n');
      while (sepIdx !== -1) {
        const raw = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        sepIdx = buffer.indexOf('\n\n');
      }
    }
  } finally {
    // Always release the connection so the server-side stream can
    // tear down. `cancel()` triggers the AbortSignal we passed to
    // the fetch, which Nest's SSE handler respects.
    try {
      await reader.cancel();
    } catch {
      // best-effort; ignore errors during teardown
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  const lines = raw.split('\n');
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue; // comment / heartbeat
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (event === null && dataLines.length === 0) return null;
  const dataRaw = dataLines.join('\n');
  let data: unknown = dataRaw;
  try {
    data = JSON.parse(dataRaw);
  } catch {
    // Not JSON — keep the raw string. Tests can assert on the type
    // if they care; for our 5 locked events every payload is JSON.
  }
  return { event, data };
}
