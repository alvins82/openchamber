/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2879
 *
 * [Bug] Markdown fence completion places caret after the closing fence
 *
 * Reported steps (chat composer):
 *   1. Place the caret at the beginning of an empty line.
 *   2. Type three backticks.
 *
 * Expected: the composer expands them into a fenced block and the caret lands
 * on the empty middle line, so typing continues inside the code block.
 * Actual (1.18.2, VS Code extension): the caret lands after the closing fence.
 *
 * Root cause, as the report describes: ChatInput's `applyEdit` applies the
 * selection separately from the controlled CodeMirror document update.
 * `setMessage(next)` schedules the React state update, then
 * `composerRef.current.setSelection(caretStart, caretEnd)` dispatches the
 * caret against the PREVIOUS document (the state update has not flushed yet).
 * When the state update lands, ComposerEditor's controlled-value effect
 * (`ComposerEditor.tsx`) rewrites the whole document and places the caret at
 * the END of the new value (`selection: { anchor: value.length }`), clobbering
 * the intended position — so the caret ends up after the closing fence.
 *
 * This test mounts the real `ComposerEditor` (CodeMirror) behind the same
 * controlled `value`/`onChange` wiring ChatInput uses, drives the first two
 * backticks through the real editor, then runs the fence-completion branch of
 * ChatInput's keydown handler verbatim (the `applyEdit` pattern) and asserts
 * where the caret actually lands.
 */

import { describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
    ComposerEditor,
    type ComposerChange,
    type ComposerEditorHandle,
} from '../ComposerEditor';
import type { ComposerLanguageContext } from '../../language/tokenize';

// --- Minimal DOM stub ------------------------------------------------------
//
// Bun's test runner provides no DOM. CodeMirror needs just enough of one to
// construct a view (measurement is skipped by making requestAnimationFrame a
// no-op — this test only inspects editor state, never layout).

interface FakeNode {
    nodeType: number;
    nodeName: string;
    tagName: string;
    ownerDocument: unknown;
    parentNode: FakeNode | null;
    childNodes: FakeNode[];
    style: Record<string, unknown>;
    attributes: Record<string, string>;
    classList: { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean; toString(): string };
    eventListeners: Record<string, Array<(e: unknown) => void>>;
    textContent: string;
    appendChild(c: FakeNode): FakeNode;
    insertBefore(c: FakeNode, ref: FakeNode | null): FakeNode;
    removeChild(c: FakeNode): FakeNode;
    remove(): void;
    setAttribute(k: string, v: string): void;
    removeAttribute(k: string): void;
    getAttribute(k: string): string | null;
    hasAttribute(k: string): boolean;
    addEventListener(type: string, fn: (e: unknown) => void): void;
    removeEventListener(type: string, fn: (e: unknown) => void): void;
    getBoundingClientRect(): Record<string, number>;
    getClientRects(): unknown[];
    contains(other: unknown): boolean;
    focus(): void;
    blur(): void;
    querySelector(): null;
    querySelectorAll(): unknown[];
}

function makeClassList(): FakeNode['classList'] {
    const classes = new Set<string>();
    return {
        add(...c: string[]) { c.forEach((x) => classes.add(x)); },
        remove(...c: string[]) { c.forEach((x) => classes.delete(x)); },
        contains(c: string) { return classes.has(c); },
        toString() { return [...classes].join(' '); },
    };
}

function makeNode(tag: string, owner: unknown): FakeNode {
    const node: FakeNode = {
        nodeType: 1,
        nodeName: tag.toUpperCase(),
        tagName: tag.toUpperCase(),
        ownerDocument: owner,
        parentNode: null,
        childNodes: [],
        style: {},
        attributes: {},
        classList: makeClassList(),
        eventListeners: {},
        textContent: '',
        appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; },
        insertBefore(c, ref) {
            const i = ref ? this.childNodes.indexOf(ref) : -1;
            if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c);
            c.parentNode = this;
            return c;
        },
        removeChild(c) {
            const i = this.childNodes.indexOf(c);
            if (i >= 0) this.childNodes.splice(i, 1);
            c.parentNode = null;
            return c;
        },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); },
        setAttribute(k, v) { this.attributes[k] = String(v); },
        removeAttribute(k) { delete this.attributes[k]; },
        getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; },
        hasAttribute(k) { return k in this.attributes; },
        addEventListener(type, fn) { (this.eventListeners[type] ||= []).push(fn); },
        removeEventListener(type, fn) {
            this.eventListeners[type] = (this.eventListeners[type] || []).filter((f) => f !== fn);
        },
        getBoundingClientRect() {
            return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600 };
        },
        getClientRects() { return []; },
        contains(other) { return other === this; },
        focus() { /* noop */ },
        blur() { /* noop */ },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    return node;
}

class FakeClass {}

function installDomStub(): () => void {
    // Stub document/window are intentionally loose (`any`): they only need to
    // satisfy the handful of DOM calls CodeMirror and React make at mount.
    const documentStub: Record<string, unknown> & { body: FakeNode; documentElement: FakeNode; head: FakeNode } = {
        nodeType: 9,
        nodeName: '#document',
        tagName: '#document',
        body: null as unknown as FakeNode,
        documentElement: null as unknown as FakeNode,
        head: null as unknown as FakeNode,
        activeElement: null,
        hidden: false,
        visibilityState: 'visible',
        createElement: (tag: string) => makeNode(tag, documentStub),
        createElementNS: (_ns: string, tag: string) => makeNode(tag, documentStub),
        createTextNode: (text: string) => {
            return {
                nodeType: 3,
                nodeName: '#text',
                textContent: String(text),
                parentNode: null,
                ownerDocument: documentStub,
            } as unknown as FakeNode;
        },
        hasFocus: () => true,
        addEventListener: () => { /* noop */ },
        removeEventListener: () => { /* noop */ },
        getSelection: () => null,
        defaultView: null,
        // react-dom checks `element instanceof containerInfo.HTMLIFrameElement`
        // (and siblings) during commit; without these, the `instanceof` throws
        // "Right hand side of instanceof is not an object".
        HTMLIFrameElement: FakeClass,
        HTMLFrameSetElement: FakeClass,
        HTMLInputElement: FakeClass,
        HTMLTextAreaElement: FakeClass,
        HTMLSelectElement: FakeClass,
        HTMLOptionElement: FakeClass,
        HTMLAnchorElement: FakeClass,
        HTMLDivElement: FakeClass,
        HTMLSpanElement: FakeClass,
        HTMLStyleElement: FakeClass,
    };

    documentStub.body = makeNode('body', documentStub);
    documentStub.documentElement = makeNode('html', documentStub);
    documentStub.head = makeNode('head', documentStub);

    const windowStub: Record<string, unknown> = {
        document: documentStub,
        window: null,
        navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        addEventListener: () => { /* noop */ },
        removeEventListener: () => { /* noop */ },
        devicePixelRatio: 1,
        innerWidth: 800,
        innerHeight: 600,
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        getComputedStyle: () => {
            return { getPropertyValue: () => '', lineHeight: '20px', fontSize: '14px' };
        },
        HTMLIFrameElement: FakeClass,
        HTMLFrameSetElement: FakeClass,
        HTMLInputElement: FakeClass,
        HTMLTextAreaElement: FakeClass,
        HTMLSelectElement: FakeClass,
        HTMLOptionElement: FakeClass,
        HTMLAnchorElement: FakeClass,
        HTMLDivElement: FakeClass,
        HTMLSpanElement: FakeClass,
        HTMLStyleElement: FakeClass,
    };
    windowStub.window = windowStub;
    documentStub.defaultView = windowStub;

    const g = globalThis as unknown as Record<string, unknown>;
    const previous: Array<[string, unknown]> = [];
    const install = (key: string, value: unknown) => {
        previous.push([key, g[key]]);
        g[key] = value;
    };

    install('document', documentStub);
    install('window', windowStub);
    install('navigator', windowStub.navigator);
    install('IS_REACT_ACT_ENVIRONMENT', true);
    install('requestAnimationFrame', () => 1);
    install('cancelAnimationFrame', () => {});
    install('MutationObserver', class { observe() {} disconnect() {} takeRecords() { return []; } });
    install('getComputedStyle', windowStub.getComputedStyle);
    install('Window', FakeClass);
    install('Document', FakeClass);
    install('Node', FakeClass);
    install('Element', FakeClass);
    install('HTMLElement', FakeClass);
    install('Text', FakeClass);
    install('Range', FakeClass);
    install('DOMRect', class { constructor(x: number, y: number, w: number, h: number) { Object.assign(this, { x, y, top: y, left: x, right: x + w, bottom: y + h, width: w, height: h }); } });

    return () => {
        for (const [key, value] of previous) {
            if (value === undefined) delete g[key]; else g[key] = value;
        }
    };
}

// --- Test harness ----------------------------------------------------------

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal',
    knownAgentNames: new Set(),
    confirmedMentions: new Set(),
    knownSlashNames: new Set(),
    knownSnippetTriggers: new Set(),
    attachmentFilenames: [],
};

interface Harness {
    editor: ComposerEditorHandle;
    /** Replicates the fence-completion branch of ChatInput's keydown handler. */
    typeThirdBacktick(): void;
    getDocument(): string;
    unmount(): void;
}

function mountComposer(initialValue: string): Harness {
    const doc = (globalThis as unknown as { document: Document }).document;
    const container = doc.createElement('div');
    const root: Root = createRoot(container as unknown as Element);

    let editorHandle: ComposerEditorHandle | null = null;
    let setMessage: ((v: string) => void) | null = null;

    // The same controlled wiring ChatInput uses: the editor reports changes and
    // the parent feeds them back as the `value` prop (`setMessage`).
    const Controlled = () => {
        const [value, setValue] = useState(initialValue);
        setMessage = setValue;
        const onChange = (change: ComposerChange) => {
            setValue(change.value);
        };
        return React.createElement(
            ComposerEditor,
            {
                value,
                onChange,
                onKeyDown: () => false,
                languageContext,
                placeholder: 'placeholder',
                'aria-label': 'composer',
                ref: (handle: unknown) => {
                    editorHandle = handle as ComposerEditorHandle | null;
                },
            },
        );
    };

    act(() => {
        root.render(React.createElement(Controlled));
    });

    if (!editorHandle) throw new Error('editor handle never attached');
    if (!setMessage) throw new Error('setMessage never attached');
    // TS narrows `let` variables assigned only inside closures to their
    // initializer type (`null`), so cast explicitly to the real handle type.
    const editor: ComposerEditorHandle = editorHandle as ComposerEditorHandle;

    return {
        editor,
        // ChatInput.tsx, handleKeyDown — markdown-aware auto-pairing (source
        // mode), lines 1537-1548, with applyEdit at lines 1516-1521. The
        // event.preventDefault() is omitted: we are already intercepting.
        typeThirdBacktick() {
            const selStart = editor.getSelection().start;
            const selEnd = editor.getSelection().end;
            if (selStart !== selEnd) throw new Error('caret must be collapsed');
            const before = editor.getValue().slice(0, selStart);
            if (!/(^|\n)``$/.test(before)) throw new Error('not preceded by two backticks at line start');
            const after = editor.getValue().slice(selEnd);
            const next = `${before}\`\n\n\`\`\`${after}`;
            const caret = before.length + 2; // after the completed ``` and first newline

            // applyEdit: setMessage(next); setSelection(caret, caret).
            // setSelection is dispatched against the PREVIOUS document — the
            // React state update has not flushed yet. When it does flush, the
            // controlled-value effect rewrites the document and moves the
            // caret to the end of the new value.
            act(() => {
                setMessage!(next);
                editor.setSelection(caret, caret);
            });
        },
        getDocument() {
            return editor.getValue();
        },
        unmount() {
            act(() => {
                root.unmount();
            });
        },
    };
}

function withComposer<T>(initialValue: string, body: (harness: Harness) => T): T {
    const restore = installDomStub();
    const harness = mountComposer(initialValue);
    try {
        return body(harness);
    } finally {
        try { harness.unmount(); } catch { /* ignore */ }
        restore();
    }
}

// --- The bug -----------------------------------------------------------------

describe('issue-2879: markdown fence completion caret placement', () => {
    test('third backtick at the start of an empty line expands a fence (setup sanity)', () => {
        withComposer('hello\n', (h) => {
            // The issue's steps: place the caret at the beginning of an empty
            // line (here: the empty last line) and type three backticks.
            act(() => { h.editor.setSelection(6, 6); });
            // Type the first two backticks through the real editor.
            act(() => { h.editor.insertText('`'); });
            act(() => { h.editor.insertText('`'); });
            expect(h.getDocument()).toBe('hello\n``');
            expect(h.editor.getSelection().start).toBe(8);

            h.typeThirdBacktick();
            expect(h.getDocument()).toBe('hello\n```\n\n```');
        });
    });

    test('BUG: the caret lands after the closing fence instead of the empty middle line', () => {
        withComposer('hello\n', (h) => {
            act(() => { h.editor.setSelection(6, 6); });
            act(() => { h.editor.insertText('`'); });
            act(() => { h.editor.insertText('`'); });

            h.typeThirdBacktick();

            const doc = h.getDocument();
            const actual = h.editor.getSelection().start;
            const intended = doc.indexOf('\n\n') + 1; // the empty line between the fences

            // What the issue expects: the caret inside the block, on the empty
            // line between the opening and closing fences.
            expect(intended).toBe(10);

            // What actually happens (1.18.2): the caret sits at the very end of
            // the document — after the closing fence.
            expect(actual).toBe(doc.length);
            expect(actual).toBe(14);
            expect(actual).not.toBe(intended);
        });
    });

    test('same failure with text following the empty line', () => {
        withComposer('abc\n\ndef', (h) => {
            // Caret at the start of the empty middle line (position 4).
            act(() => { h.editor.setSelection(4, 4); });
            act(() => { h.editor.insertText('`'); });
            act(() => { h.editor.insertText('`'); });
            expect(h.getDocument()).toBe('abc\n``\ndef');

            h.typeThirdBacktick();
            expect(h.getDocument()).toBe('abc\n```\n\n```\ndef');

            const doc = h.getDocument();
            const actual = h.editor.getSelection().start;
            const intended = doc.indexOf('\n\n') + 1;
            expect(intended).toBe(8);
            expect(actual).toBe(doc.length);
            expect(actual).not.toBe(intended);
        });
    });
});
