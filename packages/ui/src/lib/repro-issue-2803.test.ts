import { afterAll, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { startAppearanceAutoSave } from '@/lib/appearanceAutoSave';
import { useUIStore } from '@/stores/useUIStore';

// Reproduction for issue #2803 (frontend half):
// "Session Retention settings ('When sessions expire') are not persisted to
// settings.json"
//
// The issue claims the frontend never persists sessionRetentionAction. This
// test shows the opposite: startAppearanceAutoSave() subscribes to the store
// and DOES forward sessionRetentionAction changes to updateDesktopSettings.
// The value is then dropped by the server-side sanitizer (see the server test
// repro-issue-2803.test.js), which is the actual root cause.

type TestWindow = {
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  return testWindow as TestWindow;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const registerSettingsSave = (save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load: async () => ({ settings: {}, source: 'web' }),
      save,
    },
  } as unknown as RuntimeAPIs);
};

afterAll(() => {
  registerRuntimeAPIs(null);
});

describe('issue #2803: frontend sends sessionRetentionAction', () => {
  test('startAppearanceAutoSave forwards sessionRetentionAction changes to the settings API', async () => {
    getWindow();
    useUIStore.getState().setSessionRetentionAction('archive');
    const saveCalls: Array<Partial<SettingsPayload>> = [];
    registerSettingsSave(async (changes) => {
      saveCalls.push(changes);
      return changes as SettingsPayload;
    });
    startAppearanceAutoSave();

    useUIStore.getState().setSessionRetentionAction('delete');
    useUIStore.getState().setAutoDeleteEnabled(true);
    useUIStore.getState().setAutoDeleteAfterDays(60);
    await delay(500);

    expect(saveCalls.some((changes) => changes.sessionRetentionAction === 'delete')).toBe(true);
    expect(saveCalls.some((changes) => changes.autoDeleteEnabled === true)).toBe(true);
    expect(saveCalls.some((changes) => changes.autoDeleteAfterDays === 60)).toBe(true);
  });
});
