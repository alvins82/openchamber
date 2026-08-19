import { describe, mock, test } from 'bun:test';
import assert from 'node:assert/strict';

// Test-only mock of the `vscode` module. The real module is injected by the
// VS Code extension host at runtime and is marked `external` in the esbuild
// config, so this mock is never bundled or shipped. It is registered with
// `mock.module('vscode', ...)` before the provider is imported (via a dynamic
// import) so that `ChatViewProvider`'s `import * as vscode from 'vscode'`
// resolves to it — the same pattern used by bridge-config-runtime.test.js.
//
// The members below are only referenced at call-time by the provider's import
// graph, so no-op implementations are sufficient for this test to load the
// module and exercise `updateConnectionStatus` -> `_sendCachedState`.
mock.module('vscode', () => {
  const noopDisposable = () => ({ dispose() {} });

  return {
    ExtensionMode: { Development: 1, Production: 2, Test: 3 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    TextEditorRevealType: {
      Default: 0,
      InCenter: 1,
      InCenterIfOutsideViewport: 2,
      AtTop: 3,
    },
    Position: class {},
    Range: class {},
    Selection: class {},
    TextDocumentShowOptions: class {},
    Event: class {},
    Uri: {
      joinPath: (...parts) => ({ toString: () => parts.join('/') }),
      file: (path) => ({ fsPath: path, scheme: 'file', toString: () => path }),
      parse: (value) => ({ toString: () => value, scheme: 'file' }),
    },
    window: {
      activeColorTheme: { kind: 2 },
      state: { focused: true },
      activeTextEditor: undefined,
      onDidChangeActiveTextEditor: noopDisposable,
      onDidChangeTextEditorSelection: noopDisposable,
    },
    workspace: {
      workspaceFolders: undefined,
      fs: { stat: async () => ({ type: 1, size: 0, ctime: 0, mtime: 0 }) },
      asRelativePath: (uri) => String(uri),
      getConfiguration: () => ({ get: () => undefined }),
    },
    commands: { executeCommand: async () => undefined },
    env: {},
    extensions: {},
    git: undefined,
    l10n: { t: (value) => value },
    Disposable: { from: noopDisposable },
    diff: () => undefined,
    open: async () => undefined,
  };
});

const { ChatViewProvider } = await import('./ChatViewProvider.ts');

const createManager = () => {
  const listeners = new Set();
  let status = 'connecting';
  return {
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    setWorkingDirectory: async (path) => ({ success: true, path }),
    getStatus: () => status,
    getApiUrl: () => 'http://127.0.0.1:3902',
    getOpenCodeAuthHeaders: () => ({}),
    getWorkingDirectory: () => '/workspace',
    isCliAvailable: () => true,
    getDebugInfo: () => ({
      mode: 'managed',
      status,
      workingDirectory: '/workspace',
      cliAvailable: true,
      cliPath: null,
      configuredApiUrl: null,
      configuredPort: null,
      detectedPort: 3902,
      apiPrefix: '',
      apiPrefixDetected: true,
      startCount: 1,
      restartCount: 0,
      lastStartAt: null,
      lastConnectedAt: null,
      lastExitCode: null,
      serverUrl: 'http://127.0.0.1:3902',
      lastReadyElapsedMs: null,
      lastReadyAttempts: null,
      lastStartAttempts: null,
      version: null,
      secureConnection: false,
      authSource: null,
    }),
    onStatusChange: (callback) => {
      listeners.add(callback);
      return { dispose: () => listeners.delete(callback) };
    },
  };
};

describe('ChatViewProvider connection-status delivery (issue #2996)', () => {
  test('drops the single `connectionStatus=connected` postMessage when the webview bridge is not yet ready, and never re-sends', () => {
    const manager = createManager();
    const context = { extensionMode: 2, subscriptions: { push: () => {} } };
    const extensionUri = { scheme: 'file' };
    const provider = new ChatViewProvider(context, extensionUri, manager);

    // A webview whose message handler is not ready yet (slow multi-MB asset
    // load on a remote/WAN network). postMessage silently drops messages until
    // the "bridge ready" flag flips — mirroring VS Code dropping postMessage
    // calls sent before acquireVsCodeApi is ready.
    let bridgeReady = false;
    const posted = [];
    const webview = {
      html: '',
      options: {},
      postMessage: (message) => {
        if (!bridgeReady) {
          return false; // VS Code drops pre-bridge messages
        }
        posted.push(message);
        return true;
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
      asWebviewUri: (uri) => uri,
      cspSource: 'vscode-webview://x',
    };
    const webviewView = {
      webview,
      visible: true,
      onDidDispose: () => ({ dispose() {} }),
    };

    provider.resolveWebviewView(webviewView);

    // Extension host becomes connected while the webview is still loading
    // (bridge not ready). The only `connectionStatus=connected` send lands in
    // the drop window.
    provider.updateConnectionStatus('connected');

    // The webview finishes loading its assets and the bridge becomes ready.
    // Nothing in the provider triggers a resend.
    bridgeReady = true;

    // Give any hypothetical retry/scheduler a chance to fire.
    return new Promise((resolve) => {
      setTimeout(() => {
        const statusMessages = posted.filter((m) => m.type === 'connectionStatus');
        // BUG: no `connectionStatus=connected` message was ever delivered.
        assert.equal(
          statusMessages.length,
          0,
          'expected the single connectionStatus send to be dropped while the bridge was not ready',
        );
        assert.equal(
          posted.some((m) => m.type === 'connectionStatus' && m.status === 'connected'),
          false,
          'the webview never receives `connectionStatus=connected`, so the #initial-loading overlay stays forever',
        );
        resolve();
      }, 100);
    });
  });
});
