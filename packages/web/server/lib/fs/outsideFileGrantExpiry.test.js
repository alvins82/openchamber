// Reproduction for https://github.com/openchamber/openchamber/issues/3031
//
// Outside-workspace file reads work while the grant is fresh, but fail with
// `Outside workspace file access requires a grant` once the 10-minute grant
// TTL elapses. Nothing on the read path re-mints the grant, and the client
// stops sending a token once its local cache entry expires, so the server has
// nothing to validate.
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mintOutsideFileGrant, registerFsRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();
  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;
  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    type() {
      return this;
    },
    send(payload) {
      body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const registerRead = (fsPromises) => {
  const { app, getRoute } = createRouteRegistry();
  registerFsRoutes(app, {
    os: { homedir: () => '/home/user' },
    path: path.posix,
    fsPromises: {
      realpath: async (targetPath) => targetPath,
      ...fsPromises,
    },
    spawn: () => {},
    crypto: { randomUUID: () => 'job-0' },
    normalizeDirectoryPath: (p) => p,
    resolveProjectDirectory: async () => ({ directory: '/repo' }),
    buildAugmentedPath: () => '/usr/bin',
    resolveGitBinaryForSpawn: () => 'git',
    openchamberUserConfigRoot: '/home/user/.config',
  });
  return getRoute('GET', '/api/fs/read');
};

const callRead = async (handler, query) => {
  const res = createMockResponse();
  await handler({ query }, res);
  return res;
};

const OUTSIDE_FILE = '/outside/plan.txt';
const TTL_MS = 10 * 60 * 1000;

describe('outside file grant TTL expiry (issue 3031)', () => {
  const realDateNow = Date.now;
  let warn;

  afterEach(() => {
    Date.now = realDateNow;
    warn?.mockRestore();
  });

  it('read succeeds while the grant is fresh, then fails after the TTL elapses', async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fsPromises = {
      realpath: vi.fn(async (targetPath) => targetPath),
      stat: vi.fn(async () => ({ isFile: () => true, size: 6 })),
      readFile: vi.fn(async () => 'secret'),
    };
    const handler = registerRead(fsPromises);

    // The desktop shell mints a grant the first time the file is opened (this
    // is what `requestExistingFileAccess` reaches on the server).
    const grant = await mintOutsideFileGrant(OUTSIDE_FILE, {
      fsPromises,
      path: path.posix,
      crypto: { randomUUID: () => 'grant-token' },
    });

    // Fresh grant: read works.
    const fresh = await callRead(handler, {
      path: OUTSIDE_FILE,
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.body).toBe('secret');

    // Simulate the client letting the file sit open past the 10-minute TTL.
    // The client-side cache entry also expires at the same moment and is
    // deleted, so `getOutsideFileGrant` returns undefined and the request
    // carries no token.
    const now = realDateNow();
    Date.now = () => now + TTL_MS + 1000;

    // The same token the client would still be holding is now pruned server-side.
    const expiredToken = await callRead(handler, {
      path: OUTSIDE_FILE,
      allowOutsideWorkspace: 'true',
      outsideFileGrant: grant.outsideFileGrant,
    });
    expect(expiredToken.statusCode).toBe(400);
    expect(expiredToken.body).toEqual({ error: 'Outside workspace file grant is invalid or expired' });

    // This is exactly what the editor sends after its cache entry expires:
    // `allowOutsideWorkspace=true` with no token at all, because the FilesView
    // read path only reads the cache and never re-mints.
    const noToken = await callRead(handler, {
      path: OUTSIDE_FILE,
      allowOutsideWorkspace: 'true',
    });
    expect(noToken.statusCode).toBe(400);
    expect(noToken.body).toEqual({ error: 'Outside workspace file access requires a grant' });
    expect(fsPromises.readFile).toHaveBeenCalledTimes(1);
  });
});