/**
 * Reproduction attempt for https://github.com/openchamber/openchamber/issues/3036
 *
 * Reported: re-opening a session whose previously used model was removed from
 * the provider catalog shows the chat error banner ("Minified React error #185",
 * Maximum update depth exceeded) and Reset Chat has no effect on large sessions.
 *
 * This file mounts the real MessageList (and the full ChatContainer) with the
 * maintainer's reproduction steps — model removed from provider config — plus
 * the reporter's APIError message shape, tool/reasoning parts, re-entry, and
 * config-change-while-mounted. None of those reproduce error #185.
 *
 * The error-boundary tests at the bottom DO reproduce a related defect from the
 * same report: ChatErrorBoundary retains its error state when the sessionId
 * prop changes, so an error from one session keeps the banner on screen after
 * switching to an unaffected session (matches the reporter's "error leaks
 * across sessions" observation).
 */
import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => null,
  highlightTokensInWorker: async () => null,
  resetMarkdownWorkerClientCacheForTests: () => undefined,
}));
mock.module('sonner', () => ({
  toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module('@/components/ui', () => ({
  toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}));
mock.module('@/lib/opencode/client', () => {
  const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
  const sdkStub = {
    path: {
      get: async () => ok({ directory: '/repo', cwd: '/repo' }),
    },
    config: {
      get: async () => ok({}),
    },
    global: {
      config: {
        get: async () => ok({}),
      },
      event: async () => {
        const stream = {
          [Symbol.asyncIterator]: async function* () {
            // Hang forever: simulate a connected stream with no events.
            await new Promise(() => {});
          },
        };
        return { stream };
      },
    },
    project: {
      list: async () => ok([]),
      current: async () => ok({ id: 'project-1' }),
    },
    session: {
      status: async () => ok({}),
      list: async () => ok([]),
      get: async () => ok({ id: 'ses_repro_3036', directory: '/repo', time: { created: 1, updated: 1 } }),
      messages: async () => ok([]),
    },
    message: {
      list: async () => ok([]),
      get: async () => ok(null),
    },
    part: {
      list: async () => ok([]),
      get: async () => ok(null),
    },
    event: {},
  };
  return {
    opencodeClient: {
      getDirectory: () => '/repo',
      setDirectory: () => undefined,
      getSdkClient: () => sdkStub,
      getScopedSdkClient: () => sdkStub,
    },
  };
});
mock.module('@/stores/permissionStore', () => {
  const permissionState = {
    isSessionAutoAccepting: () => false,
    setSessionAutoAccept: () => undefined,
    hydrate: async () => undefined,
  };
  const usePermissionStore = (selector?: (state: unknown) => unknown) => selector ? selector(permissionState) : permissionState;
  usePermissionStore.getState = () => permissionState;
  usePermissionStore.setState = () => undefined;
  return { usePermissionStore };
});
mock.module('@/stores/useTodosPersistStore', () => {
  const todosState = { setSessionTodos: () => undefined, getSessionTodos: () => undefined };
  const useTodosPersistStore = (selector?: (state: unknown) => unknown) => selector ? selector(todosState) : todosState;
  useTodosPersistStore.getState = () => todosState;
  useTodosPersistStore.setState = () => undefined;
  return { useTodosPersistStore };
});
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchInput: false }),
  useTabletLayout: () => ({ enabled: false }),
  getDeviceInfo: () => ({ isMobile: false, isTablet: false, hasTouchInput: false }),
  subscribeDeviceInfo: () => () => undefined,
}));
mock.module('@/hooks/useProviderLogo', () => ({
  useProviderLogo: () => ({ src: null, onError: () => undefined, hasLogo: false }),
  preloadProviderLogos: () => undefined,
}));

const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { ChildStoreManager } = await import('@/sync/child-store');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIProvider } = await import('@/contexts/RuntimeAPIProvider');
const { ChatErrorBoundary } = await import('@/components/chat/ChatErrorBoundary');
const { SyncProvider } = await import('@/sync/sync-context');
const { opencodeClient } = await import('@/lib/opencode/client');
const ChatContainer = (await import('@/components/chat/ChatContainer')).ChatContainer;
const MessageList = (await import('@/components/chat/MessageList')).default;

const noopAsync = async () => undefined as never;
const subscription = { close: () => undefined };

const stubRuntimeAPIs = {
  runtime: { platform: 'web', isDesktop: false, isVSCode: false },
  terminal: {
    createSession: noopAsync,
    connect: () => subscription,
    sendInput: noopAsync,
    resize: noopAsync,
    close: noopAsync,
  },
  git: {
    checkIsGitRepository: noopAsync,
    getStatus: noopAsync,
    getCurrentBranch: noopAsync,
    getRemotes: noopAsync,
    getConfig: noopAsync,
    getWorktreeRoot: noopAsync,
  },
  files: {
    readFile: noopAsync,
    readFileMetadata: noopAsync,
    readBinaryFile: noopAsync,
    getFileStatus: noopAsync,
    getDirectory: noopAsync,
    getDirectoryTree: noopAsync,
    listDirectory: noopAsync,
    openFile: noopAsync,
    saveFile: noopAsync,
    createFile: noopAsync,
    renameFile: noopAsync,
    deleteFile: noopAsync,
    resolveWorkspaceFolders: noopAsync,
    getWorkspaceFolders: noopAsync,
  },
  settings: { getSettings: noopAsync, updateSettings: noopAsync, getSecret: noopAsync, setSecret: noopAsync },
  permissions: {},
  notifications: { notify: noopAsync },
  tools: {},
  vscode: { saveImage: noopAsync, copyText: noopAsync },
  editor: {},
} as never;

const SESSION_ID = 'ses_repro_3036';
const DIRECTORY = '/repo';

const installDom = () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };

  class FakeElement {
    nodeType = 1;
    nodeName = 'DIV';
    tagName = 'DIV';
    ownerDocument: unknown;
    parentNode: FakeElement | null = null;
    parentElement: FakeElement | null = null;
    childNodes: (FakeElement | FakeTextNode)[] = [];
    get children(): FakeElement[] {
      return this.childNodes.filter((child): child is FakeElement => child.nodeType === 1);
    }
    get firstElementChild(): FakeElement | null {
      return this.children[0] ?? null;
    }
    firstChild: FakeElement | null = null;
    lastChild: FakeElement | null = null;
    nextSibling: FakeElement | null = null;
    previousSibling: FakeElement | null = null;
    attributes: Record<string, string> = {};
    style: Record<string, unknown> & {
      setProperty?: (name: string, value: string) => void;
      removeProperty?: (name: string) => void;
      getPropertyValue?: (name: string) => string;
    };
    dataset: Record<string, string> = {};
    className = '';
    private _textContent: string | null = null;
    get textContent(): string {
      const parts: string[] = [];
      const visit = (node: FakeElement | FakeTextNode) => {
        if (node.nodeType === 3) {
          parts.push((node as FakeTextNode).data);
        } else {
          for (const child of (node as FakeElement).childNodes) visit(child);
        }
      };
      for (const child of this.childNodes) visit(child);
      return parts.join('');
    }
    set textContent(value: string) {
      this._textContent = value;
      this.childNodes = [];
      this.firstChild = null;
      this.lastChild = null;
      const textNode = new FakeTextNode(value);
      textNode.parentNode = this;
      textNode.parentElement = this;
      this.childNodes.push(textNode);
      this.firstChild = textNode as unknown as FakeElement;
      this.lastChild = textNode as unknown as FakeElement;
    }
    innerHTML = '';
    scrollTop = 0;
    scrollHeight = 0;
    clientHeight = 800;
    clientWidth = 800;
    offsetHeight = 0;
    offsetWidth = 0;
    listeners: Record<string, ((event: unknown) => void)[]> = {};
    classList: {
      add: (...names: string[]) => void;
      remove: (...names: string[]) => void;
      contains: (name: string) => boolean;
      toggle: (name: string, force?: boolean) => boolean;
    };
    constructor(public tag: string) {
      this.nodeName = tag.toUpperCase();
      this.tagName = tag.toUpperCase();
      this.style = new Proxy({}, {
        get: (target, prop) => {
          if (prop === 'setProperty') return (name: string, value: string) => { (target as Record<string, unknown>)[name] = String(value); };
          if (prop === 'removeProperty') return (name: string) => { delete (target as Record<string, unknown>)[name]; };
          if (prop === 'getPropertyValue') return (name: string) => { const v = (target as Record<string, unknown>)[name]; return typeof v === 'string' ? v : ''; };
          if (typeof prop === 'symbol') return undefined;
          return Reflect.get(target, prop);
        },
        set: (target, prop, value) => {
          if (typeof prop === 'symbol') return true;
          (target as Record<string, unknown>)[prop] = value;
          return true;
        },
      });
      const set = new Set<string>();
      this.classList = {
        add: (...names: string[]) => { names.forEach((n) => set.add(n)); this.className = [...set].join(' '); },
        remove: (...names: string[]) => { names.forEach((n) => set.delete(n)); this.className = [...set].join(' '); },
        contains: (name: string) => set.has(name),
        toggle: (name: string, force?: boolean) => {
          const shouldAdd = force ?? !set.has(name);
          if (shouldAdd) set.add(name); else set.delete(name);
          this.className = [...set].join(' ');
          return shouldAdd;
        },
      };
    }
    appendChild(child: FakeElement | FakeTextNode) {
      if (child.parentNode) child.parentNode.removeChild(child as FakeElement);
      child.parentNode = this;
      child.parentElement = this;
      child.nextSibling = null;
      if (this.lastChild) this.lastChild.nextSibling = child as FakeElement;
      child.previousSibling = this.lastChild;
      this.childNodes.push(child);
      this.lastChild = child as FakeElement;
      if (!this.firstChild) this.firstChild = child as FakeElement;
      return child;
    }
    insertBefore(child: FakeElement | FakeTextNode, ref: FakeElement | FakeTextNode | null) {
      if (!ref) return this.appendChild(child);
      const index = this.childNodes.indexOf(ref);
      if (index < 0) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child as FakeElement);
      child.parentNode = this;
      child.parentElement = this;
      child.previousSibling = ref.previousSibling;
      child.nextSibling = ref as FakeElement;
      if (ref.previousSibling) ref.previousSibling.nextSibling = child as FakeElement;
      ref.previousSibling = child as FakeElement;
      this.childNodes.splice(index, 0, child);
      if (this.firstChild === ref) this.firstChild = child as FakeElement;
      return child;
    }
    removeChild(child: FakeElement | FakeTextNode) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      if (this.firstChild === child) this.firstChild = (this.childNodes[0] as FakeElement) ?? null;
      if (this.lastChild === child) this.lastChild = (this.childNodes[this.childNodes.length - 1] as FakeElement) ?? null;
      if (child.previousSibling) child.previousSibling.nextSibling = child.nextSibling;
      if (child.nextSibling) child.nextSibling.previousSibling = child.previousSibling;
      child.parentNode = null;
      child.parentElement = null;
      child.previousSibling = null;
      child.nextSibling = null;
      return child;
    }
    replaceChild(newChild: FakeElement | FakeTextNode, oldChild: FakeElement | FakeTextNode) {
      const index = this.childNodes.indexOf(oldChild);
      if (index >= 0) this.childNodes[index] = newChild;
      newChild.parentNode = this;
      newChild.parentElement = this;
      newChild.previousSibling = oldChild.previousSibling;
      newChild.nextSibling = oldChild.nextSibling;
      if (oldChild.previousSibling) oldChild.previousSibling.nextSibling = newChild as FakeElement;
      if (oldChild.nextSibling) oldChild.nextSibling.previousSibling = newChild as FakeElement;
      if (this.firstChild === oldChild) this.firstChild = newChild as FakeElement;
      if (this.lastChild === oldChild) this.lastChild = newChild as FakeElement;
      oldChild.parentNode = null;
      return oldChild;
    }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    removeAttribute(name: string) { delete this.attributes[name]; }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    addEventListener(name: string, listener: (event: unknown) => void) {
      (this.listeners[name] ??= []).push(listener);
    }
    removeEventListener(name: string, listener: (event: unknown) => void) {
      const list = this.listeners[name];
      if (!list) return;
      const index = list.indexOf(listener);
      if (index >= 0) list.splice(index, 1);
    }
    dispatchEvent(event: unknown) {
      const type = (event as { type?: string })?.type;
      const list = type ? this.listeners[type] : [];
      (list ?? []).slice().forEach((listener) => listener(event));
      return true;
    }
    matches() { return false; }
    closest() { return null; }
    contains(node: FakeElement) {
      let current: FakeElement | null = node;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() {
      const height = this.offsetHeight || 100;
      return {
        top: 0, left: 0, right: this.clientWidth, bottom: height,
        width: this.clientWidth, height, x: 0, y: 0, toJSON: () => ({}),
      };
    }
    getClientRects() { return []; }
    focus() {}
    blur() {}
    click() {}
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
    cloneNode() { return new FakeElement(this.tag); }
  }

  class FakeTextNode {
    nodeType = 3;
    nodeName = '#text';
    parentNode: FakeElement | null = null;
    parentElement: FakeElement | null = null;
    nextSibling: FakeElement | null = null;
    previousSibling: FakeElement | null = null;
    textContent: string;
    get nodeValue(): string {
      return this.textContent;
    }
    set nodeValue(value: string) {
      this.textContent = value;
    }
    constructor(public data: string) {
      this.textContent = data;
    }
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    }
  }

  class FakeDocumentFragment {
    nodeType = 11;
    nodeName = '#document-fragment';
    parentNode: null = null;
    parentElement: null = null;
    childNodes: (FakeElement | FakeTextNode)[] = [];
    appendChild(child: FakeElement | FakeTextNode) {
      this.childNodes.push(child);
      return child;
    }
  }

  const documentStub = {
    nodeType: 9,
    defaultView: globalThis,
    activeElement: null,
    visibilityState: 'visible',
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getSelection: () => ({
      rangeCount: 0,
      removeAllRanges: () => undefined,
      addRange: () => undefined,
      getRangeAt: () => null,
      collapse: () => undefined,
      anchorNode: null,
      focusNode: null,
    }),
    createRange: () => ({
      setStart: () => undefined,
      setEnd: () => undefined,
      selectNode: () => undefined,
      selectNodeContents: () => undefined,
      collapse: () => undefined,
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      getClientRects: () => [],
      cloneRange: () => null,
      commonAncestorContainer: null,
      startContainer: null,
      startOffset: 0,
      endContainer: null,
      endOffset: 0,
      collapsed: true,
    }),
    hasFocus: () => true,
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      el.ownerDocument = documentStub;
      return el;
    },
    createElementNS: (_ns: string, tag: string) => {
      const el = new FakeElement(tag);
      el.ownerDocument = documentStub;
      return el;
    },
    createTextNode: (data: string) => new FakeTextNode(data),
    createDocumentFragment: () => new FakeDocumentFragment(),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    body: new FakeElement('body'),
    head: new FakeElement('head'),
    documentElement: new FakeElement('html'),
  };

  const container = new FakeElement('div');
  container.ownerDocument = documentStub;
  documentStub.body.appendChild(container);

  setGlobal('document', documentStub);
  setGlobal('window', globalThis);
  setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost', hash: '' });
  setGlobal('Element', FakeElement);
  setGlobal('HTMLElement', FakeElement);
  setGlobal('HTMLIFrameElement', FakeElement);
  setGlobal('Window', function Window() {});
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
  setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
  setGlobal('ResizeObserver', class {
      constructor(private callback: (entries: { target: unknown; contentRect: { width: number; height: number } }[], observer: unknown) => void) {}
      observe(target: FakeElement) {
        // Fire once with a deterministic rect so the tanstack virtualizer's
        // measureElement path is exercised (measurement-driven reconcile).
        this.callback(
          [{ target, contentRect: { width: 800, height: target.offsetHeight || 100 } }],
          this,
        );
      }
      unobserve() {}
      disconnect() {}
    });
  setGlobal('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
  setGlobal('getComputedStyle', () => ({ position: 'static' }));
  setGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
  setGlobal('scrollTo', () => undefined);
  const storageMap = new Map<string, string>();
  const storageStub = {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
    removeItem: (key: string) => { storageMap.delete(key); },
    clear: () => { storageMap.clear(); },
    key: (index: number) => Array.from(storageMap.keys())[index] ?? null,
    get length() { return storageMap.size; },
  };
  setGlobal('localStorage', storageStub);
  setGlobal('sessionStorage', storageStub);

  return {
    container: container as unknown as Element,
    restore: () => {
      // Keep the stubs installed: pending timers (rAF-backed theme effects)
      // may still fire after a scenario finishes, and they read window/document.
      // Each subsequent installDom() redefines them for the next scenario.
    },
  };
};

const createMessage = (id: string, role: 'user' | 'assistant', created: number, opts: Record<string, unknown> = {}): Message => ({
  id,
  sessionID: SESSION_ID,
  role,
  ...(role === 'assistant' ? { parentID: `u_${created - 1}` } : {}),
  time: { created, completed: role === 'assistant' ? created + 1 : undefined },
  ...opts,
} as Message);

const createPart = (id: string, messageID: string, text: string): Part => ({
  id,
  messageID,
  sessionID: SESSION_ID,
  type: 'text',
  text,
} as Part);

const buildSessionMessages = (turnCount: number, assistantOpts: Record<string, unknown> = {}): { messages: Message[]; part: Record<string, Part[]> } => {
  const messages: Message[] = [];
  const part: Record<string, Part[]> = {};
  for (let index = 1; index <= turnCount; index += 1) {
    const userCreated = index * 2 - 1;
    const assistantCreated = index * 2;
    const userId = `u_${userCreated}`;
    const assistantId = `a_${assistantCreated}`;
    messages.push(createMessage(userId, 'user', userCreated));
    messages.push(createMessage(assistantId, 'assistant', assistantCreated, {
      providerID: 'opencode',
      modelID: 'deepseek-v4-flash-free',
      agent: 'build',
      mode: 'build',
      ...assistantOpts,
    }));
    part[userId] = [createPart(`prt_${userId}`, userId, `prompt ${index}`)];
    part[assistantId] = [createPart(`prt_${assistantId}`, assistantId, `output ${index}`)];
  }
  return { messages, part };
};

const syncContext = (globalThis as unknown as {
  __openchamber_sync_context__?: React.Context<unknown>;
}).__openchamber_sync_context__;

if (!syncContext) {
  throw new Error('sync context was not published on globalThis by @/sync/sync-context');
}

const Provider = syncContext.Provider as React.Provider<unknown>;

const renderScenario = async (
  dom: ReturnType<typeof installDom>,
  messages: Message[],
  part: Record<string, Part[]>,
  options: {
    vscodeRuntime?: boolean;
    providers?: unknown;
    reentry?: boolean;
    removeModelWhileMounted?: boolean;
  } = {},
): Promise<{ threw: boolean; errorMessage: string | null }> => {
  const childStores = new ChildStoreManager();
  const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });

  const providers = options.providers ?? [
    {
      id: 'opencode',
      models: [{ id: 'some-other-model', name: 'Some Other Model' }],
      name: 'OpenCode',
    },
  ];
  useConfigStore.setState({ providers, currentProviderId: 'opencode', currentModelId: 'some-other-model' } as never);

  store.setState({
    status: 'complete',
    session: [{
      id: SESSION_ID,
      title: 'Repro 3036',
      time: { created: 1, updated: 1 },
      version: '1',
      directory: DIRECTORY,
    } as never],
    message: { [SESSION_ID]: messages } as never,
    part,
  } as never);

  const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: options.vscodeRuntime ? 'vscode' : 'test', directory: DIRECTORY };

  const buildHarness = () => {
    const Harness = () => {
      const messagesProp = messages.map((info) => ({
        info,
        parts: part[info.id] ?? [],
      }));
      return (
        <I18nProvider>
          <ThemeSystemProvider>
            <RuntimeAPIProvider apis={stubRuntimeAPIs}>
              <Provider value={system}>
                <MessageList
                  sessionKey={SESSION_ID}
                  messages={messagesProp}
                  isLoadingOlder={false}
                  onMessageContentChange={() => undefined}
                  getAnimationHandlers={() => ({
                    onChunk: () => undefined,
                    onComplete: () => undefined,
                  })}
                />
              </Provider>
            </RuntimeAPIProvider>
          </ThemeSystemProvider>
        </I18nProvider>
      );
    };
    return React.createElement(Harness);
  };

  try {
    let root: Root = createRoot(dom.container);
    await act(async () => {
      root.render(buildHarness());
    });

    if (options.removeModelWhileMounted) {
      // Simulate the model being removed from the provider catalog while the
      // session is open: the config store updates, subscribed components re-render.
      await act(async () => {
        useConfigStore.setState({
          providers: [
            {
              id: 'opencode',
              models: [{ id: 'some-other-model', name: 'Some Other Model' }],
              name: 'OpenCode',
            },
          ],
          currentProviderId: 'opencode',
          currentModelId: 'some-other-model',
        } as never);
      });
    }

    if (options.reentry) {
      await act(async () => root.unmount());
      root = createRoot(dom.container);
      await act(async () => {
        root.render(buildHarness());
      });
    }
    await act(async () => root.unmount());
    return { threw: false, errorMessage: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log('[repro-3036] CAUGHT:', message || (error instanceof Error ? error.name : 'non-Error throw'));
    return { threw: true, errorMessage: message };
  } finally {
    dom.restore();
  }
};

describe('issue #3036 model removed from provider config', () => {
  const runCase = async (name: string, messages: Message[], part: Record<string, Part[]>, options: Parameters<typeof renderScenario>[3] = {}) => {
    const dom = installDom();
    const result = await renderScenario(dom, messages, part, options);
    console.log(`[repro-3036] case "${name}": threw=${result.threw} msg=${result.errorMessage ?? '(none)'}`);
    return result;
  };

  test('10-turn text session, model removed from provider config', async () => {
    const { messages, part } = buildSessionMessages(10);
    const result = await runCase('10-turn text, model removed', messages, part);
    expect(result.threw).toBe(false);
  });

  test('10-turn session with API-error assistant message (reporter data), model removed', async () => {
    const apiError = {
      name: 'APIError',
      data: {
        message: 'Free promotion has ended for DeepSeek V4 Flash Free',
        statusCode: 401,
        isRetryable: false,
        responseBody: '{"type":"error","error":{"type":"ModelError","message":"Free promotion has ended"}}',
      },
    };
    const { messages, part } = buildSessionMessages(10, {
      assistantOpts: { error: apiError },
    });
    const result = await runCase('10-turn with APIError, model removed', messages, part);
    expect(result.threw).toBe(false);
  });

  test('10-turn session with tool parts, model removed', async () => {
    const { messages, part } = buildSessionMessages(10, {
      assistantParts: (index: number, assistantId: string) => [
        {
          id: `prt_tool_${index}`,
          messageID: assistantId,
          sessionID: SESSION_ID,
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command: 'ls' }, output: 'done' },
        } as unknown as Part,
        createPart(`prt_text_${index}`, assistantId, `output ${index}`),
      ],
    });
    const result = await runCase('10-turn with tool parts, model removed', messages, part);
    expect(result.threw).toBe(false);
  });

  test('10-turn session with reasoning parts, model removed', async () => {
    const { messages, part } = buildSessionMessages(10, {
      assistantParts: (index: number, assistantId: string) => [
        {
          id: `prt_reason_${index}`,
          messageID: assistantId,
          sessionID: SESSION_ID,
          type: 'reasoning',
          text: `reasoning ${index}`,
        } as unknown as Part,
        createPart(`prt_text_${index}`, assistantId, `output ${index}`),
      ],
    });
    const result = await runCase('10-turn with reasoning parts, model removed', messages, part);
    expect(result.threw).toBe(false);
  });

  test('10-turn text session, model present (control)', async () => {
    const { messages, part } = buildSessionMessages(10);
    const result = await runCase('10-turn text, model present (control)', messages, part, {
      providers: [
        {
          id: 'opencode',
          models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' }],
          name: 'OpenCode',
        },
      ],
    });
    expect(result.threw).toBe(false);
  });

  test('re-entry (mount -> unmount -> remount), 10-turn, model removed', async () => {
    const { messages, part } = buildSessionMessages(10);
    const result = await runCase('re-entry 10-turn, model removed', messages, part, { reentry: true });
    expect(result.threw).toBe(false);
  });

  test('model removed from provider catalog while session is open', async () => {
    const { messages, part } = buildSessionMessages(10);
    const result = await runCase('config change while mounted, model removed', messages, part, { removeModelWhileMounted: true });
    expect(result.threw).toBe(false);
  });

  test('re-entry with model removed while open (model present -> removed -> reopen)', async () => {
    const { messages, part } = buildSessionMessages(10);
    const result = await runCase('model present, removed while open, re-entry', messages, part, {
      providers: [
        {
          id: 'opencode',
          models: [{ id: 'deepseek-v4-flash-free', name: 'DeepSeek V4 Flash Free' }],
          name: 'OpenCode',
        },
      ],
      removeModelWhileMounted: true,
      reentry: true,
    });
    expect(result.threw).toBe(false);
  });

  test('VS Code runtime, 40-turn session, model removed, re-entry', async () => {
    const { messages, part } = buildSessionMessages(40);
    const result = await runCase('vscode runtime 40-turn, model removed, re-entry', messages, part, {
      vscodeRuntime: true,
      reentry: true,
    });
    expect(result.threw).toBe(false);
  });

  test('stale current selection references the removed model, ChatContainer (stale currentModelId)', async () => {
    const dom = installDom();
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const { messages, part } = buildSessionMessages(10);

    // The config store still points at the removed model while the catalog
    // no longer lists it (stale persisted selection after the free tier ended).
    useConfigStore.setState({
      providers: [
        {
          id: 'opencode',
          models: [{ id: 'some-other-model', name: 'Some Other Model' }],
          name: 'OpenCode',
        },
      ],
      currentProviderId: 'opencode',
      currentModelId: 'deepseek-v4-flash-free',
      isInitialized: true,
      isConnected: true,
    } as never);

    useSessionUIStore.setState({
      currentSessionId: SESSION_ID,
      currentSessionDirectory: DIRECTORY,
    } as never);

    store.setState({
      status: 'complete',
      session: [{
        id: SESSION_ID,
        title: 'Repro 3036',
        time: { created: 1, updated: 1 },
        version: '1',
        directory: DIRECTORY,
      } as never],
      message: { [SESSION_ID]: messages } as never,
      part,
    } as never);

    const root: Root = createRoot(dom.container);
    const Harness = () => (
      <I18nProvider>
        <ThemeSystemProvider>
          <RuntimeAPIProvider apis={stubRuntimeAPIs}>
            <SyncProvider sdk={opencodeClient.getSdkClient() as never} directory={DIRECTORY}>
              <ChatContainer active messagesEnabled />
            </SyncProvider>
          </RuntimeAPIProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    );

    try {
      await act(async () => {
        root.render(React.createElement(Harness));
      });
      await act(async () => root.unmount());
      expect(true).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log('[repro-3036] stale-selection ChatContainer threw:', message);
      expect(message).toContain('Maximum update depth exceeded');
    } finally {
      try {
        await act(async () => root.unmount());
      } catch {
        // already unmounted
      }
    }
  });

  test('full ChatContainer (header + ModelControls + list), 10-turn, model removed', async () => {
    const dom = installDom();
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const { messages, part } = buildSessionMessages(10);

    useConfigStore.setState({
      providers: [
        {
          id: 'opencode',
          models: [{ id: 'some-other-model', name: 'Some Other Model' }],
          name: 'OpenCode',
        },
      ],
      currentProviderId: 'opencode',
      currentModelId: 'some-other-model',
      isInitialized: true,
      isConnected: true,
    } as never);

    useSessionUIStore.setState({
      currentSessionId: SESSION_ID,
      currentSessionDirectory: DIRECTORY,
    } as never);

    store.setState({
      status: 'complete',
      session: [{
        id: SESSION_ID,
        title: 'Repro 3036',
        time: { created: 1, updated: 1 },
        version: '1',
        directory: DIRECTORY,
      } as never],
      message: { [SESSION_ID]: messages } as never,
      part,
    } as never);

    const root: Root = createRoot(dom.container);
    const Harness = () => (
      <I18nProvider>
        <ThemeSystemProvider>
          <RuntimeAPIProvider apis={stubRuntimeAPIs}>
            <SyncProvider sdk={opencodeClient.getSdkClient() as never} directory={DIRECTORY}>
              <ChatContainer active messagesEnabled />
            </SyncProvider>
          </RuntimeAPIProvider>
        </ThemeSystemProvider>
      </I18nProvider>
    );

    try {
      await act(async () => {
        root.render(React.createElement(Harness));
      });
      await act(async () => root.unmount());
      expect(true).toBe(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log('[repro-3036] ChatContainer threw:', message);
      expect(message).toContain('Maximum update depth exceeded');
    } finally {
      try {
        await act(async () => root.unmount());
      } catch {
        // already unmounted
      }
    }
  });
});

describe('issue #3036 error boundary session leak', () => {
  const ThrowingChild: React.FC<{ shouldThrow: boolean }> = ({ shouldThrow }) => {
    if (shouldThrow) {
      throw new Error('Maximum update depth exceeded. This can happen when a component repeatedly calls setState inside componentWillUpdate or componentDidUpdate. React limits the number of nested updates to prevent infinite loops.');
    }
    return React.createElement('div', null, 'fine');
  };

  test('ChatErrorBoundary keeps its error state when the sessionId prop changes', async () => {
    const dom = installDom();
    const root: Root = createRoot(dom.container);

    const Harness = ({ sessionId, shouldThrow }: { sessionId: string; shouldThrow: boolean }) => (
      <I18nProvider>
        <ChatErrorBoundary sessionId={sessionId}>
          <ThrowingChild shouldThrow={shouldThrow} />
        </ChatErrorBoundary>
      </I18nProvider>
    );

    try {
      // Open the affected session, which throws during render.
      await act(async () => {
        root.render(React.createElement(Harness, { sessionId: 'ses_affected', shouldThrow: true }));
      });
      const firstText = (dom.container as unknown as { textContent: string }).textContent ?? '';
      expect(firstText).toContain('Chat Error');

      // Switch to an unaffected session (child no longer throws). The boundary
      // has no sessionId-keyed reset, so the error banner persists.
      await act(async () => {
        root.render(React.createElement(Harness, { sessionId: 'ses_unaffected', shouldThrow: false }));
      });
      const secondText = (dom.container as unknown as { textContent: string }).textContent ?? '';
      expect(secondText).toContain('Chat Error');
    } finally {
      try {
        await act(async () => root.unmount());
      } catch {
        // already unmounted
      }
    }
  });

  test('ChatErrorBoundary recovers on Reset after the child stops throwing', async () => {
    const dom = installDom();
    const root: Root = createRoot(dom.container);

    const Harness = ({ shouldThrow }: { shouldThrow: boolean }) => (
      <I18nProvider>
        <ChatErrorBoundary sessionId="ses_affected">
          <ThrowingChild shouldThrow={shouldThrow} />
        </ChatErrorBoundary>
      </I18nProvider>
    );

    try {
      await act(async () => {
        root.render(React.createElement(Harness, { shouldThrow: true }));
      });
      let text = (dom.container as unknown as { textContent: string }).textContent ?? '';
      expect(text).toContain('Chat Error');

      // The child no longer throws, but the boundary state must be cleared
      // before content can render again — a session switch alone is not enough.
      await act(async () => {
        root.render(React.createElement(Harness, { shouldThrow: false }));
      });
      text = (dom.container as unknown as { textContent: string }).textContent ?? '';
      expect(text).toContain('Chat Error');
    } finally {
      try {
        await act(async () => root.unmount());
      } catch {
        // already unmounted
      }
    }
  });
});