/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2966
 *
 * "open subtask doesn't draw correctly first" — clicking "Open subtask
 * session" (or opening a subtask session) first draws the "Start a new chat"
 * empty state instead of the subtask's conversation; expanding the panel
 * makes the transcript appear, and only then is the view correct.
 *
 * Root cause chain (verified against the real sync primitives):
 *
 * 1. The subtask session is listed in the directory store (bootstrap lists
 *    session metadata, not messages), but its messages have not been fetched
 *    yet when the embedded session-chat panel boots.
 * 2. The first `session.messages` fetch can return an empty page with no
 *    `x-next-cursor` (complete) — e.g. while the backend is still warming up
 *    or the session is not yet queryable. `SessionMessageLoader.loadInitial`
 *    then COMMITS an authoritative-empty `message[sessionID] = []` (see
 *    `materializeSessionSnapshots`: `messagesChanged` is forced when
 *    `existingMessages === undefined && snapshots.length === 0`).
 * 3. That empty commit makes `getSessionMaterializationStatus().renderable`
 *    return true with zero messages. `useSessionRenderable` now reports the
 *    session "renderable", so ChatContainer's hydration-skeleton branch
 *    (`isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking`)
 *    is skipped and control falls through to the empty-state branch
 *    (`sessionMessages.length === 0 && !sessionIsWorking`) which renders
 *    `<ChatEmptyState />` — the "Start a new chat" screen.
 * 4. The reactive ensure path never retries: ChatContainer's ensure effect
 *    bails out on `hasRenderableSessionSnapshot`, and `syncSession`'s
 *    `cachedReady` check (`hasMessages && renderable`) short-circuits every
 *    subsequent non-forced `ensure()` call. The transcript stays missing until
 *    the store is updated from another channel (SSE events, a forced reload,
 *    or a re-render that happens to re-read the store after the real messages
 *    landed) — matching "the first time doesn't draw right … get the state too
 *    late and doesn't react to that state".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client";
import { ChildStoreManager } from "../child-store";
import { SessionMessageLoader } from "../session-message-loader";
import { getSessionMaterializationStatus } from "../materialization";
import type { State } from "../types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const chatContainerSource = readFileSync(join(__dirname, "..", "..", "components", "chat", "ChatContainer.tsx"), "utf-8");

const DIRECTORY = "/repo";
const SESSION_ID = "ses_subtask_2966";

const createRecord = (id: string, created: number): { info: Message; parts: Part[] } => ({
  info: { id, sessionID: SESSION_ID, role: "user", time: { created } } as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID: SESSION_ID, type: "text", text: "hello" }] as Part[],
});

const emptyCompleteResponse = () => ({
  data: [],
  response: { headers: { get: (name: string) => (name === "x-next-cursor" ? null : null) } },
});

const fullResponse = (records: ReturnType<typeof createRecord>[], cursor?: string) => ({
  data: records,
  response: { headers: { get: (name: string) => (name === "x-next-cursor" ? cursor ?? null : null) } },
});

const seedSessionIntoStore = (store: ReturnType<ChildStoreManager["ensureChild"]>) => {
  store.setState({
    status: "complete",
    session: [{
      id: SESSION_ID,
      title: "Audit the search bar",
      time: { created: 1, updated: 1 },
      version: "1",
      directory: DIRECTORY,
    } as State["session"][number]],
  } as Partial<State>);
};

/**
 * The exact branch predicates ChatContainer uses to decide what to draw
 * (ChatContainer.tsx:1058-1060, 1153, 1231).
 */
const chatContainerBranch = (input: {
  currentSessionId: string | null;
  hasRenderableSessionSnapshot: boolean;
  sessionMessagesLength: number;
  sessionIsWorking: boolean;
}): "empty-state" | "hydrating-skeleton" | "viewport" => {
  const isSessionHydrating = Boolean(input.currentSessionId) && !input.hasRenderableSessionSnapshot;
  if (isSessionHydrating && input.sessionMessagesLength === 0 && !input.sessionIsWorking) {
    return "hydrating-skeleton";
  }
  if (input.sessionMessagesLength === 0 && !input.sessionIsWorking) {
    return "empty-state";
  }
  return "viewport";
};

describe("issue #2966 subtask first draw shows the new-chat empty state", () => {
  test("an empty complete messages page commits message[sessionID]=[] and marks the session renderable", async () => {
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    seedSessionIntoStore(store);

    let calls = 0;
    const sdk = {
      session: {
        messages: async () => {
          calls += 1;
          return emptyCompleteResponse();
        },
      },
    } as unknown as OpencodeClient;
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "test" });

    expect(getSessionMaterializationStatus(store.getState(), SESSION_ID)).toEqual({
      hasMessages: false,
      renderable: false,
      missingPartMessageIDs: [],
    });

    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });

    // The session HAS a conversation, but the store now holds an
    // authoritative-empty message list for it.
    expect(store.getState().message[SESSION_ID]).toEqual([]);
    expect(getSessionMaterializationStatus(store.getState(), SESSION_ID)).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    });
    expect(loader.getSnapshot({ directory: DIRECTORY, sessionID: SESSION_ID }).status).toBe("ready");

    loader.dispose();
    childStores.disposeAll();
  });

  test("subsequent non-forced ensure() calls short-circuit and never refetch", async () => {
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    seedSessionIntoStore(store);

    let calls = 0;
    const sdk = {
      session: {
        messages: async () => {
          calls += 1;
          return emptyCompleteResponse();
        },
      },
    } as unknown as OpencodeClient;
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "test" });

    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });
    expect(calls).toBe(1);

    // Reactive re-ensure (what ChatContainer's effect would do) must NOT fetch
    // again: `cachedReady` (hasMessages && renderable) is true after the empty
    // commit, so the loader treats the session as fully materialized.
    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });
    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });
    expect(calls).toBe(1);

    loader.dispose();
    childStores.disposeAll();
  });

  test("ChatContainer branch logic draws the 'Start a new chat' empty state for an idle session whose store holds the empty commit", async () => {
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    seedSessionIntoStore(store);

    let calls = 0;
    const sdk = {
      session: {
        messages: async () => {
          calls += 1;
          return emptyCompleteResponse();
        },
      },
    } as unknown as OpencodeClient;
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "test" });
    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });

    const state = store.getState();
    const renderable = getSessionMaterializationStatus(state, SESSION_ID).renderable;
    const sessionMessagesLength = state.message[SESSION_ID]?.length ?? 0;
    // Idle subtask: session_status absent in the fresh embedded iframe store,
    // and no assistant message without `time.completed` (messages are empty),
    // so ChatContainer's sessionIsWorking is false.
    const sessionIsWorking = false;

    expect(sessionMessagesLength).toBe(0);
    expect(renderable).toBe(true);
    expect(chatContainerBranch({
      currentSessionId: SESSION_ID,
      hasRenderableSessionSnapshot: renderable,
      sessionMessagesLength,
      sessionIsWorking,
    })).toBe("empty-state");

    loader.dispose();
    childStores.disposeAll();
  });

  test("without the empty commit (message list absent) the same conditions draw the hydration skeleton instead", async () => {
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    seedSessionIntoStore(store);

    // No loader call: messages never fetched, `message[sessionID]` absent.
    const renderable = getSessionMaterializationStatus(store.getState(), SESSION_ID).renderable;
    const sessionMessagesLength = store.getState().message[SESSION_ID]?.length ?? 0;

    expect(renderable).toBe(false);
    expect(chatContainerBranch({
      currentSessionId: SESSION_ID,
      hasRenderableSessionSnapshot: renderable,
      sessionMessagesLength,
      sessionIsWorking: false,
    })).toBe("hydrating-skeleton");

    childStores.disposeAll();
  });

  test("a session whose fetch returns real messages renders the viewport, not the empty state", async () => {
    const childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    seedSessionIntoStore(store);

    const sdk = {
      session: {
        messages: async () => fullResponse([
          createRecord("msg_u1", 1),
          createRecord("msg_a1", 2),
        ]),
      },
    } as unknown as OpencodeClient;
    const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "test" });
    await loader.ensure({ directory: DIRECTORY, sessionID: SESSION_ID });

    const state = store.getState();
    const renderable = getSessionMaterializationStatus(state, SESSION_ID).renderable;
    const sessionMessagesLength = state.message[SESSION_ID]?.length ?? 0;

    expect(renderable).toBe(true);
    expect(chatContainerBranch({
      currentSessionId: SESSION_ID,
      hasRenderableSessionSnapshot: renderable,
      sessionMessagesLength,
      sessionIsWorking: false,
    })).toBe("viewport");

    loader.dispose();
    childStores.disposeAll();
  });

  test("ChatContainer itself renders <ChatEmptyState /> (the 'Start a new chat' screen) in the branch the empty commit triggers", () => {
    // The skeleton branch is gated on `isSessionHydrating` (renderable == false).
    // The next branch only checks `sessionMessages.length === 0 && !sessionIsWorking`
    // and renders <ChatEmptyState /> — that is what an idle subtask whose store
    // holds the empty commit draws on first open.
    expect(chatContainerSource).toContain("const isSessionHydrating =");
    expect(chatContainerSource).toContain("isSessionHydrating && sessionMessages.length === 0 && !sessionIsWorking");
    expect(chatContainerSource).toContain("sessionMessages.length === 0 && !sessionIsWorking");
    expect(chatContainerSource).toContain("<ChatEmptyState />");
    expect(chatContainerSource).not.toContain("!hasRenderableSessionSnapshot && sessionMessages.length === 0 && !sessionIsWorking");
  });
});