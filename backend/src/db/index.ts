import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { SCHEMA_SQL, IDEMPOTENT_ALTERS } from './schema-sql.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = path.resolve(__dirname, '../../../data/sdd.db')

// Ensure the data directory exists before opening the database
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const sqlite = new Database(dbPath)
sqlite.pragma('journal_mode = WAL')
sqlite.pragma('foreign_keys = ON')

export const db = drizzle(sqlite, { schema })

// 建表（简单 migration）
// Implements: docs/adr/0001-workflow-execution-model.md
// Phase 0: 引入工作流 + 节点状态表 + 边 + 产物表。strict MG1：
// 老 DB 不会自动迁移到新 schema，调用方需要在启动前 `rm data/sdd.db data/sdd.db-*`。

// 转发 SCHEMA_SQL：原 db/index.ts 的导出路径保留（向后兼容）。
// 新代码优先从 './schema-sql.js' 取，避免被 vi.mock('../db/index.js') 误伤。
export { SCHEMA_SQL }

export function initDb() {
  // Order matters: all CREATE TABLEs run first, then ALTER TABLEs that add
  // nullable/FK columns referencing tables that didn't exist on first init.
  sqlite.exec(SCHEMA_SQL)

  // Idempotent column adds for older DBs. Each ALTER is wrapped in try/catch
  // because the column may already exist (caught) or the table is new (succeeds).
  for (const sql of IDEMPOTENT_ALTERS) {
    try { sqlite.exec(sql) } catch { /* already exists */ }
  }
}
