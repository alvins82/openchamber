// Reproduction for https://github.com/openchamber/openchamber/issues/3122
//
// Server side of the report: `getWorktrees(directory)` is invoked once per
// retained sidebar project per discovery pass. For non-Git directories there
// is no negative cache, so every call re-spawns a git child process and logs
// the exact warning quoted in the issue:
//
//   Failed to list worktrees, returning empty list: fatal: not a git repository
//   (or any of the parent directories): .git
//
// For Git repositories the same operation runs `git worktree list --porcelain`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getWorktrees } from './service.js';

const tempDirs = [];

const createTempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-issue-3122-'));
  tempDirs.push(dir);
  return dir;
};

const runGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const realGitBinary = (() => {
  try {
    return execFileSync('which', ['git'], { encoding: 'utf8' }).trim() || 'git';
  } catch {
    return 'git';
  }
})();

// A PATH wrapper that records every git child process the server spawns.
// resolveGitBinary() returns the bare string 'git' on non-Windows, so
// simple-git resolves it through PATH at spawn time.
const installGitSpawnCounter = () => {
  const callsLog = path.join(createTempDir(), 'git-calls.log');
  const binDir = path.join(createTempDir(), 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, 'git'),
    `#!/bin/bash\necho "$PWD args=[$*]" >> "${callsLog}"\nexec "${realGitBinary}" "$@"\n`,
  );
  fs.chmodSync(path.join(binDir, 'git'), 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}:${previousPath}`;
  return {
    readCalls: () => {
      if (!fs.existsSync(callsLog)) return [];
      return fs
        .readFileSync(callsLog, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(/^.*? args=\[/, '').replace(/\]$/, ''));
    },
    restore: () => {
      process.env.PATH = previousPath;
    },
  };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('issue #3122 worktree discovery cost', () => {
  it('spawns `git worktree list --porcelain` for a git repository', async () => {
    const repo = createTempDir();
    runGit(repo, ['init', '-q', '-b', 'main']);
    runGit(repo, ['config', 'user.email', 'test@example.com']);
    runGit(repo, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Test\n');
    runGit(repo, ['add', 'README.md']);
    runGit(repo, ['commit', '-q', '-m', 'init']);

    const counter = installGitSpawnCounter();
    try {
      const result = await getWorktrees(repo);

      expect(result.length).toBe(1);
      expect(result[0].path).toBe(repo);
      expect(result[0].branch).toBe('main');
      expect(counter.readCalls()).toContain('worktree list --porcelain');
    } finally {
      counter.restore();
    }
  });

  it('re-spawns git and warns on every call for a non-git directory (no negative cache)', async () => {
    const nonGitDir = createTempDir();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const counter = installGitSpawnCounter();
    try {
      const first = await getWorktrees(nonGitDir);
      const second = await getWorktrees(nonGitDir);

      // The operation itself reports an empty list...
      expect(first).toEqual([]);
      expect(second).toEqual([]);

      // ...but the exact warning from the issue is emitted per call, not once.
      const warns = warnSpy.mock.calls.map((args) => args.map(String).join(' '));
      expect(warns).toHaveLength(2);
      for (const warning of warns) {
        expect(warning).toContain('Failed to list worktrees, returning empty list:');
        expect(warning).toContain('fatal: not a git repository');
      }

      // And git is spawned afresh on each call: three calls (two above plus the
      // rev-parse discovery) would each log; assert at least one spawn per call.
      const spawns = counter.readCalls();
      expect(spawns.length).toBeGreaterThanOrEqual(2);
      expect(spawns).toContain('rev-parse --show-toplevel');
    } finally {
      counter.restore();
    }
  });
});