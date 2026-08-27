/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3175
 *
 * Simulates the exact DOM state the closed ContextPanel produces for a
 * background agent browser tab (ContextPanel.tsx lines ~1072-1092):
 *
 *   <aside style="width: 0; overflow-x: clip" inert>
 *     ... <BrowserPane> -> <webview>
 *
 * browser.capture then calls desktop_browser_capture_page in
 * packages/electron/main.mjs, which runs webContents.capturePage() on the
 * webview. On macOS this throws `UnknownVizError`; in this Linux/Xvfb
 * software-composited run it returns an empty 0x0 image. Either way the agent
 * receives no usable screenshot while the panel is closed. Opening the panel
 * restores a real composited surface and the identical capture succeeds.
 *
 * Run from packages/electron:
 *   xvfb-run -a ./node_modules/electron/dist/electron --no-sandbox \
 *     /path/to/repro-unknown-viz.mjs
 */
import { app, BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';

const results = [];
const record = (name, value) => {
  results.push(`${name}=${value}`);
  console.log(`[repro] ${name}: ${value}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Matches the closed-panel style from ContextPanel.tsx (`width: 0` +
// `overflow-x: clip`, content `opacity-0`) and the mounted BrowserPane webview.
const PANEL_HTML = (panelClass) => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #333; }
  .panel {
    position: absolute;
    right: 0; top: 0; bottom: 0;
    width: 0;
    overflow-x: clip;
    background: #fff;
    opacity: 0;
    pointer-events: none;
  }
  .panel.open { width: 480px; opacity: 1; }
  webview { width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
  <div id="panel" class="panel ${panelClass}">
    <webview id="browser" partition="persist:repro-3175" src="https://example.com/"></webview>
  </div>
</body>
</html>`;

let webviewContents = null;
let domReady = false;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true },
  });

  win.webContents.on('did-attach-webview', (_event, contents) => {
    webviewContents = contents;
    contents.on('dom-ready', () => { domReady = true; });
  });

  const capture = async (label) => {
    if (!webviewContents) {
      record(label, 'no-webview');
      return;
    }
    try {
      const image = await webviewContents.capturePage();
      const { width, height } = image.getSize();
      record(label, `${image.isEmpty() ? 'EMPTY' : 'ok'}:${width}x${height}`);
    } catch (error) {
      record(label, `threw:${error.message}`);
    }
  };

  try {
    // Phase 1: panel closed (the 4bed3589 regression state, reveal: false).
    await win.loadURL('data:text/html,' + encodeURIComponent(PANEL_HTML('')));
    const deadline = Date.now() + 20000;
    while (!domReady && Date.now() < deadline) await sleep(100);
    await sleep(1500);

    const rect = await win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('browser').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`,
    );
    record('webviewRectClosed', JSON.stringify(rect));
    await capture('captureWhilePanelClosed');

    // Phase 2: open the panel (pre-regression behavior, reveal: true).
    await win.webContents.executeJavaScript(
      `document.getElementById('panel').classList.add('open'); true`,
    );
    await sleep(1500);

    const rectOpen = await win.webContents.executeJavaScript(
      `(() => { const r = document.getElementById('browser').getBoundingClientRect(); return { w: r.width, h: r.height }; })()`,
    );
    record('webviewRectOpen', JSON.stringify(rectOpen));
    await capture('captureAfterPanelOpened');
  } catch (error) {
    record('harness', `threw:${error.message}`);
  }

  writeFileSync('/tmp/opencode/repro/results.txt', results.join('\n') + '\n');
  app.exit(0);
});