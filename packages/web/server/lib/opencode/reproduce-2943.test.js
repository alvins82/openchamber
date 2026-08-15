// Reproduction for https://github.com/openchamber/openchamber/issues/2943
//
// [Bug] Managed OpenCode restart silently strands active sessions
//
// Reported behavior: when the managed OpenCode server becomes unhealthy while
// sessions are busy, OpenChamber force-restarts it after the failure threshold
// and the 2-minute stale-busy grace, but every in-flight turn is silently
// stranded: no terminal error, no interrupted state, no notification, no retry
// action. Sessions only become usable after another user message.
//
// This test wires the session runtime and the lifecycle runtime together the
// same way `packages/web/server/index.js` does (`getActiveSessionCount` from
// the session runtime, `onOpenCodeRestarted` bound to the message-stream
// rebind), drives the health-check failure threshold while sessions are busy,
// and observes what happens to the busy sessions after the forced restart.
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionRuntime } from './session-runtime.js';

const spawnMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  spawnMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

describe('issue #2943: managed OpenCode restart and busy sessions', () => {
  it('strands busy sessions after a forced restart (no idle/aborted transition, no notification)', async () => {
    // --- Session runtime, wired like index.js -----------------------------
    const broadcastEvents = [];
    const sessionRuntime = createSessionRuntime({
      writeSseEvent() {
        throw new Error('SSE fallback should not be used when broadcastEvent is provided');
      },
      getNotificationClients: () => new Set(),
      broadcastEvent: (payload) => {
        broadcastEvents.push(payload);
      },
    });

    // Three concurrent long-lived sessions report busy (as in the incident log:
    // "OpenCode unhealthy with 3 busy session(s)").
    for (const sessionId of ['ses_1', 'ses_2', 'ses_3']) {
      sessionRuntime.processOpenCodeSsePayload({
        type: 'session.status',
        properties: { sessionID: sessionId, status: { type: 'busy' } },
      });
    }
    expect(sessionRuntime.getActiveSessionCount()).toBe(3);

    // --- Lifecycle runtime, wired like index.js ---------------------------
    const onOpenCodeRestarted = vi.fn(); // index.js binds messageStreamRuntime.rebindUpstream()
    let nowMs = 1_700_000_000_000;

    const state = {
      openCodeWorkingDirectory: '/tmp/project',
      openCodeProcess: null,
      openCodePort: null,
      openCodeBaseUrl: null,
      currentRestartPromise: null,
      isRestartingOpenCode: false,
      openCodeApiPrefix: '',
      openCodeApiPrefixDetected: false,
      openCodeApiDetectionTimer: null,
      lastOpenCodeError: null,
      isOpenCodeReady: true,
      openCodeNotReadySince: 0,
      isExternalOpenCode: false,
      isShuttingDown: false,
      healthCheckInterval: null,
      expressApp: null,
      useWslForOpencode: false,
      resolvedWslBinary: null,
      resolvedWslOpencodePath: null,
      resolvedWslDistro: null,
    };

    const runtime = createOpenCodeLifecycleRuntime({
      state,
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 3001,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: false,
      },
      syncToHmrState: vi.fn(),
      syncFromHmrState: vi.fn(),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
      waitForReady: vi.fn(async () => true),
      normalizeApiPrefix: vi.fn(() => ''),
      applyOpencodeBinaryFromSettings: vi.fn(async () => null),
      ensureOpencodeCliEnv: vi.fn(),
      ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
      resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
      setOpenCodePort: vi.fn((port) => {
        state.openCodePort = port;
      }),
      setDetectedOpenCodeApiPrefix: vi.fn(),
      setupProxy: vi.fn(),
      ensureOpenCodeApiPrefix: vi.fn(),
      clearResolvedOpenCodeBinary: vi.fn(),
      buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
      buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
      getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
        PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
        SHELL_ONLY: 'yes',
        OPENCODE_SERVER_PASSWORD: 'shell-password',
      })),
      // index.js: getActiveSessionCount = () => sessionRuntime.getActiveSessionCount()
      getActiveSessionCount: () => sessionRuntime.getActiveSessionCount(),
      // index.js: onOpenCodeRestarted = () => messageStreamRuntime?.rebindUpstream()
      onOpenCodeRestarted,
      now: () => nowMs,
    });

    // The health endpoint stops responding while the process is still alive.
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));

    // The managed process is still alive (hung), so failures accumulate.
    const close = vi.fn(async () => {});
    state.openCodeProcess = {
      pid: null,
      exitCode: null,
      signalCode: null,
      close,
    };
    state.openCodePort = 45678;

    // --- Phase 1: health failures accumulate while sessions stay busy ----
    // 20 failures at one per 15s interval (HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES).
    for (let i = 0; i < 20; i += 1) {
      await runtime.triggerHealthCheck();
      nowMs += 15_000;
    }
    // The 20th failure reached the threshold but the busy-session grace
    // skips the restart (shouldSkipRestartForBusySessions -> true).
    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
    expect(sessionRuntime.getActiveSessionCount()).toBe(3);

    // --- Phase 2: stale-busy grace expires, restart is forced ------------
    // Advance past the 2-minute stale-busy grace (STALE_BUSY_GRACE_MS).
    nowMs += 2 * 60 * 1000;
    // The replacement process comes up healthy on the (new) port.
    const replacement = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });

    await runtime.triggerHealthCheck();

    // Restart succeeded and the event stream was rebound.
    expect(close).toHaveBeenCalledTimes(1);
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);

    // ------------------------------------------------------------------
    // Reproduction assertions — the bug:
    //
    // After the forced restart, the busy sessions are NOT reconciled:
    // 1. The session runtime still reports all 3 sessions busy.
    // 2. No terminal `session.status` idle/aborted event was emitted.
    // 3. No notification (openchamber:notification) was emitted.
    //    => The UI keeps the turn stranded with no retry/error surface.
    // ------------------------------------------------------------------
    expect(sessionRuntime.getActiveSessionCount()).toBe(3);
    expect(sessionRuntime.getSessionStateSnapshot()).toEqual({
      ses_1: expect.objectContaining({ status: 'busy' }),
      ses_2: expect.objectContaining({ status: 'busy' }),
      ses_3: expect.objectContaining({ status: 'busy' }),
    });
    expect(sessionRuntime.getSessionActivitySnapshot()).toEqual({
      ses_1: { type: 'busy' },
      ses_2: { type: 'busy' },
      ses_3: { type: 'busy' },
    });

    const terminalStatusEvents = broadcastEvents.filter(
      (event) => (
        event.type === 'openchamber:session-status'
        && (event.properties.status === 'idle' || event.properties.status === 'aborted' || event.properties.status === 'error')
      ),
    );
    expect(terminalStatusEvents).toEqual([]);

    const notifications = broadcastEvents.filter((event) => event.type === 'openchamber:notification');
    expect(notifications).toEqual([]);

    sessionRuntime.dispose();
  });
});
