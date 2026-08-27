/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3174
 *
 * "Session row actions block swipe-to-dismiss in the left mobile drawer"
 *
 * The left sessions drawer (`MobileSessionsDrawerContainer`) can be dismissed
 * only via the header X, Escape, or Android Back: its `<section>` mounts no
 * touch handlers at all, so a right-to-left swipe never closes it.
 *
 * `SessionRow` meanwhile claims every horizontal touch movement after 8px and
 * uses leftward movement to reveal its 144px Rename/Archive/Delete action
 * area. On a full-screen left drawer with no tappable scrim, the Material-3
 * dismissal swipe (toward the anchoring edge = right-to-left) therefore lands
 * on the row: the drawer stays open and the destructive row actions slide out.
 *
 * This test renders the real drawer with a session row and performs the
 * reported gesture — touchstart → touchmove (right-to-left) → touchend on the
 * row — then asserts the drawer does not dismiss (`onOpenChange` never fires)
 * while the row's content slides to -144px and the action buttons become
 * reachable, i.e. exactly the collision described in the issue.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Window, Touch as HappyTouch, type EventTarget as HappyEventTarget, type HTMLElement as HappyHTMLElement } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Session } from '@opencode-ai/sdk/v2';

const PROJECT_PATH = '/repo';
const PROJECT_ID = 'proj_repo';
const SESSION_ID = 'ses_3174';
const SESSION_TITLE = 'Issue 3174 repro session';

// SAFETY: the fixture session matches the shape the global-sessions store and
// the mobile sheet read (id, title, time, directory).
const reproSession: Session = {
  id: SESSION_ID,
  title: SESSION_TITLE,
  time: { created: 1, updated: 1 },
  directory: PROJECT_PATH,
  version: '1',
} as Session;

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => PROJECT_PATH,
    setDirectory: () => undefined,
    getSdkClient: () => ({
      experimental: {
        session: { list: async () => ({ data: [reproSession] }) },
      },
    }),
    getScopedSdkClient: () => ({
      experimental: {
        session: { list: async () => ({ data: [] }) },
      },
    }),
  },
}));
// Only `git.checkIsGitRepository` is exercised by the drawer/row render path;
// the rest of the RuntimeAPIs surface stays untouched, so the context default
// carries just that stub.
mock.module('@/contexts/runtimeAPIContext', () => ({
  RuntimeAPIContext: React.createContext({
    runtime: { isDesktop: false, isVSCode: false, platform: 'web' },
    terminal: {},
    git: { checkIsGitRepository: async () => false },
    files: {},
    settings: {},
    permissions: {},
    notifications: {},
    tools: {},
  }),
}));
mock.module('sonner', () => ({
  toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module('@/components/ui', () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}));
// Auxiliary surfaces are unrelated to the drawer/row gesture conflict; keep
// them out of the render so the reproduction stays focused.
mock.module('@/components/session/DirectoryExplorerDialog', () => ({
  DirectoryExplorerDialog: () => null,
}));
mock.module('@/components/session/NewWorktreeDialog', () => ({
  NewWorktreeDialog: () => null,
}));
mock.module('@/apps/MobileProjectEditSurface', () => ({
  MobileProjectEditSurface: () => null,
}));
mock.module('@/apps/MobileDeleteWorktreeDialog', () => ({
  MobileDeleteWorktreeDialog: () => null,
}));

const { MobileSessionsSheet } = await import('@/apps/MobileSessionsSheet');
const { useProjectsStore } = await import('@/stores/useProjectsStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { ChildStoreManager } = await import('@/sync/child-store');
const { I18nProvider, initializeLocale } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');

// SAFETY: sync-context publishes its context singleton on globalThis so tests
// can drive a minimal provider without booting the full SyncProvider.
const syncGlobal = globalThis as typeof globalThis & { __openchamber_sync_context__?: React.Context<unknown> };
const syncContext = syncGlobal.__openchamber_sync_context__;

if (!syncContext) {
  throw new Error('sync context was not published on globalThis by @/sync/sync-context');
}

type DomHandle = {
  windowInstance: Window;
  host: Element;
  root: Root;
  restore: () => void;
};

let dom: DomHandle | null = null;
let onOpenChangeCalls: boolean[] = [];
let onOpenChange: ReturnType<typeof mock<(open: boolean) => void>>;

afterEach(() => {
  dom?.restore();
  dom = null;
});

const installDom = (): DomHandle => {
  const windowInstance = new Window();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = <T,>(name: string, value: T) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  setGlobal('window', windowInstance);
  setGlobal('document', windowInstance.document);
  setGlobal('navigator', windowInstance.navigator);
  setGlobal('location', windowInstance.location);
  setGlobal('history', windowInstance.history);
  setGlobal('HTMLElement', windowInstance.HTMLElement);
  setGlobal('Element', windowInstance.Element);
  setGlobal('Node', windowInstance.Node);
  setGlobal('TouchEvent', windowInstance.TouchEvent);
  setGlobal('PointerEvent', windowInstance.PointerEvent);
  setGlobal('MouseEvent', windowInstance.MouseEvent);
  setGlobal('KeyboardEvent', windowInstance.KeyboardEvent);
  setGlobal('CustomEvent', windowInstance.CustomEvent);
  setGlobal('Event', windowInstance.Event);
  setGlobal('localStorage', windowInstance.localStorage);
  setGlobal('sessionStorage', windowInstance.sessionStorage);
  setGlobal('requestAnimationFrame', windowInstance.requestAnimationFrame.bind(windowInstance));
  setGlobal('cancelAnimationFrame', windowInstance.cancelAnimationFrame.bind(windowInstance));
  setGlobal('ResizeObserver', windowInstance.ResizeObserver);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  const host = document.createElement('div');
  // SAFETY: happy-dom always creates a <body>, so the container host is always attached.
  document.body?.appendChild(host);
  const root = createRoot(host);
  return {
    windowInstance,
    host,
    root,
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const seedStores = () => {
  useProjectsStore.setState({
    projects: [{ id: PROJECT_ID, path: PROJECT_PATH, label: 'repo', addedAt: 1, lastOpenedAt: 1 }],
    activeProjectId: PROJECT_ID,
  });
  useGlobalSessionsStore.setState({ activeSessions: [reproSession] });
  useDirectoryStore.setState({ currentDirectory: PROJECT_PATH });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const renderDrawer = async (): Promise<DomHandle> => {
  const installed = installDom();
  dom = installed;
  initializeLocale();
  seedStores();
  onOpenChange = mock<(open: boolean) => void>((open: boolean) => {
    onOpenChangeCalls.push(open);
  });

  const system = {
    childStores: new ChildStoreManager(),
    messageLoader: {},
    sdk: {},
    runtimeKey: 'test',
    directory: PROJECT_PATH,
  };
  // SAFETY: the published context singleton is the real SyncContext from
  // @/sync/sync-context, only widened to a plain Provider here.
  const Provider = syncContext.Provider as React.Provider<unknown>;

  await act(async () => {
    installed.root.render(
      <Provider value={system}>
        <I18nProvider>
          <ThemeSystemProvider>
            <MobileSessionsSheet open onOpenChange={onOpenChange} />
          </ThemeSystemProvider>
        </I18nProvider>
      </Provider>,
    );
    // Let the drawer's open animation state and the global-sessions load settle.
    await sleep(60);
  });
  return installed;
};

const findSessionRow = (windowInstance: Window): HappyHTMLElement => {
  const drawer = windowInstance.document.querySelector('#mobile-surface-root > section');
  if (!drawer) throw new Error('drawer section not found in portal root');
  const buttons = Array.from(drawer.querySelectorAll('button'));
  const selectButton = buttons.find((button) => button.textContent?.includes(SESSION_TITLE));
  if (!selectButton) throw new Error(`session row button not found for "${SESSION_TITLE}"`);
  const row = selectButton.closest('div.relative.overflow-hidden');
  if (!row) throw new Error('session row wrapper (div.relative.overflow-hidden) not found');
  // SAFETY: the matched wrapper is a real <div> (the attribute selector matched it).
  return row as HappyHTMLElement;
};

const fireTouch = (windowInstance: Window, target: HappyEventTarget, type: string, x: number, y: number) => {
  const touch = new HappyTouch({ identifier: 1, target, clientX: x, clientY: y });
  const isEnd = type === 'touchend';
  const event = new windowInstance.TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: isEnd ? [] : [touch],
    targetTouches: isEnd ? [] : [touch],
    changedTouches: [touch],
  });
  target.dispatchEvent(event);
};

const swipeRightToLeft = (windowInstance: Window, target: HappyEventTarget) => {
  fireTouch(windowInstance, target, 'touchstart', 320, 100);
  fireTouch(windowInstance, target, 'touchmove', 200, 100);
  fireTouch(windowInstance, target, 'touchmove', 80, 100);
  fireTouch(windowInstance, target, 'touchend', 80, 100);
};

describe('issue #3174: session row actions block swipe-to-dismiss in the left mobile drawer', () => {
  test('right-to-left swipe over a session row reveals the row actions and does not dismiss the drawer', async () => {
    const installed = await renderDrawer();
    try {
      const row = findSessionRow(installed.windowInstance);
      // The sliding content div is the row's child whose style carries the
      // imperative transform/transition; the actions wrapper is the sibling
      // with the fixed width + aria-hidden.
      // SAFETY: the matched node is a real div (querySelector by attribute).
      const content = row.querySelector('div[style*="transform"]') as HappyHTMLElement | null;
      // SAFETY: the matched node is a real div (querySelector by attribute).
      const actions = row.querySelector('div[aria-hidden]') as HappyHTMLElement | null;
      const deleteButton = Array.from(row.querySelectorAll('button')).find((button) =>
        button.getAttribute('aria-label')?.includes('Delete'),
      );
      if (!content || !actions || !deleteButton) throw new Error('row internals not found');

      expect(content.style.transform).not.toContain('translateX(-144px)');
      expect(actions.getAttribute('aria-hidden')).toBe('true');
      expect(deleteButton.tabIndex).toBe(-1);

      await act(async () => {
        swipeRightToLeft(installed.windowInstance, row);
      });

      // The gesture that should have dismissed the drawer instead:
      // 1) the drawer is still open (no onOpenChange call), and
      // 2) the row actions are revealed.
      expect(onOpenChangeCalls.length).toBe(0);
      expect(content.style.transform).toContain('translateX(-144px)');
      expect(actions.getAttribute('aria-hidden')).toBe('false');
      expect(deleteButton.tabIndex).toBe(0);

      const drawer = installed.windowInstance.document.querySelector('#mobile-surface-root > section');
      expect(drawer?.getAttribute('aria-hidden')).toBe('false');
    } finally {
      await act(async () => installed.root.unmount());
    }
  });

  test('a dismissal swipe on the drawer chrome (outside any row) also does not dismiss the drawer', async () => {
    const installed = await renderDrawer();
    try {
      const drawer = installed.windowInstance.document.querySelector('#mobile-surface-root > section');
      if (!drawer) throw new Error('drawer section not found');

      await act(async () => {
        swipeRightToLeft(installed.windowInstance, drawer);
      });

      expect(onOpenChangeCalls.length).toBe(0);
      expect(drawer.getAttribute('aria-hidden')).toBe('false');
    } finally {
      await act(async () => installed.root.unmount());
    }
  });
});