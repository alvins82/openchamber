import { describe, expect, mock, test } from 'bun:test';

mock.module('dompurify', () => ({
  default: {
    isSupported: true,
    addHook: () => undefined,
    sanitize: (html: string) => html,
  },
}));
mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
}));

const { renderMarkdownSync } = await import('./markdownCore');

// Reproduces openchamber/openchamber#3039: marked's GFM `url` tokenizer
// swallows CJK/fullwidth punctuation directly after a bare URL into the href.
// marked's `_backpedal` only backtracks ASCII punctuation, so fullwidth parens
// (U+FF08/U+FF09), fullwidth comma (U+FF0C) and CJK full stop (U+3002) are
// consumed. These tests assert the punctuation is NOT in the href; they fail on
// the current parser, which is the bug.
describe('CJK/fullwidth punctuation in bare-URL autolinks (#3039)', () => {
  test('fullwidth paren annotation is swallowed into href', () => {
    const html = renderMarkdownSync('访问 https://example.com/docs（中文说明）了解更多');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('（');
  });

  test('fullwidth comma after a bare URL is swallowed into href', () => {
    const html = renderMarkdownSync('https://example.com/guide，详见');
    expect(html).toContain('href="https://example.com/guide"');
    expect(html).not.toContain('，');
  });

  test('CJK full stop after a bare URL is swallowed into href', () => {
    const html = renderMarkdownSync('https://example.com。');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('。');
  });

  test('ASCII parenthetical after a bare URL is correctly trimmed (control)', () => {
    const html = renderMarkdownSync('visit https://example.com/docs (english) more');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('href="https://example.com/docs (english)');
  });
});
