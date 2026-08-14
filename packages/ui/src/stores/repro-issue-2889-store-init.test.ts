import { describe, expect, test } from 'bun:test';

/**
 * Reproduction for issue #2889:
 * "Open New Session in Editor" uses previous workspace directory instead of current.
 *
 * VS Code extension flow:
 *  - Sidebar "openchamber" / "New Session" button -> command `openchamber.newSession`
 *    -> webview receives `newSession` with an EXPLICIT `directory` (the current
 *    workspace folder A) -> `openNewSessionDraft({ directoryOverride: '/ws/A' })`.
 *    This path always works.
 *
 *  - Editor "Open New Session in Editor" button -> command `openchamber.openNewSessionInEditor`
 *    -> `SessionEditorPanelProvider.createOrShowNewSession()` -> new webview panel with
 *    NO initial session id -> the webview's VSCodeLayout / ChatContainer auto-open a
 *    draft via `openNewSessionDraft({ automatic: true })` with NO explicit directory.
 *    This path resolves the draft directory from `useDirectoryStore.currentDirectory`.
 *
 * Root cause:
 *
 * `useDirectoryStore` computes `initialCurrentDirectory` at MODULE LOAD:
 *
 *   const initialCurrentDirectory = (() => {
 *     const persisted = getStoredLastDirectory();          // localStorage 'lastDirectory'
 *     if (persisted && !isVSCodeRuntime()) {               // <- isVSCodeRuntime() is FALSE
 *       return resolveDirectoryPath(persisted, initialHomeDirectory);
 *     }
 *     return initialHomeDirectory;
 *   })();
 *
 * `isVSCodeRuntime()` (lib/desktop.ts) checks the REGISTERED runtime APIs, which are
 * only registered after React mounts (VSCodeApp useEffect -> registerRuntimeAPIs).
 * At module-load time it returns `false`, so the guard that is supposed to skip the
 * persisted "last directory" in the VS Code runtime does NOT fire. The same problem
 * disables `getVsCodeWorkspaceFolder()` (line 226-236), which is also gated on the
 * registered-API check.
 *
 * Meanwhile `useProjectsStore` detects VS Code correctly at module load by checking
 * the bootstrap config (see `isVSCodeRuntime(getRegisteredRuntimeAPIs(), getVSCodeBootstrapConfig())`),
 * so the VS Code workspace projects ARE seeded — but the directory store is not.
 *
 * Consequence: with workspace folder A open and a previously used directory B still
 * in localStorage `lastDirectory` (left by a session previously run in folder B),
 * the editor panel boots `currentDirectory` to B, and the auto-opened new-session
 * draft — and the session created from it — run in folder B instead of the current
 * workspace folder A.
 *
 * The sidebar path is unaffected because it passes the explicit `directoryOverride`.
 *
 * The test simulates the VS Code webview at store-module load:
 *  - `window.__VSCODE_CONFIG__.workspaceFolder` = current workspace folder A
 *  - `window.__OPENCHAMBER_HOME__` = folder A
 *  - localStorage 'lastDirectory' = previously used folder B
 *  - runtime APIs NOT yet registered (exactly the state at store-module load)
 */

const storage = new Map<string, string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const windowGlobal = globalThis as any;

windowGlobal.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
} as Storage;

// Persisted state left by a session previously started in folder B.
storage.set('lastDirectory', '/ws/B');

windowGlobal.window = windowGlobal;
windowGlobal.location = { search: '', href: 'https://openchamber.test/', origin: 'https://openchamber.test' };
windowGlobal.__VSCODE_CONFIG__ = {
  workspaceFolder: '/ws/A',
  workspaceFolders: [{ name: 'A', path: '/ws/A' }],
};
windowGlobal.__OPENCHAMBER_HOME__ = '/ws/A';

describe('issue #2889 - "Open New Session in Editor" uses previous workspace directory', () => {
  test('editor panel directory store boots to the current workspace folder (A), not the persisted previous directory (B)', async () => {
    const { useDirectoryStore } = await import('@/stores/useDirectoryStore');

    // BUG: the store booted to the persisted previous directory, not the
    // current VS Code workspace folder A.
    expect(useDirectoryStore.getState().currentDirectory).toBe('/ws/A');
  });

  test('the new-session draft auto-opened by the editor panel is bound to the current workspace folder (A)', async () => {
    const { useSessionUIStore } = await import('@/sync/session-ui-store');

    // The editor panel webview (SessionEditorPanelProvider -> createOrShowNewSession,
    // no initial session id) auto-opens a new session draft with exactly this call:
    useSessionUIStore.getState().openNewSessionDraft({ automatic: true });

    // BUG: the new-session draft is bound to folder B, so the session created
    // from it will run in folder B instead of the current workspace folder A.
    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe('/ws/A');
  });

  test('the sidebar new-session path (explicit directoryOverride) still targets the current workspace folder (A)', async () => {
    const { useSessionUIStore } = await import('@/sync/session-ui-store');

    // Sidebar "openchamber" button -> openchamber.newSession command passes the
    // current workspace folder explicitly:
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: '/ws/A',
      selectedProjectId: 'proj-a',
    });

    expect(useSessionUIStore.getState().newSessionDraft.directoryOverride).toBe('/ws/A');
  });
});
