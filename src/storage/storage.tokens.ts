/**
 * DI token for the `StorageService` interface.
 *
 * Using a Symbol avoids accidental provider collisions if a future
 * module also defines a class called `StorageService`. Consumers
 * `import { STORAGE_SERVICE } from '../storage/storage.tokens'` and
 * inject via `@Inject(STORAGE_SERVICE)`.
 */
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
