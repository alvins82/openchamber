import { afterEach, describe, expect, test } from 'bun:test';

import { marked } from 'marked';
import type { Part } from '@opencode-ai/sdk/v2';
import { copyMarkdownToClipboard } from '../clipboard';
import { flattenAssistantTextParts } from './messageText';

// Reproduction for https://github.com/openchamber/openchamber/issues/2867
// Confirms the flattened text (blank lines collapsed) is what `handleCopyMessage`
// writes to the clipboard for ALL THREE formats: text/plain, text/markdown, text/html.

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalClipboardItem = Object.getOwnPropertyDescriptor(globalThis, 'ClipboardItem');

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
  if (originalClipboardItem) Object.defineProperty(globalThis, 'ClipboardItem', originalClipboardItem);
  else Reflect.deleteProperty(globalThis, 'ClipboardItem');
});

const basePart = (overrides: Partial<Part>): Part =>
  ({
    id: 'p1', sessionID: 's', messageID: 'm', type: 'text', text: '', ...overrides,
  }) as Part;

const makeParts = (texts: string[]): Part[] =>
  texts.map((text, index) => basePart({ id: `p${index}`, text, type: 'text' }));

describe('issue #2867: clipboard payload is corrupted', () => {
  test('all clipboard formats carry the blank-line-collapsed text', async () => {
    const parts = makeParts(['第一段', '第二段', '```js\nconsole.log(1)\n```', '第三段']);

    class FakeClipboardItem {
      static supports(type: string): boolean { return type === 'text/markdown'; }
      readonly data: Record<string, Blob>;
      constructor(data: Record<string, Blob>) { this.data = data; }
    }
    let writtenItem: { data: Record<string, Blob> } | undefined;
    Object.defineProperty(globalThis, 'ClipboardItem', { configurable: true, value: FakeClipboardItem });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { write: async (items: Array<{ data: Record<string, Blob> }>) => { writtenItem = items[0]; } } },
    });

    // Same path as ChatMessage.tsx handleCopyMessage:
    const text = flattenAssistantTextParts(parts);
    // renderMarkdownSync wraps marked (gfm, breaks:false) — same parser here.
    const html = marked.parse(text, { gfm: true, breaks: false }) as string;
    await copyMarkdownToClipboard(text, html);

    const plain = await writtenItem?.data['text/plain']?.text();
    const markdown = await writtenItem?.data['text/markdown']?.text();
    const htmlText = await writtenItem?.data['text/html']?.text();

    // Correct behavior: block separators (`\n\n`) survive into every format.
    const expected =
      '第一段\n\n第二段\n\n```js\nconsole.log(1)\n```\n\n第三段';
    expect(plain).toBe(expected);
    expect(markdown).toBe(expected);
    // HTML must render two separate paragraphs, not one merged soft-broken <p>.
    expect(htmlText).toContain('<p>第一段</p>');
    expect(htmlText).toContain('<p>第二段</p>');
    expect(htmlText).not.toContain('<p>第一段\n第二段</p>');
  });
});
