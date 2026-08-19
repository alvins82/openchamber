import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../opencode/auth.js', () => ({
  readAuthFile: () => ({ 'zai-coding-plan': { key: 'test-key' } }),
}));

import { fetchQuota } from './zai.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const okResponse = (body) => ({
  ok: true,
  status: 200,
  json: async () => body,
});

const errResponse = (body) => ({
  ok: false,
  status: 401,
  json: async () => body,
});

describe('Z.ai quota provider reproduction for #3012', () => {
  it('BUG: ignores CREDIT_LIMIT entries returned by the current Z.ai API (live payload)', async () => {
    // The exact payload the issue reporter got from the WORKING path
    // https://api.z.ai/api/monitor/usage — the adapter only ever queries the
    // legacy path, but this isolates the type-filter problem.
    const livePayload = {
      code: 200,
      msg: 'Operation successful',
      data: {
        limits: [
          {
            type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000,
            currentValue: 1653, remaining: 346, percentage: 82,
            nextResetTime: 1787176502893,
          },
          {
            type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000,
            currentValue: 4562, remaining: 5437, percentage: 45,
            nextResetTime: 1787607163997,
          },
        ],
        level: 'lite',
      },
      success: true,
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(livePayload)));

    const result = await fetchQuota();
    const windows = result.usage?.windows ?? {};

    // The adapter filters on type === 'TOKENS_LIMIT', but Z.ai now returns
    // CREDIT_LIMIT, so every window is dropped -> "No rate limits reported".
    expect(Object.keys(windows)).toEqual([]);
    expect(windows['5h']).toBeUndefined();
    expect(windows['weekly']).toBeUndefined();
  });

  it('BUG: hardcoded endpoint /api/monitor/usage/quota/limit returns 401 for valid keys', async () => {
    // The adapter requests the legacy path regardless of the payload. With a
    // 401 (as the reporter's curl showed), fetchQuota returns ok:false.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errResponse({
      code: 401,
      msg: 'token expired or incorrect',
      success: false,
    })));

    const result = await fetchQuota();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/401/);
    expect(result.usage).toBeNull();
  });
});
