import { describe, expect, it } from 'vitest';

import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsNormalizationRuntime } from './settings-normalization-runtime.js';

// Reproduces https://github.com/openchamber/openchamber/issues/3046
// `editorFontSize` is silently dropped by the server sanitizer while the
// symmetric `terminalFontSize` is persisted. Reproduce only; do not fix.

const createTestHelpers = () =>
  createSettingsHelpers({
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

describe('reproduce issue 3046: editorFontSize not persisted (missing server sanitization)', () => {
  it('sanitizeSettingsUpdate persists terminalFontSize', () => {
    const helpers = createTestHelpers();
    const result = helpers.sanitizeSettingsUpdate({ terminalFontSize: 20 });
    expect(result.terminalFontSize).toBe(20);
  });

  it('sanitizeSettingsUpdate silently drops editorFontSize (BUG)', () => {
    const helpers = createTestHelpers();
    // The client sends { editorFontSize: 20 } via appearanceAutoSave ->
    // updateDesktopSettings -> PUT /api/config/settings. The sanitizer has no
    // branch for editorFontSize, so it returns {} and the value is never written.
    const result = helpers.sanitizeSettingsUpdate({ editorFontSize: 20 });
    expect(result).not.toHaveProperty('editorFontSize');
    expect(Object.keys(result)).toEqual([]);
  });

  it('formatSettingsResponse filters editorFontSize out of the GET response (BUG)', () => {
    const helpers = createTestHelpers();
    // Even a manually edited settings.json with editorFontSize would be
    // stripped by formatSettingsResponse -> sanitizeSettingsUpdate on GET.
    const response = helpers.formatSettingsResponse({
      editorFontSize: 20,
      terminalFontSize: 20,
    });
    expect(response.terminalFontSize).toBe(20);
    expect(response).not.toHaveProperty('editorFontSize');
  });

  it('terminalFontSize round-trips through persist+format while editorFontSize does not', () => {
    const helpers = createTestHelpers();
    const sanitized = helpers.sanitizeSettingsUpdate({
      terminalFontSize: 20,
      editorFontSize: 20,
    });
    const persisted = helpers.mergePersistedSettings({}, sanitized);
    const response = helpers.formatSettingsResponse(persisted);
    // The pair must be symmetric; editorFontSize is lost, terminalFontSize survives.
    expect(response.terminalFontSize).toBe(20);
    expect(response).not.toHaveProperty('editorFontSize');
  });
});
