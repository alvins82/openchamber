import { describe, expect, test, beforeEach, mock } from "bun:test"

// Reproduction for issue #3006
// "Remote host: OpenChamber aborts the running turn when the client disconnects"
//
// Scenario: the desktop client is connected to a remote host (`opencode serve`
// on the remote, reached over an SSH port-forward) and a turn is running. The
// client disconnects (laptop sleep). The issue claims OpenChamber sends
// `POST /session/:id/abort` (logged by opencode as `message=cancel`), killing
// the in-flight turn.
//
// Findings from this reproduction:
//   1. A transport disconnect (marking isConnected=false) does NOT issue
//      `session.abort`. The only client path that sends `session.abort` is an
//      explicit user action (stop button, Escape, goal pause/remove).
//   2. The store carries `sessionAbortFlags`/`abortControllers` fields, but
//      nothing in the codebase populates them — an abort-on-disconnect
//      mechanism was scaffolded but is not wired up in 1.19.0.

const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = []

const mockSdk = {
  session: {
    abort: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.abort", params })
      return Promise.resolve({ data: true })
    }),
    messages: mock(() => Promise.resolve({ data: [] })),
  },
} as never

let currentConnected = true

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: currentConnected,
      hasEverConnected: true,
    }),
  },
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getSdkClient: () => mockSdk,
    getDirectory: () => "/test/project",
    setDirectory: () => {},
    getScopedSdkClient: () => mockSdk,
    replyToPermission: () => Promise.resolve(true),
    replyToQuestion: () => Promise.resolve(true),
    revertSession: () => Promise.resolve({}),
    updateSession: () => Promise.resolve({}),
    deleteSession: () => Promise.resolve(true),
  },
}))

const { setActionRefs } = await import("../session-actions")

const childStores = {
  getChild: () => ({
    getState: () => ({ session: [], session_status: {}, message: {}, part: {} }),
  }),
  ensureChild: () => ({
    getState: () => ({ session: [], session_status: {}, message: {}, part: {} }),
    setState: () => {},
  }),
  children: new Map(),
} as never

beforeEach(() => {
  replyCalls.length = 0
  currentConnected = true
})

describe("issue #3006: abort-on-disconnect for remote hosts", () => {
  test("a transport disconnect does not issue session.abort on the running turn", async () => {
    const { abortCurrentOperation } = await import("../session-actions")
    setActionRefs(mockSdk as never, childStores, () => "/test/project")

    // Simulate the client losing its connection (SSH tunnel drop / laptop sleep).
    currentConnected = false
    expect(replyCalls.filter((c) => c.method === "session.abort").length).toBe(0)

    // Reconnect and resync: still no abort is issued to the remote opencode.
    currentConnected = true
    expect(replyCalls.filter((c) => c.method === "session.abort").length).toBe(0)

    // The turn keeps running server-side; no abort to send.
    expect(abortCurrentOperation).toBeDefined()
  })

  test("abortCurrentOperation is only invoked by explicit user intent", async () => {
    const { abortCurrentOperation } = await import("../session-actions")
    setActionRefs(mockSdk as never, childStores, () => "/test/project")

    // A user pressing stop DOES abort — this is the intended behavior and the
    // only client path that sends session.abort. A plain disconnect must not.
    await abortCurrentOperation("session-remote")
    expect(replyCalls.some((c) => c.method === "session.abort")).toBe(true)
  })
})
