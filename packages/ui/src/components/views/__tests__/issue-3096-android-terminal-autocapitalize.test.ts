/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3096
 *
 * Android terminal auto-capitalizes the first character of every command:
 * typing `ls` at a fresh prompt produces `Ls`, and `Ls` fails because the
 * shell looks for a binary that does not exist.
 *
 * Root cause chain (verified against the runtime artifacts):
 *
 * 1. ghostty-web's `Terminal.open(host)` promotes the host element that
 *    OpenChamber passes in (the `div.terminal-viewport-container`) to
 *    `contenteditable="true"` with `role="textbox"`, and that host is what
 *    `Terminal.focus()` targets (lines 2481-2486 of the dist bundle). On
 *    Android the soft keyboard / IME therefore attaches to the host div, not
 *    to ghostty's internal 1px textarea.
 * 2. ghostty-web only sets `autocapitalize="off"`, `autocorrect="off"` and
 *    `spellcheck="false"` on that internal hidden textarea, never on the host
 *    element. OpenChamber never sets these attributes on its terminal
 *    container either. The element that actually receives IME focus has no
 *    `autocapitalize` attribute, so Chromium/Android applies the default of
 *    `sentences`, which capitalizes the first character of every input run:
 *    the first character after focus, and again after each Enter.
 * 3. Text from the Android IME arrives as `beforeinput`/`insertText` with the
 *    already-capitalized payload (`Ls`). TerminalViewport's forwarding handler
 *    sends `input.data` to the PTY verbatim, with no case normalization.
 *
 * The test inspects the exact runtime artifacts (the patched ghostty-web
 * bundle and the OpenChamber sources) and then simulates the Android IME
 * contract against the attributes the app actually leaves on the focus target.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Read the exact patched bundle that runs in the app, plus the OpenChamber sources.
const ghosttyBundlePath = fileURLToPath(import.meta.resolve('ghostty-web'));
const terminalViewportPath = join(__dirname, '..', '..', 'terminal', 'TerminalViewport.tsx');

const ghosttyBundle = readFileSync(ghosttyBundlePath, 'utf-8');
const terminalViewportSource = readFileSync(terminalViewportPath, 'utf-8');

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/**
 * The Android/Chromium `autocapitalize` contract as applied to a focused
 * editable element. Absent the attribute the effective value is `sentences`,
 * which capitalizes the first character of each input run (after focus and
 * after each Enter). `off`/`none` disables it. This mirrors what the Android
 * IME does to the first character; the WebView never rewrites characters for
 * any other value.
 */
const capitalizeFirstOfEachRun = (
  text: string,
  autocapitalize: string | null,
): string => {
  const effective = autocapitalize ?? 'sentences';
  if (effective === 'off' || effective === 'none' || effective === 'characters') {
    return text;
  }
  // 'sentences' is the default and the only other value that matters here;
  // the IME capitalizes the first character of the current run.
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
};

describe('issue 3096: Android terminal auto-capitalizes the first character of every command', () => {
  test('ghostty-web makes the OpenChamber host element the IME target via contenteditable', () => {
    const openSite = ghosttyBundle.indexOf('setAttribute("contenteditable"');
    expect(openSite).toBeGreaterThan(-1);
    // The host element OpenChamber passes to `Terminal.open()` gets promoted
    // to an editable textbox. That element receives IME focus on Android.
    const openSetup = ghosttyBundle.slice(openSite - 60, openSite + 200);
    expect(openSetup).toContain('setAttribute("contenteditable", "true")');
    expect(openSetup).toContain('setAttribute("role", "textbox")');
  });

  test('autocapitalize/autocorrect are disabled only on the internal textarea, never on the host', () => {
    const textareaSite = ghosttyBundle.indexOf('createElement("textarea")');
    expect(textareaSite).toBeGreaterThan(-1);
    const textareaSetup = ghosttyBundle.slice(textareaSite, textareaSite + 400);

    // The one and only autocapitalize/autocorrect disablement targets
    // `this.textarea`, the 1px hidden helper element.
    expect(textareaSetup).toContain('this.textarea.setAttribute("autocapitalize", "off")');
    expect(textareaSetup).toContain('this.textarea.setAttribute("autocorrect", "off")');
    expect(textareaSetup).toContain('this.textarea.setAttribute("spellcheck", "false")');

    // Those are the only occurrences in the whole bundle: the host element
    // never gets an autocapitalize/autocorrect attribute.
    expect(countOf(ghosttyBundle, 'setAttribute("autocapitalize"')).toBe(1);
    expect(countOf(ghosttyBundle, 'setAttribute("autocorrect"')).toBe(1);
  });

  test('ghostty focus() targets the contenteditable host, not the textarea', () => {
    const focusSite = ghosttyBundle.indexOf('focus() {\n    this.isOpen && this.element');
    expect(focusSite).toBeGreaterThan(-1);
    const focusBody = ghosttyBundle.slice(focusSite, focusSite + 200);
    // Terminal.focus() focuses `this.element` (the contenteditable host). The
    // textarea is only focused by canvas mousedown/touchend, which OpenChamber's
    // pointer-capture touch handling supersedes.
    expect(focusBody).toContain('this.element.focus()');
    expect(focusBody).not.toContain('this.textarea.focus()');
  });

  test('OpenChamber never sets autocapitalize/autocorrect on the terminal container', () => {
    const containerReturn = terminalViewportSource.indexOf('data-terminal-owner="main"');
    expect(containerReturn).toBeGreaterThan(-1);
    // The container div is the element ghostty promotes to contenteditable.
    expect(terminalViewportSource.slice(containerReturn, containerReturn + 200)).toContain('terminal-viewport-container');

    // Neither the viewport nor the view set an autocapitalize/autocorrect
    // attribute on the terminal input path anywhere.
    expect(terminalViewportSource.indexOf('autocapitalize')).toBe(-1);
    expect(terminalViewportSource.indexOf('autocorrect')).toBe(-1);
  });

  test('Android IME text is forwarded verbatim: `Ls` from the IME reaches the PTY as `Ls`', () => {
    const beforeInputSite = terminalViewportSource.indexOf('const handleBeforeInput = (event: Event) => {');
    expect(beforeInputSite).toBeGreaterThan(-1);
    const handler = terminalViewportSource.slice(beforeInputSite, beforeInputSite + 700);

    // The touch-terminal path (Android) delivers IME text via beforeinput.
    expect(handler).toContain("case 'insertText':");
    // `input.data` is forwarded unchanged; there is no case normalization.
    expect(handler).toContain('if (input.data) inputRef.current(input.data);');
  });

  test('simulated Android IME: focus target without autocapitalize=off turns `ls` into `Ls`, after Enter again', () => {
    // Attributes the app actually leaves on the IME focus target: none.
    const focusTargetAutocapitalize = null;

    const firstRun = capitalizeFirstOfEachRun('ls', focusTargetAutocapitalize);
    expect(firstRun).toBe('Ls');

    // The IME keeps the same focus target across Enter, so the next command
    // run is capitalized again.
    const secondRun = capitalizeFirstOfEachRun('ls', focusTargetAutocapitalize);
    expect(secondRun).toBe('Ls');

    // With `autocapitalize="off"` (what the acceptance criteria requires) the
    // same input is delivered exactly as typed.
    expect(capitalizeFirstOfEachRun('ls', 'off')).toBe('ls');
    expect(capitalizeFirstOfEachRun('ls', 'none')).toBe('ls');
  });
});