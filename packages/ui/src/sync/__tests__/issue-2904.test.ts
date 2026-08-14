import { describe, expect, mock, test } from "bun:test"
import type { Message, OpencodeClient, Part, Session } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// Minimal harness for optimisticSend (mirrors session-actions.test.ts).
// mocks must be declared before the modules they replace are imported.
// NOTE: relative mock specifiers resolve from THIS file (__tests__/), so the
// sync modules are addressed through the `@/sync/...` alias, which resolves to
// the same module the importer uses.
// ---------------------------------------------------------------------------

const mockSdk = { session: {} } as unknown as OpencodeClient

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getScopedSdkClient: () => mockSdk,
    getDirectory: () => "/repo",
    getSdkClient: () => mockSdk,
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
      probeConnection: async () => true,
    }),
  },
}))

mock.module("@/sync/sync-refs", () => ({
  getSyncSessionDirectory: () => null,
  registerSessionDirectory: () => {},
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: (session: Session) => (session as Session & { directory?: string | null }).directory ?? null,
  mergeSessionDirectoryMetadata: (incoming: Session, existing?: Session | null) => {
    if (!existing) return incoming
    const next = { ...(incoming as Session & { directory?: string | null }) }
    const existingWithDirectory = existing as Session & { directory?: string | null }
    if (!next.directory && existingWithDirectory.directory) next.directory = existingWithDirectory.directory
    return next
  },
  isGlobalSessionRecencyOnlyUpdate: () => false,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: () => {},
      removeSessions: () => {},
    }),
  },
}))

mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => null,
      currentSessionId: null,
      setCurrentSession: () => {},
      setWorktreeMetadata: () => {},
      setSessionDirectory: () => {},
    }),
  },
}))

mock.module("@/sync/input-store", () => ({
  useInputStore: {
    getState: () => ({
      pendingInputText: "",
      pendingInputMode: "normal",
      attachedFiles: [],
    }),
  },
}))

mock.module("@/sync/session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: () => {},
}))

import { create, type StoreApi } from "zustand"

import { mergeMessages, mergeOptimisticPage } from "../optimistic"
import { materializeSessionSnapshots } from "../materialization"
import { buildRevertedMessageDockState } from "../../components/chat/revertedMessageDockState"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"

/**
 * Reproduction for openchamber/openchamber#2904:
 * Message IDs are treated as chronological clocks. Message IDs embed an
 * encoded timestamp (`msg_` + 6 bytes of `BigInt(now) * 0x1000 + counter` +
 * random). At the encoded-timestamp rollover, a message with ID `msg_ffff...`
 * (time.created = 1000) is immediately followed by one with ID `msg_0000...`
 * (time.created = 1001). Lexical ID comparison then reverses their real
 * chronological order in every path that sorts by ID.
 */

const SES = "ses_2904"

const message = (id: string, created: number, role: "user" | "assistant" = "user"): Message => ({
  id,
  sessionID: SES,
  role,
  time: { created, completed: 0 },
} as Message)

// Encoded timestamp rollover: `ffff...` has the smaller time.created.
const rolledOverId = "msg_ffffffffffff00000000000000"
const rolledOver = message(rolledOverId, 1000)

const postRolloverId = "msg_00000000000000000000000001"
const postRollover = message(postRolloverId, 1001)

const part = (id: string, messageID: string, text: string): Part => ({
  id,
  messageID,
  sessionID: SES,
  type: "text",
  text,
} as Part)

describe("issue #2904: message ID rollover breaks message ordering, pagination, and revert boundaries", () => {
  test("mergeMessages keeps the rolled-over chronological order (timeline materialization)", () => {
    // Real order: `msg_ffff...` (created 1000) is immediately BEFORE
    // `msg_0000...` (created 1001). The issue's acceptance criterion says the
    // timeline must render `msg_ffff...` first because its time.created is
    // earlier.
    const merged = mergeMessages([], [rolledOver, postRollover])

    // EXPECTED (chronology via time.created, ID only as tie-breaker):
    expect(merged.map((item) => item.id)).toEqual([rolledOverId, postRolloverId])
  })

  test("materializeSessionSnapshots keeps rolled-over chronological order in the store", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      SES,
      [
        { info: rolledOver, parts: [] },
        { info: postRollover, parts: [] },
      ],
    )

    // EXPECTED: store array (consumed by useSessionMessages → timeline) keeps
    // `msg_ffff...` before `msg_0000...`.
    expect(result.message[SES].map((item) => item.id)).toEqual([rolledOverId, postRolloverId])
  })

  test("pagination across the rollover boundary preserves order without reversal", () => {
    // Each fetched page is sorted by ID inside SessionMessageLoader.fetchPage.
    // Page 2 (older history, pre-rollover) contains `msg_ffff...`; page 1
    // (newest, post-rollover) contains `msg_0000...`. Committing the initial
    // page then prepending the older page must place `msg_ffff...` first.
    let store = materializeSessionSnapshots(
      { message: {}, part: {} },
      SES,
      [{ info: postRollover, parts: [] }],
    )

    // "load older" prepend: merge the older page into the store.
    const prepended = materializeSessionSnapshots(
      store,
      SES,
      [{ info: rolledOver, parts: [] }],
      { mode: "prepend" },
    )
    store = prepended

    // EXPECTED: `msg_ffff...` (older) first, `msg_0000...` (newest) last.
    expect(store.message[SES].map((item) => item.id)).toEqual([rolledOverId, postRolloverId])
  })

  test("mergeOptimisticPage does not insert newer optimistic messages before older rolled-over ones", () => {
    // A message sent after the rollover (created 1002, ID `msg_0000...`) is
    // merged into a page whose only server record is the older `msg_ffff...`
    // (created 1000). Chronologically the optimistic message belongs AFTER
    // `msg_ffff...`.
    const optimistic = message("msg_000000000000zzzzzzzzzzzzzz", 1002)
    const page = mergeOptimisticPage(
      { session: [rolledOver], part: [], complete: true },
      [{ message: optimistic, parts: [] }],
    )

    // EXPECTED: rolled-over message first, optimistic (newer) after it.
    expect(page.session.map((item) => item.id)).toEqual([rolledOverId, optimistic.id])
  })

  test("reverted-message dock uses chronology, not lexical ID, for visibility", () => {
    const revertMessageID = rolledOverId // revert at the earlier message
    const dock = buildRevertedMessageDockState(
      {
        session: [{ id: SES, revert: { messageID: revertMessageID } } as Session],
        // Store order is the materialized chronological order.
        message: { [SES]: [rolledOver, postRollover] },
        part: {
          [rolledOverId]: [part("p_ffff", rolledOverId, "rolled over")],
          [postRolloverId]: [part("p_0000", postRolloverId, "newer branch")],
        },
      },
      SES,
    )

    // EXPECTED: `msg_0000...` was created after the revert point, so it is a
    // reverted message and must appear in the dock.
    expect(dock.records.map((record) => record.message.id)).toEqual([postRolloverId])
  })

  test("reverted-message dock excludes messages created BEFORE the revert point", () => {
    const revertMessageID = postRolloverId // revert at the later message
    const dock = buildRevertedMessageDockState(
      {
        session: [{ id: SES, revert: { messageID: revertMessageID } } as Session],
        message: { [SES]: [rolledOver, postRollover] },
        part: {
          [rolledOverId]: [part("p_ffff", rolledOverId, "earlier branch")],
          [postRolloverId]: [part("p_0000", postRolloverId, "revert point")],
        },
      },
      SES,
    )

    // EXPECTED: `msg_ffff...` was created BEFORE the revert point, so it must
    // NOT appear in the reverted dock.
    expect(dock.records.map((record) => record.message.id)).toEqual([])
  })

  test("optimisticSend removes exactly the chronologically reverted branch", async () => {
    // Session was reverted at `msg_ffff...` (created 1000). The reverted branch
    // is everything at/after that point chronologically: both `msg_ffff...`
    // and `msg_0000...` (created 1001). Sending a new prompt must remove both.
    const targetStore = createStore({}, {
      session: [{ id: SES, revert: { messageID: rolledOverId } } as Session],
      message: { [SES]: [rolledOver, postRollover] },
      part: {
        [rolledOverId]: [part("p_ffff", rolledOverId, "old")],
        [postRolloverId]: [part("p_0000", postRolloverId, "old branch")],
      },
    })
    const childStores = createChildStores([["/repo", targetStore]])
    const optimisticShadow = new Set([rolledOverId, postRolloverId])

    const { optimisticSend, setActionRefs, setOptimisticRefs } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/repo")
    setOptimisticRefs(
      (input) => {
        optimisticShadow.add(input.message.id)
        targetStore.setState((state) => ({
          message: { ...state.message, [input.sessionID]: [...(state.message[input.sessionID] ?? []), input.message] },
          part: { ...state.part, [input.message.id]: input.parts },
        }))
      },
      () => {},
      (input) => optimisticShadow.delete(input.messageID),
    )

    await optimisticSend({
      sessionId: SES,
      directory: "/repo",
      content: "new branch",
      providerID: "provider",
      modelID: "model",
      send: async () => {},
    })

    // EXPECTED: both rolled-over messages are removed before the new prompt;
    // neither their parts nor their optimistic shadow survive.
    const retained = targetStore.getState().message[SES].map((item) => item.id)
    expect(retained).not.toContain(rolledOverId)
    expect(retained).not.toContain(postRolloverId)
    expect(targetStore.getState().part[rolledOverId]).toBe(undefined)
    expect(targetStore.getState().part[postRolloverId]).toBe(undefined)
    expect(optimisticShadow.has(rolledOverId)).toBe(false)
    expect(optimisticShadow.has(postRolloverId)).toBe(false)
  })
})

function createStore(
  _permissions: Record<string, never> = {},
  state?: Partial<DirectoryStore>,
): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: {},
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  const children = new Map(entries)
  return {
    children,
    ensureChild: (dir: string) => {
      const store = children.get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => children.get(dir),
  } as unknown as import("../child-store").ChildStoreManager
}
