/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2892
 *
 * [Bug] Embedded chat panel (Work status → subagent) opens empty —
 * "Start a new chat" instead of session history.
 *
 * Reported: clicking a subagent in the Work status panel opens the embedded
 * session-chat iframe (`?ocPanel=session-chat&sessionId=...`) which shows the
 * empty state ("Start a new chat" + "Subagent sessions cannot be prompted.")
 * even though `GET /api/session/{id}` and `GET /api/session/{id}/message`
 * both return 200 with the full history. The data arrives but is never
 * rendered. Opening the same session in the main view works.
 *
 * Root cause demonstrated here (regression from commit 9fb3109, v1.18.3):
 *
 * 1. The embedded chat iframe now boots with `isEmbeddedVisible === false`
 *    (commit 9fb3109 changed the initial state from `true` to `false`) and
 *    only becomes "active" when the parent window's one-way
 *    `openchamber:embedded-visibility` postMessage arrives. There is no
 *    request/acknowledgment handshake: the iframe only *listens* for the
 *    message. A parent message posted before the iframe's React listener is
 *    registered (e.g. the iframe `onLoad` / parent layout effect firing while
 *    the embedded React app is still mounting) is silently dropped and never
 *    re-sent, leaving the panel permanently inactive.
 * 2. While inactive (`active === false`), `ChatContainer` calls
 *    `useSessionMessageRecords(..., { enabled: false })`, which always returns
 *    an empty list regardless of what the sync store holds. The store is
 *    fully materialized (that is the successful message fetch), so
 *    `isSessionHydrating` is false and the renderer falls into the
 *    `sessionMessages.length === 0 && !sessionIsWorking` branch which shows
 *    `<ChatEmptyState />` ("Start a new chat") plus the read-only banner —
 *    exactly the reported symptom.
 */
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import type { Message, OpencodeClient, Part } from '@opencode-ai/sdk/v2/client';

import { SyncProvider, useChildStoreManager, useSessionMessageRecords } from '@/sync/sync-context';
import { getSessionMaterializationStatus, materializeSessionSnapshots } from '@/sync/materialization';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf-8');
const chatContainerSource = readFileSync(join(__dirname, '..', 'ChatContainer.tsx'), 'utf-8');

const DIRECTORY = '/repo';
const SESSION_ID = 'ses_child';

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

const makeSdk = (): OpencodeClient => {
  const noopStream = (async function* stream() {})();
  const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } as never });
  const base = {
    global: { event: () => ({ stream: noopStream }), config: { get: async () => ok({}) } },
    path: { get: async () => ok({ directory: DIRECTORY }) },
    session: {
      get: async () => ok(null),
      messages: async () => ok([]),
      list: async () => ok([]),
      status: async () => ok({}),
    },
    project: { current: async () => ok({ worktree: DIRECTORY }), list: async () => ok([]) },
    config: { get: async () => ok({}) },
    agent: { list: async () => ok([]) },
    provider: { list: async () => ok([]) },
    tool: { list: async () => ok([]) },
    event: { stream: () => ({ stream: noopStream }) },
  } as unknown as OpencodeClient;
  return base;
};

/** A fully completed subagent session: 14 messages, all parts materialized. */
const buildHistory = (): Array<{ info: Message; parts: Part[] }> => {
  const records: Array<{ info: Message; parts: Part[] }> = [];
  for (let index = 0; index < 14; index += 1) {
    const isAssistant = index % 2 === 1;
    const id = `msg_${String(index).padStart(3, '0')}`;
    const message = {
      id,
      sessionID: SESSION_ID,
      role: isAssistant ? 'assistant' : 'user',
      time: { created: index, completed: isAssistant ? index + 1 : undefined },
    } as Message;
    records.push({
      info: message,
      parts: isAssistant ? [{ id: `part_${id}`, messageID: id, sessionID: SESSION_ID, type: 'text', text: `response ${index}` } as Part] : [],
    });
  }
  return records;
};

let dom: ReturnType<typeof installMinimalDom> | null = null;
let root: Root | null = null;

beforeEach(() => {
  dom = installMinimalDom();
});

afterAll(() => {
  dom?.restore();
  dom = null;
  root = null;
});

describe('issue #2892 — embedded chat shows empty state while data is materialized', () => {
  test('an inactive embedded chat hides a fully-renderable session (records = 0) while active reveals it', async () => {
    const history = buildHistory();
    let recordsCount: number | null = null;
    let renderable: boolean | null = null;
    let childStores: ReturnType<typeof useChildStoreManager> | null = null;

    const Harness = ({ enabled }: { enabled: boolean }) => {
      childStores = useChildStoreManager();
      // Same call ChatContainer makes: useSessionMessageRecords(sessionId, dir, { enabled: active })
      const records = useSessionMessageRecords(SESSION_ID, DIRECTORY, { enabled });
      recordsCount = records.length;
      return null;
    };

    const sessionStoreRef = { current: null as unknown };
    const CaptureStore = () => {
      childStores = useChildStoreManager();
      sessionStoreRef.current = childStores!.ensureChild(DIRECTORY, { bootstrap: false });
      return null;
    };

    try {
      root = createRoot(dom!.container);
      await act(async () => {
        root!.render(React.createElement(
          SyncProvider,
          { sdk: makeSdk(), directory: DIRECTORY, children: React.createElement(CaptureStore) },
        ));
      });

      // Simulate the successful `GET /api/session/{id}/message` commit: the
      // message loader materializes the page into the directory store.
      const store = sessionStoreRef.current as {
        getState: () => { message: Record<string, Message[]>; part: Record<string, Part[]> };
        setState: (patch: Record<string, unknown>) => void;
      };
      const before = store.getState();
      const materialized = materializeSessionSnapshots(before, SESSION_ID, history);
      store.setState({
        ...(materialized.messagesChanged ? { message: materialized.message } : {}),
        ...(materialized.partsChanged ? { part: materialized.part } : {}),
      });

      // The session is fully materialized — this is the "data arrives" half of
      // the report. The empty state shown by the panel is therefore NOT caused
      // by missing data.
      renderable = getSessionMaterializationStatus(store.getState(), SESSION_ID).renderable;
      expect(renderable).toBe(true);
      expect(store.getState().message[SESSION_ID]).toHaveLength(14);

      // Boot state of the embedded panel (commit 9fb3109): active=false.
      await act(async () => {
        root!.render(React.createElement(
          SyncProvider,
          { sdk: makeSdk(), directory: DIRECTORY, children: React.createElement(Harness, { enabled: false }) },
        ));
      });
      // Data is materialized, yet the records surface — the exact value that
      // drives ChatContainer's `sessionMessages` — is empty. ChatContainer
      // therefore falls into the `sessionMessages.length === 0` branch and
      // renders ChatEmptyState ("Start a new chat") + read-only banner.
      expect(recordsCount).toBe(0);

      // When the panel becomes active (visibility message received), the same
      // store instantly yields all 14 messages.
      await act(async () => {
        root!.render(React.createElement(
          SyncProvider,
          { sdk: makeSdk(), directory: DIRECTORY, children: React.createElement(Harness, { enabled: true }) },
        ));
      });
      expect(recordsCount).toBe(14);
    } finally {
      if (root) await act(async () => root!.unmount());
    }
  });

  test('embedded chat boots inactive (isEmbeddedVisible=false) per commit 9fb3109', () => {
    // The regression commit changed the initial visibility from true to false.
    expect(appSource).toContain('const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);');
    // Active (background work) is gated on visibility for embedded chats.
    expect(appSource).toContain('const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;');
    // And that flag is what becomes ChatContainer's `active` prop.
    expect(appSource).toContain('active={embeddedBackgroundWorkEnabled}');
  });

  test('embedded chat only listens for visibility — a lost parent message is never recovered', () => {
    // The iframe registers a message listener for `openchamber:embedded-visibility`...
    expect(appSource).toContain("data?.type !== 'openchamber:embedded-visibility'");
    expect(appSource).toContain("window.addEventListener('message', handleMessage)");
    // ...but never posts a visibility request of its own: the channel is a
    // one-way push from the parent. Search for any request/ack message types
    // the iframe might emit and confirm there is no visibility request.
    expect(appSource).not.toContain('openchamber:embedded-visibility-request');
    expect(appSource).not.toContain('openchamber:embedded-visibility-ack');
  });

  test('ChatContainer renders the empty state when records are empty and the session is not working', () => {
    // `sessionMessages` is exactly the records hook gated on `active`.
    expect(chatContainerSource).toContain(
      "const sessionMessageRecords = useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {",
    );
    expect(chatContainerSource).toContain('enabled: active,');
    // When records are empty and the session is not working, the empty state
    // ("Start a new chat") is rendered with the read-only banner.
    expect(chatContainerSource).toContain("if (sessionMessages.length === 0 && !sessionIsWorking) {");
    expect(chatContainerSource).toContain('<ChatEmptyState />');
    expect(chatContainerSource).toContain('promptReadOnly ? <ReadOnlyPromptBanner /> :');
  });
});
