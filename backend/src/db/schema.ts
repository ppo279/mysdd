import { sqliteTable, text, integer, real, type SQLiteColumn } from 'drizzle-orm/sqlite-core'

// Implements: docs/adr/0001-workflow-execution-model.md
// workspaces ↔ workflows 形成循环引用（workspaces.default_workflow_id → workflows.id
// 且 workflows.workspace_id → workspaces.id）。Drizzle 0.36 在循环推断上会失败，
// 用 SQLiteColumn 显式标注解决。
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  repoUrl: text('repo_url').notNull().default(''),
  techStack: text('tech_stack').notNull().default('ts'),
  background: text('background').notNull().default(''),
  localPath: text('local_path').notNull().default(''),
  defaultWorkflowId: text('default_workflow_id').references((): SQLiteColumn => workflows.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const features = sqliteTable('features', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  currentStage: text('current_stage').notNull().default('spec'),
  currentWorkflowId: text('current_workflow_id').references((): SQLiteColumn => workflows.id, { onDelete: 'set null' }),
  currentNodeId: text('current_node_id').notNull().default('spec'),
  status: text('status').notNull().default('active'), // active | done | paused
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

// 每个阶段的一次运行
// stage 字段保留：当前约定为 agent id（来自 workflow_nodes.agentId），
// Phase 0 起新增 nodeId 字段：workflow-scoped 节点 id，调度与产物路径都基于它。
export const stageRuns = sqliteTable('stage_runs', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => features.id),
  stage: text('stage').notNull(), // spec | plan | tasks | coding
  nodeId: text('node_id'),
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

// Implements: docs/adr/0001-workflow-execution-model.md
// Phase 0 新增：工作流 / 节点 / 边 / 节点状态 / 产物 / 迁移审计
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isArchived: integer('is_archived').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const workflowNodes = sqliteTable('workflow_nodes', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  agentId: text('agent_id').notNull(),
  positionX: real('position_x').notNull().default(0),
  positionY: real('position_y').notNull().default(0),
  configJson: text('config_json').notNull().default('{}'),
  displayName: text('display_name').notNull().default(''),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const workflowEdges = sqliteTable('workflow_edges', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id, { onDelete: 'cascade' }),
  fromNodeId: text('from_node_id').notNull(),
  fromOutput: text('from_output').notNull().default('default'),
  toNodeId: text('to_node_id').notNull(),
  toInput: text('to_input').notNull().default('default'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const featureNodeStates = sqliteTable('feature_node_states', {
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  nodeId: text('node_id').notNull(),
  status: text('status').notNull().default('pending'), // pending | active | approved | rejected
  lastStageRunId: text('last_stage_run_id'),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

export const stageRunOutputs = sqliteTable('stage_run_outputs', {
  id: text('id').primaryKey(),
  stageRunId: text('stage_run_id').notNull().references(() => stageRuns.id, { onDelete: 'cascade' }),
  outputName: text('output_name').notNull().default('default'),
  content: text('content').notNull().default(''),
  approvedAt: integer('approved_at', { mode: 'timestamp' }),
})

export const featureNodeMigrations = sqliteTable('feature_node_migrations', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => features.id, { onDelete: 'cascade' }),
  fromWorkflowId: text('from_workflow_id').notNull(),
  toWorkflowId: text('to_workflow_id').notNull(),
  mappingJson: text('mapping_json').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  appliedAt: integer('applied_at', { mode: 'timestamp' }),
})
