/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3079.
 *
 * Follow-up messages are queued client-side only.
 *
 * `ChatInput.handleQueueMessage` calls `useMessageQueueStore.addToQueue`, which
 * mutates a Zustand store persisted to the browser's localStorage. No request
 * reaches the OpenCode server at queue time. The only drain path is
 * `useQueuedMessageAutoSend`, a React hook mounted inside the client app. When
 * every client disconnects, queued follow-ups sit in localStorage until a
 * client reconnects; the server never processes them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opencodeClient } from '@/lib/opencode/client';
import { createMessageQueueTarget, useMessageQueueStore } from '../messageQueueStore';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

const SERVER_QUEUE_PATTERNS = [/queuedMessage/i, /messageQueue/i, /autoSend/i, /auto-send/i];

describe('issue #3079 — queuing a follow-up message is a purely client-side action', () => {
  let originalSendMessage: typeof opencodeClient.sendMessage;
  const sendCalls: unknown[] = [];

  beforeEach(() => {
    sendCalls.length = 0;
    useMessageQueueStore.setState({ queuedMessages: {}, quarantinedLegacyMessages: {}, sendingIds: {} });
    originalSendMessage = opencodeClient.sendMessage;
    opencodeClient.sendMessage = (params: unknown) => {
      sendCalls.push(params);
      return Promise.resolve('msg') as never;
    };
  });

  afterEach(() => {
    opencodeClient.sendMessage = originalSendMessage;
  });

  test('addToQueue (the ChatInput queue path) issues no server request', () => {
    const target = createMessageQueueTarget('session-1', '/remote/repo', 'runtime-a')!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'second task' });

    // The message exists only in the client-side store.
    const queue = useMessageQueueStore.getState().getQueueForTarget(target);
    expect(queue).toHaveLength(1);
    expect(queue[0]?.content).toBe('second task');

    // The server was never asked to accept or persist anything.
    expect(sendCalls).toHaveLength(0);
  });

  test('with no client connected, nothing drains the queue', async () => {
    const target = createMessageQueueTarget('session-1', '/remote/repo', 'runtime-a')!;
    useMessageQueueStore.getState().addToQueue(target, { content: 'follow up' });

    // No React client is mounted, so `useQueuedMessageAutoSend` is not running.
    // There is no server-side processor and no background timer; the message
    // just sits in the client store until a client reconnects.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sendCalls).toHaveLength(0);
    expect(useMessageQueueStore.getState().getQueueForTarget(target)).toHaveLength(1);
  });
});

describe('issue #3079 — the queue is stored and drained entirely on the client', () => {
  test('the queue store persists to browser localStorage, never to the server', () => {
    const storeSource = readFileSync(join(__dirname, '..', 'messageQueueStore.ts'), 'utf-8');
    expect(storeSource).toContain('createDeferredSafeJSONStorage');
    expect(storeSource).toContain("name: 'message-queue-store'");

    const storageSource = readFileSync(join(__dirname, '..', 'utils', 'safeStorage.ts'), 'utf-8');
    expect(storageSource).toContain("getWindowStorage('localStorage')");
  });

  test('the only drain path is the client-side useQueuedMessageAutoSend hook', () => {
    const hookSource = readFileSync(join(__dirname, '..', '..', 'hooks', 'useQueuedMessageAutoSend.ts'), 'utf-8');
    // `sendQueuedAutoSendPayload` is what actually hands a queued message to the
    // server, and it is only ever called from inside this React hook.
    expect(hookSource).toContain('export const sendQueuedAutoSendPayload');
    expect(hookSource).toContain('await sendQueuedAutoSendPayload(target, payload, {');

    // The hook is mounted in the client app shell (AppEffects), gated on the
    // session becoming idle. With the client closed it never runs.
    const appEffectsSource = readFileSync(join(__dirname, '..', '..', 'apps', 'AppEffects.tsx'), 'utf-8');
    expect(appEffectsSource).toContain('useQueuedMessageAutoSend');
  });

  test('the web server has no queued message handling at all', () => {
    const serverRoot = join(repoRoot, 'packages', 'web', 'server');
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(js|mjs|cjs|ts)$/.test(entry.name)) continue;
        const source = readFileSync(full, 'utf-8');
        for (const pattern of SERVER_QUEUE_PATTERNS) {
          if (pattern.test(source)) offenders.push(`${relative(repoRoot, full)} matched ${pattern}`);
        }
      }
    };
    walk(serverRoot);

    expect(offenders).toEqual([]);
  });
});