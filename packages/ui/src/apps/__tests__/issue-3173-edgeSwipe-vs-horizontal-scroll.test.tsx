/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3173
 *
 * On Android the right-edge workspace gesture (useEdgeSwipe, 80px edge zone,
 * 64px min distance) fires purely on gesture geometry. It never checks whether
 * the touch begins inside a horizontally scrollable element, so a leftward
 * swipe meant to reveal the right-hand columns of a wide Markdown table (whose
 * right edge sits near the screen edge) opens the workspace drawer instead of
 * scrolling the table.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useEdgeSwipe } from '../useEdgeSwipe';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TableHost: React.FC<{
  mainRef: React.RefObject<HTMLElement | null>;
  onRightEdgeSwipe: () => void;
  onLeftEdgeSwipe: () => void;
}> = ({ mainRef, onRightEdgeSwipe, onLeftEdgeSwipe }) => {
  // Mirror MobileApp.tsx: the hook is attached to the chat <main> element.
  useEdgeSwipe(mainRef, { onRightEdgeSwipe, onLeftEdgeSwipe });
  return (
    <main ref={mainRef} style={{ width: 360, height: 600 }}>
      {/* Wide Markdown table overflowing the viewport: scrollWidth > clientWidth. */}
      <div className="table" style={{ width: 900, overflowX: 'auto' }}>
        <table style={{ width: 900 }}>
          <tbody>
            <tr>
              <td>col</td>
              <td>col</td>
              <td>col</td>
              <td>col</td>
              <td>col</td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  );
};

describe('issue #3173: right-edge workspace gesture vs horizontal scroll', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let mainRef: React.RefObject<HTMLElement | null>;
  let rightSwipeCount: number;
  let leftSwipeCount: number;

  const touch = (clientX: number, clientY: number) => ({ clientX, clientY });
  const dispatch = (type: string, touches: Array<{ clientX: number; clientY: number }>) => {
    const event = new windowInstance.Event(type, { cancelable: true }) as unknown as Event;
    Object.defineProperty(event, type === 'touchstart' ? 'touches' : 'changedTouches', {
      value: touches,
    });
    mainRef.current!.dispatchEvent(event);
  };

  const swipe = (startX: number, startY: number, endX: number, endY: number) => {
    dispatch('touchstart', [touch(startX, startY)]);
    dispatch('touchend', [touch(endX, endY)]);
  };

  beforeEach(async () => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
      // Simulate the Capacitor Android runtime so the 80px edge zone applies.
      Capacitor: { getPlatform: () => 'android' },
    });

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mainRef = React.createRef<HTMLElement | null>();
    rightSwipeCount = 0;
    leftSwipeCount = 0;

    await act(async () => {
      root.render(
        <TableHost
          mainRef={mainRef}
          onRightEdgeSwipe={() => { rightSwipeCount += 1; }}
          onLeftEdgeSwipe={() => { leftSwipeCount += 1; }}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('a right-edge swipe toward the centre opens the workspace drawer (expected gesture)', () => {
    // Start 10px from the right edge (within the 80px zone), travel 80px left.
    swipe(360 - 10, 200, 360 - 10 - 80, 200);
    expect(rightSwipeCount).toBe(1);
  });

  test('BUG: a horizontal-scroll swipe that begins inside the wide table also opens the drawer', () => {
    // The table is wider than the viewport (900 > 360), so its right portion
    // reaches the right edge of the screen. A swipe that starts at the right
    // edge of the table and moves left to reveal columns is inside the 80px
    // edge zone and travels >= 64px, so the hook commits the edge swipe even
    // though the target is a horizontally scrollable element.
    swipe(360 - 20, 300, 360 - 20 - 90, 300);
    expect(rightSwipeCount).toBe(1);
  });

  test('the hook never inspects whether the touch target is horizontally scrollable', () => {
    // Same swipe but originating on the wide table element. The hook reads only
    // start/end coordinates from the event; it ignores event.target entirely.
    swipe(360 - 30, 300, 360 - 30 - 70, 300);
    expect(rightSwipeCount).toBe(1);
  });

  test('a left-edge swipe still opens the sessions drawer (control)', () => {
    swipe(10, 300, 10 + 80, 300);
    expect(leftSwipeCount).toBe(1);
  });
});

describe('issue #3173: MobileWorkspaceDrawer has no swipe-to-dismiss gesture', () => {
  const drawerSource = readFileSync(join(__dirname, '..', 'MobileWorkspaceDrawer.tsx'), 'utf-8');

  test('the drawer registers no touch listeners for closing it', () => {
    // The drawer closes via the header X, Escape, or the Android back button
    // (handled in MobileApp). There is no touchstart/touchend/pointer gesture,
    // so once opened by a right-edge swipe there is no reverse-swipe to dismiss.
    expect(drawerSource).not.toContain('touchstart');
    expect(drawerSource).not.toContain('touchend');
    expect(drawerSource).not.toContain('onTouchStart');
    expect(drawerSource).not.toContain('onTouchEnd');
    expect(drawerSource).not.toContain('onTouchMove');
    expect(drawerSource).not.toContain('useEdgeSwipe');
  });

  test('the only close affordances are the X button and Escape', () => {
    expect(drawerSource).toContain('onClick={onClose}');
    expect(drawerSource).toContain("event.key === 'Escape'");
  });
});
