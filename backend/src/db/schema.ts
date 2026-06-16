import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  repoUrl: text('repo_url').notNull().default(''),
  techStack: text('tech_stack').notNull().default('ts'),
  background: text('background').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const features = sqliteTable('features', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  currentStage: text('current_stage').notNull().default('spec'),
  status: text('status').notNull().default('active'), // active | done
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 每个阶段的一次运行
export const stageRuns = sqliteTable('stage_runs', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => features.id),
  stage: text('stage').notNull(), // spec | plan | tasks | coding
  runtimeId: text('runtime_id').notNull().default('claude'),
  cliSessionId: text('cli_session_id'), // claude --resume 用的 session id
  status: text('status').notNull().default('active'), // active | approved | rejected
  artifactContent: text('artifact_content').notNull().default(''),
  artifactPath: text('artifact_path').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
})

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  stageRunId: text('stage_run_id').notNull().references(() => stageRuns.id),
  role: text('role').notNull(), // user | assistant
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})
