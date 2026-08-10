/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2804
 *
 * "Work-status panel becomes unreachable when all sections are hidden"
 *
 * Scenario (mirrors the issue's steps 1-4):
 *   1. A session is open and the work-status panel is visible with sections
 *      reporting content (`renderedSections > 0`).
 *   2. The "Panel sections" dialog is used to uncheck all 8 sections
 *      (`setWorkStatusSectionVisible(id, false)` for each id).
 *   3. Every section unmounts; the real `WorkStatusPresenceProvider` reports an
 *      empty set, so `renderedSections` drops to 0.
 *   4. `WorkStatusPanel` renders the `<aside>` with `inert`,
 *      `aria-hidden="true"`, `pointer-events: none`, `opacity: 0` and no width.
 *      The settings gear is still in the DOM but is a descendant of an inert
 *      element, so it cannot be clicked or focused - and toggling the panel
 *      off/on re-renders the same dead state, leaving the user stuck.
 *
 * The data-heavy section components (git/quota/session stores) are replaced by
 * stubs that keep the real presence contract: they report themselves present
 * through `useReportWorkStatusPresence` while mounted, exactly like the real
 * sections do. Everything in `WorkStatusPanel.tsx` itself - the
 * `interactive = visible && renderedSections > 0` derivation and the
 * `inert`/`aria-hidden`/`pointer-events` wiring - is the unmodified production
 * code.
 */
import './reproduce-issue-2804.dom';
import { restoreDomGlobals } from './reproduce-issue-2804.dom';

import React from 'react';
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';

import { I18nProvider } from '@/lib/i18n';
import { useReportWorkStatusPresence } from './presenceContext';
import { WORK_STATUS_SECTION_IDS } from './sections';

/**
 * Bun module mocks are process-global within a test worker, and file execution
 * order across workers is not guaranteed. `useWorkStatusVisibility.test.ts`
 * mocks `@/stores/useUIStore` with a non-zustand stub, so this file registers
 * its own mock (a real zustand store with the same section-visibility action)
 * to be immune to whatever other files loaded first. The panel itself reads
 * `workStatusHiddenSections` and calls `setWorkStatusSectionVisible` on this
 * store, exactly as it would on the real one.
 */
type WorkStatusStore = {
  workStatusHiddenSections: string[];
  workStatusPanelEnabled: boolean;
  workStatusPanelVisible: boolean;
  workStatusScrollTop: number;
  workStatusOverlayOpen: boolean;
  setWorkStatusScrollTop: (scrollTop: number) => void;
  setWorkStatusOverlayOpen: (open: boolean) => void;
  setWorkStatusSectionVisible: (sectionId: string, visible: boolean) => void;
  setWorkStatusHiddenSections: (sectionIds: string[]) => void;
};

const useUIStore = create<WorkStatusStore>()((set) => ({
  workStatusHiddenSections: [],
  workStatusPanelEnabled: true,
  workStatusPanelVisible: true,
  workStatusScrollTop: 0,
  workStatusOverlayOpen: false,
  setWorkStatusScrollTop: (scrollTop) => set({ workStatusScrollTop: scrollTop }),
  setWorkStatusOverlayOpen: (open) => set({ workStatusOverlayOpen: open }),
  // Mirrors the real store's action: visible sections are stored as the
  // hidden set, so hiding appends and showing removes.
  setWorkStatusSectionVisible: (sectionId, visible) => {
    set((state) => {
      const hidden = state.workStatusHiddenSections;
      const isHidden = hidden.includes(sectionId);
      if (visible === !isHidden) return state;
      return {
        workStatusHiddenSections: visible
          ? hidden.filter((entry) => entry !== sectionId)
          : [...hidden, sectionId],
      };
    });
  },
  setWorkStatusHiddenSections: (sectionIds) => {
    set({ workStatusHiddenSections: [...new Set(sectionIds)] });
  },
}));

mock.module('@/stores/useUIStore', () => ({ useUIStore }));

/** A section stub that reports itself present while mounted. */
const present = (id: string) => () => {
  useReportWorkStatusPresence(id, true);
  return <div data-testid={`presence-${id}`} />;
};

type PrimaryGroupProps = {
  sessionId: string | null;
  directory: string | null;
  goalRow: React.ReactNode;
  showSession: boolean;
  showRepository: boolean;
};

// The real `WorkStatusPrimaryGroup` reports presence as
// `hasSession || hasRepository`; both require the corresponding show prop, so
// the stub mirrors that with the props alone.
mock.module('./WorkStatusGoalRow', () => ({
  WorkStatusGoalRow: () => null,
}));
mock.module('./WorkStatusPrimaryGroup', () => ({
  WorkStatusPrimaryGroup: ({ showSession, showRepository }: PrimaryGroupProps) => {
    useReportWorkStatusPresence('session-repository', showSession || showRepository);
    return <div data-testid="presence-session-repository" />;
  },
}));
mock.module('./WorkStatusUsageSection', () => ({ WorkStatusUsageSection: present('usage') }));
mock.module('./WorkStatusSubagentsSection', () => ({ WorkStatusSubagentsSection: present('subagents') }));
mock.module('./WorkStatusTasksSection', () => ({ WorkStatusTasksSection: present('tasks') }));
mock.module('./WorkStatusMcpSection', () => ({ WorkStatusMcpSection: present('mcp') }));
mock.module('./WorkStatusPinnedSection', () => ({ WorkStatusPinnedSection: present('pinned') }));
mock.module('./WorkStatusContextSection', () => ({ WorkStatusContextSection: present('contextSources') }));
mock.module('./WorkStatusSectionsDialog', () => ({ WorkStatusSectionsDialog: () => null }));

const { WorkStatusPanel } = await import('./WorkStatusPanel');

const Harness: React.FC<{ visible: boolean }> = ({ visible }) => (
  <I18nProvider>
    <WorkStatusPanel sessionId="session-2804" directory="/tmp/repro" visible={visible} />
  </I18nProvider>
);

beforeEach(() => {
  useUIStore.setState({
    workStatusHiddenSections: [],
    workStatusPanelEnabled: true,
    workStatusPanelVisible: true,
    workStatusScrollTop: 0,
    workStatusOverlayOpen: false,
  });
});

// Put the happy-dom browser globals back so files sharing the worker process
// (e.g. `@pierre/diffs`'s custom-element registration) are not affected.
afterAll(() => {
  restoreDomGlobals();
});

describe('issue 2804: work-status panel unreachable when all sections are hidden', () => {
  test('unchecking every section makes the panel inert and the gear icon unreachable', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      // Step 1: session open, panel visible, sections reporting content.
      await React.act(async () => {
        root.render(<Harness visible />);
      });

      const aside = host.querySelector('aside');
      expect(aside).not.toBeNull();

      // The panel starts interactive: no `inert`, no pointer-events trap,
      // and the settings gear is present.
      expect(aside!.hasAttribute('inert')).toBe(false);
      expect(aside!.style.pointerEvents).not.toBe('none');
      expect(aside!.querySelector('button[aria-label]')).not.toBeNull();

      // Steps 2-3: uncheck all 8 sections in the "Panel sections" dialog.
      // `setWorkStatusSectionVisible` is exactly what the dialog's
      // `SettingsCheckboxRow` calls.
      await React.act(async () => {
        for (const id of WORK_STATUS_SECTION_IDS) {
          useUIStore.getState().setWorkStatusSectionVisible(id, false);
        }
      });

      expect(useUIStore.getState().workStatusHiddenSections).toHaveLength(WORK_STATUS_SECTION_IDS.length);

      // Step 4: the panel went fully inert and invisible.
      expect(aside!.hasAttribute('inert')).toBe(true);
      expect(aside!.getAttribute('aria-hidden')).toBe('true');
      expect(aside!.style.pointerEvents).toBe('none');
      expect(aside!.style.opacity).toBe('0');
      expect(aside!.style.width).toBe('0px');

      // The settings gear is still in the DOM...
      const gear = aside!.querySelector('button[aria-label]');
      expect(gear).not.toBeNull();
      // ...but it is a descendant of the inert aside, so it cannot be clicked
      // or focused: there is no way to re-open the sections dialog.
      expect(gear!.closest('aside')).toBe(aside);

      // Toggling the panel off and back on re-renders the same dead state:
      // the sections are still hidden, so the presence set stays empty.
      await React.act(async () => {
        root.render(<Harness visible={false} />);
      });
      await React.act(async () => {
        root.render(<Harness visible />);
      });
      expect(aside!.hasAttribute('inert')).toBe(true);
    } finally {
      await React.act(async () => root.unmount());
      host.remove();
    }
  });
});
