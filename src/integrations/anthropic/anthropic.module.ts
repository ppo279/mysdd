import { Module } from '@nestjs/common';
import { AnthropicClientProvider } from './anthropic.provider';
import { ANTHROPIC_CLIENT } from './anthropic.tokens';

/**
 * AnthropicModule — binds the real `AnthropicClientProvider` to the
 * `ANTHROPIC_CLIENT` DI token.
 *
 * NOT `@Global()`. Phase 1 has exactly one consumer (`ProblemsModule`).
 * Phase 2 backlog says: "promote to @Global() when a second consumer
 * appears" (see `docs/prd/problems.md` §"Deferred Items"). Mirrors the
 * decision on `StorageModule`.
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
