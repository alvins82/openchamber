import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createSettingsHelpers } from './settings-helpers.js';
import { createSettingsRuntime } from './settings-runtime.js';

// Repro for https://github.com/openchamber/openchamber/issues/3021
// Changing the theme in Settings sends a theme-only update to
// PUT /api/config/settings, which calls persistSettings(). On a settings file
// whose projects still carry a legacy (non-deterministic) id, persistSettings
// runs the deterministic-project-id migration. If the migration's filesystem
// moves hit an on-disk collision, the whole theme save throws and the route
// returns 500 "Failed to save settings".

const makeHelpers = () => createSettingsHelpers({
  normalizePathForPersistence: (p) => p,
  normalizeDirectoryPath: (p) => p,
  normalizeTunnelBootstrapTtlMs: (v) => v,
  normalizeTunnelSessionTtlMs: (v) => v,
  normalizeTunnelProvider: (v) => v,
  normalizeTunnelMode: (v) => v,
  normalizeOptionalPath: (p) => p,
  normalizeManagedRemoteTunnelHostname: (v) => v,
  normalizeManagedRemoteTunnelPresets: (v) => v,
  normalizeManagedRemoteTunnelPresetTokens: (v) => v,
  sanitizeTypographySizesPartial: (v) => v,
  normalizeStringArray: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []),
  sanitizeModelRefs: (v) => v,
  sanitizeSkillCatalogs: (v) => v,
  sanitizeProjects: (v) => (Array.isArray(v) ? v : []),
});

const makeRuntime = (helpers, settingsFilePath) => createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH: settingsFilePath,
  sanitizeProjects: (v) => (Array.isArray(v) ? v : []),
  sanitizeSettingsUpdate: helpers.sanitizeSettingsUpdate,
  mergePersistedSettings: helpers.mergePersistedSettings,
  normalizeSettingsPaths: (input) => ({ settings: input && typeof input === 'object' ? input : {}, changed: false }),
  normalizeStringArray: (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []),
  formatSettingsResponse: helpers.formatSettingsResponse,
  resolveDirectoryCandidate: (v) => v,
  normalizeManagedRemoteTunnelHostname: (v) => v,
  normalizeManagedRemoteTunnelPresets: (v) => v,
  normalizeManagedRemoteTunnelPresetTokens: (v) => v,
  syncManagedRemoteTunnelConfigWithPresets: async () => {},
  upsertManagedRemoteTunnelToken: async () => {},
});

// A theme-only settings update, exactly what the Settings UI sends on a theme
// change.
const THEME_ONLY = {
  themeId: 'dracula',
  themeVariant: 'dark',
  useSystemTheme: false,
  lightThemeId: 'flexoki-light',
  darkThemeId: 'dracula',
  splashBgLight: '#ffffff',
  splashFgLight: '#000000',
  splashBgDark: '#000000',
  splashFgDark: '#ffffff',
};

describe('repro issue 3021: theme-only save after 1.19.0 deterministic project id migration', () => {
  it('persists a theme-only update when the project id migration is clean', async () => {
    const helpers = makeHelpers();
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-clean-'));
    try {
      const settingsFilePath = path.join(tempRoot, 'settings.json');
      const projectsRoot = path.join(tempRoot, 'projects');
      const projectPath = path.join(tempRoot, 'project');
      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      const legacyId = 'a3f1c2d4-0000-4000-8000-000000000001';
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        themeId: 'flexoki-light', themeVariant: 'light', useSystemTheme: true,
        projects: [{ id: legacyId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
        activeProjectId: legacyId,
      }));

      const runtime = makeRuntime(helpers, settingsFilePath);
      const result = await runtime.persistSettings(THEME_ONLY);
      expect(result.themeId).toBe('dracula');
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws on a theme-only save when the migration hits an on-disk collision (old storage dir is a file)', async () => {
    const helpers = makeHelpers();
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-enotdir-'));
    try {
      const settingsFilePath = path.join(tempRoot, 'settings.json');
      const projectsRoot = path.join(tempRoot, 'projects');
      const projectPath = path.join(tempRoot, 'project');
      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      const legacyId = 'a3f1c2d4-0000-4000-8000-000000000001';
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        themeId: 'flexoki-light', themeVariant: 'light', useSystemTheme: true,
        projects: [{ id: legacyId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
        activeProjectId: legacyId,
      }));
      // The legacy project storage path exists as a FILE, not a directory.
      await fsPromises.writeFile(path.join(projectsRoot, legacyId), 'not a directory');

      const runtime = makeRuntime(helpers, settingsFilePath);
      await expect(runtime.persistSettings(THEME_ONLY)).rejects.toThrow(/ENOTDIR/);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('throws on a theme-only save when the migration hits a dir/file name collision (EEXIST)', async () => {
    const helpers = makeHelpers();
    const tempRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-repro-eexist-'));
    try {
      const settingsFilePath = path.join(tempRoot, 'settings.json');
      const projectsRoot = path.join(tempRoot, 'projects');
      const projectPath = path.join(tempRoot, 'project');
      await fsPromises.mkdir(projectPath, { recursive: true });
      await fsPromises.mkdir(projectsRoot, { recursive: true });
      const legacyId = 'a3f1c2d4-0000-4000-8000-000000000001';
      const canonicalId = createProjectIdFromPath(projectPath);
      await fsPromises.writeFile(settingsFilePath, JSON.stringify({
        themeId: 'flexoki-light', themeVariant: 'light', useSystemTheme: true,
        projects: [{ id: legacyId, path: projectPath, addedAt: 1, lastOpenedAt: 1 }],
        activeProjectId: legacyId,
      }));
      // Old storage has a subdirectory `x`; new storage has a FILE named `x`.
      const oldDir = path.join(projectsRoot, legacyId);
      const newDir = path.join(projectsRoot, canonicalId);
      await fsPromises.mkdir(path.join(oldDir, 'x'), { recursive: true });
      await fsPromises.writeFile(path.join(oldDir, 'x', 'inside.txt'), 'content');
      await fsPromises.mkdir(newDir, { recursive: true });
      await fsPromises.writeFile(path.join(newDir, 'x'), 'blocks directory creation');

      const runtime = makeRuntime(helpers, settingsFilePath);
      await expect(runtime.persistSettings(THEME_ONLY)).rejects.toThrow(/EEXIST/);
    } finally {
      await fsPromises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
