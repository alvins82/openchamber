// Reproduction for issue #3084:
// Windows (non-container) web self-update does nothing: multi-line script passed
// to cmd.exe /c runs nothing and exits 0.
//
// This drives the REAL route code (registerOpenChamberRoutes) with the Windows
// branch forced (process.platform = 'win32'), REAL child_process.spawn, and REAL
// fs. On this Linux CI the spawned shell is Wine's cmd.exe (the only way to get
// a cmd.exe here); on a Windows host it would be the real cmd.exe via ComSpec.
//
// Control: the identical route with platform 'linux' spawns `sh -c` with the
// same multi-line shape and executes it fine.
//
// Invariants asserted (robust across Wine-vs-Windows cmd differences):
//   1. the route passes a MULTI-LINE script (with an `if %ERRORLEVEL%` block)
//      as a single argument to cmd.exe /c  -- the buggy shape from the issue;
//   2. the update command never executes (marker file stays absent);
//   3. the route unconditionally shuts the server down via process.exit(0),
//      never inspecting the child's output or exit code.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import request from 'supertest';

// Keep the REAL child_process.spawn behind a mock so the route's dynamic
// `import('child_process')` is intercepted (so we can capture the spawned
// script) while the spawned process is genuinely executed by cmd.exe / sh.
const realSpawnHolder = vi.hoisted(() => ({ spawn: null }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  realSpawnHolder.spawn = actual.spawn;
  return { ...actual, spawn: vi.fn() };
});

vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  getUpdateCommand: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
}));

const childProcess = await import('child_process');
const packageManager = await import('../package-manager.js');
const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const WINE_AVAILABLE = spawnSync('wine', ['--version'], { stdio: 'ignore' }).status === 0;
// Wine refuses to create its prefix under a root-owned directory (e.g. /tmp),
// so create the prefix dir up front so it is owned by the current user.
const WINEPREFIX = path.join(os.tmpdir(), 'openchamber-issue-3084-wineprefix');
if (WINE_AVAILABLE) {
  fs.mkdirSync(WINEPREFIX, { recursive: true });
  spawnSync('wine', ['cmd.exe', '/c', 'echo prefix-ok'], {
    stdio: 'ignore',
    env: { ...process.env, WINEPREFIX, WINEDEBUG: '-all' },
    timeout: 120_000,
  });
}

describe.skipIf(!WINE_AVAILABLE)('issue-3084: Windows (non-container) self-update', () => {
  let tmpDir;
  let markerPath;
  let logPath;
  let exitMock;
  let spawnCalls;
  let spawnSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-issue-3084-'));
    markerPath = path.join(tmpDir, 'update-ran.marker');
    logPath = path.join(tmpDir, 'data', 'update-install.log');
    exitMock = vi.fn();
    spawnCalls = [];
    vi.mocked(childProcess.spawn).mockImplementation((...args) => {
      const child = realSpawnHolder.spawn(...args);
      spawnCalls.push({ args, child });
      return child;
    });

    packageManager.checkForUpdates.mockResolvedValue({
      available: true,
      version: '9.9.9',
      currentVersion: '1.19.0',
    });
    packageManager.detectPackageManagerDetails.mockReturnValue({
      packageManager: 'npm',
      reason: 'cached',
      packageManagerCommand: 'npm',
      packagePath: 'C:\\Users\\repro\\AppData\\Roaming\\npm\\node_modules\\@openchamber\\web',
      globalNodeModulesRoot: 'unknown',
    });
    // A harmless observable stand-in for `npm install -g @openchamber/web@latest`.
    packageManager.getUpdateCommand.mockReturnValue(`echo UPDATE_RAN >> ${markerPath}`);
  });

  afterEach(() => {
    vi.clearAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const buildRouteEnv = ({ platform, port, cmdWrapper }) => {
    const app = express();
    fs.mkdirSync(path.join(tmpDir, 'data', 'run'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'data', 'run', `openchamber-${port}.json`),
      JSON.stringify({ port, launchMode: 'daemon' }),
    );
    const dependencies = {
      // Real fs, except /.dockerenv must not exist so the container branch is skipped.
      fs: new Proxy(fs, {
        get(target, prop) {
          if (prop === 'existsSync') {
            return (p) => (p === '/.dockerenv' ? false : fs.existsSync(p));
          }
          return target[prop];
        },
      }),
      path,
      process: {
        env: {
          ...process.env,
          ComSpec: cmdWrapper || undefined,
          WINEPREFIX,
          WINEDEBUG: '-all',
        },
        platform,
        execPath: process.execPath,
        exit: exitMock,
      },
      server: { address: () => ({ port }) },
      __dirname: here,
      openchamberDataDir: path.join(tmpDir, 'data'),
      modelsDevApiUrl: 'https://models.example.test',
      modelsMetadataCacheTtl: 0,
      readSettingsFromDiskMigrated: vi.fn(),
      fetchFreeZenModels: vi.fn(),
      getCachedZenModels: vi.fn(),
    };
    registerOpenChamberRoutes(app, dependencies);
    return app;
  };

  const waitForChildExit = (child) => new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });

  const waitForSpawn = async () => {
    const deadline = Date.now() + 10_000;
    while (spawnCalls.length === 0) {
      if (Date.now() > deadline) throw new Error('route never spawned the update child');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return spawnCalls[0];
  };

  const waitForExitCall = async () => {
    const deadline = Date.now() + 10_000;
    while (exitMock.mock.calls.length === 0) {
      if (Date.now() > deadline) throw new Error('route never called process.exit');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  it('Windows branch: multi-line script to cmd.exe /c runs nothing, yet the server shuts down', async () => {
    // ComSpec -> a wrapper that loads cmd.exe through Wine (PE loader on Linux).
    const cmdWrapper = path.join(tmpDir, 'cmd-wrapper.sh');
    fs.writeFileSync(
      cmdWrapper,
      '#!/bin/bash\n'
      + `export WINEPREFIX=${WINEPREFIX}\n`
      + 'export WINEDEBUG=-all\n'
      + 'exec wine cmd.exe "$@"\n',
    );
    fs.chmodSync(cmdWrapper, 0o755);

    const app = buildRouteEnv({ platform: 'win32', port: 7897, cmdWrapper });

    const response = await request(app).post('/api/openchamber/update-install').expect(200);
    expect(response.body.success).toBe(true);

    // Route responds immediately; the spawn happens ~500ms later.
    const { args: [shell, shellArgs], child } = await waitForSpawn();
    const exitCode = await waitForChildExit(child);

    // 1. Buggy shape: multi-line script as a single argument to cmd.exe /c.
    expect(shell).toBe(cmdWrapper); // ComSpec
    expect(shellArgs[0]).toBe('/c');
    const script = shellArgs[1];
    expect(script).toMatch(/\n/); // multi-line
    expect(script).toContain('if %ERRORLEVEL% EQU 0 (');
    expect(script).toContain('echo UPDATE_RAN >>');

    // 2. Update command never executed.
    expect(fs.existsSync(markerPath)).toBe(false);

    // 3. Server shut down unconditionally, with no verification of the child.
    await waitForExitCall();
    expect(exitMock).toHaveBeenCalledWith(0);

    // Observational (Wine cmd differs byte-for-byte from real cmd.exe; on a real
    // Windows host the reporter observed a 0-byte log and exit code 0).
    const logContent = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '(no log file)';
    expect(logContent).not.toContain('Update successful');
    console.log('[issue-3084] win32 route: child exit code =', exitCode);
    console.log('[issue-3084] win32 route: update-install.log bytes =', Buffer.byteLength(logContent));
    console.log('[issue-3084] win32 route: log content =', JSON.stringify(logContent));
    console.log('[issue-3084] win32 route: spawned script:\n', script);
  });

  it('control: identical route with sh -c executes the multi-line script fine', async () => {
    // Hold the restart port so the restart attempt fails fast and sh exits.
    const busyPort = 7898;
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(busyPort, '127.0.0.1', resolve));

    try {
      const app = buildRouteEnv({ platform: 'linux', port: busyPort, cmdWrapper: null });
      await request(app).post('/api/openchamber/update-install').expect(200);

      const { args: [shell, shellArgs], child } = await waitForSpawn();
      const exitCode = await waitForChildExit(child);

      expect(shell).toBe('sh');
      expect(shellArgs[0]).toBe('-c');
      const script = shellArgs[1];
      expect(script).toContain('if [ $? -eq 0 ]; then');

      // sh -c runs the whole multi-line script: update command executed...
      expect(fs.existsSync(markerPath)).toBe(true);
      // ...and the success branch was taken, even though the server shuts down all the same.
      const logContent = fs.readFileSync(logPath, 'utf8');
      expect(logContent).toContain('Update successful, restarting OpenChamber...');
      await waitForExitCall();
      expect(exitMock).toHaveBeenCalledWith(0);
      console.log('[issue-3084] linux control: sh child exit code =', exitCode);
    } finally {
      blocker.close();
    }
  });
});