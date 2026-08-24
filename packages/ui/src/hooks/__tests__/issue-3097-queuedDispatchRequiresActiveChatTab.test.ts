/**
 * Reproduction coverage for https://github.com/openchamber/openchamber/issues/3097
 *
 * A message queued on a busy session is only auto-sent when that session's chat
 * tab is the active context panel tab. The reporter's root cause has two parts:
 *
 * 1. Each context panel chat tab runs its own embedded iframe, and each iframe
 *    has its own in-memory instance of `useMessageQueueStore`. The background
 *    (non-active) tab's auto-send is disabled because App.tsx gates
 *    `useQueuedMessageAutoSend` on
 *    `embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible`,
 *    and `isEmbeddedVisible` is false for every tab but the active one.
 * 2. There is no live cross-frame propagation of the queue store: it persists
 *    to localStorage without a storage-event or BroadcastChannel sync, and
 *    frames hydrate only at load. The parent window's auto-send stays enabled
 *    but never sees the item, and even a shared store would skip any target
 *    whose directory is not the currently selected directory.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const sendMessageCalls: unknown[][] = [];

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: () => [],
      currentAgentName: undefined,
      currentProviderId: 'provider-1',
      currentModelId: 'model-1',
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      sessionAbortFlags: new Map(),
    }),
  },
}));

mock.module('@/sync/selection-store', () => ({
  useSelectionStore: { getState: () => ({ lastUsedProvider: null }) },
}));

mock.module('@/stores/contextStore', () => ({
  useContextStore: {
    getState: () => ({
      getSessionAgentSelection: () => undefined,
      getCurrentAgent: () => undefined,
      getSessionModelSelection: () => undefined,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}));

const { useMessageQueueStore, createMessageQueueTarget } = await import('@/stores/messageQueueStore');
const { setSyncRefs } = await import('@/sync/sync-refs');
const { ChildStoreManager } = await import('@/sync/child-store');
// Importing sync-context publishes the context onto globalThis and lets
// useDirectorySync resolve the child store provided by the harness.
await import('@/sync/sync-context');

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', 'App.tsx'), 'utf-8');
const hookSource = readFileSync(join(__dirname, '..', 'useQueuedMessageAutoSend.ts'), 'utf-8');
const appEffectsSource = readFileSync(join(__dirname, '..', '..', 'apps', 'AppEffects.tsx'), 'utf-8');
const storeSource = readFileSync(join(__dirname, '..', '..', 'stores', 'messageQueueStore.ts'), 'utf-8');

const SESSION_ID = 'ses_3097';
const DIRECTORY = '/repo';

const installMinimalDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  class ElementStub {}
  const documentStub: Record<string, unknown> = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  const container = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  documentStub.documentElement = container;
  documentStub.body = container;
  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
  setGlobal('Element', ElementStub);
  setGlobal('HTMLElement', ElementStub);
  setGlobal('HTMLIFrameElement', ElementStub);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
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

const syncContext = (globalThis as unknown as {
  __openchamber_sync_context__?: React.Context<unknown>;
}).__openchamber_sync_context__;

if (!syncContext) {
  throw new Error('sync context was not published on globalThis by @/sync/sync-context');
}

// The hook reads `currentDirectory` from @/stores/useDirectoryStore. Reset it
// to the reproduction directory so targets for that directory pass the filter.
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

const { useQueuedMessageAutoSend } = await import('../useQueuedMessageAutoSend');

describe('issue #3097 queued messages dispatch only when the chat tab is active', () => {
  beforeEach(() => {
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    sendMessageCalls.length = 0;
    useDirectoryStore.setState({ currentDirectory: DIRECTORY } as never);
  });

  afterAll(() => {
    useDirectoryStore.setState({ currentDirectory: '/' } as never);
  });

  test('background embedded chat (enabled=false) never dispatches a queued message at idle', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    setSyncRefs({} as never, childStores, DIRECTORY);

    // Queue a message for the session while it is busy (the reproduction step 3).
    const target = createMessageQueueTarget(SESSION_ID, DIRECTORY)!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'queued follow-up' });

    // The session turn has now completed: session_status is idle and the
    // trailing assistant message carries a completed timestamp.
    store.setState({
      status: 'complete',
      session_status: { [SESSION_ID]: { type: 'idle' } },
      message: {
        [SESSION_ID]: [{
          id: 'a_done',
          role: 'assistant',
          sessionID: SESSION_ID,
          time: { created: 1, completed: 2 },
        } as never],
      },
      part: {},
    } as never);

    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: DIRECTORY };
    const Provider = syncContext.Provider as React.Provider<unknown>;

    const Harness = () => {
      // `false` mirrors the background embedded chat tab:
      // embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible,
      // with isEmbeddedVisible === false.
      useQueuedMessageAutoSend(false);
      return null;
    };

    try {
      await act(async () => {
        root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
      });
      // Give the effect loop and any scheduled dispatch a chance to run.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // The queued message is never sent while the frame is in the background.
      expect(sendMessageCalls.length).toBe(0);
      // And it remains queued.
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('enabled frame skips a queued target whose directory is not currentDirectory', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    setSyncRefs({} as never, childStores, DIRECTORY);

    // Simulate the parent window: it is enabled, but its currently selected
    // directory differs from the directory the queued session belongs to.
    useDirectoryStore.setState({ currentDirectory: '/other-repo' } as never);

    const target = createMessageQueueTarget(SESSION_ID, DIRECTORY)!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'queued follow-up' });

    store.setState({
      status: 'complete',
      session_status: { [SESSION_ID]: { type: 'idle' } },
      message: {},
      part: {},
    } as never);

    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: DIRECTORY };
    const Provider = syncContext.Provider as React.Provider<unknown>;

    const Harness = () => {
      useQueuedMessageAutoSend(true);
      return null;
    };

    try {
      await act(async () => {
        root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      // Even with background work enabled, the dispatch loop's guard
      // `target.directory !== currentDirectory` skips the item.
      expect(sendMessageCalls.length).toBe(0);
      expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
      useDirectoryStore.setState({ currentDirectory: DIRECTORY } as never);
    }
  });

  test('enabled frame with matching directory dispatches the queued message (control)', async () => {
    const dom = installMinimalDom();
    const root: Root = createRoot(dom.container);
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    setSyncRefs({} as never, childStores, DIRECTORY);

    const target = createMessageQueueTarget(SESSION_ID, DIRECTORY)!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'queued follow-up' });

    store.setState({
      status: 'complete',
      session_status: { [SESSION_ID]: { type: 'idle' } },
      message: {},
      part: {},
    } as never);

    const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: 'test', directory: DIRECTORY };
    const Provider = syncContext.Provider as React.Provider<unknown>;

    const Harness = () => {
      useQueuedMessageAutoSend(true);
      return null;
    };

    try {
      await act(async () => {
        root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });

      expect(sendMessageCalls.length).toBe(1);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('no cross-frame propagation exists for the message queue store', () => {
    // The queue store persists to localStorage under this key but there is no
    // storage-event listener or BroadcastChannel that rehydrates other frames'
    // in-memory store instances. The only storage rehydration in App.tsx is for
    // `ui-store`, and the only BroadcastChannel is for mini-chat presence.
    expect(storeSource).toContain("name: 'message-queue-store'");
    expect(hookSource).toContain("target.directory !== currentDirectory");

    const appStorageHandler = appSource.indexOf('useUIStore.persist.rehydrate');
    expect(appStorageHandler).toBeGreaterThan(-1);
    const appBlock = appSource.slice(Math.max(0, appStorageHandler - 400), appStorageHandler + 100);
    // The storage handler only rehydrates the UI store, never the queue store.
    expect(appBlock).not.toContain('message-queue-store');

    expect(appEffectsSource).toContain('MINI_CHAT_PRESENCE_CHANNEL');
    expect(appSource).not.toContain('BroadcastChannel');
  });

  test('embedded chat background work is gated on the tab being visible', () => {
    expect(appSource).toContain(
      'const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;',
    );
    expect(appEffectsSource).toContain('useQueuedMessageAutoSend(embeddedBackgroundWorkEnabled)');
  });
});
