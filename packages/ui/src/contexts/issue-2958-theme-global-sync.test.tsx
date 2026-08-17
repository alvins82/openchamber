/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2958
 *
 * Reported bug: in OpenChamber Desktop, changing the theme in Settings →
 * Appearance in one instance window changes the theme in ALL instance windows
 * (local desktop, remote laptop, remote WSL), even though other settings stay
 * instance-specific. Expected: theme scoped per instance/connection.
 *
 * Root cause demonstrated here: every Electron window shares one origin and
 * therefore one `localStorage`. The theme preference is persisted to *flat*,
 * runtime-agnostic keys — `themeMode`, `lightThemeId`, `darkThemeId` — and
 * `ThemeSystemProvider` listens for cross-window `storage` events on exactly
 * those flat keys (`ThemeSystemContext.tsx` storage-sync effect) and adopts
 * whatever it reads from them. The per-runtime settings mirror that DOES exist
 * (`openchamber.settingsMirror.v2:<runtimeKey>`, written by
 * `persistRuntimeSettingsMirror`) is never consulted for this sync; only the
 * flat keys are.
 *
 * So a window connected to instance A (runtime key `local`) and a window
 * connected to instance B (runtime key `url:https://…`) share the same flat
 * keys: when the instance-B window changes its theme it writes those keys and
 * the instance-A window receives the `storage` event and switches theme too —
 * and then even persists the foreign theme into instance A's own settings.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DesktopSettings } from '@/lib/desktop';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The provider pushes theme changes into the shared desktop settings on every
// preference change. That write path needs a live runtime and is not part of
// this reproduction, so stub it and record the calls: we assert that the
// foreign theme even gets pushed to THIS instance's settings.
const updateDesktopSettingsCalls: Array<Partial<DesktopSettings>> = [];
mock.module('@/lib/persistence', () => ({
  updateDesktopSettings: async (changes: Partial<DesktopSettings>) => {
    updateDesktopSettingsCalls.push({ ...changes });
  },
}));

const { ThemeSystemProvider } = await import('./ThemeSystemContext');
const { useThemeSystem } = await import('./useThemeSystem');

// ── Minimal DOM stub (Bun's test runner provides no DOM) ─────────────────────

type Listener = (event: StorageEventLike) => void;

interface StorageEventLike {
  readonly type: string;
  readonly key: string | null;
  readonly storageArea: StorageArea | null;
  readonly newValue: string | null;
  readonly oldValue: string | null;
  readonly url: string;
}

interface StorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
  key(index: number): string | null;
  readonly length: number;
}

interface MediaQueryLike {
  readonly matches: boolean;
  readonly media: string;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

interface LocationLike {
  readonly search: string;
  readonly href: string;
  readonly origin: string;
  readonly protocol: string;
  readonly hostname: string;
}

interface FakeClassList {
  add(...names: string[]): void;
  remove(...names: string[]): void;
  contains(name: string): boolean;
  toggle(name: string, force?: boolean): boolean;
}

interface FakeElement {
  readonly tagName: string;
  readonly nodeType: number;
  classList: FakeClassList;
  style: { backgroundColor: string };
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface FakeDocument {
  readonly nodeType: number;
  defaultView: typeof globalThis;
  documentElement: FakeElement;
  body: { style: { backgroundColor: string } };
  head: { appendChild(node: FakeElement): void };
  createElement(tag: string): FakeElement;
  getElementById(id: string): FakeElement | null;
  querySelector(selector: string): FakeElement | null;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  dispatchEvent(event: StorageEventLike): boolean;
}

interface FakeContainer {
  readonly nodeType: number;
  readonly tagName: string;
  readonly nodeName: string;
  readonly namespaceURI: string;
  ownerDocument: FakeDocument;
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

interface GlobalPatch {
  window: typeof globalThis;
  document: FakeDocument;
  localStorage: StorageArea;
  addEventListener: (type: string, listener: Listener) => void;
  removeEventListener: (type: string, listener: Listener) => void;
  dispatchEvent: (event: StorageEventLike) => boolean;
  location: LocationLike;
  matchMedia: (query: string) => MediaQueryLike;
  Element: new () => object;
  HTMLElement: new () => object;
  HTMLIFrameElement: new () => object;
  IS_REACT_ACT_ENVIRONMENT: boolean;
  requestAnimationFrame: (callback: (time: number) => void) => ReturnType<typeof setTimeout>;
  cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => void;
  fetch: typeof globalThis.fetch;
}

interface CapturedTheme {
  mode?: string;
  themeId?: string;
  variant?: string;
}

type RuntimeGlobalThis = typeof globalThis & {
  __OPENCHAMBER_API_BASE_URL__?: string;
  __OPENCHAMBER_LOCAL_ORIGIN__?: string;
};

const installMinimalDom = () => {
  const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();

  const storage = new Map<string, string>();
  const localStorageStub: StorageArea = {
    getItem: (key: string): string | null => (storage.has(key) ? storage.get(key)! : null),
    setItem: (key: string, value: string): void => {
      storage.set(key, String(value));
    },
    removeItem: (key: string): void => {
      storage.delete(key);
    },
    clear: (): void => {
      storage.clear();
    },
    key: (index: number): string | null => Array.from(storage.keys())[index] ?? null,
    get length(): number {
      return storage.size;
    },
  };

  const listeners = new Map<string, Set<Listener>>();
  const addEventListener = (type: string, listener: Listener): void => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  };
  const removeEventListener = (type: string, listener: Listener): void => {
    listeners.get(type)?.delete(listener);
  };
  const dispatchEvent = (event: StorageEventLike): boolean => {
    for (const listener of listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  };

  const classes = new Set<string>();
  const classList: FakeClassList = {
    add: (...names: string[]): void => {
      names.forEach((name) => classes.add(name));
    },
    remove: (...names: string[]): void => {
      names.forEach((name) => classes.delete(name));
    },
    contains: (name: string): boolean => classes.has(name),
    toggle: (name: string, force?: boolean): boolean => {
      const shouldAdd = force ?? !classes.has(name);
      if (shouldAdd) classes.add(name);
      else classes.delete(name);
      return shouldAdd;
    },
  };

  const makeElement = (tag: string): FakeElement => ({
    tagName: tag.toUpperCase(),
    nodeType: 1,
    classList,
    style: { backgroundColor: '' },
    setAttribute: (): void => undefined,
    remove: (): void => undefined,
  });

  const documentStub: FakeDocument = {
    nodeType: 9,
    defaultView: globalThis,
    documentElement: makeElement('html'),
    body: { style: { backgroundColor: '' } },
    head: { appendChild: (): void => undefined },
    createElement: makeElement,
    getElementById: (): FakeElement | null => null,
    querySelector: (): FakeElement | null => null,
    addEventListener,
    removeEventListener,
    dispatchEvent,
  };

  const container: FakeContainer = {
    nodeType: 1,
    tagName: 'DIV',
    nodeName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: documentStub,
    addEventListener,
    removeEventListener,
  };

  const patch: GlobalPatch = {
    window: globalThis,
    document: documentStub,
    localStorage: localStorageStub,
    // Override Bun's own global emitter so `window.addEventListener(...)` (used
    // by ThemeSystemProvider) registers into the map `dispatchEvent` reads.
    addEventListener,
    removeEventListener,
    dispatchEvent,
    location: {
      search: '',
      href: 'http://localhost:8080/',
      origin: 'http://localhost:8080',
      protocol: 'http:',
      hostname: 'localhost',
    },
    matchMedia: (query: string): MediaQueryLike => ({
      matches: false,
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }),
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (callback: (time: number) => void): ReturnType<typeof setTimeout> =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>): void => clearTimeout(id),
    fetch: async () => new Response('{}', { status: 404 }),
  };

  const patchNames: Array<keyof GlobalPatch> = [
    'window',
    'document',
    'localStorage',
    'addEventListener',
    'removeEventListener',
    'dispatchEvent',
    'location',
    'matchMedia',
    'Element',
    'HTMLElement',
    'HTMLIFrameElement',
    'IS_REACT_ACT_ENVIRONMENT',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'fetch',
  ];
  for (const name of patchNames) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: patch[name] });
  }

  const restore = (): void => {
    for (const [name, descriptor] of savedDescriptors) {
      // Keep `window` defined (as globalThis) across restores: React's
      // scheduler reads `window.event` from a pending timer callback after
      // the test body finishes, and deleting it crashes the runner.
      if (name === 'window') continue;
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };

  return {
    localStorage: localStorageStub,
    // SAFETY: React's createRoot requires an `Element`, but the test mounts on
    // a stub that only implements the subset React touches (nodeType,
    // ownerDocument, event listeners) — same pattern as the other DOM-stub
    // tests in this repo. The stub is never used as a real DOM node.
    container: container as unknown as Element,
    dispatchEvent,
    restore,
  };
};

// ── Harness that captures the applied theme ─────────────────────────────────

const captured: CapturedTheme = {};
const Harness = () => {
  const { themeMode, currentTheme } = useThemeSystem();
  captured.mode = themeMode;
  captured.themeId = currentTheme.metadata.id;
  captured.variant = currentTheme.metadata.variant;
  return null;
};

const SETTINGS_MIRROR_PREFIX = 'openchamber.settingsMirror.v2:';

describe('issue 2958 — theme changes apply globally across instance windows', () => {
  let dom: ReturnType<typeof installMinimalDom>;
  let root: Root;

  beforeEach(() => {
    dom = installMinimalDom();
    updateDesktopSettingsCalls.length = 0;

    // SAFETY: the test deliberately runs as a desktop renderer window connected
    // to the LOCAL instance, so the injected runtime globals mirror what
    // Electron's preload script writes before the app boots (main.mjs
    // buildInitScript). Both point at the same loopback origin, which makes
    // getRuntimeKey() return 'local' for this window.
    const runtime = globalThis as RuntimeGlobalThis;
    runtime.__OPENCHAMBER_API_BASE_URL__ = 'http://localhost:8080';
    runtime.__OPENCHAMBER_LOCAL_ORIGIN__ = 'http://localhost:8080';
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root.unmount();
      });
    }
    dom.restore();
  });

  test('a theme change in a remote instance window flips the local window theme via the shared flat localStorage keys', async () => {
    // Local instance's own persisted appearance is dark (themeId openchamber-dark).
    dom.localStorage.setItem('themeMode', 'dark');
    dom.localStorage.setItem('lightThemeId', 'openchamber-light');
    dom.localStorage.setItem('darkThemeId', 'openchamber-dark');
    // Per-runtime mirror for THIS instance also says dark (as the instance's
    // settings would have been persisted by persistRuntimeSettingsMirror).
    dom.localStorage.setItem(
      `${SETTINGS_MIRROR_PREFIX}local`,
      JSON.stringify({ themeId: 'openchamber-dark', themeVariant: 'dark', useSystemTheme: false }),
    );

    root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(ThemeSystemProvider, null, React.createElement(Harness)),
      );
    });

    // Let the async effect work (custom-themes fetch, mocked settings write)
    // settle inside `act` so no state update lands outside it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(captured.variant).toBe('dark');
    expect(captured.themeId).toBe('openchamber-dark');

    // Simulate the OTHER window (connected to a remote instance, e.g.
    // url:https://laptop.example, sharing the same origin localStorage)
    // changing the theme to light: it writes the flat keys, which fires a
    // `storage` event in this window.
    act(() => {
      dom.localStorage.setItem('themeMode', 'light');
      dom.localStorage.setItem('lightThemeId', 'openchamber-light');
      dom.localStorage.setItem('darkThemeId', 'openchamber-dark');
      dom.dispatchEvent({
        type: 'storage',
        key: 'themeMode',
        storageArea: dom.localStorage,
        newValue: 'light',
        oldValue: 'dark',
        url: 'http://localhost:8080/',
      });
    });

    // BUG: this window's theme followed the remote window's change even though
    // this window is a different instance (runtime key `local` vs `url:…`).
    expect(captured.variant).toBe('light');
    expect(captured.themeId).toBe('openchamber-light');

    // The local instance's own persisted setting (per-runtime mirror) is
    // untouched — the leak came from the flat keys, not from this instance.
    // SAFETY: the value was written by this test two lines above as a
    // JSON.stringify of a known literal, so the parsed shape is trusted.
    const mirror = JSON.parse(dom.localStorage.getItem(`${SETTINGS_MIRROR_PREFIX}local`)!) as {
      themeId: string;
    };
    expect(mirror.themeId).toBe('openchamber-dark');

    // Worse: the provider pushed the foreign (remote) theme into THIS
    // instance's settings via updateDesktopSettings.
    expect(
      updateDesktopSettingsCalls.some((call) => call.themeId === 'openchamber-light' && call.themeVariant === 'light'),
    ).toBe(true);
  });

  test('a window that boots after the remote window changed theme starts with the remote theme (flat keys beat the per-runtime mirror)', async () => {
    // The remote window already switched the shared flat keys to light.
    dom.localStorage.setItem('themeMode', 'light');
    dom.localStorage.setItem('lightThemeId', 'openchamber-light');
    dom.localStorage.setItem('darkThemeId', 'openchamber-dark');
    // This (local) instance's own persisted appearance is still dark.
    dom.localStorage.setItem(
      `${SETTINGS_MIRROR_PREFIX}local`,
      JSON.stringify({ themeId: 'openchamber-dark', themeVariant: 'dark', useSystemTheme: false }),
    );

    root = createRoot(dom.container);
    await act(async () => {
      root.render(
        React.createElement(ThemeSystemProvider, null, React.createElement(Harness)),
      );
    });

    // Let the async effect work settle inside `act` (see first test).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The local window boots with the remote window's light theme instead of
    // its own persisted dark theme, because buildInitialPreferences reads the
    // flat keys and never consults the per-runtime mirror.
    expect(captured.variant).toBe('light');
    expect(captured.themeId).toBe('openchamber-light');
  });
});