// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02) +
//   docs/adr/0002-bug-fix-workflow.md §4.2 / §4.3
//
// Per-feature git worktree lifecycle:
// - Path:   <localPath>/repo.worktrees/feat-<featId>
// - Branch: bugfix/<featId> branched from <defaultBranch> (default: "main")
// - On first call: creates the worktree + symlinks node_modules (best-effort).
// - On subsequent calls: idempotent — returns the existing worktree path with
//   created=false so retries of the same feature share the same worktree.
// - assertWithinWorkspaceBase guards the path so this service is safe to call
//   from the workflow engine without an extra check at the call site.
//
// Why a worktree? The TDD pipeline (test-architect + code-surgeon) writes
// files into the worktree; we want agent writes to be isolated from the
// user's main worktree until they explicitly merge.
import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { assertWithinWorkspaceBase } from '../routes/workspaces.js'

export interface EnsureWorktreeOpts {
  featureId: string
  localPath: string
  defaultBranch?: string
}

export interface EnsureWorktreeResult {
  path: string
  created: boolean
  branch: string
}

const DEFAULT_BRANCH = 'main'
const WORKTREES_DIRNAME = 'repo.worktrees'

function worktreesDir(localPath: string): string {
  return path.join(localPath, WORKTREES_DIRNAME)
}

export function getFeatureWorktreePath(localPath: string, featureId: string): string {
  return path.join(worktreesDir(localPath), `feat-${featureId}`)
}

export function worktreeExists(localPath: string, featureId: string): boolean {
  const p = getFeatureWorktreePath(localPath, featureId)
  return fs.existsSync(p) && fs.existsSync(path.join(p, '.git'))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function branchExists(repoDir: string, branch: string): boolean {
  try {
    const out = git(repoDir, 'rev-parse', '--verify', '--quiet', branch)
    return out.length > 0
  } catch {
    return false
  }
}

function trySymlinkNodeModules(repoDir: string, worktreePath: string): void {
  const src = path.join(repoDir, 'node_modules')
  if (!fs.existsSync(src)) return
  const dst = path.join(worktreePath, 'node_modules')
  if (fs.existsSync(dst)) return
  try {
    fs.symlinkSync(src, dst, 'dir')
  } catch {
    // best-effort: if symlink fails (e.g. permission), skip silently
  }
}

/**
 * Create or reuse the per-feature worktree.
 *
 * Idempotent: when the worktree already exists and is registered with git,
 * returns created=false. Otherwise creates the worktree on a new branch
 * bugfix/<featId> from the workspace's default branch tip.
 */
export async function ensureFeatureWorktree(opts: EnsureWorktreeOpts): Promise<EnsureWorktreeResult> {
  const { featureId, localPath } = opts
  const defaultBranch = opts.defaultBranch ?? DEFAULT_BRANCH
  const repoDir = path.join(localPath, 'repo')
  const wtPath = getFeatureWorktreePath(localPath, featureId)
  const branch = `bugfix/${featureId}`

  // Guard: localPath must live under WORKSPACE_BASE. wtPath is nested under
  // localPath so if localPath passes, wtPath passes too — single check is enough.
  assertWithinWorkspaceBase(localPath)

  if (worktreeExists(localPath, featureId)) {
    return { path: wtPath, created: false, branch }
  }

  // If the worktree directory was left behind (e.g. previous crash), clean it up
  // so `git worktree add` doesn't fail with "directory already exists".
  if (fs.existsSync(wtPath)) {
    fs.rmSync(wtPath, { recursive: true, force: true })
  }

  // Resolve base commit: <defaultBranch> if it exists in the repo, else HEAD.
  const base = branchExists(repoDir, defaultBranch) ? defaultBranch : 'HEAD'

  fs.mkdirSync(path.dirname(wtPath), { recursive: true })
  git(repoDir, 'worktree', 'add', '-b', branch, wtPath, base)

  trySymlinkNodeModules(repoDir, wtPath)

  return { path: wtPath, created: true, branch }
}

/**
 * Remove a feature's worktree. Idempotent: no-op when the worktree does not exist.
 *
 * Steps:
 *  1. `git worktree remove --force` (removes the working tree + worktree registration)
 *  2. `git worktree prune` (cleans stale entries)
 *  3. rm the directory if it survived step 1 (e.g. the dir was untracked)
 *
 * Note: we intentionally do NOT delete the bugfix/<featId> branch — keeping it
 * allows re-running the feature to resume from the same starting point.
 */
export async function removeFeatureWorktree(localPath: string, featureId: string): Promise<void> {
  const repoDir = path.join(localPath, 'repo')
  const wtPath = getFeatureWorktreePath(localPath, featureId)

  assertWithinWorkspaceBase(localPath)
  assertWithinWorkspaceBase(wtPath)

  if (!fs.existsSync(wtPath)) return

  try {
    git(repoDir, 'worktree', 'remove', '--force', wtPath)
  } catch {
    // Fall through to direct directory removal below
  }

  if (fs.existsSync(wtPath)) {
    try { fs.rmSync(wtPath, { recursive: true, force: true }) } catch { /* best-effort */ }
  }

  try {
    git(repoDir, 'worktree', 'prune')
  } catch {
    // best-effort
  }
}
