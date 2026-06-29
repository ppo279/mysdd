import { ConfigService } from '@nestjs/config';
import { AnthropicClientProvider } from '../../../src/integrations/anthropic/anthropic.provider';

/**
 * Unit tests for AnthropicClientProvider — the class-based provider
 * that binds the real `@anthropic-ai/sdk` Anthropic client to the
 * `ANTHROPIC_CLIENT` DI token.
 *
 * We mock the SDK at the import boundary so the test doesn't try to
 * open a real HTTP agent or hit the network. The assertions are on
 * the CONFIG the provider hands the SDK, not on SDK internals — we
 * want to know "if you set ANTHROPIC_API_KEY, the provider passes it
 * through; if you don't, it throws."
 *
 * The PRD's "Lazy instantiation" decision (constructor is class-based,
 * not a `useFactory`) is what makes the missing-key path a runtime
 * concern, not a module-init concern. These tests pin that down.
 */
jest.mock('@anthropic-ai/sdk', () => {
  // The provider calls `new Anthropic({ apiKey, baseURL })` and reads
  // `.messages` off the result. We return an object whose `messages`
  // encodes the args we received, so the test can assert on them.
  const factory = jest
    .fn()
    .mockImplementation((opts: { apiKey: string; baseURL: string }) => ({
      __sentinel: `Anthropic(${opts.apiKey}@${opts.baseURL})`,
      messages: { __marker: `messages-from-${opts.apiKey}-${opts.baseURL}` },
    }));
  return { __esModule: true, default: factory };
});

const AnthropicMock = jest.requireMock('@anthropic-ai/sdk')
  .default as jest.Mock;

describe('AnthropicClientProvider', () => {
  beforeEach(() => {
    AnthropicMock.mockClear();
  });

  it('throws when ANTHROPIC_API_KEY is not configured', () => {
    // The provider is documented to use `getOrThrow` so a missing
    // key surfaces a clear error at the first injection. We model
    // that by having the mock throw the same way `getOrThrow` does.
    const config = {
      getOrThrow: jest.fn().mockImplementation((key: string) => {
        if (key === 'ANTHROPIC_API_KEY') {
          throw new Error('Missing required config: ANTHROPIC_API_KEY');
        }
        return undefined;
      }),
      get: jest.fn(),
    } as unknown as ConfigService;

    expect(() => new AnthropicClientProvider(config)).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    // And the SDK itself must not have been constructed in that path.
    expect(AnthropicMock).not.toHaveBeenCalled();
  });

  it('passes the configured apiKey + baseURL through to the SDK', () => {
    // The mock fns are extracted to top-level variables so
    // `expect(mockFn)` doesn't trip the unbound-method lint rule
    // (extracting a method from an object literal can lose its
    // `this` binding — top-level `jest.fn()` references don't have
    // that problem).
    const getOrThrow = jest.fn((key: string) => {
      if (key === 'ANTHROPIC_API_KEY') return 'sk-test-123';
      return undefined;
    });
    const get = jest.fn((key: string, fallback?: string) => {
      if (key === 'ANTHROPIC_BASE_URL')
        return 'https://api.minimaxi.com/anthropic';
      return fallback;
    });
    const config = { getOrThrow, get } as unknown as ConfigService;

    const provider = new AnthropicClientProvider(config);

    expect(getOrThrow).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    expect(AnthropicMock).toHaveBeenCalledTimes(1);
    expect(AnthropicMock).toHaveBeenCalledWith({
      apiKey: 'sk-test-123',
      baseURL: 'https://api.minimaxi.com/anthropic',
    });
    // The `messages` field on the provider must be the SDK's
    // `messages` field, not a copy or a re-derivation.
    expect(provider.messages).toEqual({
      __marker: 'messages-from-sk-test-123-https://api.minimaxi.com/anthropic',
    });
  });

  it('defaults ANTHROPIC_BASE_URL to the MiniMax-hosted endpoint when not configured', () => {
    // The default is a project-level commitment: we never default to
    // Anthropic's own host because this project is bound to
    // MiniMax-M3. The default lives in the provider, not in env.
    const config = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'ANTHROPIC_API_KEY') return 'sk-test-456';
        return undefined;
      }),
      get: jest.fn((key: string, fallback?: string) => fallback),
    } as unknown as ConfigService;

    new AnthropicClientProvider(config);

    expect(AnthropicMock).toHaveBeenCalledWith({
      apiKey: 'sk-test-456',
      baseURL: 'https://api.minimaxi.com/anthropic',
    });
  });
});
