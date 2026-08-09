// Reproduction test for issue #2780:
// "OpenCode small_model config not taken into account"
//
// Reported behavior: a `small_model` defined in the OpenCode config does not
// populate the small model picker in the OpenChamber settings dialog — the
// drop-down is empty.
//
// Data flow today:
//   1. Server-side small-model resolution (resolve.js) DOES honor the OpenCode
//      `small_model` config — `GET /api/small-model` reports it as the resolved
//      model (`source: 'config'`).
//   2. The settings dialog (`DefaultsSettings.tsx`) never consumes that. Its
//      small model override picker is populated exclusively from OpenChamber's
//      own `smallModelOverride` setting, loaded via `GET /api/config/settings`
//      (formatSettingsResponse over OpenChamber's settings.json).
//   3. With only the OpenCode config's `small_model` set (no OpenChamber
//      `smallModelOverride`), the settings payload has no small-model value, so
//      `getDisplayModel(undefined)` yields `{ providerId: '', modelId: '' }` and
//      the picker renders empty ("Not selected").
//
// The three tests below demonstrate exactly that gap.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelIdentifier } from '@openchamber/ui/lib/modelIdentifier';
import { createSettingsHelpers } from '../opencode/settings-helpers.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';

// The settings override is read straight from disk at module load; an empty
// data dir simulates a fresh OpenChamber install with no override set.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-2780-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

vi.mock('../opencode/auth.js', () => ({ readAuthFile: vi.fn() }));
vi.mock('../opencode/shared.js', () => ({
  readConfig: vi.fn(),
  readConfigLayers: vi.fn(),
}));
vi.mock('./catalog.js', () => ({
  getModelCatalog: vi.fn(),
  getCatalogProvider: vi.fn(),
}));
vi.mock('./call.js', () => ({
  callSmallModel: vi.fn(),
  resolveProviderLogin: vi.fn(({ auth, providerID }) => {
    const entry = auth?.[providerID];
    return entry && typeof entry === 'object' ? entry : null;
  }),
}));

const { describeSmallModel } = await import('./index.js');
const { readAuthFile } = await import('../opencode/auth.js');
const { readConfigLayers } = await import('../opencode/shared.js');
const { getModelCatalog } = await import('./catalog.js');

const CATALOG = {
  anthropic: {
    id: 'anthropic',
    models: {
      'claude-haiku-4-5': { id: 'claude-haiku-4-5', limit: { context: 8_000 }, structured_output: true },
    },
  },
};

// Same helper wiring as settings-helpers.test.js's createTestHelpersWithRealSanitizers,
// so formatSettingsResponse behaves like production.
const createTestHelpers = () => {
  const runtime = createSettingsNormalizationRuntime({
    os: { homedir: () => '/home/testuser' },
    path: {
      resolve: (...args) => args[args.length - 1],
      sep: '/',
      dirname: (p) => p.split('/').slice(0, -1).join('/') || '/',
    },
    processLike: { platform: 'linux', env: {} },
    realpathSync: (p) => p,
    tunnelBootstrapTtlDefaultMs: 600000,
    tunnelBootstrapTtlMinMs: 60000,
    tunnelBootstrapTtlMaxMs: 3600000,
    tunnelSessionTtlDefaultMs: 86400000,
    tunnelSessionTtlMinMs: 3600000,
    tunnelSessionTtlMaxMs: 604800000,
  });
  return createSettingsHelpers({
    normalizePathForPersistence: (value) => value,
    normalizeDirectoryPath: (value) => value,
    normalizeTunnelBootstrapTtlMs: (value) => value,
    normalizeTunnelSessionTtlMs: (value) => value,
    normalizeTunnelProvider: (value) => value,
    normalizeTunnelMode: (value) => value,
    normalizeOptionalPath: (value) => value,
    normalizeManagedRemoteTunnelHostname: (value) => value,
    normalizeManagedRemoteTunnelPresets: () => undefined,
    normalizeManagedRemoteTunnelPresetTokens: () => undefined,
    sanitizeTypographySizesPartial: () => undefined,
    normalizeStringArray: runtime.normalizeStringArray,
    sanitizeModelRefs: runtime.sanitizeModelRefs,
    sanitizeSkillCatalogs: () => undefined,
    sanitizeProjects: () => undefined,
  });
};

// Mirrors `getDisplayModel` inside DefaultsSettings.tsx.
const getDisplayModel = (storedModel) => {
  const parsed = parseModelIdentifier(storedModel);
  if (parsed) {
    return parsed;
  }
  return { providerId: '', modelId: '' };
};

describe('Issue #2780 - OpenCode small_model config not taken into account', () => {
  beforeEach(() => {
    readAuthFile.mockReturnValue({ anthropic: { type: 'api', key: 'sk-ant' } });
    readConfigLayers.mockReturnValue({ mergedConfig: { small_model: 'anthropic/claude-haiku-4-5' } });
    getModelCatalog.mockResolvedValue(CATALOG);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('server-side small-model resolution DOES honor the OpenCode config small_model', async () => {
    // GET /api/small-model -> describeSmallModel(): the config small_model wins.
    const described = await describeSmallModel({ directory: '/proj' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'config',
      hasLogin: true,
    });
  });

  it('the settings payload consumed by the settings dialog carries no small-model value', () => {
    const helpers = createTestHelpers();
    // Fresh OpenChamber install: OpenChamber's settings.json has no
    // smallModelOverride, regardless of what opencode.json says.
    const response = helpers.formatSettingsResponse({});

    expect(response.smallModelOverride).toBeUndefined();
    expect(response.smallModelUseDefault).toBeUndefined();
  });

  it('reproduces the DefaultsSettings picker wiring: the override drop-down stays empty', async () => {
    // 1. What the settings dialog receives from GET /api/config/settings.
    const settingsResponse = createTestHelpers().formatSettingsResponse({});
    const smallModelOverride =
      typeof settingsResponse.smallModelOverride === 'string' && settingsResponse.smallModelOverride.trim()
        ? settingsResponse.smallModelOverride.trim()
        : undefined;

    // 2. DefaultsSettings.tsx then computes:
    //    parsedSmallModel = getDisplayModel(smallModelOverride)
    const parsedSmallModel = getDisplayModel(smallModelOverride);

    // 3. ModelSelector is rendered with providerId='' and modelId='', so the
    //    trigger shows the "not selected" placeholder — the empty drop-down
    //    reported in the issue.
    expect(parsedSmallModel).toEqual({ providerId: '', modelId: '' });

    // 4. Meanwhile the OpenCode config's small_model is only known to the
    //    small-model resolver (see first test) — the settings dialog never
    //    queries /api/small-model for the picker value, so it stays empty.
    const { mergedConfig } = readConfigLayers('/proj');
    expect(mergedConfig.small_model).toBe('anthropic/claude-haiku-4-5');
    expect(mergedConfig.small_model).not.toBe(smallModelOverride);
  });
});

afterAll(() => {
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});
