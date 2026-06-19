// Implements: docs/prd/0001-bug-fix-workflow.md (Issue 02)
// Unit tests for the per-feature git worktree service.
//
// Seam: real git operations against a temp git repo created per test.
// No DB / no HTTP — pure service-level test.
//
// HOME is overridden BEFORE the worktree module loads because
// routes/workspaces.ts captures `os.homedir()` into WORKSPACE_BASE at module
// load time. We use a dynamic import for the worktree module so HOME is set
// first; static imports would hoist above this assignment.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFileSync } from 'child_process'

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-worktree-home-'))
process.env.HOME = TEST_HOME

// Dynamic import AFTER HOME is set so the routes/workspaces module's
// WORKSPACE_BASE is computed from the new HOME value.
const wt = await import('../services/worktree.js')
const {
  ensureFeatureWorktree,
  getFeatureWorktreePath,
  removeFeatureWorktree,
  worktreeExists,
} = wt

let repoDir = ''
let worktreesDir = ''
let wsDir = ''

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()
}

function setupFixtureRepo(): void {
  // Fresh workspace under TEST_HOME so WORKSPACE_BASE contains wsDir
  wsDir = path.join(TEST_HOME, 'sdd-workspaces', 'ws-test')
  repoDir = path.join(wsDir, 'repo')
  worktreesDir = path.join(wsDir, 'repo.worktrees')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, 'init', '-b', 'main')
  git(repoDir, 'config', 'user.email', 'test@example.com')
  git(repoDir, 'config', 'user.name', 'Test')
  git(repoDir, 'config', 'commit.gpgsign', 'false')

  // Add an initial commit so worktree can branch from HEAD
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'fixture\n')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'initial')

  // Create a node_modules dir in main repo to test symlinking
  fs.mkdirSync(path.join(repoDir, 'node_modules'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'node_modules', 'pkg.json'), '{}')
}

function teardownFixtureRepo(): void {
  try { fs.rmSync(wsDir, { recursive: true, force: true }) } catch { /* best-effort */ }
}

describe('worktree service: per-feature isolation', () => {
  beforeEach(() => {
    teardownFixtureRepo()
    setupFixtureRepo()
  })

  afterEach(() => {
    teardownFixtureRepo()
  })

  it('creates a worktree at <localPath>/repo.worktrees/feat-<featId> on a new branch bugfix/<featId>', async () => {
    const featureId = 'feat-001'
    const result = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(result.created).toBe(true)
    expect(result.path).toBe(path.join(worktreesDir, 'feat-' + featureId))

    // Worktree directory exists and is a working tree
    expect(fs.existsSync(result.path)).toBe(true)
    expect(fs.existsSync(path.join(result.path, 'README.md'))).toBe(true)

    // Branch bugfix/<featId> exists in the main repo
    const branches = git(repoDir, 'branch', '--list', 'bugfix/' + featureId)
    expect(branches).toContain('bugfix/' + featureId)

    // Worktree is registered in git's worktree list
    const wtList = git(repoDir, 'worktree', 'list')
    expect(wtList).toContain('feat-' + featureId)
  })

  it('reuses an existing worktree (idempotent) — created=false on second call', async () => {
    const featureId = 'feat-reuse'
    const first = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(first.created).toBe(true)

    // Write a marker file into the worktree; second call must not wipe it
    const marker = path.join(first.path, 'marker.txt')
    fs.writeFileSync(marker, 'kept')

    const second = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(second.created).toBe(false)
    expect(second.path).toBe(first.path)
    expect(fs.readFileSync(marker, 'utf-8')).toBe('kept')
  })

  it('symlinks node_modules from main repo into the worktree when it exists', async () => {
    const featureId = 'feat-sym'
    const result = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    const linkPath = path.join(result.path, 'node_modules')
    expect(fs.existsSync(linkPath)).toBe(true)
    // Real symlink
    const lst = fs.lstatSync(linkPath)
    expect(lst.isSymbolicLink()).toBe(true)
    // Resolves to the same target file
    expect(fs.readFileSync(path.join(linkPath, 'pkg.json'), 'utf-8')).toBe('{}')
  })

  it('skips node_modules symlink gracefully when main repo has none', async () => {
    // Remove node_modules to test the skip path
    fs.rmSync(path.join(repoDir, 'node_modules'), { recursive: true, force: true })

    const featureId = 'feat-no-nm'
    const result = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(fs.existsSync(path.join(result.path, 'node_modules'))).toBe(false)
  })

  it('branches from the configured default branch (not HEAD when on a detached HEAD)', async () => {
    // Create a side branch with a different commit, then check the new worktree
    // starts from the default branch tip.
    const featureId = 'feat-from-default'
    git(repoDir, 'checkout', '-b', 'side-branch')
    fs.writeFileSync(path.join(repoDir, 'side.txt'), 'side\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'side commit')
    git(repoDir, 'checkout', 'main')

    const result = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })

    // Worktree must not contain the side-branch file
    expect(fs.existsSync(path.join(result.path, 'side.txt'))).toBe(false)
  })

  it('worktreeExists returns true after creation, false after removal', async () => {
    const featureId = 'feat-exists'
    expect(worktreeExists(wsDir, featureId)).toBe(false)
    await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(worktreeExists(wsDir, featureId)).toBe(true)
    await removeFeatureWorktree(wsDir, featureId)
    expect(worktreeExists(wsDir, featureId)).toBe(false)
  })

  it('removeFeatureWorktree prunes git worktree list and removes the directory', async () => {
    const featureId = 'feat-cleanup'
    const result = await ensureFeatureWorktree({
      featureId,
      localPath: wsDir,
      defaultBranch: 'main',
    })
    expect(fs.existsSync(result.path)).toBe(true)

    await removeFeatureWorktree(wsDir, featureId)
    expect(fs.existsSync(result.path)).toBe(false)

    // Pruned from worktree list
    const wtList = git(repoDir, 'worktree', 'list')
    expect(wtList).not.toContain('feat-' + featureId)

    // Branch remains (we don't delete it — re-running the feature should reuse the work)
    const branches = git(repoDir, 'branch', '--list', 'bugfix/' + featureId)
    expect(branches).toContain('bugfix/' + featureId)
  })

  it('getFeatureWorktreePath returns the canonical path without touching disk', async () => {
    const featureId = 'feat-getpath'
    const expected = path.join(worktreesDir, 'feat-' + featureId)
    expect(getFeatureWorktreePath(wsDir, featureId)).toBe(expected)
  })
})
