/**
 * Reproduction for openchamber#3009 — Remote host: after reconnect, finished
 * session stays stuck in "computing" state until webview reload.
 *
 * Scenario: a remote agent turn is running when the client disconnects (laptop
 * sleep). The turn COMPLETES on the server while disconnected. On reconnect,
 * the client's resync path (`resyncDirectoryAfterReconnect` →
 * `resyncDirectorySessionStatuses(..., "authoritative")` + tail refresh) must
 * reconcile the session to the server's completed state. The issue reports the
 * session instead stays stuck showing "<model> is computing .." with the
 * in-flight tool call rendered red as interrupted — even though the server log
 * shows the turn completed cleanly (display-only bug).
 *
 * This test simulates the exact store mutations the reconnect resync performs:
 *   1. authoritative status snapshot (server reports the session idle/absent)
 *   2. `interruptedTurnToolParts` finalization (the #2577 interruption logic)
 *   3. tail refresh merge of the server's authoritative completed message+parts
 * and then derives the UI activity state the same way `useSessionActivity`
 * does, checking for the stuck "working/computing" condition.
 */
import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { Message, Part, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { applySessionStatusSnapshot, interruptedTurnToolParts } from "../sync-context"
import { materializeSessionSnapshots } from "../materialization"

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function unfinishedAssistantMessage(id: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "primary",
    system: "",
    agent: "",
    model: "",
    time: { created: 10 },
  } as unknown as Message
}

function completedAssistantMessage(id: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "assistant",
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "primary",
    system: "",
    agent: "",
    model: "",
    time: { created: 10, completed: 5000 },
  } as unknown as Message
}

function userMessage(id: string): Message {
  return {
    id,
    sessionID: "ses_1",
    role: "user",
    parentID: "",
    modelID: "",
    providerID: "",
    mode: "primary",
    system: "",
    agent: "",
    model: "",
    time: { created: 1 },
  } as unknown as Message
}

function runningTool(id: string, messageID: string): Part {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    state: { status: "running", time: { start: 1000 }, input: {} },
  } as unknown as Part
}

function completedTool(id: string, messageID: string): Part {
  return {
    id,
    messageID,
    sessionID: "ses_1",
    type: "tool",
    tool: "bash",
    state: { status: "completed", time: { start: 1000, end: 4500 }, input: {}, output: "all 50 files written" },
  } as unknown as Part
}

// The same derivation `useSessionActivity` (packages/ui/src/hooks/useSessionActivity.ts)
// applies to decide whether the UI shows the session as working/computing.
function deriveSessionActivity(status: SessionStatus | undefined, messages: Message[] | undefined) {
  // SAFETY: SessionStatus.type is exactly "idle" | "busy" | "retry" per the SDK.
  const phase = (status?.type ?? "idle") as "idle" | "busy" | "retry"
  const lastMessage = messages?.[messages.length - 1]
  // SAFETY: Message.time is always an object; reading an optional completed field is safe.
  const hasPendingAssistant = Boolean(
    lastMessage
    && lastMessage.role === "assistant"
    && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== "number",
  )
  const hasAuthoritativeStatus = status !== undefined
  const statusWorking = hasAuthoritativeStatus && phase !== "idle"
  const isWorking = statusWorking || hasPendingAssistant
  if (hasAuthoritativeStatus && !statusWorking) return { isWorking: false, phase }
  if (!isWorking) return { isWorking: false, phase }
  return { isWorking: true, phase: statusWorking ? phase : "busy" }
}

describe("issue #3009 — reconnect resync of a session whose turn completed while disconnected", () => {
  test("resync finalizes a completed-while-disconnected turn as interrupted and the authoritative tail cannot repair the message", () => {
    // --- Pre-disconnect local state: turn running on the remote host ---
    const store = createDirectoryStore({
      session_status: { ses_1: { type: "busy" } },
      message: { ses_1: [userMessage("msg_u"), unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })

    // --- Step 1: authoritative status snapshot on reconnect. The turn finished
    // while the laptop was asleep, so the server reports NO active session. ---
    // SAFETY: an empty snapshot map is a valid SessionStatus record ("all idle").
    const changed = applySessionStatusSnapshot(store, {} as Record<string, SessionStatus>, ["ses_1"], "authoritative")
    expect(changed).toBe(true)
    expect(store.getState().session_status.ses_1).toEqual({ type: "idle" })

    // --- Step 2: the interrupted-turn finalization that resyncDirectorySessionStatuses
    // applies immediately after the snapshot (before any tail refresh). The
    // local message is still the stale unfinished one, so the turn is judged
    // interrupted even though it completed on the server. ---
    const interrupted = interruptedTurnToolParts(store.getState(), "ses_1", 6000)
    expect(interrupted).not.toBeNull()
    store.setState((state) => ({
      message: { ...state.message, ses_1: interrupted!.messages },
      part: { ...state.part, [interrupted!.messageID]: interrupted!.parts! },
    }))

    // The in-flight tool is finalized as error/Interrupted → renders red.
    // SAFETY: the fixture part is a tool part whose state carries status/error.
    const toolAfterMark = store.getState().part.msg_1[0] as { state: { status: string; error?: string } }
    expect(toolAfterMark.state.status).toBe("error")
    expect(toolAfterMark.state.error).toBe("Interrupted")

    // --- Step 3: tail refresh (loader.refreshTail) merges the server's
    // authoritative tail: the assistant message IS completed and the tool DID
    // complete (the turn was never interrupted on the server). ---
    const materialized = materializeSessionSnapshots(
      store.getState(),
      "ses_1",
      [
        { info: completedAssistantMessage("msg_1"), parts: [completedTool("tool_1", "msg_1")] },
      ],
      { skipPartTypes: new Set(["patch", "step-start", "step-finish"]) },
    )
    store.setState({
      message: materialized.message,
      part: materialized.part,
    })

    // --- Final state after the full resync path ---
    const finalState = store.getState()
    // SAFETY: the fixtures guarantee message[1] is the assistant message and
    // part[0] is the tool part under assertion.
    const finalMessage = finalState.message.ses_1[1] as Message & { error?: { name?: string } }
    const finalTool = finalState.part.msg_1[0] as { state: { status: string; error?: string } }

    // BUG: the locally-finalized MessageAbortedError message survives the
    // authoritative refresh — `mergeMessages` keeps the existing record for the
    // same ID, so the server's completed message (time.completed, no error) is
    // never applied. The finished turn stays rendered as interrupted/aborted.
    // SAFETY: the aborted fixture carries time.completed from the local mark.
    expect((finalMessage.time as { completed?: number }).completed).toBe(5000) // fails: stays 6000 with MessageAbortedError
    expect(finalMessage.error?.name).toEqual(undefined) // fails: MessageAbortedError persists

    // The tool part IS corrected by the current merge, but the message-level
    // abort stays — the chat keeps showing the red interrupted state.
    expect(finalTool.state.status).toBe("completed")

    // And because the message is now locally "completed" (aborted) while the
    // server session is idle, the status row derives idle — the session only
    // shows the true completed state after a webview reload (full bootstrap).
    const activity = deriveSessionActivity(finalState.session_status.ses_1, finalState.message.ses_1)
    expect(activity.isWorking).toBe(false)
  })

  test("resync race: snapshot taken while turn still running leaves a stuck busy session", () => {
    // The reconnect resync runs the status snapshot BEFORE the tail refresh.
    // If the turn is still running at snapshot time (completing moments later),
    // the snapshot reports the session busy and the interruption mark is gated.
    const store = createDirectoryStore({
      session_status: { ses_1: { type: "busy" } },
      message: { ses_1: [userMessage("msg_u"), unfinishedAssistantMessage("msg_1")] },
      part: { msg_1: [runningTool("tool_1", "msg_1")] },
    })

    // Snapshot still reports busy (turn not finished when the resync ran).
    applySessionStatusSnapshot(store, { ses_1: { type: "busy" } }, ["ses_1"], "authoritative")
    expect(store.getState().session_status.ses_1).toEqual({ type: "busy" })
    // interruptedTurnToolParts is gated on idle → no-op while the snapshot
    // still reports busy.
    expect(interruptedTurnToolParts(store.getState(), "ses_1")).toBeNull()

    // Tail refresh fetched while the turn was still running: unfinished.
    const materialized = materializeSessionSnapshots(
      store.getState(),
      "ses_1",
      [
        { info: unfinishedAssistantMessage("msg_1"), parts: [runningTool("tool_1", "msg_1")] },
      ],
      { skipPartTypes: new Set(["patch", "step-start", "step-finish"]) },
    )
    store.setState({ message: materialized.message, part: materialized.part })

    // The turn completes on the server shortly after — but if the stream
    // missed the terminal events (e.g. replay buffer overflowed during the
    // long disconnect), the UI derives a stuck busy/working session:
    const activity = deriveSessionActivity(store.getState().session_status.ses_1, store.getState().message.ses_1)
    expect(activity.isWorking).toBe(true) // "<model> is computing .." until reload
    expect(activity.phase).toBe("busy")
  })
})