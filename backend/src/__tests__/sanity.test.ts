// Implements: .scratch/agent-contract-db/issues/01-test-framework.md
// Sanity test for backend vitest infrastructure.
// Ensures the runner, ESM resolution, and TypeScript transpilation all wire up
// before any business-logic tests are added on top of this scaffold.

import { describe, it, expect } from 'vitest'

describe('backend vitest scaffold', () => {
  it('arithmetic works', () => {
    expect(1 + 1).toBe(2)
  })
})