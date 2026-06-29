import { Global, Module } from '@nestjs/common';
import { AnthropicClientProvider } from './anthropic.provider';
import { ANTHROPIC_CLIENT } from './anthropic.tokens';

/**
 * AnthropicModule — binds the real `AnthropicClientProvider` to the
 * `ANTHROPIC_CLIENT` DI token.
 *
 * `@Global()` since 2026-06-29 (overrides backlog item #4 in
 * `docs/issues/003-problems-phase-2-backlog.md`, which originally
 * gated this on "a second consumer appears"). Lifted early on user
 * request, mirroring the lift on `StorageModule`.
 *
 * `ConfigModule` is already `@Global()` (set in `app.module.ts`), so we
 * don't need to re-import it here.
 *
 * Lazy instantiation: `AnthropicClientProvider` is a class, not a
 * `useFactory`, so `getOrThrow('ANTHROPIC_API_KEY')` only fires when
 * something actually injects `ANTHROPIC_CLIENT`. Test suites that
 * never reach the solver (e.g. the auth-only e2e suite) don't trip
 * the env requirement.
 */
@Global()
@Module({
  providers: [
    AnthropicClientProvider,
    {
      provide: ANTHROPIC_CLIENT,
      useExisting: AnthropicClientProvider,
    },
  ],
  exports: [ANTHROPIC_CLIENT],
})
export class AnthropicModule {}
