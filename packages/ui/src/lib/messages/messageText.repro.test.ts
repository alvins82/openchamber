import { describe, expect, test } from 'bun:test';

import type { Part } from '@opencode-ai/sdk/v2';
import { flattenAssistantTextParts } from './messageText';

// Reproduction for https://github.com/openchamber/openchamber/issues/2867
//
// `flattenAssistantTextParts` collapses every blank line into a single `\n`.
// Markdown block structure (paragraphs, lists, fenced code blocks) requires a
// blank line (`\n\n`); a single `\n` is a CommonMark soft break that renders
// as a space or merges blocks. `ChatMessage.tsx`'s `handleCopyMessage` feeds
// this flattened string into `copyMarkdownToClipboard`, which writes it to
// BOTH `text/plain` and `text/markdown` (and its markdown-rendered HTML into
// `text/html`), so every paste target is corrupted.

const basePart = (overrides: Partial<Part>): Part =>
  ({
    id: 'p1',
    sessionID: 's',
    messageID: 'm',
    type: 'text',
    text: '',
    ...overrides,
  }) as Part;

const makeParts = (texts: string[]): Part[] =>
  texts.map((text, index) =>
    basePart({ id: `p${index}`, text, type: 'text' }),
  );

describe('issue #2867: copied assistant markdown loses block separation', () => {
  const parts = makeParts([
    '第一段',
    '第二段',
    '```js\nconsole.log(1)\n```',
    '第三段',
    '- item 1\n- item 2',
  ]);

  test('blank lines between paragraphs/code blocks/lists are preserved', () => {
    const flattened = flattenAssistantTextParts(parts);
    // Expected markdown keeps `\n\n` as the block separator so that pasted
    // content renders paragraphs, code fences and lists correctly.
    const expected =
      '第一段\n\n第二段\n\n```js\nconsole.log(1)\n```\n\n第三段\n\n- item 1\n- item 2';
    expect(flattened).toBe(expected);
  });

  test('a code fence is not glued to the following paragraph', () => {
    const flattened = flattenAssistantTextParts(parts);
    // Buggy output ends the fence with `\n第三段` — a CommonMark parser then
    // treats "第三段" as part of the (unterminated) code block content.
    expect(flattened).not.toContain('```\n第三段');
    expect(flattened).toContain('```\n\n第三段');
  });

  test('paragraphs are not merged into a single soft-wrapped line', () => {
    const flattened = flattenAssistantTextParts(parts);
    // Buggy output has only a single `\n` between paragraphs, which renders as
    // a space (soft break) in CommonMark instead of separate paragraphs.
    expect(flattened).toContain('第一段\n\n第二段');
    expect(flattened).not.toContain('第一段\n第二段');
  });

  test('text parts are joined with a blank line so part boundaries keep blocks', () => {
    const flattened = flattenAssistantTextParts(parts);
    expect(flattened.split('\n\n').length).toBeGreaterThan(1);
  });
});
