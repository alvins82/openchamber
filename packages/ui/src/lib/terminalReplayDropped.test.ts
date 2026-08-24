import { afterEach, describe, expect, test } from 'bun:test';
import { useTerminalStore, type TerminalChunk } from '@/stores/useTerminalStore';

/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/3103
 *
 * "Terminals lose output sometimes": open a terminal, start a command that
 * streams output, switch to another terminal tab, come back. The output is
 * blank until new output is appended. If the command already finished, only
 * pressing Enter (which produces a new echoed line) brings the output back.
 *
 * Root cause: the replay effect in `TerminalViewport.tsx` (the `chunks`
 * effect) keys continuity off chunk ids. The viewport is keyed by
 * directory+tab (`terminalViewportKey`), so switching tabs remounts it, and on
 * remount it replays the persisted buffer chunks and stores the last chunk id
 * in `lastChunkRef`. When the attach on return delivers a snapshot,
 * `replaceBuffer` in `useTerminalStore` swaps the whole buffer for one chunk
 * with a BRAND NEW id (`nextChunkId`). The effect's id scan then cannot find
 * the previous id, takes the `recreateRenderer()` branch, resets the terminal
 * in place, and returns WITHOUT writing the current chunks. Nothing re-triggers
 * the effect (no state change), so the screen stays blank until the next
 * `data` event appends a chunk and the effect runs again from
 * `lastChunkRef = null`, replaying the full buffer.
 *
 * This test models the store-side buffer transition (streamed chunks ->
 * snapshot replacement with a fresh id) and feeds it through the same replay
 * decision the viewport makes, asserting that the snapshot content is dropped
 * from the write stream.
 */

type ReplayState = { lastChunkId: number | null; terminalReady: boolean };

/**
 * Faithful model of the TerminalViewport chunks effect (lines ~306-334 of
 * TerminalViewport.tsx), including the terminal-not-ready early return and the
 * recreateRenderer short-circuit. Returns the text that would be handed to
 * `terminal.write()`, or null when the pass writes nothing.
 */
const viewportReplay = (state: ReplayState, chunks: TerminalChunk[]): string | null => {
  // `if (!terminal) return;` -- ghostty is still loading on a fresh mount.
  if (!state.terminalReady) return null;
  if (chunks.length === 0) {
    if (state.lastChunkId !== null) {
      // recreateRenderer(): reset terminal in place, clear tracking.
      state.lastChunkId = null;
      return null;
    }
    return '';
  }
  const previous = state.lastChunkId;
  let previousIndex = -1;
  if (previous !== null) {
    for (let index = chunks.length - 1; index >= 0; index -= 1) {
      const id = chunks[index].id;
      if (id === previous) { previousIndex = index; break; }
      if (id < previous) break;
    }
    if (previousIndex < 0) {
      // recreateRenderer(): resets the terminal and RETURNS without writing
      // the current chunks. Nothing re-runs this effect until chunks change.
      state.lastChunkId = null;
      return null;
    }
  }
  const isReplay = previousIndex < 0;
  const pending = previousIndex >= 0 ? chunks.slice(previousIndex + 1) : chunks;
  state.lastChunkId = chunks.at(-1)?.id ?? null;
  return pending.map((chunk) => (isReplay ? (chunk.replayData ?? chunk.data) : chunk.data)).join('');
};

/** Mirror of the store buffer: appendToBuffer / replaceBuffer chunk semantics. */
const makeBuffer = () => {
  let nextChunkId = 1;
  const chunks: TerminalChunk[] = [];
  const append = (data: string) => {
    const id = nextChunkId++;
    chunks.push({ id, data, byteLength: data.length });
  };
  const replace = (data: string) => {
    const id = nextChunkId++;
    chunks.length = 0;
    chunks.push({ id, data, byteLength: data.length });
  };
  return { chunks, append, replace };
};

describe('terminal replay across a tab switch-back (#3103)', () => {
  afterEach(() => useTerminalStore.getState().clearAll());

  test('fresh viewport replays the persisted buffer from scratch', () => {
    const buffer = makeBuffer();
    buffer.append('line one\n');
    buffer.append('line two\n');
    const state: ReplayState = { lastChunkId: null, terminalReady: true };

    expect(viewportReplay(state, buffer.chunks)).toBe('line one\nline two\n');
  });

  test('before ghostty is ready the snapshot cannot be written', () => {
    const buffer = makeBuffer();
    buffer.append('line one\n');
    buffer.append('line two\n');
    const state: ReplayState = { lastChunkId: null, terminalReady: false };

    // Mounted viewport, ghostty still loading: the effect returns early.
    expect(viewportReplay(state, buffer.chunks)).toBeNull();
  });

  test('snapshot replacement after remount drops the replayed output (#3103)', () => {
    const buffer = makeBuffer();
    buffer.append('line one\n');
    buffer.append('line two\n');
    const state: ReplayState = { lastChunkId: null, terminalReady: true };

    // 1. Fresh viewport processes the persisted buffer before the attach
    //    snapshot has come back from the server.
    const first = viewportReplay(state, buffer.chunks);
    expect(first).toBe('line one\nline two\n');
    expect(state.lastChunkId).not.toBeNull();

    // 2. Attach returns: `replaceBuffer` swaps the whole buffer for one
    //    snapshot chunk carrying a brand new id.
    buffer.replace('line one\nline two\nprompt$');

    // 3. The chunks effect runs again. The previous id is gone, so it hits
    //    the recreateRenderer() branch and writes nothing: screen goes blank.
    const second = viewportReplay(state, buffer.chunks);
    expect(second).toBeNull();

    // 4. Terminal stays blank until the next `data` event (new output, or an
    //    echoed Enter). Only then does a pass from lastChunkId = null replay
    //    the full buffer, which is why the report says output only reappears
    //    when new lines arrive or Enter is pressed.
    buffer.append('\n');
    const third = viewportReplay(state, buffer.chunks);
    expect(third).toBe('line one\nline two\nprompt$\n');
  });

  test('store replacement assigns a fresh chunk id (root cause)', () => {
    useTerminalStore.getState().clearAll();
    useTerminalStore.getState().ensureDirectory('/repo');
    const tabId = useTerminalStore.getState().getDirectoryState('/repo')!.tabs[0].id;

    // Streamed output while the tab is active.
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'line one\n', 1);
    useTerminalStore.getState().appendToBuffer('/repo', tabId, 'line two\n', 2);
    const before = useTerminalStore.getState().getBuffer('/repo', tabId).chunks;
    const lastIdBefore = before.at(-1)!.id;

    // Attach on tab switch-back delivers a snapshot, replacing the buffer.
    useTerminalStore.getState().replaceBuffer('/repo', tabId, 'line one\nline two\nprompt$', 2);
    const after = useTerminalStore.getState().getBuffer('/repo', tabId).chunks;

    // The snapshot is one chunk with a NEW id, so a viewport that had already
    // advanced past lastIdBefore cannot find its continuation.
    expect(after).toHaveLength(1);
    expect(after[0].id).not.toBe(lastIdBefore);
  });
});