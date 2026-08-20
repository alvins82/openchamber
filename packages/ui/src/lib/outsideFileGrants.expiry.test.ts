import { afterEach, describe, expect, test } from 'bun:test';

import { ensureOutsideFileGrantForDesktop, getOutsideFileGrant } from './outsideFileGrants';

// Reproduction for https://github.com/openchamber/openchamber/issues/3031
//
// The desktop shell mints a grant when a chat file reference is opened. The
// grant is cached client-side for 10 minutes. When the cache entry expires,
// `getOutsideFileGrant` deletes it and returns `undefined`. The FilesView read
// path (loadFile) only reads this cache and never re-mints, so the next read
// goes to the server with `allowOutsideWorkspace=true` and no token, which the
// server rejects with `Outside workspace file access requires a grant`.

type DesktopWindowGlobals = {
  __OPENCHAMBER_ELECTRON__: { runtime: string };
  __OPENCHAMBER_DESKTOP__: {
    invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    grantFileAccess: (path: string) => Promise<{ path: string; outsideFileGrant: string }>;
  };
  __OPENCHAMBER_API_BASE_URL__: string;
  __OPENCHAMBER_LOCAL_ORIGIN__: string;
};

const withDesktopGlobals = async <T>(globals: DesktopWindowGlobals, run: () => Promise<T>): Promise<T> => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globals,
  });
  try {
    return await run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

const createDesktopGlobals = (): DesktopWindowGlobals => ({
  __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
  __OPENCHAMBER_DESKTOP__: {
    invoke: async () => null,
    grantFileAccess: async (path: string) => ({ path, outsideFileGrant: `grant-${path}` }),
  },
  __OPENCHAMBER_API_BASE_URL__: 'http://localhost:4200',
  __OPENCHAMBER_LOCAL_ORIGIN__: 'http://localhost:4200',
});

describe('outside file grant client cache expiry (issue 3031)', () => {
  const realDateNow = Date.now;

  afterEach(() => {
    Date.now = realDateNow;
  });

  test('grant is served while fresh, then the cache entry expires and returns undefined', async () => {
    await withDesktopGlobals(createDesktopGlobals(), async () => {
      const workspaceRoot = '/repo';
      const outsidePath = '/outside/plan.txt';

      // This is what clicking a chat file reference does: mint + cache the grant.
      const token = await ensureOutsideFileGrantForDesktop(outsidePath, workspaceRoot);
      expect(token).toBe(`grant-${outsidePath}`);

      // The file is now open in the editor. The read path reads the cache.
      expect(getOutsideFileGrant(outsidePath)).toBe(token);

      // Leave the file open past the 10-minute cache TTL.
      const now = realDateNow();
      Date.now = () => now + 10 * 60 * 1000 + 1000;

      // The cache entry is deleted on expiry. `undefined` is exactly what the
      // FilesView read path receives, so its request carries no token.
      expect(getOutsideFileGrant(outsidePath)).toBe(undefined);

      // Re-minting never happens on the read path: `ensureOutsideFileGrantForDesktop`
      // is only wired into chat/Markdown file-reference rendering. Re-reading the
      // same path from the editor after the TTL is a request with
      // `allowOutsideWorkspace=true` and no token, which the server rejects.
      expect(getOutsideFileGrant(outsidePath)).toBe(undefined);
    });
  });
});