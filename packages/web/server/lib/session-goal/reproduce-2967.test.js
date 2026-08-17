// Reproduction for https://github.com/openchamber/openchamber/issues/2967
//
// Reported: the goal strip stays stuck on "评估中… / Evaluating…" forever with
// no progress, no response, and no movement.
//
// The UI renders that state (SessionGoalRow.tsx) whenever the goal metadata
// still says `status: 'active'` while the session is idle — i.e. the server
// loop is supposed to be auditing/continuing but never does anything again.
//
// These tests show that `tick()` in runtime.js has several silent-exit paths
// that neither settle the goal nor re-arm the quiet-window timer, so the loop
// dies permanently and the goal is left `active` + session `idle` forever.
// Note the asymmetry: /session/status and /session/:id/children failures DO
// re-arm (see the "retries the quiet window" test in runtime.test.js), but the
// /session/:id and /message failures below do NOT.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionGoalRuntime } from './runtime.js';

const SESSION_ID = 'ses_parent';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const assistantMessage = {
  info: {
    id: 'msg_assistant',
    sessionID: SESSION_ID,
    role: 'assistant',
    providerID: 'provider',
    modelID: 'model',
    time: { completed: 2 },
    tokens: { input: 1, output: 1, cache: { read: 0 } },
  },
  parts: [{ type: 'text', text: 'The task is still in progress.' }],
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const requestPath = (input) => new URL(typeof input === 'string' ? input : input.url).pathname;

const makeRuntime = ({ fetchImpl, getSmallModelService = vi.fn() }) => {
  vi.stubGlobal('fetch', fetchImpl);
  return createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService,
    idleQuietMs: 10,
  });
};

const sendIdleEvent = (runtime) => {
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
};

describe('reproduce #2967: goal loop stalls permanently, UI stuck on "Evaluating…"', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('a single transient /session fetch failure kills the loop: no retry, no audit, no continuation, goal stays active', async () => {
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      // One transient 500 from the OpenCode server (startup, network blip).
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ error: 'boom' }, 500);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const runtime = makeRuntime({ fetchImpl });

    sendIdleEvent(runtime);
    await vi.advanceTimersByTimeAsync(10);

    // The tick ran, the session read failed, and the loop died without
    // settling the goal or arming another quiet-window timer.
    expect(paths).toEqual([`/session/${SESSION_ID}`]);

    // The UI keeps showing "Evaluating…" as long as the goal stays active
    // and the session idle; here it never even settles (no PATCH) nor
    // continues (no prompt_async).
    await vi.advanceTimersByTimeAsync(3_600_000); // an hour later
    expect(paths).toEqual([`/session/${SESSION_ID}`]); // still dead

    runtime.stop();
  });

  it('a single transient /message fetch failure kills the loop after passing status+children gates', async () => {
    const paths = [];
    const fetchImpl = vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse({ error: 'boom' }, 500);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const runtime = makeRuntime({ fetchImpl });

    sendIdleEvent(runtime);
    await vi.advanceTimersByTimeAsync(10);

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
      `/session/${SESSION_ID}/message`,
    ]);

    // No re-arm despite the quiet-window pattern status/children failures use.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
      `/session/${SESSION_ID}/message`,
    ]);

    runtime.stop();
  });

  it('a failed continuation (prompt_async 500) leaves the goal active and never retries', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET', body: init.body });
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) return jsonResponse([assistantMessage]);
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({ error: 'boom' }, 500);
      throw new Error(`Unexpected request: ${pathname}`);
    });
    const service = {
      generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"still working"}',
        providerID: 'provider',
        modelID: 'model',
      })),
    };
    const runtime = makeRuntime({ fetchImpl, getSmallModelService: async () => service });

    sendIdleEvent(runtime);
    await vi.advanceTimersByTimeAsync(10);

    const continuationAttempts = () => requests.filter((r) => r.pathname === `/session/${SESSION_ID}/prompt_async`);
    expect(continuationAttempts()).toHaveLength(1);
    const patches = requests.filter((r) => r.pathname === `/session/${SESSION_ID}` && r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    // Accounting was persisted, but the goal was never settled: still active.
    const writtenGoal = JSON.parse(patches[0].body).metadata.openchamber.goal;
    expect(writtenGoal.status).toBe('active');

    // The tick threw after prompt_async failed; nothing re-arms the loop, so
    // the goal sits active+idle forever — the UI shows "Evaluating…".
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(continuationAttempts()).toHaveLength(1);
    expect(requests.filter((r) => r.pathname === `/session/${SESSION_ID}` && r.method === 'PATCH')).toHaveLength(1);

    runtime.stop();
  });
});