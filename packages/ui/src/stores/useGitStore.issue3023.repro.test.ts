/**
 * Reproduction test for https://github.com/openchamber/openchamber/issues/3023
 *
 * "Reduce or remove flickering when updating the file being displayed"
 *
 * Flicker mechanism #1 from the issue: in the Changes view, every completed
 * edit fires a git refresh hint. `DiffView` handles that hint by calling
 * `clearDiffCache` (dropping the cached diff for the path) and bumping a
 * per-path refresh nonce that is part of the `MultiFileDiffEntry` React `key`
 * (`DiffView.tsx:1654-1655`). Both effects force the entry to remount, discard
 * its in-memory diff, show the loading spinner (`DiffView.tsx:892-894`), and
 * re-fetch + rebuild the diff from scratch.
 *
 * This test demonstrates the store half of the mechanism: a git refresh clears
 * the previously-cached diff, so the diff is no longer available in place and
 * must be re-fetched before it can render again.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { useGitStore } from './useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];

const createGitApi = (): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus: async () => ({
    current: 'main',
    tracking: null,
    ahead: 0,
    behind: 0,
    files: [],
    isClean: true,
  }),
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({
    original: 'const x = 1;',
    modified: 'const x = 2;',
    path: options.path,
  }),
});

describe('issue #3023 Changes view diff refresh drops cached diff', () => {
  beforeEach(() => {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('a git refresh hint clears the cached diff for the edited path, so it must re-fetch', async () => {
    const directory = '/repo';
    const path = 'src/index.ts';
    const git = createGitApi();

    // Simulate the diff being fetched and cached while viewing the file.
    useGitStore.getState().setDiff(directory, path, {
      original: 'const x = 1;',
      modified: 'const x = 2;',
    });
    const before = useGitStore.getState().getDiff(directory, path);
    expect(before).not.toBeNull();
    expect(before?.modified).toBe('const x = 2;');

    // The agent completes an edit and fires requestGitRefresh -> the DiffView
    // handler calls clearDiffCache(effectiveDirectory, hint.paths).
    useGitStore.getState().clearDiffCache(directory, [path]);

    // The cached diff is gone. The MultiFileDiffEntry's `diffData` resolves to
    // null here, so the render shows the loading spinner until the diff is
    // re-fetched (DiffView.tsx:892-894: `isLoading && !diffData`).
    const after = useGitStore.getState().getDiff(directory, path);
    expect(after).toBeNull();
  });

  test('the refreshed diff is only available again after an explicit re-fetch', async () => {
    const directory = '/repo';
    const path = 'src/index.ts';
    const git = createGitApi();

    useGitStore.getState().setDiff(directory, path, {
      original: 'const x = 1;',
      modified: 'const x = 2;',
    });
    useGitStore.getState().clearDiffCache(directory, [path]);
    expect(useGitStore.getState().getDiff(directory, path)).toBeNull();

    // The only way the diff renders again is a fresh fetch (the component's
    // diff-fetch effect re-runs once the cached diff is missing). Until that
    // fetch resolves, the previous diff is not available for an in-place
    // update — that is the remount + spinner window reported in the issue.
    const runtimeKey = getRuntimeKey();
    useGitStore.getState().setDiff(directory, path, {
      original: 'const x = 1;',
      modified: 'const x = 3;',
    }, runtimeKey);
    expect(useGitStore.getState().getDiff(directory, path)?.modified).toBe('const x = 3;');
  });
});
