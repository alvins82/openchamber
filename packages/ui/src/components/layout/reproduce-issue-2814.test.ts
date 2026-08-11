/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2814
 *
 * "[Bug] i don't see my quota usage at lastest version" (Desktop Web)
 *
 * Scenario (matches the reporter's screenshot: home / session-list page with
 * the header services dropdown open, showing only "Current Local" / "Default
 * Local" / "Add instance" — no Usage tab, no quota anywhere):
 *
 *   1. Before 1.18.2 the desktop header services dropdown offered three tabs —
 *      instance, usage, mcp — and the "Usage" tab rendered the quota dashboard
 *      from any page, including the home page.
 *   2. Commit f2523d0cf ("feat(chat): work-status panel") reduced the desktop
 *      header services menu to instances only: quota and MCP moved into the
 *      work-status panel.
 *   3. The work-status panel is only mounted by ChatContainer in the main
 *      (message-bearing) branch. The new-session draft branch, the hydrating
 *      branch, and the empty-session branch all return before the panel is
 *      rendered, and on the home page ChatContainer is not the active surface
 *      at all.
 *
 * Net effect: on Desktop Web the quota usage is no longer reachable from the
 * home page / header in the latest version.
 *
 * This test pins the current (regressed) wiring so the exact removal points
 * are visible, and asserts what the reporter observed.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const headerSource = readFileSync(join(__dirname, 'Header.tsx'), 'utf-8');
const chatContainerSource = readFileSync(
  join(__dirname, '..', 'chat', 'ChatContainer.tsx'),
  'utf-8',
);

describe('issue 2814: quota usage no longer visible on Desktop Web (home page / header)', () => {
  test('desktop header services menu no longer offers a Usage (quota) tab', () => {
    // The desktop services tabs previously included 'usage' and 'mcp'
    // alongside 'instance'. Since f2523d0cf the desktop header keeps
    // instances only — the reporter opened this dropdown and found no way to
    // reach quota usage.
    const servicesTabsBlock = headerSource.slice(
      headerSource.indexOf('const servicesTabs = React.useMemo'),
      headerSource.indexOf('const servicesTabs = React.useMemo') + 400,
    );

    // The 'usage' tab entry that existed before 1.18.2 is gone.
    expect(servicesTabsBlock).not.toContain("value: 'usage'");
    expect(servicesTabsBlock).not.toContain("value: 'mcp'");
    // Only the instance entry remains for the desktop app.
    expect(servicesTabsBlock).toContain("value: 'instance'");
  });

  test('the quota surface moved into the work-status panel, which is only mounted beside a session with messages', () => {
    // The header comment states the intent: quota now lives in the
    // work-status panel rather than the header.
    expect(headerSource).toContain(
      'Desktop keeps instances only: quota and MCP now live in the work-status',
    );

    // The work-status panel is mounted inside ChatContainer...
    expect(chatContainerSource).toContain('WorkStatusPanel');

    // ...but only in the final, message-bearing branch. Find the early
    // returns that precede it: the draft branch, the no-session branch, the
    // hydrating branch, and the empty-session branch all return before the
    // panel can render.
    // Skip the import statement: locate the JSX mount site instead.
    const workStatusMountIndex = chatContainerSource.indexOf('<WorkStatusPanel');
    expect(workStatusMountIndex).toBeGreaterThan(-1);

    // The empty-session branch (`sessionMessages.length === 0`) returns
    // before the panel — so a freshly opened or empty session (the state in
    // the reporter's screenshot) shows no quota usage at all.
    const emptyBranch = chatContainerSource.indexOf('sessionMessages.length === 0 && !sessionIsWorking');
    expect(emptyBranch).toBeGreaterThan(-1);
    expect(emptyBranch).toBeLessThan(workStatusMountIndex);

    // The new-session draft branch also returns before the panel.
    const draftBranch = chatContainerSource.indexOf('!currentSessionId && draftOpen');
    expect(draftBranch).toBeGreaterThan(-1);
    expect(draftBranch).toBeLessThan(workStatusMountIndex);
  });

  test('the panel that hosts quota is gated on the chat tab and desktop layout (not shown on the home page)', () => {
    // The work-status panel is only mountable inside the chat surface: it is
    // skipped for mobile, VS Code, mini-chat, and expanded-input, and is
    // additionally gated on the active main tab being chat. On the home /
    // session-list page none of these conditions hold, so quota usage is
    // unreachable from there in the latest version.
    expect(chatContainerSource).toContain(
      "chatSurfaceMode !== 'mini-chat'",
    );
    expect(chatContainerSource).toContain('!isMobile');
    expect(chatContainerSource).toContain('!isVSCode');

    // The header's work-status toggle only exists while the chat tab is the
    // active main tab.
    const toggleGuard = headerSource.slice(
      headerSource.indexOf('activeMainTab === \'chat\' && !isVSCode'),
      headerSource.indexOf('activeMainTab === \'chat\' && !isVSCode') + 120,
    );
    expect(toggleGuard).toContain("activeMainTab === 'chat' && !isVSCode");
  });
});
