/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3122
 *
 * Sidebar worktree discovery is keyed off the retained project list
 * (`useProjectsStore.getState().projects`) rather than active session
 * ownership. Mounting the real SessionSidebar with two git projects and one
 * non-git project, where only /repo-a has an active session, shows that
 * `git.worktree.list` (backed by `git worktree list --porcelain` on the
 * server) is still invoked for /repo-b — a retained project with no session —
 * and that the non-git directory is probed with `checkIsGitRepository`
 * instead of being skipped.
 */
import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { RuntimeAPIs } from '@/lib/api/types';

const gitListCalls: string[] = [];
const gitCheckCalls: string[] = [];

const fakeGitStatus = {
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
};

const fakeApis: RuntimeAPIs = {
  runtime: { isVSCode: false, kind: 'web', platform: 'web', isDesktop: false } as unknown as RuntimeAPIs['runtime'],
  terminal: {} as RuntimeAPIs['terminal'],
  git: {
    checkIsGitRepository: (directory: string) => {
      gitCheckCalls.push(directory);
      return Promise.resolve(directory !== '/non-git');
    },
    getGitStatus: () => Promise.resolve(fakeGitStatus),
    getGitDiff: () => Promise.resolve({ files: [], summary: '' }),
    getGitFileDiff: () => Promise.resolve({ content: '', changed: false }),
    isLinkedWorktree: () => Promise.resolve(false),
    getGitBranches: () => Promise.resolve({ current: 'main', branches: [] }),
    deleteGitBranch: () => Promise.resolve({ success: true }),
    deleteRemoteBranch: () => Promise.resolve({ success: true }),
    removeRemote: () => Promise.resolve({ success: true }),
    generateCommitMessage: () => Promise.resolve({ message: '' }),
    generatePullRequestDescription: () => Promise.resolve({ description: '' }),
    revertGitFile: () => Promise.resolve(),
    stageGitFile: () => Promise.resolve(),
    unstageGitFile: () => Promise.resolve(),
    listGitWorktrees: (directory: string) => {
      gitListCalls.push(directory);
      return Promise.resolve([]);
    },
    worktree: {
      list: (directory: string) => {
        gitListCalls.push(directory);
        return Promise.resolve([]);
      },
    },
  } as unknown as RuntimeAPIs['git'],
  files: {} as RuntimeAPIs['files'],
  settings: {} as RuntimeAPIs['settings'],
  permissions: {} as RuntimeAPIs['permissions'],
  notifications: {} as RuntimeAPIs['notifications'],
  tools: {} as RuntimeAPIs['tools'],
};

mock.module('@/contexts/runtimeAPIContext', () => ({
  RuntimeAPIContext: React.createContext<RuntimeAPIs | null>(fakeApis),
}));

mock.module('sonner', () => ({
  toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module('@/components/ui', () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }),
}));
mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => '/repo-a',
    setDirectory: () => undefined,
    getSdkClient: () => ({}),
    getScopedSdkClient: () => ({}),
  },
}));
mock.module('@/stores/permissionStore', () => ({
  usePermissionStore: { getState: () => ({ isSessionAutoAccepting: () => false, hydrate: async () => undefined }) },
}));
mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true, settingsMessageStreamTransport: 'auto' }),
    setState: () => undefined,
  },
}));
mock.module('@/stores/useTodosPersistStore', () => ({
  useTodosPersistStore: { getState: () => ({ setSessionTodos: () => undefined }) },
}));

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {
    classList = { add: () => undefined, remove: () => undefined, toggle: () => undefined };
    style: Record<string, unknown> = {
      setProperty: () => undefined,
      removeProperty: () => undefined,
    };
    dataset: Record<string, string> = {};
    setAttribute = () => undefined;
    getAttribute = () => null;
    removeAttribute = () => undefined;
    appendChild = () => undefined;
    removeChild = () => undefined;
    insertBefore = () => undefined;
    addEventListener = () => undefined;
    removeEventListener = () => undefined;
    set innerHTML(_value: string) {}
    set textContent(_value: string) {}
    setAttributeNS = () => undefined;
  }
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => new ElementStub(),
    createElementNS: () => new ElementStub(),
    createTextNode: () => new ElementStub(),
    createComment: () => new ElementStub(),
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined },
    setAttribute: () => undefined,
    removeAttribute: () => undefined,
    insertBefore: () => undefined,
    removeChild: () => undefined,
    appendChild: () => undefined,
    firstChild: null,
    style: {},
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  documentStub.head = {
    appendChild: () => undefined,
    removeChild: () => undefined,
    insertBefore: () => undefined,
  };
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => {
    try {
      callback(Date.now());
    } catch {
      // Animation callbacks may fire after the test DOM is torn down.
    }
  }, 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal('addEventListener', () => undefined);
  setGlobal('removeEventListener', () => undefined);
  setGlobal('innerWidth', 1280);
  setGlobal('innerHeight', 800);
  setGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  setGlobal('navigator', { userAgent: 'test', maxTouchPoints: 0, platform: 'linux' });
  setGlobal('EventSource', undefined);
  const storage = () => {
    const store = new Map<string, string>();
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    };
  };
  setGlobal('localStorage', storage());
  setGlobal('sessionStorage', storage());
  return {
    container: container as unknown as Element,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { registerRuntimeAPIs } = await import('@/contexts/runtimeAPIRegistry');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const syncContext = (globalThis as unknown as {
  __openchamber_sync_context__?: React.Context<unknown>;
}).__openchamber_sync_context__;
const { SessionSidebar } = await import('../SessionSidebar');
const { ChildStoreManager } = await import('@/sync/child-store');

registerRuntimeAPIs(fakeApis);

describe('issue #3122 sidebar worktree discovery vs active sessions', () => {
  test('git worktree discovery runs for retained projects without an active session', async () => {
    gitListCalls.length = 0;
    gitCheckCalls.length = 0;

    // Three retained projects. Only /repo-a is the current project AND has an
    // active session. /repo-b is a git repo with no session. /non-git is not a
    // repository at all.
    useProjectsStore.setState({
      projects: [
        { id: 'p-a', path: '/repo-a' },
        { id: 'p-b', path: '/repo-b' },
        { id: 'p-c', path: '/non-git' },
      ],
      activeProjectId: 'p-a',
    });
    useGlobalSessionsStore.setState({
      activeSessions: [{
        id: 'ses-a',
        title: 'active in repo-a',
        time: { created: 1, updated: 1 },
        version: '1',
        directory: '/repo-a',
      }],
      archivedSessions: [],
      status: 'ready',
    } as never);

    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: '/repo-a' };
    const Provider = syncContext?.Provider as React.Provider<unknown>;
    try {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { value: system },
            React.createElement(I18nProvider, null,
              React.createElement(ThemeSystemProvider, null,
                React.createElement(SessionSidebar, { isVisible: true }),
              ),
            ),
          ),
        );
      });
      // Let the discovery effect and its background tasks settle.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // The bug: `git.worktree.list` (server: `git worktree list --porcelain`)
      // is invoked for /repo-b even though it has no active session and is not
      // the current project. Only /repo-a should be queried.
      expect(gitListCalls.sort()).toEqual(['/repo-a', '/repo-b']);
      expect(gitListCalls).toContain('/repo-b');

      // The non-git directory is still probed with a git subprocess
      // (checkIsGitRepository -> server `git rev-parse`) rather than skipped.
      expect(gitCheckCalls).toContain('/non-git');
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});