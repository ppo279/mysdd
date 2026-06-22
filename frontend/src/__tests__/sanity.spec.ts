// Implements: .scratch/agent-contract-db/issues/01-test-framework.md
// Sanity test for frontend vitest + @vue/test-utils + jsdom infrastructure.
// Confirms the runner, alias resolution (`@`), and TypeScript transpilation
// all wire up before any component tests are added on top of this scaffold.

import { describe, it, expect } from 'vitest'

describe('frontend vitest scaffold', () => {
  it('arithmetic works', () => {
    expect(1 + 1).toBe(2)
  })
})
