import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNotificationTriggerRuntime } from './runtime.js';

// Reproduction for https://github.com/openchamber/openchamber/issues/2949
//
// "Clicking a notification from another instance errors instead of routing to
// the owning instance."
//
// The trigger runtime builds the desktop notification payload and the web-push
// deep-link URL that the app later turns into navigation on click. Today both
// carry only `sessionId` (+ `directory`): there is no owning-instance identity
// (server URL / instance id / runtime key) anywhere in the payload, so the
// click handler has no way to switch the app to the instance that owns the
// session and resolves the deep link against the currently-connected instance
// instead — which errors for sessions owned by another instance.
//
// These tests lock in the current payload shape so the missing instance field
// is explicit. A fix (adding the owning instance to the payload / deep link)
// must update these expectations.

const SESSION_ID = 'ses_remote_instance_123';
const DIRECTORY = '/home/remote/project';

// OpenCode SSE payload for an assistant completion (the trigger for a
// "ready" notification), as delivered through openCodeWatcherRuntime.
const buildAssistantCompletionPayload = (directory) => ({
  type: 'message.updated',
  properties: {
    directory,
    info: {
      sessionID: SESSION_ID,
      role: 'assistant',
      finish: 'stop',
      id: 'msg_1',
      modelID: 'claude-sonnet',
      mode: 'agent',
      parts: [{ type: 'text', text: 'task complete' }],
    },
  },
});

const INSTANCE_IDENTITY_KEYS = [
  'instance',
  'instanceId',
  'instanceID',
  'serverId',
  'serverID',
  'serverUrl',
  'apiBaseUrl',
  'runtimeKey',
  'hostId',
  'host',
];

const createRuntime = (overrides = {}) => {
  const emitDesktopNotification = vi.fn();
  const broadcastUiNotification = vi.fn();
  const sendPushToAllUiSessions = vi.fn(async () => {});
  const sendApnsToAllUiSessions = vi.fn(async () => {});

  const runtime = createNotificationTriggerRuntime({
    readSettingsFromDisk: async () => ({
      notifyOnSubtasks: true,
      notifyOnCompletion: true,
      notifyOnError: true,
      notifyOnQuestion: true,
      notificationMode: 'always',
      nativeNotificationsEnabled: true,
      notificationTemplates: {},
    }),
    prepareNotificationLastMessage: async ({ message }) => (typeof message === 'string' ? message : ''),
    buildTemplateVariables: async () => ({ session_name: 'remote task' }),
    extractLastMessageText: () => '',
    fetchLastAssistantMessageText: async () => 'task complete',
    resolveNotificationTemplate: (template) => (typeof template === 'string' ? template : ''),
    shouldApplyResolvedTemplateMessage: () => true,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    isAnyInteractiveClientVisible: () => false,
    buildOpenCodeUrl: (path) => `http://127.0.0.1:3456${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    ...overrides,
  });
  runtime.setGetIsWindowFocused(() => false);
  return {
    runtime,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
  };
};

beforeEach(() => {
  // Session-goal / parent checks fetch `/session/<id>`; a non-OK response
  // makes both helpers fall through to normal notification behavior.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('issue #2949 — notification payload carries no owning-instance identity', () => {
  it('desktop notification payload only carries sessionId/directory, no instance identity', async () => {
    const { runtime, emitDesktopNotification } = createRuntime();

    await runtime.maybeSendPushForTrigger(buildAssistantCompletionPayload(undefined));

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    const payload = emitDesktopNotification.mock.calls[0][0];

    expect(payload).toMatchObject({
      kind: 'ready',
      title: '{agent_name} is ready',
      body: '{model_name} completed the task',
      tag: `ready-${SESSION_ID}`,
      sessionId: SESSION_ID,
      directory: undefined,
      requireHidden: false,
    });

    // The payload the desktop click handler receives has NO way to know which
    // instance owns the session — this is the root cause of #2949.
    const instanceKeys = Object.keys(payload).filter((key) => INSTANCE_IDENTITY_KEYS.includes(key));
    expect(instanceKeys).toEqual([]);
  });

  it('desktop notification payload keeps directory but still carries no instance identity', async () => {
    const { runtime, emitDesktopNotification } = createRuntime();

    await runtime.maybeSendPushForTrigger(buildAssistantCompletionPayload(DIRECTORY));

    expect(emitDesktopNotification).toHaveBeenCalledTimes(1);
    const payload = emitDesktopNotification.mock.calls[0][0];

    expect(payload.directory).toBe(DIRECTORY);
    expect(payload.sessionId).toBe(SESSION_ID);

    const instanceKeys = Object.keys(payload).filter((key) => INSTANCE_IDENTITY_KEYS.includes(key));
    expect(instanceKeys).toEqual([]);
  });

  it('web-push deep-link URL is /?session=<id> with no instance identity', async () => {
    const { runtime, sendPushToAllUiSessions } = createRuntime();

    await runtime.maybeSendPushForTrigger(buildAssistantCompletionPayload(undefined));

    expect(sendPushToAllUiSessions).toHaveBeenCalledTimes(1);
    const pushPayload = sendPushToAllUiSessions.mock.calls[0][0];

    // The URL a click resolves is the bare session deep link — it names the
    // session but never the instance that owns it.
    expect(pushPayload.data.url).toBe(`/?session=${SESSION_ID}`);
    expect(pushPayload.data.sessionId).toBe(SESSION_ID);

    const dataKeys = Object.keys(pushPayload.data);
    const instanceKeys = dataKeys.filter((key) => INSTANCE_IDENTITY_KEYS.includes(key));
    expect(instanceKeys).toEqual([]);
  });
});