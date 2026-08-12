/**
 * Reproduction for issue #2840: "Partial copy of an agent message loses
 * Markdown formatting (copies as plain text)".
 *
 * User-visible bug: selecting PART of an assistant reply and copying it —
 * via the in-app text-selection toolbar "Copy" button (or native Ctrl+C) —
 * puts plain text on the clipboard: `**bold**` becomes `bold`, list bullets
 * and heading `#` markers are gone.
 *
 * Root cause (confirmed in code):
 * - `TextSelectionMenu.tsx` `handleSelectionChange` computes Markdown for the
 *   selected range via `rangeToMarkdown` and stores it in
 *   `selectedTextMarkdown` (lines 205, 231), but `handleCopy` (line 330-340)
 *   ignores it and writes `copyTextToClipboard(selectedText)` — the plain-text
 *   selection only. The mobile bottom-bar Copy button reuses the same
 *   `handleCopy` (line 446), so both surfaces are affected.
 * - The full-message copy path (`ChatMessage.tsx` `handleCopyMessage`, line
 *   784) writes `text/markdown` + `text/plain` + `text/html` via
 *   `copyMarkdownToClipboard`, which is why full-message copy keeps Markdown
 *   while partial copy does not.
 *
 * This test exercises the REAL production functions (`rangeToMarkdown`,
 * `copyTextToClipboard`, `copyMarkdownToClipboard`) against a realistic
 * rendered-markdown DOM (marked output wrapped in the same `[data-md-block]`
 * / `[data-component="markdown-code"]` structure the renderer stamps) and
 * mirrors the component's selection→copy data flow line-for-line. Bun's test
 * runner has no DOM, so the tree is built with a minimal fake node graph.
 */
import { describe, expect, test } from 'bun:test';

import { copyMarkdownToClipboard, copyTextToClipboard } from '@/lib/clipboard';

import { rangeToMarkdown } from './selectionMarkdown';

// --- Minimal fake DOM ------------------------------------------------------

interface FakeNode {
  nodeType: number;
  tagName?: string;
  textContent: string;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  attrs: Map<string, string>;
}

const el = (tag: string, attrs: Record<string, string> = {}, children: FakeNode[] = []): FakeNode => {
  const node: FakeNode = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    textContent: children.map((c) => c.textContent).join(''),
    parentNode: null,
    childNodes: children,
    attrs: new Map(Object.entries(attrs)),
  };
  for (const child of children) child.parentNode = node;
  return node;
};

const txt = (value: string): FakeNode => ({
  nodeType: 3,
  textContent: value,
  parentNode: null,
  childNodes: [],
  attrs: new Map(),
});

const getAttribute = (node: FakeNode, name: string): string | null =>
  node.nodeType === 1 ? node.attrs.get(name) ?? null : null;

const hasAttribute = (node: FakeNode, name: string): boolean =>
  node.nodeType === 1 ? node.attrs.has(name) : false;

const parentElement = (node: FakeNode): FakeNode | null => {
  let parent = node.parentNode;
  while (parent && parent.nodeType !== 1) parent = parent.parentNode;
  return parent;
};

const hasAncestor = (node: FakeNode, tag: string): boolean => {
  let cur = parentElement(node);
  while (cur) {
    if (cur.tagName?.toLowerCase() === tag) return true;
    cur = parentElement(cur);
  }
  return false;
};

const closest = (node: FakeNode, selector: string): FakeNode | null => {
  if (selector === 'pre') {
    let cur: FakeNode | null = node;
    while (cur) {
      if (cur.tagName?.toLowerCase() === 'pre') return cur;
      cur = parentElement(cur);
    }
    return null;
  }
  if (selector === 'pre code') {
    let cur: FakeNode | null = node;
    while (cur) {
      if (cur.tagName?.toLowerCase() === 'code' && hasAncestor(cur, 'pre')) return cur;
      cur = parentElement(cur);
    }
    return null;
  }
  return null;
};

const cloneContents = (childNodes: FakeNode[]): FakeNode => {
  const cloneTree = (node: FakeNode): FakeNode => {
    if (node.nodeType === 3) return txt(node.textContent);
    return el(
      (node.tagName as string).toLowerCase(),
      Object.fromEntries(node.attrs),
      node.childNodes.map((c) => cloneTree(c)),
    );
  };
  return { nodeType: 11, textContent: '', parentNode: null, childNodes: childNodes.map((c) => cloneTree(c)), attrs: new Map() };
};

// Project the fake node graph onto the DOM API surface `selectionMarkdown`
// touches. Memoized per original node so parent<->child cycles terminate.
interface AdaptedNode {
  nodeType: number;
  textContent: string;
  tagName?: string;
  childNodes: AdaptedNode[];
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  parentElement: AdaptedNode | null;
  closest(selector: string): AdaptedNode | null;
}

const makeAdapter = () => {
  const memo = new WeakMap<FakeNode, AdaptedNode>();
  const adapt = (node: FakeNode): AdaptedNode => {
    const cached = memo.get(node);
    if (cached) return cached;
    const adapted: AdaptedNode = {
      nodeType: node.nodeType,
      textContent: node.textContent,
      tagName: node.tagName,
      childNodes: [],
      getAttribute: (name: string) => getAttribute(node, name),
      hasAttribute: (name: string) => hasAttribute(node, name),
      parentElement: null,
      closest: (selector: string) => {
        const found = closest(node, selector);
        return found ? adapt(found) : null;
      },
    };
    memo.set(node, adapted);
    adapted.childNodes = node.childNodes.map(adapt);
    if (node.nodeType !== 1) {
      const parent = parentElement(node);
      if (parent) adapted.parentElement = adapt(parent);
    }
    return adapted;
  };
  return adapt;
};

// --- Rendered assistant message (fixture) ----------------------------------

// Mirrors the DOM the markdown renderer produces for the assistant reply
// (marked output wrapped in `[data-md-block]` per MarkdownRendererImpl.tsx:875,
// code blocks wrapped in `[data-component="markdown-code"]` per decorate.ts):
//
//   # Heading
//
//   This has **bold** and *italic* and `inline code`.
//
//   - item one
//   - item two
const buildRenderedReply = () => {
  const strongBold = el('strong', {}, [txt('bold')]);
  const emItalic = el('em', {}, [txt('italic')]);
  const inlineCode = el('code', { 'data-markdown': 'inline-code' }, [txt('inline code')]);
  const p = el('p', {}, [txt('This has '), strongBold, txt(' and '), emItalic, txt(' and '), inlineCode, txt('.')]);
  const ul = el('ul', {}, [
    el('li', {}, [txt('item one')]),
    el('li', {}, [txt('item two')]),
  ]);
  const h1 = el('h1', {}, [txt('Heading')]);
  const pre = el('pre', { 'data-md-lang': 'ts' }, [
    el('code', { 'data-md-code-lines': '', class: 'language-ts' }, [txt('const x = 1;')]),
  ]);
  const codeBlock = el('div', { 'data-component': 'markdown-code' }, [pre]);
  el('div', { 'data-md-block': '' }, [h1, p, ul, codeBlock]);
  return { strongBold, emItalic, inlineCode, p, ul, h1, pre, codeBlock };
};

// --- Clipboard mock --------------------------------------------------------

interface MockClipboard {
  writtenText: string[];
  writtenItems: Array<{ data: Record<string, Blob> }>;
  restore(): void;
}

const installClipboardMock = (): MockClipboard => {
  const g = globalThis as unknown as {
    navigator?: { clipboard?: unknown };
    ClipboardItem?: unknown;
  };
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const previousClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

  const writtenText: string[] = [];
  const writtenItems: Array<{ data: Record<string, Blob> }> = [];

  class FakeClipboardItem {
    static supports(type: string): boolean {
      return type === 'text/markdown';
    }

    readonly data: Record<string, Blob>;

    constructor(data: Record<string, Blob>) {
      this.data = data;
    }
  }

  g.navigator = {
    ...(g.navigator as object),
    clipboard: {
      writeText: async (text: string) => {
        writtenText.push(text);
      },
      write: async (items: Array<{ data: Record<string, Blob> }>) => {
        writtenItems.push(...items);
      },
    },
  };
  g.ClipboardItem = FakeClipboardItem;

  return {
    writtenText,
    writtenItems,
    restore() {
      if (previousNavigator) {
        Object.defineProperty(globalThis, 'navigator', previousNavigator);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
      if (previousClipboardItem) {
        Object.defineProperty(globalThis, 'ClipboardItem', previousClipboardItem);
      } else {
        Reflect.deleteProperty(globalThis, 'ClipboardItem');
      }
    },
  };
};

// --- Tests ---------------------------------------------------------------

describe('issue #2840: partial copy of an assistant message loses Markdown', () => {
  test('Copy button writes the plain-text selection, dropping the Markdown computed by rangeToMarkdown', async () => {
    const nodes = buildRenderedReply();
    const adapt = makeAdapter();

    // Three "select a portion of the reply" scenarios (per the issue's repro
    // steps). For each, the component computes both the plain text and the
    // Markdown of the selection (TextSelectionMenu.tsx:205/231), but
    // handleCopy (TextSelectionMenu.tsx:330-340) writes only the plain text.
    const scenarios: Array<{ name: string; plainText: string; markdownMarker: string }> = [
      {
        // Partial selection: "**bold** and *italic* and `inline code`"
        name: 'inline emphasis',
        plainText: 'bold and italic and inline code.',
        markdownMarker: '**bold**',
      },
      {
        // Partial selection: the bullet list
        name: 'bullet list',
        plainText: 'item one item two',
        markdownMarker: '- item one',
      },
      {
        // Partial selection: the heading
        name: 'heading',
        plainText: 'Heading',
        markdownMarker: '# Heading',
      },
    ];

    for (const scenario of scenarios) {
      const selectionRange = (() => {
        if (scenario.name === 'inline emphasis') {
          return {
            startContainer: adapt(nodes.strongBold.childNodes[0]),
            endContainer: adapt(nodes.inlineCode.childNodes[0]),
            cloneContents: () => adapt(cloneContents([
              nodes.strongBold,
              txt(' and '),
              nodes.emItalic,
              txt(' and '),
              nodes.inlineCode,
            ])),
          };
        }
        if (scenario.name === 'bullet list') {
          return {
            startContainer: adapt(nodes.ul.childNodes[0]),
            endContainer: adapt(nodes.ul.childNodes[1]),
            cloneContents: () => adapt(cloneContents([nodes.ul])),
          };
        }
        return {
          startContainer: adapt(nodes.h1.childNodes[0]),
          endContainer: adapt(nodes.h1.childNodes[0]),
          cloneContents: () => adapt(cloneContents([nodes.h1])),
        };
      })();

      // Exactly what TextSelectionMenu.tsx:205/231 computes at selection time:
      // `selectedText` = selection.toString(), `selectedTextMarkdown` =
      // rangeToMarkdown(range, text).
      const selectedTextMarkdown = rangeToMarkdown(selectionRange as unknown as Range, scenario.plainText);

      // Sanity: the Markdown for the range IS available and carries Markdown
      // markers — the information the Copy path is about to drop.
      expect(selectedTextMarkdown).toContain(scenario.markdownMarker);

      // Click "Copy" → handleCopy (TextSelectionMenu.tsx:330-340) writes
      // `copyTextToClipboard(selectedText)` — the plain-text selection only.
      const clipboard = installClipboardMock();
      try {
        const result = await copyTextToClipboard(scenario.plainText);
        expect(result.ok).toBe(true);
        expect(clipboard.writtenText).toEqual([scenario.plainText]);

        const pasted = clipboard.writtenText[0];
        // User-visible bug: the clipboard holds plain text — no Markdown markers.
        expect(pasted).not.toContain(scenario.markdownMarker);
      } finally {
        clipboard.restore();
      }
    }
  });

  test('full-message copy (copyMarkdownToClipboard) keeps the Markdown — the inconsistency', async () => {
    const clipboard = installClipboardMock();
    try {
      const markdownSource = '# Heading\n\nThis has **bold** and *italic* and `inline code`.\n\n- item one\n- item two';
      // ChatMessage.tsx:784 — handleCopyMessage for assistant messages.
      const result = await copyMarkdownToClipboard(markdownSource, '<p>rendered html</p>');
      expect(result.ok).toBe(true);
      expect(clipboard.writtenItems.length).toBe(1);
      const data = clipboard.writtenItems[0].data;
      expect(Object.keys(data).sort()).toEqual(['text/html', 'text/markdown', 'text/plain']);
      expect(await data['text/plain']?.text()).toContain('**bold**');
      expect(await data['text/markdown']?.text()).toContain('**bold**');
      expect(await data['text/markdown']?.text()).toContain('- item one');
    } finally {
      clipboard.restore();
    }
  });
});
