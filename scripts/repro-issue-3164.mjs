// Repro for https://github.com/openchamber/openchamber/issues/3164
//
// "1.21 delete my catlogs and project sessions and settings"
//
// Mechanism under test:
//   packages/web/server/lib/opencode/settings-runtime.js
//
//   readSettingsFromDisk() coerces ANY read failure (corrupt JSON, EACCES,
//   partial read) to `{}`. readSettingsFromDiskMigrated() then runs the
//   migration chain on the empty object. Two migrations always report
//   `changed: true` for an empty object:
//     - migrateSettingsFromLegacyThemePreferences      (migration2)
//     - migrateSettingsNotificationDefaults            (migration4)
//   so the chain calls writeSettingsToDisk() with the tiny migrated stub,
//   replacing the user's whole settings.json (theme, projects, skillCatalogs,
//   everything) with just those defaults.
//
// This mirrors what a user hits when settings.json is momentarily unreadable
// (e.g. read during a non-atomic write from another writer — the CLI's
// createSettingsAccessors() in commands-connect-url.js still uses plain
// fs.writeFile — or a transient FS error during an update/relaunch). The
// first GET /api/config/settings after that wipes the file.

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSettingsNormalizationRuntime } from '../packages/web/server/lib/opencode/settings-normalization-runtime.js';
import { createSettingsHelpers } from '../packages/web/server/lib/opencode/settings-helpers.js';
import { createSettingsRuntime } from '../packages/web/server/lib/opencode/settings-runtime.js';
import { createProjectIdFromPath } from '../packages/web/server/lib/projects/project-id.js';

const TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS = 30 * 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MIN_MS = 60 * 1000;
const TUNNEL_BOOTSTRAP_TTL_MAX_MS = 24 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_DEFAULT_MS = 8 * 60 * 60 * 1000;
const TUNNEL_SESSION_TTL_MIN_MS = 5 * 60 * 1000;
const TUNNEL_SESSION_TTL_MAX_MS = 30 * 24 * 60 * 60 * 1000;

const normalization = createSettingsNormalizationRuntime({
  os,
  path,
  processLike: process,
  realpathSync: fs.realpathSync,
  tunnelBootstrapTtlDefaultMs: TUNNEL_BOOTSTRAP_TTL_DEFAULT_MS,
  tunnelBootstrapTtlMinMs: TUNNEL_BOOTSTRAP_TTL_MIN_MS,
  tunnelBootstrapTtlMaxMs: TUNNEL_BOOTSTRAP_TTL_MAX_MS,
  tunnelSessionTtlDefaultMs: TUNNEL_SESSION_TTL_DEFAULT_MS,
  tunnelSessionTtlMinMs: TUNNEL_SESSION_TTL_MIN_MS,
  tunnelSessionTtlMaxMs: TUNNEL_SESSION_TTL_MAX_MS,
});

const helpers = createSettingsHelpers({
  normalizePathForPersistence: normalization.normalizePathForPersistence,
  normalizeDirectoryPath: normalization.normalizeDirectoryPath,
  normalizeTunnelBootstrapTtlMs: normalization.normalizeTunnelBootstrapTtlMs,
  normalizeTunnelSessionTtlMs: normalization.normalizeTunnelSessionTtlMs,
  normalizeTunnelProvider: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  normalizeTunnelMode: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  normalizeOptionalPath: (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  normalizeManagedRemoteTunnelHostname: normalization.normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets: normalization.normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens: normalization.normalizeManagedRemoteTunnelPresetTokens,
  sanitizeTypographySizesPartial: normalization.sanitizeTypographySizesPartial,
  normalizeStringArray: normalization.normalizeStringArray,
  sanitizeModelRefs: normalization.sanitizeModelRefs,
  sanitizeSkillCatalogs: normalization.sanitizeSkillCatalogs,
  sanitizeProjects: normalization.sanitizeProjects,
});

const makeRuntime = async (settingsFilePath) => createSettingsRuntime({
  fsPromises,
  path,
  crypto,
  SETTINGS_FILE_PATH: settingsFilePath,
  sanitizeProjects: normalization.sanitizeProjects,
  sanitizeSettingsUpdate: helpers.sanitizeSettingsUpdate,
  mergePersistedSettings: helpers.mergePersistedSettings,
  normalizeSettingsPaths: normalization.normalizeSettingsPaths,
  normalizeStringArray: normalization.normalizeStringArray,
  formatSettingsResponse: helpers.formatSettingsResponse,
  resolveDirectoryCandidate: (value) => value,
  normalizeManagedRemoteTunnelHostname: normalization.normalizeManagedRemoteTunnelHostname,
  normalizeManagedRemoteTunnelPresets: normalization.normalizeManagedRemoteTunnelPresets,
  normalizeManagedRemoteTunnelPresetTokens: normalization.normalizeManagedRemoteTunnelPresetTokens,
  syncManagedRemoteTunnelConfigWithPresets: async () => {},
  upsertManagedRemoteTunnelToken: async () => {},
});

// Realistic settings.json: theme, a project (with deterministic path id, the
// format 1.20+ writes), skill catalogs, notification defaults, misc prefs.
const projectPath = path.join(os.homedir(), 'Projects', 'acme');
const buildSettings = () => ({
  themeId: 'gruvbox',
  themeVariant: 'dark',
  lightThemeId: 'flexoki-light',
  darkThemeId: 'gruvbox-dark',
  useSystemTheme: false,
  lastDirectory: projectPath,
  homeDirectory: os.homedir(),
  desktopLocalPort: 51515,
  desktopInstallId: '8f0c0e3e-7e42-4b6a-9c3d-2a1b4c5d6e7f',
  projects: [
    {
      id: createProjectIdFromPath(projectPath),
      path: projectPath,
      label: 'acme',
      addedAt: 1750000000000,
      lastOpenedAt: 1753000000000,
    },
  ],
  activeProjectId: createProjectIdFromPath(projectPath),
  skillCatalogs: [
    { id: 'cat-1', label: 'Team Skills', source: 'https://github.com/acme/team-skills', subpath: 'skills' },
    { id: 'cat-2', label: 'Community', source: 'https://github.com/openchamber/skills' },
  ],
  defaultModel: 'anthropic/claude-sonnet-4',
  defaultAgent: 'build',
  notifyOnSubtasks: true,
  notifyOnCompletion: true,
  notifyOnError: true,
  notifyOnQuestion: true,
  notificationTemplates: {
    completion: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
    error: { title: 'Tool error', message: '{last_message}' },
    question: { title: 'Input needed', message: '{last_message}' },
    subtask: { title: '{agent_name} is ready', message: '{model_name} completed the task' },
  },
  pwaAppName: 'OpenChamber',
  reportUsage: true,
  gitmojiEnabled: true,
});

const control = async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-issue-3164-ok-'));
  const file = path.join(dir, 'settings.json');
  const runtime = await makeRuntime(file);
  await fsPromises.writeFile(file, JSON.stringify(buildSettings(), null, 2), 'utf8');

  const before = JSON.parse(await fsPromises.readFile(file, 'utf8'));
  await runtime.readSettingsFromDiskMigrated();
  const after = JSON.parse(await fsPromises.readFile(file, 'utf8'));

  console.log('[control] healthy file read -> migrated: preserves all keys:', JSON.stringify(Object.keys(before).sort()) === JSON.stringify(Object.keys(after).sort()));
  if (JSON.stringify(Object.keys(before).sort()) !== JSON.stringify(Object.keys(after).sort())) {
    console.log('  before keys:', Object.keys(before).sort().join(', '));
    console.log('  after  keys:', Object.keys(after).sort().join(', '));
  }
  await fsPromises.rm(dir, { recursive: true, force: true });
};

const reproduce = async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-issue-3164-wipe-'));
  const file = path.join(dir, 'settings.json');
  const runtime = await makeRuntime(file);
  await fsPromises.writeFile(file, JSON.stringify(buildSettings(), null, 2), 'utf8');

  const before = JSON.parse(await fsPromises.readFile(file, 'utf8'));
  console.log(`[repro] before: ${JSON.stringify(before).length} bytes, ${Object.keys(before).length} keys`);
  console.log(`[repro]   projects:      ${before.projects.length} (${before.projects[0].label})`);
  console.log(`[repro]   skillCatalogs: ${before.skillCatalogs.length}`);
  console.log(`[repro]   themeId:       ${before.themeId}`);

  // Simulate a transient unreadable settings.json: the exact content another
  // writer leaves behind when read mid-write (the CLI's createSettingsAccessors
  // in commands-connect-url.js still writes with plain fs.writeFile, i.e.
  // truncate-then-write, and readSettingsFromDisk() coerces the parse failure
  // to `{}`). Truncated at the same byte offset a plain write would leave
  // visible mid-flush.
  const raw = await fsPromises.readFile(file, 'utf8');
  await fsPromises.writeFile(file, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');

  let readError = null;
  let result = null;
  try {
    result = await runtime.readSettingsFromDiskMigrated();
  } catch (error) {
    readError = error;
  }
  console.log(`[repro] readSettingsFromDiskMigrated threw: ${readError ? readError.message : 'no'}`);

  const afterRaw = await fsPromises.readFile(file, 'utf8');
  const after = JSON.parse(afterRaw);
  console.log(`[repro] after: ${afterRaw.length} bytes, ${Object.keys(after).length} keys`);
  console.log(`[repro]   keys: ${Object.keys(after).sort().join(', ')}`);
  console.log(`[repro]   projects present:      ${Array.isArray(after.projects)}`);
  console.log(`[repro]   skillCatalogs present: ${Array.isArray(after.skillCatalogs)}`);
  console.log(`[repro]   desktopInstallId kept: ${after.desktopInstallId !== undefined}`);
  console.log(`[repro]   themeId kept:          ${after.themeId !== undefined}`);
  console.log(`[repro]   defaultModel kept:     ${after.defaultModel !== undefined}`);

  const wiped = !Array.isArray(after.projects)
    && !Array.isArray(after.skillCatalogs)
    && after.desktopInstallId === undefined
    && after.themeId === undefined;
  console.log(`[repro] RESULT: ${wiped ? 'DATA LOSS REPRODUCED — settings.json replaced with migration stub' : 'not wiped'}`);

  await fsPromises.rm(dir, { recursive: true, force: true });
  return { wiped, result };
};

await control();
const outcome = await reproduce();
process.exitCode = outcome.wiped ? 0 : 1;