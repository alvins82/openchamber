// Reproduction for https://github.com/openchamber/openchamber/issues/2948
//
// Scenario: a session is running (busy) in opencode. The web tab is closed and
// reopened. The reconnecting global-message-stream WebSocket client connects
// WITHOUT `lastEventId` (fresh page load => frontend `lastEventId` is
// undefined, see packages/ui/src/sync/event-pipeline.ts). Because
// `globalHub.replayAfter(eventId)` returns `[]` when `eventId` is empty
// (global-hub.js:150-151), the reconnecting client is never replayed the
// `server.connected` + `session.status(busy)` snapshot the hub buffered when
// it dialed opencode at server start. And because the hub is a process
// singleton passed in as `globalEventHub` (ownsGlobalHub=false,
// runtime.js:79), it is never stopped/restarted when clients leave, so the
// upstream SSE is never re-dialed to obtain a fresh snapshot.
//
// Result: after a tab refresh, if the busy session is in a quiet period (no
// new events), the UI shows the session as not running / no live updates.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from './global-hub.js';
import { createMessageStreamWsRuntime } from './runtime.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closeCalls = [];
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  ping() {
    void 0;
  }

  close(code, reason) {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.closeCalls.push({ code, reason });
    this.emit('close');
  }
}

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              const next = blocks[index++];
              return { value: encoder.encode(next), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRuntimeWithSingletonHub({ fetchImpl }) {
  const server = new EventEmitter();
  const wsClients = new Set();
  let fetchCalls = 0;

  // Process-level singleton hub created at server start (server/index.js:782).
  // Passed explicitly => ownsGlobalHub=false (runtime.js:79): it is never
  // stopped while no WS clients are connected.
  const globalHub = createGlobalMessageStreamHub({
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    upstreamReconnectDelayMs: 0,
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      return fetchImpl(url, options, fetchCalls);
    },
  });

  const runtime = createMessageStreamWsRuntime({
    server,
    uiAuthController: null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {
      throw new Error('upgrade should not be used in this test');
    },
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    processForwardedEventPayload() {},
    wsClients,
    globalEventHub: globalHub,
    upstreamReconnectDelayMs: 0,
  });

  return {
    runtime,
    globalHub,
    server,
    getFetchCalls: () => fetchCalls,
  };
}

const SNAPSHOT_BLOCKS = [
  // opencode pushes `server.connected` + the initial session.status(busy)
  // snapshot when the hub dials /global/event at server start.
  'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
  'id: evt-2\ndata: {"type":"session.status","properties":{"sessionID":"ses_1","status":{"type":"busy"}}}\n\n',
];

describe('issue #2948: reconnected WS client without lastEventId misses the busy snapshot', () => {
  it('a client that connects with a lastEventId gets the buffered snapshot', async () => {
    const { runtime, globalHub, getFetchCalls } = createRuntimeWithSingletonHub({
      fetchImpl: (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: SNAPSHOT_BLOCKS,
      }),
    });

    try {
      // First page load: hub dials opencode and buffers the snapshot.
      const clientA = new FakeSocket();
      runtime.wsServer.emit('connection', clientA, { url: '/api/global/event/ws' });
      await sleep(30);

      expect(clientA.sent).toContainEqual({ type: 'ready', scope: 'global' });
      expect(clientA.sent).toContainEqual({
        type: 'event',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
        eventId: 'evt-2',
        directory: 'global',
      });

      // Tab closed. Hub keeps running (ownsGlobalHub=false).
      clientA.close();
      await sleep(10);

      // Reopened tab reconnects WITH lastEventId: replayAfter('evt-1') must
      // deliver the buffered evt-2 snapshot.
      const clientB = new FakeSocket();
      runtime.wsServer.emit('connection', clientB, { url: '/api/global/event/ws?lastEventId=evt-1' });
      await sleep(30);

      expect(getFetchCalls()).toBe(1); // no new upstream dial
      expect(clientB.sent).toContainEqual({ type: 'ready', scope: 'global' });
      expect(clientB.sent).toContainEqual({
        type: 'event',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
        eventId: 'evt-2',
        directory: 'global',
      });

      clientB.close();
    } finally {
      globalHub.stop();
      await runtime.close();
    }
  });

  it('a reconnecting client WITHOUT lastEventId (tab refresh) receives the buffered busy snapshot', async () => {
    const { runtime, globalHub, getFetchCalls } = createRuntimeWithSingletonHub({
      fetchImpl: (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: SNAPSHOT_BLOCKS,
      }),
    });

    try {
      // First page load: hub dials opencode and buffers the snapshot.
      const clientA = new FakeSocket();
      runtime.wsServer.emit('connection', clientA, { url: '/api/global/event/ws' });
      await sleep(30);

      expect(clientA.sent).toContainEqual({ type: 'ready', scope: 'global' });
      expect(clientA.sent.some(
        (frame) => frame.type === 'event' && frame.payload?.type === 'session.status',
      )).toBe(true);

      // Tab closed. Hub keeps running (ownsGlobalHub=false) — no re-dial, no
      // fresh snapshot.
      clientA.close();
      await sleep(10);

      // Tab reopened: the frontend connects WITHOUT lastEventId
      // (event-pipeline.ts: lastEventId is undefined on a fresh page load).
      const clientB = new FakeSocket();
      runtime.wsServer.emit('connection', clientB, { url: '/api/global/event/ws' });
      await sleep(30);

      expect(getFetchCalls()).toBe(1); // hub was never restarted
      expect(clientB.sent).toContainEqual({ type: 'ready', scope: 'global' });

      // BUG (#2948): replayAfter('') returns [] (global-hub.js:150-151), so
      // the buffered session.status(busy) snapshot is never replayed.
      // This assertion fails on current code, demonstrating the bug.
      expect(clientB.sent).toContainEqual({
        type: 'event',
        payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } },
        eventId: 'evt-2',
        directory: 'global',
      });

      clientB.close();
    } finally {
      globalHub.stop();
      await runtime.close();
    }
  });
});
