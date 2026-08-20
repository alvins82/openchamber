/**
 * Reproduction test for https://github.com/openchamber/openchamber/issues/3023
 *
 * "Reduce or remove flickering when updating the file being displayed"
 *
 * Flicker mechanism #4 from the issue: `useWorkerHighlightedLines` resets its
 * result to `null` on every `code`/`language` change, then re-runs the worker
 * highlight. The `DiffPreview`/`WritePreview` components consume this and render
 * plain unhighlighted text whenever `highlighted` is null, so every streamed
 * update (a write tool's partial file content, a permission-card preview) first
 * flashes the unhighlighted text and only repaints highlighted once the worker
 * round-trips. This test demonstrates that the hook returns `null` (the
 * "plain-text fallback" state) on every update rather than keeping the previous
 * highlight while the new one computes.
 */
import { describe, expect, mock, test } from 'bun:test';
import { act } from 'react';

// Deterministic worker resolution so we can observe the null window between
// updates regardless of the real Shiki worker's timing.
let highlightCalls = 0;
const highlightLinesInWorkerMock = mock(async (code: string, lang: string) => {
  highlightCalls += 1;
  await Promise.resolve();
  return code.split('\n').map((line, i) => `<span class="hl">${i}:${line}</span>`);
});

mock.module('@/components/chat/markdown/markdown-worker', () => ({
  highlightLinesInWorker: highlightLinesInWorkerMock,
  highlightCodeInWorker: mock(async () => null),
  highlightTokensInWorker: mock(async () => null),
}));

const { useWorkerHighlightedLines } = await import('./useWorkerHighlightedLines');

describe('issue #3023 highlight flash during file updates', () => {
  test('useWorkerHighlightedLines returns null (plain-text fallback) on every code update', async () => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    type Root = ReturnType<typeof createRoot>;

    // Minimal DOM stubs so react-dom/client can render a functional component.
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
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('HTMLFrameSetElement', ElementStub);
    setGlobal('HTMLInputElement', ElementStub);
    setGlobal('HTMLTextAreaElement', ElementStub);
    setGlobal('HTMLSelectElement', ElementStub);
    setGlobal('HTMLOptionElement', ElementStub);
    setGlobal('HTMLAnchorElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0));
    setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));

    try {
      const observed: Array<{ code: string; lines: string[] | null }> = [];
      let code = 'const x = 1;';

      const Harness: React.FC = () => {
        const lines = useWorkerHighlightedLines(code, 'typescript');
        observed.push({ code, lines });
        return null;
      };

      const root: Root = createRoot(container as unknown as Element);
      const render = () => root.render(React.createElement(Harness));

      // First render: cold start, no previous highlight yet.
      await act(async () => { render(); });
      await act(async () => { await Promise.resolve(); });

      // Second update: file content changes (as it does on each streamed write).
      code = 'const x = 2;';
      await act(async () => { render(); });

      // The hook reset `lines` to null on the code change BEFORE the worker
      // round-trip resolves. This is the unhighlighted plain-text flash window.
      const nullWindow = observed.some((o) => o.code === 'const x = 2;' && o.lines === null);
      expect(nullWindow).toBe(true);

      // Highlight eventually repaints.
      await act(async () => { await Promise.resolve(); });
      const final = observed[observed.length - 1];
      expect(final.lines).not.toBeNull();
      expect(final.lines![0]).toContain('const x = 2;');

      // Demonstrates the flash: the previous highlight for the old content was
      // discarded, and the new content rendered plain text before repainting.
      expect(highlightCalls).toBeGreaterThanOrEqual(2);
    } finally {
      await act(async () => { /* unmount */ });
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
