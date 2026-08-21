import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Regression for https://github.com/openchamber/openchamber/issues/3042
// "[Bug] Git doesn't work on Desktop Windows"
//
// Reported symptoms on desktop: with a workspace open, the Git and Changes
// views stay blank and the Walkthrough view shows the error banner
// `Cannot use simple-git on a directory that does not exist`.
//
// That message is simple-git's own error, thrown by `createGit(baseDir)` when
// the passed directory does not exist on disk. The desktop UI derives its
// effective directory from persisted state (localStorage `lastDirectory` /
// `homeDirectory`), session directories, and worktree metadata; when that path
// is stale or wrong, every git-backed surface runs against a directory that
// simple-git rejects. `/api/git/status` and `/api/git/check` are guarded and
// degrade to a soft "not a git repository" payload (blank views), but the
// walkthrough calls `getRepositoryRoot` → `createGit` with no existence guard,
// so the raw simple-git error leaks into the error banner.
// ---------------------------------------------------------------------------

const TEMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-3042-'));
process.env.HOME = TEMP_HOME;
process.env.OPENCHAMBER_DATA_DIR = path.join(TEMP_HOME, '.config', 'openchamber');

const SOURCE = { kind: 'working-tree', scope: 'all' };
const REPO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-repo-3042-'));
const MISSING_DIR = path.join(os.tmpdir(), 'oc-repo-3042-does-not-exist');

const setupGitRepo = () => {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_DIR, encoding: 'utf8' });
    } catch (error) {
      throw new Error(`git ${args.join(' ')} failed: ${error.stderr?.toString() ?? error.message}`);
    }
  };

  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# Test\n', 'utf8');
  run(['add', 'README.md']);
  run(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# Test\nchanged\n', 'utf8');
};

let walkthrough;
let gitService;

describe('issue 3042 — git surfaces break when the effective directory does not exist', () => {
  beforeAll(async () => {
    setupGitRepo();
    walkthrough = await import('./index.js');
    gitService = await import('../git/service.js');
  });

  afterAll(() => {
    fs.rmSync(TEMP_HOME, { recursive: true, force: true });
    fs.rmSync(REPO_DIR, { recursive: true, force: true });
  });

  it('reproduces the exact walkthrough error-banner message for a missing directory', async () => {
    const error = await walkthrough.getWalkthrough({ directory: MISSING_DIR, source: SOURCE })
      .then(() => null, (e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Cannot use simple-git on a directory that does not exist');
  });

  it('serves HTTP 500 with the same message on the walkthrough GET route', async () => {
    const app = express();
    app.use(express.json());
    const { registerWalkthroughRoutes } = await import('./routes.js');
    registerWalkthroughRoutes(app, { getWalkthroughService: async () => walkthrough });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(
        `${base}/api/walkthrough?directory=${encodeURIComponent(MISSING_DIR)}&source=${encodeURIComponent(JSON.stringify(SOURCE))}`
      );
      const body = await response.json();

      expect(response.status).toBe(500);
      expect(body.error).toBe('Cannot use simple-git on a directory that does not exist');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('git check/status degrade the missing directory to a non-repo, leaving the views empty', async () => {
    // The guarded routes do not crash, but they report "not a git repository"
    // for a directory the user opened as a workspace, so Git/Changes render
    // without repo content.
    expect(await gitService.isGitRepository(MISSING_DIR)).toBe(false);

    const statusError = await gitService.getStatus(MISSING_DIR).then(() => null, (e) => e);
    expect(statusError?.message).toMatch(/not a git repository/i);
  });

  it('control: the same operations succeed against an existing git repo', async () => {
    const status = await gitService.getStatus(REPO_DIR);
    expect(status.current).toBe('main');
    expect(status.files.length).toBeGreaterThan(0);

    const result = await walkthrough.getWalkthrough({ directory: REPO_DIR, source: SOURCE });
    // Reached the diff/model pipeline instead of failing on the directory.
    expect(result.readiness).toBeDefined();
  });
});