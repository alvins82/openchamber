/**
 * DOM preload for the issue-2804 reproduction test.
 *
 * Every other test in this package renders with `react-dom/server`, which never
 * runs effects. This reproduction needs effects: the bug only appears when
 * `renderedSections` transitions to 0 through the presence reports that fire
 * when sections mount and unmount. Register happy-dom's browser globals so
 * `react-dom/client` can mount the real `WorkStatusPanel`.
 *
 * `installDomGlobals` is idempotent and `restoreDomGlobals` puts every global
 * back the way it was, so the test file can clean up after itself in
 * `afterAll`. Without that, files sharing the worker process would see
 * `HTMLElement`/`document` etc. defined and misbehave (e.g.
 * `@pierre/diffs` registers a custom element when `HTMLElement` exists).
 */
import { Window } from 'happy-dom';

const window = new Window({
  url: 'http://localhost/',
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
  },
});

const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'location',
  'history',
  'HTMLElement',
  'HTMLDivElement',
  'HTMLButtonElement',
  'HTMLSpanElement',
  'HTMLParagraphElement',
  'HTMLAnchorElement',
  'HTMLBodyElement',
  'HTMLStyleElement',
  'Element',
  'Node',
  'Text',
  'Comment',
  'Document',
  'DocumentFragment',
  'NodeList',
  'HTMLCollection',
  'NamedNodeMap',
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'PointerEvent',
  'UIEvent',
  'FocusEvent',
  'MutationObserver',
  'ResizeObserver',
  'IntersectionObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'performance',
  'matchMedia',
  'getSelection',
  'localStorage',
  'sessionStorage',
  'CSS',
  'DOMParser',
  'XMLSerializer',
  'Image',
  'Blob',
  'File',
  'FormData',
  'Headers',
  'Request',
  'Response',
] as const;

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

const saveDescriptor = (key: string) => {
  if (originalDescriptors.has(key)) return;
  originalDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
};

/** Register happy-dom browser globals on `globalThis`. Idempotent. */
export const installDomGlobals = (): void => {
  for (const key of BROWSER_GLOBALS) {
    saveDescriptor(key);
    const value = (window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      (globalThis as unknown as Record<string, unknown>)[key] = value;
    }
  }
  saveDescriptor('IS_REACT_ACT_ENVIRONMENT');
  (globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  // happy-dom provides these, but keep hard fallbacks in case a future version
  // stops exposing them on the Window instance.
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    saveDescriptor('requestAnimationFrame');
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0)) as unknown as typeof requestAnimationFrame;
  }
  if (typeof globalThis.cancelAnimationFrame !== 'function') {
    saveDescriptor('cancelAnimationFrame');
    globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id)) as unknown as typeof cancelAnimationFrame;
  }
};

/** Undo every global mutation `installDomGlobals` made. */
export const restoreDomGlobals = (): void => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, name);
    }
  }
  originalDescriptors.clear();
};

installDomGlobals();
