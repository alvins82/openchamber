import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

// Reproduction for https://github.com/openchamber/openchamber/issues/3013
//
// The controlled value writeback in ComposerEditor.tsx dispatches:
//
//   view.dispatch({
//     changes: { from: 0, to: current.length, insert: value },
//     selection: { anchor: value.length },
//   });
//
// CodeMirror normalizes CRLF (`\r\n`) to `\n`, so when `value` contains
// CRLF the normalized document is shorter than `value.length` and the
// selection anchor points outside the document, making CodeMirror throw
// `RangeError: Selection points outside of document`.
//
// These tests assert the expected behavior from the issue (no crash, caret
// at the normalized document end) and currently FAIL on main, reproducing
// the crash.

/** Exact transaction shape used by the controlled writeback in ComposerEditor.tsx. */
const writeback = (currentDoc: string, value: string) => {
    const state = EditorState.create({ doc: currentDoc });
    return state.update({
        changes: { from: 0, to: state.doc.length, insert: value },
        selection: { anchor: value.length },
    });
};

describe('composer controlled writeback with CRLF values (issue #3013)', () => {
    test('writes "x\\r\\ny" and lands the caret at the normalized document end without throwing', () => {
        const value = 'x\r\ny';
        const updated = writeback('a', value);
        // "x\ny" — CodeMirror normalizes CRLF to LF, length 3, not 4.
        expect(updated.state.doc.toString()).toBe('x\ny');
        expect(updated.state.selection.main.anchor).toBe(updated.state.doc.length);
    });

    test('writes a PTY-style payload with carriage returns and ANSI sequences without throwing', () => {
        const value = '\r\x1b[2K\r\x1b[1;32m\u2714\x1b[0m build complete\r\ny';
        const updated = writeback('previous draft', value);
        expect(updated.state.selection.main.anchor).toBe(updated.state.doc.length);
    });
});