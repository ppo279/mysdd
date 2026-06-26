/**
 * DI token for the `AnthropicClient` interface.
 *
 * Consumers:
 *   import { ANTHROPIC_CLIENT } from '../integrations/anthropic/anthropic.tokens';
 *   constructor(@Inject(ANTHROPIC_CLIENT) private readonly ai: AnthropicClient) {}
 *
 * The `Symbol` avoids provider-key collisions with any other class that
 * might end up being called `AnthropicClient`.
 */
export const ANTHROPIC_CLIENT = Symbol('ANTHROPIC_CLIENT');
