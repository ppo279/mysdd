import Anthropic from '@anthropic-ai/sdk';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AnthropicClient } from './anthropic-client';

/**
 * Class-based provider for the real Anthropic-compatible client.
 *
 * Why a class, not a `useFactory` provider?
 * - `useFactory` runs eagerly when the module is constructed, so
 *   `config.getOrThrow('ANTHROPIC_API_KEY')` fires even if no caller
 *   injects `ANTHROPIC_CLIENT` (e.g. the auth-only e2e suite).
 * - A class is only constructed when Nest first needs an instance to
 *   inject. Auth tests that never reach the solver never see a
 *   missing-key error.
 *
 * Configuration source-of-truth:
 *   - `ANTHROPIC_API_KEY`  — required for any environment that
 *     actually solves. `getOrThrow` runs at the first injection.
 *   - `ANTHROPIC_BASE_URL` — defaults to the MiniMax-hosted
 *     Anthropic-compatible endpoint. Override only if MiniMax rotates
 *     the host. We never default to Anthropic's own `api.anthropic.com`
 *     because this project is bound to MiniMax-M3.
 *
 * The instance is a singleton because the underlying `Anthropic` class
 * is documented as cheap to construct once and reuse (it holds an
 * `http.Agent` internally for connection pooling).
 */
@Injectable()
export class AnthropicClientProvider implements AnthropicClient {
  readonly messages: AnthropicClient['messages'];

  constructor(config: ConfigService) {
    const apiKey = config.getOrThrow<string>('ANTHROPIC_API_KEY');
    const baseURL = config.get<string>(
      'ANTHROPIC_BASE_URL',
      'https://api.minimaxi.com/anthropic',
    );
    const client = new Anthropic({ apiKey, baseURL });
    this.messages = client.messages;
  }
}
