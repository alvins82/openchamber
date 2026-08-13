import { describe, expect, test } from 'bun:test';

// Reproduction for https://github.com/openchamber/openchamber/issues/2876
//
// [Bug] Pasting from the copy button in the shell widget to the terminal fails
//
// Symptom (macOS desktop): after clicking the copy button on the chat shell
// widget, pasting into the integrated terminal yields a single "random"
// character ~90% of the time. The character is stable across repeated pastes
// but changes on re-copy, is not the first/last character of the copied text,
// and pasting the same clipboard into an external app shows the same single
// character. Copying via terminal selection / Cmd+C works fine.
//
// Root cause: ghostty-web (v0.4.0, used by TerminalViewport.tsx) implements
// copy-on-click. Its SelectionManager:
//
//   mousedown (button 0) on the canvas:
//     selectionStart = selectionEnd = clicked cell
//     isSelecting = true
//   mouseup (document level):
//     if isSelecting:
//       text = getSelection()          // single character of the clicked cell
//       if text: copyToClipboard(text) // navigator.clipboard.writeText(char)
//
// So a plain left click on any character in the integrated terminal WRITES that
// single character to the system clipboard. The reporter's flow is:
//
//   1. click shell widget copy button  -> clipboard = full output
//   2. click into the integrated terminal to focus it
//      -> ghostty copies the character under the cursor to the clipboard
//   3. Cmd+V -> pastes that single character
//
// Every observation in the issue matches: the character is whatever cell the
// click landed on (random w.r.t. the copied text), re-copying then re-clicking
// can land on a different cell (different character), pasting into an external
// app after the terminal click shows the same single character (the clipboard
// was already clobbered), and clicking empty cells does nothing (~10% success).

type Cell = { col: number; absoluteRow: number };

/**
 * Faithful model of ghostty-web v0.4.0 SelectionManager mouse handling
 * (packages from `node_modules/ghostty-web/dist/ghostty-web.js`):
 * - left mousedown on the canvas selects a single cell and arms isSelecting
 * - document-level mouseup copies the selection to the clipboard
 * - getSelection() returns the character(s) of the selected range
 */
const createGhosttySelectionModel = (screen: string[][]) => {
    let selectionStart: Cell | null = null;
    let selectionEnd: Cell | null = null;
    let isSelecting = false;
    const clipboardWrites: string[] = [];

    const getSelection = (): string => {
        if (!selectionStart || !selectionEnd) return '';
        let fromCol = selectionStart.col;
        let fromRow = selectionStart.absoluteRow;
        let toCol = selectionEnd.col;
        let toRow = selectionEnd.absoluteRow;
        if (fromRow > toRow || (fromRow === toRow && fromCol > toCol)) {
            [fromCol, toCol] = [toCol, fromCol];
            [fromRow, toRow] = [toRow, fromRow];
        }
        let result = '';
        for (let row = fromRow; row <= toRow; row += 1) {
            const line = screen[row];
            if (!line) continue;
            let lastNonSpace = -1;
            const startCol = row === fromRow ? fromCol : 0;
            const endCol = row === toRow ? toCol : line.length - 1;
            let cellText = '';
            for (let col = startCol; col <= endCol; col += 1) {
                const char = line[col];
                if (char && char !== ' ') {
                    cellText += char;
                    if (char.trim()) lastNonSpace = cellText.length;
                } else {
                    cellText += ' ';
                }
            }
            cellText = lastNonSpace >= 0 ? cellText.substring(0, lastNonSpace) : '';
            result += cellText;
            if (row < toRow) result += '\n';
        }
        return result;
    };

    // canvas mousedown listener
    const mousedown = (button: number, col: number, row: number): void => {
        if (button !== 0) return;
        selectionStart = { col, absoluteRow: row };
        selectionEnd = { col, absoluteRow: row };
        isSelecting = true;
    };

    // canvas mousemove listener (only extends the selection while selecting)
    const mousemove = (col: number, row: number): void => {
        if (!isSelecting) return;
        selectionEnd = { col, absoluteRow: row };
    };

    // document mouseup listener
    const mouseup = (): void => {
        if (!isSelecting) return;
        isSelecting = false;
        const text = getSelection();
        if (text) clipboardWrites.push(text); // copyToClipboard(text)
    };

    return { mousedown, mousemove, mouseup, getSelection, clipboardWrites };
};

describe('issue 2876: copy-on-click in the integrated terminal clobbers the clipboard', () => {
    test('a plain left click on a character writes that single character to the clipboard', () => {
        // Terminal screen: row 0 is `$ echo hi` (prompt + command).
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

        // 1. User copied the shell widget output; clipboard holds the full text.
        const clipboard: string[] = ['pnpm install\n'];

        // 2. User clicks into the terminal to focus it — click lands on cell
        //    (col 3, row 0), the character 'c' of "echo".
        const model = createGhosttySelectionModel(screen);
        model.mousedown(0, 3, 0);
        model.mouseup();

        expect(model.getSelection()).toBe('c');
        expect(model.clipboardWrites).toEqual(['c']);

        // 3. ghostty-web copied the clicked character over the full output.
        for (const write of model.clipboardWrites) clipboard.unshift(write);
        expect(clipboard[0]).toBe('c');
    });

    test('clicking empty/whitespace cells does not clobber the clipboard (~10% success)', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o'], [], [' ', ' ', ' ']];

        const model = createGhosttySelectionModel(screen);
        model.mousedown(0, 1, 0); // the space in `$ echo`
        model.mouseup();
        model.mousedown(0, 0, 2); // an empty line
        model.mouseup();

        expect(model.clipboardWrites).toEqual([]);
    });

    test('copying via terminal selection (drag) intentionally copies the selected text', () => {
        const screen = [['$', ' ', 'e', 'c', 'h', 'o', ' ', 'h', 'i']];

        // Real drag selection: mousedown, mousemove to extend, mouseup.
        const model = createGhosttySelectionModel(screen);
        model.mousedown(0, 2, 0);
        // mousemove extends selectionEnd (mirrors the library's mousemove handler)
        model.mousemove(5, 0);
        model.mouseup();

        expect(model.clipboardWrites[0]).toBe('echo');
    });
});
