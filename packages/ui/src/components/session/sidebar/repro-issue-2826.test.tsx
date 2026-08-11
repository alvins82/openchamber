import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Session } from '@opencode-ai/sdk/v2';

// Regression reproduction for #2826:
// "working sessions show a solid yellow dot instead of a blinking one"
//
// The sidebar session row used to render a blinking dot (`animate-busy-pulse`)
// while a session was working. Commit faa9c243 replaced it with a static dot
// plus a 1fps elapsed-turn counter, so a working session now renders an
// entirely solid dot. This test renders the session row for a `busy` session
// and asserts the status marker still carries the blink animation — which the
// current code no longer does, demonstrating the regression.

mock.module('@/sync/sync-context', () => ({
  useGlobalSessionStatus: () => ({ type: 'busy' }) as { type: 'busy' },
  useDirectoryStore: () => ({
    getState: () => ({}),
    subscribe: () => () => undefined,
  }),
  useSessionPermissions: () => [],
  useSessionQuestionCount: () => 0,
  buildSessionMessageRecordsSnapshot: () => ({ list: [] }),
  useAllLiveSessions: () => [],
  setActiveSession: () => undefined,
}));

mock.module('@/sync/use-sync', () => ({
  useSync: () => ({}),
}));

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: () => null,
}));

const { SessionNodeItem } = await import('./SessionNodeItem');
const { I18nProvider } = await import('@/lib/i18n');

const session: Session = {
  id: 'sess-busy',
  title: 'Busy session',
  time: { created: 0, updated: 0 },
  directory: '/project',
} as Session;

const noop = () => undefined;

const commonProps = {
  pinnedSessionIds: new Set<string>(),
  expandedParents: new Set<string>(),
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  notifyOnSubtasks: true,
  editingId: null,
  setEditingId: noop,
  editTitle: '',
  setEditTitle: noop,
  handleSaveEdit: noop,
  handleCancelEdit: noop,
  toggleParent: noop,
  handleSessionSelect: noop,
  handleSessionDoubleClick: noop,
  togglePinnedSession: noop,
  handleShareSession: noop,
  copiedSessionId: null,
  handleCopyShareUrl: noop,
  handleCopySessionId: noop,
  handleUnshareSession: noop,
  openSidebarMenuKey: null,
  setOpenSidebarMenuKey: noop,
  renamingFolderId: null,
  getFoldersForScope: () => [],
  getSessionFolderId: () => null,
  removeSessionFromFolder: noop,
  addSessionToFolder: noop,
  createFolderAndStartRename: () => null,
  openContextPanelTab: noop,
  handleDeleteSession: noop,
  handleRestoreSession: noop,
  mobileVariant: false,
  alwaysShowActions: false,
  renderSessionNode: () => null,
  menuOpenSessionId: null,
  nodeStructureKey: 'key',
  subtreeContainsEditing: new Set<string>(),
};

describe('reproduce #2826: working session status dot', () => {
  test('busy session row renders a blinking (animated) status dot', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <SessionNodeItem
          node={{ session, children: [], worktree: null }}
          {...commonProps}
        />
      </I18nProvider>,
    );

    // The active marker for a busy session previously carried the blink
    // animation class (`animate-busy-pulse`). Expect it to still blink.
    expect(markup).toContain('animate-busy-pulse');
  });
});
