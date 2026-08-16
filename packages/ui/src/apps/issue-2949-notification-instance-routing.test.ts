import { beforeEach, describe, expect, test } from 'bun:test';

import { parseDeepLink } from './deepLinks';
import { getRuntimeKey, initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { useSessionUIStore } from '@/sync/session-ui-store';

// Reproduction for https://github.com/openchamber/openchamber/issues/2949
//
// "Clicking a notification from another instance errors instead of routing to
// the owning instance."
//
// The desktop notification click path is:
//
//   1. The server emits a desktop notification whose payload is only
//      `{ kind, title, body, tag, sessionId, directory, requireHidden }`
//      (see packages/web/server/lib/notifications/runtime.js).
//   2. Electron main shows the native notification and on click emits
//      `openchamber:open-session` with `{ sessionId, directory }` only
//      (see packages/electron/main.mjs `notification.on('click')`).
//   3. The UI handler applies it with
//      `useSessionUIStore.getState().setCurrentSession(sessionId, directory)`
//      (see packages/ui/src/App.tsx `openchamber:open-session` listener), and
//      deepLinkNavigation does the same for `type: 'session'` intents
//      (see packages/ui/src/apps/deepLinkNavigation.ts `execute`).
//
// None of these steps carries the owning instance (server URL / instance id),
// so the session is resolved against the *currently connected* instance only.
// For a session owned by another instance that fails — the app never switches
// to the instance that owns the session.
//
// These tests exercise the real modules to pin down that behavior.

const LOCAL_API_BASE_URL = 'http://127.0.0.1:3456';
const REMOTE_SESSION_ID = 'ses_remote_instance_123';
const REMOTE_DIRECTORY = '/home/remote/project';

beforeEach(() => {
  // The desktop app is connected to the LOCAL instance (issue repro step 1).
  initializeRuntimeEndpoint({ apiBaseUrl: LOCAL_API_BASE_URL, runtimeKey: 'local' });
  expect(getRuntimeKey()).toBe('local');

  useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
});

describe('issue #2949 — deep-link vocabulary has no owning-instance field', () => {
  test('session intents carry only sessionId (+ directory), never an instance', () => {
    const intent = parseDeepLink(`openchamber://session/${REMOTE_SESSION_ID}`);
    expect(intent).toEqual({ type: 'session', sessionId: REMOTE_SESSION_ID });
  });

  test('instance-ish query parameters are dropped — the vocabulary has no place for them', () => {
    // A notification sender that DID try to include the owning instance has
    // nowhere to put it: parseDeepLink only knows sessionId + dir.
    const intent = parseDeepLink(
      `openchamber://session/${REMOTE_SESSION_ID}?instance=remote-host&serverUrl=https%3A%2F%2Fremote.example&dir=${encodeURIComponent(REMOTE_DIRECTORY)}`,
    );
    expect(intent).toEqual({ type: 'session', sessionId: REMOTE_SESSION_ID, directory: REMOTE_DIRECTORY });
    if (intent?.type !== 'session') throw new Error('expected session intent');
    expect('instance' in intent).toBe(false);
  });

  test('the server-built deep-link URL the web path navigates to names no instance', () => {
    // buildSessionDeepLinkUrl() in the notification runtime produces exactly
    // this: `/?session=<id>`. The app's URL router then applies it via
    // setCurrentSession on the current instance (useRouter.ts applyRoute).
    const intent = parseDeepLink(`openchamber://session/${REMOTE_SESSION_ID}`);
    expect(intent?.type).toBe('session');
    if (intent?.type !== 'session') throw new Error('expected session intent');
    expect(intent.sessionId).toBe(REMOTE_SESSION_ID);
    expect('instance' in intent).toBe(false);
  });
});

describe('issue #2949 — notification click resolves the session on the current instance only', () => {
  test('the click-handler call (setCurrentSession) never switches instances', () => {
    // This is exactly what the `openchamber:open-session` handler in App.tsx
    // and deepLinkNavigation.execute do on a notification click — the payload
    // has no instance info, so no switchRuntimeEndpoint can happen.
    useSessionUIStore.getState().setCurrentSession(REMOTE_SESSION_ID, REMOTE_DIRECTORY);

    // The app now believes it is viewing the remote session ...
    expect(useSessionUIStore.getState().currentSessionId).toBe(REMOTE_SESSION_ID);
    expect(useSessionUIStore.getState().currentSessionDirectory).toBe(REMOTE_DIRECTORY);

    // ... while STILL being connected to the local instance. The remote
    // session does not exist there, so the session/message fetch (started by
    // setCurrentSession) fails and the UI shows an error instead of routing
    // to the owning instance. This is the bug from #2949.
    expect(getRuntimeKey()).toBe('local');
  });
});