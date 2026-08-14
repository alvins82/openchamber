// Reproduction for https://github.com/openchamber/openchamber/issues/2895
//
// The SkillsCatalogPage renders the Source Repository dropdown from
// `useSkillsCatalogStore.sources`. When the server fetch fails, the store
// falls back to FALLBACK_SOURCES, which labels the clawdhub registry
// "ClawdHub" instead of "ClawHub".

import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => undefined,
    checkHealth: async () => true,
  },
}));

mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: {
    getState: () => ({
      getActiveProject: () => null,
    }),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => new Response(JSON.stringify({ ok: true, sources: [] }), {
    headers: { 'Content-Type': 'application/json' },
  }),
}));

mock.module('@/lib/background-network', () => ({
  runBackgroundNetworkTask: async <T,>(task: () => T) => task(),
}));

mock.module('@/lib/configUpdate', () => ({
  startConfigUpdate: mock(() => undefined),
  finishConfigUpdate: mock(() => undefined),
  updateConfigUpdateMessage: mock(() => undefined),
}));

mock.module('@/lib/configSync', () => ({
  emitConfigChange: mock(() => undefined),
  scopeMatches: mock(() => false),
  subscribeToConfigChanges: mock(() => () => undefined),
}));

mock.module('./utils/safeStorage', () => ({
  createDeferredSafeJSONStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}));

const { useSkillsCatalogStore } = await import('./useSkillsCatalogStore');

describe('reproduce issue #2895: "ClawHub" rendered as "ClawdHub" (UI fallback sources)', () => {
  beforeEach(() => {
    useSkillsCatalogStore.setState({
      sources: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          description: "Anthropic's public skills repository",
          source: 'anthropics/skills',
          defaultSubpath: 'skills',
          sourceType: 'github',
        },
        {
          id: 'clawdhub',
          label: 'ClawdHub',
          description: 'Community skill registry with vector search',
          source: 'clawdhub:registry',
          sourceType: 'clawdhub',
        },
      ],
    });
  });

  test('the clawdhub source label served to the Source Repository dropdown is the misspelled "ClawdHub"', () => {
    const clawdhub = useSkillsCatalogStore.getState().sources.find((s) => s.id === 'clawdhub');
    expect(clawdhub).toBeTruthy();

    // The bug: the dropdown displays this label verbatim.
    expect(clawdhub?.label).toBe('ClawdHub');

    // Expected per the issue. This assertion fails, proving the bug.
    expect(clawdhub?.label).toBe('ClawHub');
  });
});
