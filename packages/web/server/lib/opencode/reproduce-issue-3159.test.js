import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import path from 'node:path';
import request from 'supertest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('../package-manager.js', () => ({
  checkForUpdates: vi.fn(),
  getUpdateCommand: vi.fn(),
  detectPackageManagerDetails: vi.fn(),
}));

const childProcess = await import('child_process');
const packageManager = await import('../package-manager.js');
const { registerOpenChamberRoutes } = await import('./openchamber-routes.js');

/**
 * Builds an Express app wired exactly like the real server for the
 * `/api/openchamber/update-install` route, but with the platform and the
 * on-disk instance file shaped the way `openchamber startup enable` produces
 * them on macOS (launchd User LaunchAgent running `serve --foreground`).
 */
const createApp = ({ platform = 'darwin', environment = {}, instanceFile = {} } = {}) => {
  const app = express();
  const dependencies = {
    fs: {
      existsSync: vi.fn(() => false),
      promises: {
        readFile: vi.fn(async () => JSON.stringify({
          launchMode: 'foreground',
          port: 14000,
          ...instanceFile,
        })),
      },
    },
    path,
    process: {
      env: environment,
      platform,
      execPath: '/usr/local/bin/node',
    },
    server: {
      address: () => ({ port: 14000 }),
    },
    __dirname: '/opt/openchamber/server',
    openchamberDataDir: '/tmp/openchamber',
    modelsDevApiUrl: 'https://models.example.test',
    modelsMetadataCacheTtl: 0,
    readSettingsFromDiskMigrated: vi.fn(),
    fetchFreeZenModels: vi.fn(),
    getCachedZenModels: vi.fn(),
  };

  registerOpenChamberRoutes(app, dependencies);
  return { app, dependencies };
};

const SYSTEMD_ONLY_409 = 'Foreground servers must be updated by their service manager. Set OPENCHAMBER_SYSTEMD_UNIT when running under systemd, or run openchamber update and restart the service.';

beforeEach(() => {
  packageManager.checkForUpdates.mockResolvedValue({
    available: true,
    version: '1.22.0',
  });
  packageManager.detectPackageManagerDetails.mockReturnValue({
    packageManager: 'npm',
  });
  packageManager.getUpdateCommand.mockReturnValue('npm install -g @openchamber/web@latest');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Reproduce issue #3159: in-app Update fails on macOS launchd service', () => {
  it('macOS launchd foreground service rejects the update with the systemd-only 409', async () => {
    // Scenario: `openchamber startup enable --port 14000` on macOS created a
    // launchd User LaunchAgent (`~/Library/LaunchAgents/dev.openchamber.web.plist`)
    // that runs `node <cli> serve --foreground --port 14000 --host 127.0.0.1`.
    // The instance file therefore says launchMode: 'foreground'. launchd does
    // not set INVOCATION_ID (that variable is systemd-specific), so
    // resolveSystemdServiceUnit() returns null.
    const { app } = createApp({
      platform: 'darwin',
      environment: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/Users/repro',
      },
      instanceFile: {
        launchMode: 'foreground',
        port: 14000,
        host: '127.0.0.1',
      },
    });

    const response = await request(app)
      .post('/api/openchamber/update-install')
      .expect(409);

    expect(response.body).toEqual({ error: SYSTEMD_ONLY_409 });
    // No systemd-run was attempted; the route short-circuits to the 409.
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('proves the route has no darwin branch: on darwin it still schedules a systemd-run job when systemd env vars are present', async () => {
    // The route never consults process.platform. Give it a darwin process but
    // the systemd env a Linux unit would set: it proceeds down the systemd
    // path and returns restartManager: 'systemd'. On a real Mac there is no
    // systemd-run binary, so this path is unreachable and the 409 above is
    // the only outcome for launchd-run servers.
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' });

    const { app } = createApp({
      platform: 'darwin',
      environment: {
        INVOCATION_ID: 'launchd-would-never-set-this',
        OPENCHAMBER_SYSTEMD_UNIT: 'openchamber.service',
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
      instanceFile: { launchMode: 'foreground', port: 14000 },
    });

    const response = await request(app)
      .post('/api/openchamber/update-install')
      .expect(200);

    expect(response.body.restartManager).toBe('systemd');
    expect(childProcess.spawnSync).toHaveBeenCalledWith('systemd-run', expect.any(Array), expect.any(Object));
  });
});