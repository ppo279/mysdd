// Implements: .scratch/agent-contract-db/issues/01-test-framework.md (AC item 9)
// Transient smoke test: verifies better-sqlite3 can open a `:memory:` database,
// Drizzle can wrap it, and a trivial SELECT round-trips. Intended as a one-shot
// proof-of-life for the in-memory SQLite seam that future PRD slices will use
// for hermetic backend tests (no leakage into data/sdd.db).

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { sql } from 'drizzle-orm'

describe('in-memory SQLite seam', () => {
  it('opens :memory: and round-trips a SELECT', () => {
    const sqlite = new Database(':memory:')
    try {
      sqlite.exec('CREATE TABLE probe (n INTEGER NOT NULL)')
      sqlite.prepare('INSERT INTO probe (n) VALUES (?)').run(42)

      const db = drizzle(sqlite)
      const rows = db.all<{ n: number }>(sql`SELECT n FROM probe`)

      expect(rows).toEqual([{ n: 42 }])
    } finally {
      sqlite.close()
    }
  })
})
