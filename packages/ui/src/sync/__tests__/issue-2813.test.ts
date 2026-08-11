import { beforeEach, describe, expect, mock, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, OpencodeClient, Part, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE } from "../types"
import type { DirectoryStore } from "../child-store"
import { useTodosPersistStore } from "@/stores/useTodosPersistStore"

// Issue #2813 — "Todo list is not cleared when reverting a message".
//
// Reproduces the acceptance criteria from the issue:
//   - Reverting a message clears the todo list for that session from both the
//     live sync store and the persist store
//   - Unreverting (restoring) a message re-fetches or restores the todo list to
//     match the session state after unrevert
//
// Each test asserts the expected (fixed) behavior. The current implementation
// never touches `store.todo[sessionId]` or `useTodosPersistStore` in
// `revertToMessage` / `unrevertSession`, so these tests fail and demonstrate
// the bug.

const todo: Todo = { content: "write the tests", status: "in_progress", priority: "high" }

// Recorded SDK calls
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []
let sessionRevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionUnrevertResult: { data?: unknown; error?: unknown; response?: { status?: number } } = {}
let sessionMessagesResult: { data?: unknown; error?: unknown; response?: { status?: number } } = { data: [] }

const mockSdk = {
  session: {
    messages: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.messages", params })
      return Promise.resolve(sessionMessagesResult)
    }),
    revert: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.revert", params })
      return Promise.resolve(sessionRevertResult)
    }),
    unrevert: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.unrevert", params })
      return Promise.resolve(sessionUnrevertResult)
    }),
    todo: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.todo", params })
      return Promise.resolve({ data: [todo] })
    }),
    abort: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      return Promise.resolve({ data: true })
    }),
  },
}

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/test/project",
    getSdkClient: () => mockSdk,
    getScopedSdkClient: (directory: string) => mockSdk,
    revertSession: mock((sessionId: string, messageId: string, partId?: string, directory?: string | null) => {
      replyCalls.push({
        method: "session.revert",
        params: { sessionID: sessionId, messageID: messageId, partID: partId, directory },
      })
      if (sessionRevertResult.error) {
        const status = sessionRevertResult.response?.status
        throw new Error(`session.revert failed${status ? ` (${status})` : ""}: rejected`)
      }
      return Promise.resolve(sessionRevertResult.data)
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

mock.module("../session-ui-store", () => ({
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

// Shared input store mock
const inputState = {
  pendingInputText: "",
  pendingInputMode: "normal" as const,
  attachedFiles: [],
  clearAttachedFiles: () => {
    inputState.attachedFiles = []
  },
  addRestoredAttachment: (attachment: never) => {
    inputState.attachedFiles = [...inputState.attachedFiles, attachment]
  },
}

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  resolveGlobalSessionDirectory: () => null,
  mergeSessionDirectoryMetadata: (incoming: Session) => incoming,
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
      upsertSession: () => {},
      removeSessions: () => {},
    }),
  },
}))

mock.module("../session-deletion-cleanup", () => ({
  cleanupPersistedSessionState: () => {},
}))

mock.module("../sync-refs", () => ({
  getSyncSessionDirectory: () => null,
  registerSessionDirectory: () => {},
}))

function createStore(state?: Partial<DirectoryStore>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir)
      if (!store) throw new Error(`No store for ${dir}`)
      return store
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("../child-store").ChildStoreManager
}

function seedRevertableSession(sessionStore: StoreApi<DirectoryStore>) {
  const session = { id: "session-a", time: { created: 1 } } as Session
  const targetMessage = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
  const targetPart = { id: "prt_2", messageID: "msg_2", type: "text", text: "edit this" } as Part
  sessionStore.setState({
    session: [session],
    message: { "session-a": [targetMessage] },
    part: { "msg_2": [targetPart] },
  })
  return { session, targetMessage, targetPart }
}

beforeEach(() => {
  replyCalls.length = 0
  sessionRevertResult = {}
  sessionUnrevertResult = {}
  sessionMessagesResult = { data: [] }
  Object.assign(inputState, {
    pendingInputText: "",
    pendingInputMode: "normal" as const,
    attachedFiles: [],
  })
  useTodosPersistStore.setState({ sessions: {} })
})

describe("issue #2813 — todo list is not cleared when reverting a message", () => {
  test("revertToMessage clears the live sync store todo list for the session", async () => {
    const sessionStore = createStore({ todo: { "session-a": [todo] } })
    seedRevertableSession(sessionStore)
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    const { setActionRefs, revertToMessage } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    // The messages that produced these todos are now hidden by the revert
    // marker, so the live todo list must be cleared. Today it is not.
    expect(sessionStore.getState().todo["session-a"]).toBe(undefined)
  })

  test("revertToMessage clears the persisted todo list for the session", async () => {
    const sessionStore = createStore({})
    seedRevertableSession(sessionStore)
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionRevertResult = { data: { id: "session-a", time: { created: 1, updated: 2 }, revert: { messageID: "msg_2" } } }

    // Mirror of the onSetSessionTodo callback in sync-context.tsx.
    useTodosPersistStore.getState().setSessionTodos("/test/project", "session-a", [todo])
    expect(useTodosPersistStore.getState().getSessionTodos("/test/project", "session-a")).toEqual([todo])

    const { setActionRefs, revertToMessage } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await revertToMessage("session-a", "msg_2")

    // StatusRow falls back to persisted todos when the live list is empty, so
    // stale persisted todos keep the old list visible after the revert. Today
    // they are never cleared.
    expect(useTodosPersistStore.getState().getSessionTodos("/test/project", "session-a")).toBe(undefined)
  })

  test("unrevertSession re-fetches todos to match the session state after unrevert", async () => {
    // Post-revert state: revert marker set, reverted message absent, todos gone.
    const session = { id: "session-a", time: { created: 1 }, revert: { messageID: "msg_2" } } as Session
    const beforeRevert = { id: "msg_1", sessionID: "session-a", role: "user", time: { created: 1 } } as Message
    const afterRevert = { id: "msg_2", sessionID: "session-a", role: "user", time: { created: 2 } } as Message
    const sessionStore = createStore({
      session: [session],
      message: { "session-a": [beforeRevert] },
    })
    const childStores = createChildStores([["/test/project", sessionStore]])
    sessionUnrevertResult = { data: { id: "session-a", time: { created: 1, updated: 3 } } }
    sessionMessagesResult = {
      data: [
        { info: beforeRevert, parts: [] },
        { info: afterRevert, parts: [] },
      ],
    }

    const { setActionRefs, unrevertSession } = await import("../session-actions")
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project")

    await unrevertSession("session-a")

    // The restored session re-shows the messages that produced the todos, so
    // the todo list must be re-fetched. Today no todo fetch happens at all.
    expect(replyCalls.filter((call) => call.method === "session.todo")).toHaveLength(1)
    expect(sessionStore.getState().todo["session-a"]).toEqual([todo])
  })
})
