import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { registerFsRoutes } from './routes.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';

// Reproduction for https://github.com/openchamber/openchamber/issues/3019
//
// [Bug] File paths in backticks in messages are not linkified when the
// browsed directory differs from the session directory.
//
// The renderer's `fileReferenceExists` (packages/ui/src/components/chat/
// MarkdownRendererImpl.tsx) probes the server with
// `runtimeFetch('/api/fs/stat?path=<absolute>&optional=true')` and sends NO
// directory hint. The server resolves the workspace from `settings.lastDirectory`
// (the directory the UI last browsed), not the session's directory, so when the
// two differ the stat returns 400 "Path is outside of active workspace" and the
// renderer treats the failure as "file does not exist".
//
// This test wires the real route registration and the real project-directory
// runtime together and demonstrates the mismatch:
//   - session directory B contains `src/index.ts`
//   - settings.lastDirectory points at directory A
//   - the exact request the renderer sends (no directory hint) -> 400
//   - the same request carrying `x-opencode-directory: B` -> 200

const DIR_A = '/home/user/workspace/project-a'; // settings.lastDirectory (UI last browsed)
const DIR_B = '/home/user/workspace/project-b'; // session directory
const FILE_IN_B = `${DIR_B}/src/index.ts`;      // exists under the session directory

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
  const headers = new Map();
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
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
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

describe('issue-3019: file-reference stat probe ignores the session directory', () => {
  it('reproduces the lastDirectory mismatch on /api/fs/stat', async () => {
    const statMock = vi.fn(async (targetPath) => {
      if (targetPath === DIR_A || targetPath === DIR_B) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if (targetPath === FILE_IN_B) {
        return { isDirectory: () => false, isFile: () => true, size: 12, mtimeMs: 123 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const fsPromises = {
      realpath: async (targetPath) => targetPath,
      stat: statMock,
    };

    // Real project-directory runtime: header/query hint wins, otherwise the
    // workspace falls back to settings.lastDirectory (directory A).
    const projectDirectoryRuntime = createProjectDirectoryRuntime({
      fsPromises,
      path: path.posix,
      normalizeDirectoryPath: (p) => p,
      getReadSettingsFromDiskMigrated: () => async () => ({
        lastDirectory: DIR_A,
        projects: [],
      }),
      sanitizeProjects: (input) => input,
    });

    const { app, getRoute } = createRouteRegistry();
    registerFsRoutes(app, {
      os: { homedir: () => '/home/user' },
      path: path.posix,
      fsPromises,
      spawn: vi.fn(),
      crypto: { randomUUID: () => 'job-0' },
      normalizeDirectoryPath: (p) => p,
      resolveProjectDirectory: projectDirectoryRuntime.resolveProjectDirectory,
      buildAugmentedPath: () => '/usr/bin',
      resolveGitBinaryForSpawn: () => 'git',
      openchamberUserConfigRoot: '/home/user/.config',
    });
    const statHandler = getRoute('GET', '/api/fs/stat');
    expect(statHandler).toBeDefined();

    const query = { path: FILE_IN_B, optional: 'true' };

    // 1. The request the renderer actually sends: no directory hint, so the
    //    server resolves the workspace from settings.lastDirectory (DIR_A).
    //    The file exists under the session directory (DIR_B) but is outside
    //    the resolved workspace -> 400. `fileReferenceExists` maps this to
    //    `false`, so the inline-code span is never promoted to a link.
    const resWithoutHint = createMockResponse();
    await statHandler({ query, get: () => null }, resWithoutHint);

    expect(resWithoutHint.statusCode).toBe(400);
    expect(resWithoutHint.body).toEqual({ error: 'Path is outside of active workspace' });

    // 2. The same request carrying the session directory as the
    //    x-opencode-directory header -> 200 with the file's stat payload.
    const resWithHint = createMockResponse();
    await statHandler({
      query,
      get: (name) => (name === 'x-opencode-directory' ? DIR_B : null),
    }, resWithHint);

    expect(resWithHint.statusCode).toBe(200);
    expect(resWithHint.body).toEqual({
      path: FILE_IN_B,
      isFile: true,
      size: 12,
      mtimeMs: 123,
    });

    // Sanity: both requests target the same existing file; only the workspace
    // resolution differs. The stat mock saw the file in both cases.
    expect(statMock).toHaveBeenCalledWith(FILE_IN_B);
  });
});