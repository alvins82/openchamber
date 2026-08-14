// Reproduction for https://github.com/openchamber/openchamber/issues/2895
//
// Reported bug: In Settings > Skills Catalog, the Source Repository dropdown
// displays the clawdhub registry as "ClawdHub". The correct name is "ClawHub".
//
// This test demonstrates that the label served by the catalog API (and used by
// the SkillsCatalogPage dropdown) is the misspelled "ClawdHub".

import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSkillRoutes } from '../opencode/skill-routes.js';
import { getCuratedSkillsSources } from './curated-sources.js';

describe('reproduce issue #2895: "ClawHub" rendered as "ClawdHub"', () => {
  const startCatalogApp = () => {
    const app = express();
    app.use(express.json());

    registerSkillRoutes(app, {
      fs,
      path,
      os,
      resolveProjectDirectory: async () => ({ directory: null, error: null }),
      resolveOptionalProjectDirectory: async () => ({ directory: null, error: null }),
      readSettingsFromDisk: async () => ({}),
      sanitizeSkillCatalogs: (value) => value,
      isUnsafeSkillRelativePath: () => false,
      refreshOpenCodeAfterConfigChange: async () => {},
      clientReloadDelayMs: 0,
      buildOpenCodeUrl: () => 'http://127.0.0.1:9/',
      getOpenCodeAuthHeaders: () => ({}),
      getOpenCodePort: () => 0,
      getCuratedSkillsSources, // real curated sources, as in production
      getCacheKey: () => 'k',
      getCachedScan: () => null,
      setCachedScan: () => {},
      parseSkillRepoSource: () => ({ ok: false }),
      scanSkillsRepository: async () => ({ ok: false }),
      installSkillsFromRepository: async () => ({ ok: false }),
      scanClawdHubPage: async () => ({ ok: false }),
      installSkillsFromClawdHub: async () => ({ ok: false }),
      isClawdHubSource: () => true,
      getProfiles: () => [],
      getProfile: () => null,
    });

    const server = app.listen(0);
    const { port } = server.address();
    return {
      baseUrl: `http://127.0.0.1:${port}`,
      close: () => new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    };
  };

  /** @type {{ close: () => Promise<void> } | null} */
  let appHandle = null;

  afterEach(async () => {
    if (appHandle) {
      await appHandle.close();
      appHandle = null;
    }
  });

  it('serves the clawdhub source label as "ClawdHub" from the curated sources (typo)', () => {
    const clawdhub = getCuratedSkillsSources().find((s) => s.id === 'clawdhub');

    // The bug: the dropdown label is the misspelled "ClawdHub".
    expect(clawdhub?.label).toBe('ClawdHub');

    // Expected per the issue: "ClawHub". This assertion fails, proving the bug.
    expect(clawdhub?.label).toBe('ClawHub');
  });

  it('returns "ClawdHub" from GET /api/config/skills/catalog, which SkillsCatalogPage renders verbatim', async () => {
    appHandle = startCatalogApp();

    const response = await fetch(`${appHandle.baseUrl}/api/config/skills/catalog`);
    expect(response.ok).toBe(true);

    const payload = await response.json();
    const clawdhub = payload.sources.find((s) => s.id === 'clawdhub');
    expect(clawdhub).toBeTruthy();

    // The label the Source Repository dropdown displays for the clawdhub source.
    expect(clawdhub.label).toBe('ClawdHub');

    // Expected per the issue. This assertion fails, proving the bug.
    expect(clawdhub.label).toBe('ClawHub');
  });
});
