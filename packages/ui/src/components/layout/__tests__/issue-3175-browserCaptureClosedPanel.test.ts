/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3175
 *
 * Regression from commit 4bed3589 ("fix(browser): keep the panel closed when
 * an agent opens a page"). The agent's browser.open now upserts the browser
 * tab with `{ reveal: false }`, so a closed ContextPanel stays closed. The
 * panel's closed render style is `width: 0` + `overflow-x: clip`, which makes
 * Chromium skip composited surface allocation for the mounted <webview>.
 * browser.capture then calls Electron's webContents.capturePage() and gets
 * an empty 0x0 image (UnknownVizError on macOS GPU builds) instead of a
 * screenshot. Opening the panel restores a real surface and capture succeeds.
 *
 * A full ContextPanel mount is not available in bun test (Vite worker URL in
 * the import graph), so like issue-2815-sessionChatIframesMountAllTabs.test.ts
 * this uses the real store plus source-level guards, and the compositor
 * behavior is covered by the standalone Electron script in the repro branch.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { useUIStore } from '@/stores/useUIStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');
const browserPaneSource = readFileSync(join(__dirname, '..', '..', 'browser', 'BrowserPane.tsx'), 'utf-8');

const DIRECTORY = '/path/to/repository';
const AGENT_URL = 'https://www.google.com';

beforeEach(() => {
  useUIStore.setState({ contextPanelByDirectory: {}, contextRailOrder: [] });
});

describe('issue #3175 browser.capture with the ContextPanel closed', () => {
  test('agent browser.open registers with reveal: false (regression line from 4bed3589)', () => {
    expect(contextPanelSource).toContain(
      'return registerBrowserOpener((url) => openContextBrowser(effectiveDirectory, url, { reveal: false }));',
    );
  });

  test('browser.open leaves a closed panel closed and mounts the tab invisibly', () => {
    // Precondition: user has the panel closed.
    useUIStore.getState().openContextPanelTab(DIRECTORY, { mode: 'terminal' });
    useUIStore.getState().closeContextPanel(DIRECTORY);
    expect(useUIStore.getState().contextPanelByDirectory[DIRECTORY]?.isOpen).toBe(false);

    // Agent's browser.open via the registered opener (reveal: false).
    useUIStore.getState().openContextBrowser(DIRECTORY, AGENT_URL, { reveal: false });

    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    // The tab mounts (BrowserPane stays in the DOM for browser.snapshot) ...
    expect(panel?.tabs.some((tab) => tab.mode === 'browser' && tab.targetPath === AGENT_URL)).toBe(true);
    // ... but the panel stays closed, so the webview renders at width: 0.
    expect(panel?.isOpen).toBe(false);
  });

  test('the closed panel renders the browser tab at width 0 with overflow clip', () => {
    // Closed-panel style from ContextPanel.tsx: the exact state that makes
    // Chromium skip VizSurface allocation for the mounted <webview>.
    const closedBlock = contextPanelSource.slice(
      contextPanelSource.indexOf('const panelStyle'),
      contextPanelSource.indexOf('const panelStyle') + 1200,
    );
    expect(closedBlock).toContain('!isOpen');
    expect(closedBlock).toContain('width: 0,');
    expect(closedBlock).toContain("overflowX: 'clip',");

    // Browser panes stay mounted regardless of visibility: the tab exists in
    // the DOM while the panel is closed, exactly where the 0-width webview lives.
    expect(contextPanelSource).toContain('{browserTabs.map((tab) => (');
    expect(contextPanelSource).toContain("activeTab?.id !== tab.id && 'hidden'");
  });

  test('browser.capture routes to webContents.capturePage via desktop_browser_capture_page', () => {
    // The capture path in BrowserPane -> main.mjs. On a 0-width webview this
    // returns an empty 0x0 image / throws UnknownVizError (see Electron repro).
    expect(browserPaneSource).toContain(
      "invokeDesktopCommand<PageCapture>('desktop_browser_capture_page', { webContentsId })",
    );
  });

  test('pre-regression reveal: true would have opened the panel (the behavior 4bed3589 removed)', () => {
    useUIStore.getState().openContextBrowser(DIRECTORY, AGENT_URL, { reveal: true });
    const panel = useUIStore.getState().contextPanelByDirectory[DIRECTORY];
    expect(panel?.isOpen).toBe(true);
    expect(panel?.activeTabId).toBe(panel?.tabs.find((tab) => tab.mode === 'browser')?.id);
  });
});