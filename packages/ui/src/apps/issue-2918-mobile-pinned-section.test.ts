/**
 * Reproduction for issue #2918: "iPhone session drawer does not show global
 * Pinned section".
 *
 * Reported behavior (OpenChamber 1.18.3, unchanged in 1.18.4 / current main):
 * - Desktop/iPad show pinned sessions lifted to the top of the session list
 *   ("Pinned" cluster above the recency-ordered sessions).
 * - On the iPhone sessions drawer the same sessions are only reachable via
 *   "Show more sessions" — there is no Pinned section and no pinned-first
 *   ordering.
 *
 * What the code shows:
 * 1. `MobileSessionsSheet` (used for BOTH the iPhone drawer and the iPad
 *    sidebar) never renders a Pinned section. The only use of
 *    `pinnedSessionIds` is `orderSessionsByLifecycleScopes(...)` — ordering
 *    sessions inside project/worktree buckets.
 * 2. Pins are persisted per-device in `localStorage`
 *    (`oc.sessions.pinned.v2`, keyed by `[runtimeKey, directory, sessionId]`).
 *    `useSessionPinnedStore` never talks to the server, so a pin created on
 *    the desktop/iPad device does not exist in the iPhone device's store.
 *    `isSessionPinned(...)` therefore returns false on the iPhone and the
 *    pinned-first ordering never happens there — the pinned session is sorted
 *    purely by recency and lands beyond the first page of 7
 *    (`SESSIONS_PER_BUCKET`), exactly matching the reporter's steps 6–7.
 *
 * The tests below reproduce both parts at the logic level and assert the
 * structural claim from the issue's source observation.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Session } from '@opencode-ai/sdk/v2';

import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  getPinnedSessionKey,
  isSessionPinned,
  useSessionPinnedStore,
} from '@/stores/useSessionPinnedStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  resetSessionOrdering,
} from '@/sync/session-ordering';

// --- Constants mirroring packages/ui/src/apps/MobileSessionsSheet.tsx -------
// The sheet pages each project/worktree bucket to the first
// `SESSIONS_PER_BUCKET` roots (renderBucketSessions, `visibleRoots` slice).
const SESSIONS_PER_BUCKET = 7;
const REPO = '/home/user/project';
const DAY_MS = 24 * 60 * 60 * 1000;

const session = (id: string, updated: number, directory = REPO): Session => ({
  id,
  directory,
  title: id,
  version: 'v1',
  projectID: 'proj',
  time: { created: updated - DAY_MS, updated },
} as Session);

beforeEach(() => {
  resetSessionOrdering();
  useSessionPinnedStore.setState({ ids: new Set(), touchedAt: {} });
});

describe('issue #2918: global Pinned section on the mobile sessions sheet', () => {
  test('same device (desktop/iPad): a pinned session is lifted above much newer sessions', () => {
    const now = Date.now();
    // The pinned session is OLD (10 days) — recency alone would bury it.
    const pinnedOld = session('pinned-old', now - 10 * DAY_MS);
    // Eight sessions updated seconds ago.
    const recent = Array.from({ length: 8 }, (_, index) => session(`recent-${index}`, now - index * 1000));

    // Pin it in the store, exactly as the desktop sidebar's pin action does.
    useSessionPinnedStore.getState().toggle({ directory: REPO, sessionId: 'pinned-old' });
    expect(useSessionPinnedStore.getState().ids.size).toBe(1);

    const ordered = orderSessionsByLifecycleScopes(
      [pinnedOld, ...recent],
      useSessionPinnedStore.getState().ids,
      EMPTY_SESSION_ORDER_RANKS,
    );

    // This is the desktop "Pinned" behavior the issue compares against: the
    // pinned session surfaces at the top of the list.
    expect(ordered[0]?.id).toBe('pinned-old');
  });

  test('iPhone (fresh device): the desktop pin is not in the phone store, so pinned-first ordering never applies', () => {
    const now = Date.now();
    const pinnedOld = session('pinned-old', now - 10 * DAY_MS);
    const recent = Array.from({ length: 8 }, (_, index) => session(`recent-${index}`, now - index * 1000));

    // The pin the user created on desktop/iPad lives in THAT device's
    // localStorage (`oc.sessions.pinned.v2`), keyed by runtime+directory+id.
    const desktopPinKey = getPinnedSessionKey(getRuntimeKey(), REPO, 'pinned-old');
    expect(desktopPinKey).not.toBeNull();

    // The iPhone device starts with its own empty store — the pin made on the
    // other device is invisible here (`useSessionPinnedStore` is local-only).
    expect(useSessionPinnedStore.getState().ids.has(desktopPinKey!)).toBe(false);
    expect(isSessionPinned(useSessionPinnedStore.getState().ids, REPO, 'pinned-old')).toBe(false);

    const ordered = orderSessionsByLifecycleScopes(
      [pinnedOld, ...recent],
      useSessionPinnedStore.getState().ids,
      EMPTY_SESSION_ORDER_RANKS,
    );

    // Recency-only ordering: the 10-day-old pinned session sinks to the end.
    expect(ordered[ordered.length - 1]?.id).toBe('pinned-old');

    // The mobile sheet only shows the first SESSIONS_PER_BUCKET roots per
    // bucket — the pinned session is not on the first page, matching the
    // report: it is only discoverable after tapping "Show more sessions".
    const firstPage = ordered.slice(0, SESSIONS_PER_BUCKET).map((entry) => entry.id);
    expect(firstPage).not.toContain('pinned-old');
  });

  test('structural: MobileSessionsSheet never renders a Pinned section — pins only reorder within buckets', () => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(__dirname, 'MobileSessionsSheet.tsx'), 'utf8');

    // The issue's source observation: pinned IDs are used ONLY when ordering
    // sessions within project/worktree buckets. In the current source the only
    // call sites of `orderSessionsByLifecycleScopes(` are the two bucket
    // ordering paths (project tree + search results).
    const orderingCalls = source.match(/orderSessionsByLifecycleScopes\(/g);
    expect(orderingCalls).toHaveLength(2);

    // The five `pinnedSessionIds` references are the store selector, the two
    // ordering calls, and the two memo dependency arrays — nothing renders a
    // section.
    const pinnedRefs = source.match(/pinnedSessionIds/g) ?? [];
    expect(pinnedRefs.length).toBe(5);
    expect(source).toContain('const pinnedSessionIds = useSessionPinnedStore');

    // No Pinned section can be rendered from this component: no i18n key
    // containing "pinned", no `section.pinned`, no pin icon on mobile rows
    // (the desktop SessionNodeItem renders `pinnedMarkerContent` / a pushpin
    // icon — the mobile SessionRow has neither).
    expect(source.includes("'pinned")).toBe(false);
    expect(source.includes('section.pinned')).toBe(false);
    expect(source.includes('pushpin')).toBe(false);
    expect(source.includes('pinnedMarker')).toBe(false);

    // The drawer's tree render is driven exclusively by project sections
    // (`orderedNodes.map(...)`); there is no pinned group rendered above it.
    expect(source).toContain('orderedNodes.map');
  });
});
