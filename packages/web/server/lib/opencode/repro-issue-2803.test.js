import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';

// Reproduction for issue #2803:
// "Session Retention settings ('When sessions expire') are not persisted to settings.json"
//
// The UI autosaves `sessionRetentionAction` through updateDesktopSettings
// (packages/ui/src/lib/appearanceAutoSave.ts), but the server whitelist in
// sanitizeSettingsUpdate drops it on the write path, and formatSettingsResponse
// drops it on the read path. autoDeleteEnabled / autoDeleteAfterDays survive.
const createTestHelpers = () => createSettingsHelpers({
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
  normalizeStringArray: (input) => input,
  sanitizeModelRefs: () => undefined,
  sanitizeSkillCatalogs: () => undefined,
  sanitizeProjects: () => undefined,
});

describe('issue #2803: sessionRetentionAction persistence', () => {
  it('keeps sessionRetentionAction in sanitizeSettingsUpdate (write path)', () => {
    const helpers = createTestHelpers();

    const sanitized = helpers.sanitizeSettingsUpdate({
      autoDeleteEnabled: true,
      autoDeleteAfterDays: 60,
      sessionRetentionAction: 'delete',
    });

    expect(sanitized.autoDeleteEnabled).toBe(true);
    expect(sanitized.autoDeleteAfterDays).toBe(60);
    // Currently failing: sanitizeSettingsUpdate has no whitelist entry for
    // sessionRetentionAction, so it is stripped before mergePersistedSettings
    // writes it to settings.json.
    expect(sanitized.sessionRetentionAction).toBe('delete');
  });

  it('rejects invalid sessionRetentionAction values', () => {
    const helpers = createTestHelpers();

    expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: 'purge' })).toEqual({});
    expect(helpers.sanitizeSettingsUpdate({ sessionRetentionAction: 'archive' })).toEqual({
      sessionRetentionAction: 'archive',
    });
  });

  it('keeps sessionRetentionAction in formatSettingsResponse (read path)', () => {
    const helpers = createTestHelpers();

    const response = helpers.formatSettingsResponse({
      themeId: 'openchamber',
      autoDeleteEnabled: true,
      autoDeleteAfterDays: 60,
      sessionRetentionAction: 'delete',
    });

    // Currently failing: formatSettingsResponse spreads sanitizeSettingsUpdate
    // output, which strips sessionRetentionAction from the GET response, so the
    // UI cannot re-hydrate the persisted value after restart.
    expect(response.sessionRetentionAction).toBe('delete');
  });
});
