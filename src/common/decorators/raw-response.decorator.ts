import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key for the `@RawResponse()` opt-out flag.
 * `Reflector.getAllAndOverride()` looks this up to decide whether to skip
 * the wrap-response interceptor.
 */
export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Opt this route (or controller) OUT of the success-envelope wrap.
 *
 * Use for endpoints that don't return JSON API payloads:
 *   - File downloads (images, PDFs)
 *   - Server-Sent Events
 *   - Health checks (K8s liveness probes expect a specific shape)
 *
 * Can be applied at:
 *   - Method level: opts out that single handler
 *   - Class level: opts out every handler in the controller
 *   - Both: method overrides class
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);