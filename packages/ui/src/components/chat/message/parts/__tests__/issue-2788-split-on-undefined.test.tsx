import { test, expect, describe } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The chat DiffPreview pulls in the Shiki markdown worker through a Vite-only
// `?worker&url` import. Under bun test that specifier resolves to an empty
// module. The `packages/ui/bunfig.toml` test preload (`test-preload.ts`) stubs
// it before any test module loads; the worker is only used for syntax
// highlighting and is irrelevant to this reproduction.

import { I18nProvider } from '@/lib/i18n';
import { DiffPreview } from '@/components/chat/DiffPreview';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { parseDiffToUnified } from '../../toolRenderers';

// Reproduction for https://github.com/openchamber/openchamber/issues/2788
//
// "[Bug] AI code generation interrupted halfway, suddenly shows 'Chat Error'"
//   TypeError: Cannot read properties of undefined (reading 'split')
//
// Scenario: while the model is streaming an apply_patch/edit diff, the output
// is interrupted halfway. The persisted diff is truncated exactly after an
// "Index:" header line, leaving a bare "Index:" line with no filename.
// parseDiffToUnified() then evaluates `line.split(' ')[1].split('/')` where
// `line.split(' ')[1]` is undefined, throwing
// "Cannot read properties of undefined (reading 'split')".
//
// The throw happens while rendering the permission/diff card inside the chat
// view, so ChatErrorBoundary catches it and shows "Chat Error". "Reset Chat"
// only clears the boundary state; the same truncated diff re-renders and
// throws again, so the error persists — exactly as reported.

const COMPLETE_DIFF = [
  'Index: src/foo.ts',
  '===================================================================',
  '--- src/foo.ts',
  '+++ src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  ' line2',
  '-line3',
  '+line3 modified',
  '+line4',
].join('\n');

// The same diff, but the model was interrupted right after starting a new
// "Index:" section — the last line is a bare "Index:" with no filename.
const INTERRUPTED_DIFF = [
  'Index: src/foo.ts',
  '===================================================================',
  '--- src/foo.ts',
  '+++ src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' line1',
  ' line2',
  '-line3',
  '+line3 modified',
  '',
  'Index:',
].join('\n');

describe('parseDiffToUnified (issue #2788)', () => {
    test('parses a complete diff without error', () => {
        const hunks = parseDiffToUnified(COMPLETE_DIFF);
        expect(hunks.length).toBe(1);
        expect(hunks[0]?.file).toBe('foo.ts');
    });

    test('throws "Cannot read properties of undefined (reading \'split\')" on a diff interrupted at a bare "Index:" line', () => {
        expect(() => parseDiffToUnified(INTERRUPTED_DIFF)).toThrow(
            /Cannot read properties of undefined \(reading 'split'\)|undefined is not an object.*split/,
        );
    });
});

// Mirrors the real ChatView tree (MainLayout → ErrorBoundary → ChatView →
// ChatErrorBoundary): DiffPreview must render inside both providers.
const renderDiff = (diff: string): string =>
    renderToStaticMarkup(
        React.createElement(ThemeSystemProvider, null,
            React.createElement(I18nProvider, null,
                React.createElement(DiffPreview, { diff }))),
    );

describe('DiffPreview + error-boundary flow (issue #2788)', () => {
    test('renders the complete diff', () => {
        expect(renderDiff(COMPLETE_DIFF)).toContain('foo.ts');
    });

    test('throws during render when the diff is interrupted (what ChatErrorBoundary catches as "Chat Error")', () => {
        let thrown: unknown = null;
        try {
            renderDiff(INTERRUPTED_DIFF);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).not.toBeNull();
        // Both V8 ("Cannot read properties of undefined (reading 'split')") and
        // JavaScriptCore ("undefined is not an object ... 'split'") messages
        // mention the property name.
        expect(String(thrown)).toContain('split');
    });

    test('re-throws on every render attempt with the same data (why "Reset Chat" does not help)', () => {
        // Mirrors ChatErrorBoundary.handleReset(): it clears hasError and
        // re-renders the children. Because the interrupted diff is still part
        // of the message list, the boundary catches the same error again.
        const renderOnce = (): string => {
            try {
                return renderDiff(INTERRUPTED_DIFF);
            } catch (error) {
                return `Chat Error: ${String(error)}`;
            }
        };

        const first = renderOnce();
        const afterReset = renderOnce();
        expect(first).toContain('Chat Error');
        expect(afterReset).toContain('Chat Error');
        expect(afterReset).toBe(first);
    });
});
