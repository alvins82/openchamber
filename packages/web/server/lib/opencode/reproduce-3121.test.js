// Reproduction for https://github.com/openchamber/openchamber/issues/3121
//
// "Update OpenCode" always fails with a bare "Bad Request" toast. The upstream
// opencode server (>= 1.18.x) rejects POST /global/upgrade when the JSON body
// lacks a `target` field, and its rejection payload is `{ name, data: { message } }`.
// OpenChamber forwards the empty body verbatim and then reads `payload?.error`,
// which is undefined for that shape, so the real message ("Missing key at
// [target]") is dropped and the UI sees only the HTTP statusText "Bad Request".
//
// This test pins the current behavior against the exact upstream 400 shape
// observed with opencode 1.18.22 / 1.18.23. The two assertions that fail once
// the bug is fixed are marked below.

import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Exact body and payload returned by opencode 1.18.23 for `POST /global/upgrade`
// with an empty `{}` body (verified against a live 1.18.23 server). The real
// HTTP response also carries the `Bad Request` statusText.
const upstreamBadRequestBody = JSON.stringify({
  name: 'BadRequest',
  data: {
    message: 'Missing key\n  at ["target"]',
    kind: 'Payload',
  },
});

const upstreamBadRequest = () => new Response(upstreamBadRequestBody, {
  status: 400,
  statusText: 'Bad Request',
  headers: { 'Content-Type': 'application/json' },
});

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    getOpenCodeUpgradeCapability: () => ({
      supported: true,
      manager: 'opencode',
      reason: null,
    }),
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic dGVzdDp0ZXN0' }),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('reproduce #3121: OpenCode upgrade with no target', () => {
  it('forwards an empty body to /global/upgrade when no target is supplied', async () => {
    globalThis.fetch = vi.fn(async () => upstreamBadRequest());
    const { app } = createApp();

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(400);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalThis.fetch.mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:4096/global/upgrade');
    // The empty body is what triggers upstream's 400. This is the bug: no
    // `target` is resolved from /api/opencode/upgrade-status first.
    expect(init.body).toBe('{}');
  });

  it('drops the upstream message and surfaces only the HTTP statusText', async () => {
    globalThis.fetch = vi.fn(async () => upstreamBadRequest());
    const { app } = createApp();

    const response = await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(400);

    // The upstream message is "Missing key\n  at [\"target\"]" but the UI only
    // ever sees "Bad Request". This assertion pins the buggy behavior.
    expect(response.body).toEqual({
      success: false,
      error: 'Bad Request',
    });
  });
});