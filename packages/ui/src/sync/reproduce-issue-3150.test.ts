import { describe, expect, test } from "bun:test"
import type { OpencodeClient, Project } from "@opencode-ai/sdk/v2/client"
import { bootstrapDirectory } from "./bootstrap"
import { ChildStoreManager } from "./child-store"

// Reproduction for https://github.com/openchamber/openchamber/issues/3150
//
// Claim under test: after a page reload (fresh bootstrap), the deferred phase
// that re-pulls `permission.list` / `question.list` never runs, because it is
// gated by `isStale()` which maps to the child-store `isCurrent()` guard. That
// guard requires this bootstrap's token to still be in `runningBootstraps`, but
// the pump's `.then().finally()` chain deletes the token as microtasks right
// after `bootstrapDirectory()` returns — always before the `setTimeout(0)`
// macrotask fires. So `runDeferredPhase()` is skipped on every reload and a
// pending permission ask stays invisible forever.

const pendingPermission = {
  id: "permission-1",
  sessionID: "session-1",
  requestID: "req-1",
  type: "request",
  pattern: "/etc/hostname",
}

const createRecordingSdk = (options?: {
  permissionList?: () => Promise<{ data: unknown[] }>
  questionList?: () => Promise<{ data: unknown[] }>
}) => {
  const calls = { permissionList: 0, questionList: 0 }
  const sdk = {
    project: { current: async () => ({ data: { id: "project-a" } }) },
    config: { get: async () => ({ data: {} }) },
    path: { get: async () => ({ data: { state: "", config: "", worktree: "/repo", directory: "/repo", home: "/home" } }) },
    session: { status: async () => ({ data: {} }) },
    command: { list: async () => ({ data: [] }) },
    mcp: { status: async () => ({ data: {} }) },
    lsp: { status: async () => ({ data: [] }) },
    vcs: { get: async () => ({ data: { branch: "main" } }) },
    question: {
      list: async () => {
        calls.questionList += 1
        return options?.questionList ? options.questionList() : { data: [] }
      },
    },
    permission: {
      list: async () => {
        calls.permissionList += 1
        return options?.permissionList ? options.permissionList() : { data: [] }
      },
    },
  }
  return { sdk: sdk as unknown as OpencodeClient, calls }
}

const project = { id: "project-a", worktree: "/repo" } as Project

const flushMacrotasks = async () => {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

const waitForBootstrapState = async (
  manager: ChildStoreManager,
  directory: string,
  expected: "complete" | "failed" | "running" | "queued",
) => {
  for (let i = 0; i < 200; i += 1) {
    if (manager.getBootstrapState(directory) === expected) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`bootstrap state for ${directory} never reached ${expected}`)
}

describe("issue 3150: pending permission requests after reload", () => {
  test("reproduces the bug: deferred phase (permission.list/question.list) never runs after a fresh bootstrap", async () => {
    const { sdk, calls } = createRecordingSdk({
      permissionList: async () => ({ data: [pendingPermission] }),
    })
    const manager = new ChildStoreManager()
    // Mirrors the production wiring in sync-context.tsx (onBootstrap + bootstrapDirectory).
    manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: async (context) => {
        const store = manager.getChild(context.directory)
        if (!store || !context.isCurrent()) return
        await bootstrapDirectory({
          directory: context.directory,
          sdk,
          getState: () => store.getState(),
          set: (patch) => store.setState(patch),
          isStale: () => !context.isCurrent(),
          global: { config: {}, projects: [project] },
          loadSessions: async () => undefined,
        })
      },
    })

    // Simulates a page reload: a brand-new child store bootstraps from scratch.
    manager.ensureChild("/repo")

    await waitForBootstrapState(manager, "/repo", "complete")
    // Give the deferred setTimeout(0) every chance to run.
    await flushMacrotasks()

    // The directory bootstrap completed...
    expect(manager.getBootstrapState("/repo")).toBe("complete")
    // ...but the recovery pull for the still-pending server-side request never happened.
    expect(calls.permissionList).toBe(0)
    expect(calls.questionList).toBe(0)

    const store = manager.getChild("/repo")
    expect(store?.getState().permission).toEqual({})

    manager.disposeAll()
  })

  test("control: when isStale does not depend on the runningBootstraps token, the deferred pull runs", async () => {
    const { sdk, calls } = createRecordingSdk({
      permissionList: async () => ({ data: [pendingPermission] }),
    })
    const manager = new ChildStoreManager()
    manager.configure({
      bootstrapConcurrency: 1,
      onBootstrap: async (context) => {
        const store = manager.getChild(context.directory)
        if (!store || !context.isCurrent()) return
        await bootstrapDirectory({
          directory: context.directory,
          sdk,
          getState: () => store.getState(),
          set: (patch) => store.setState(patch),
          // Mirrors fix direction 1: staleness decoupled from the token lifecycle.
          isStale: () => false,
          global: { config: {}, projects: [project] },
          loadSessions: async () => undefined,
        })
      },
    })

    manager.ensureChild("/repo")

    await waitForBootstrapState(manager, "/repo", "complete")
    await flushMacrotasks()

    expect(calls.permissionList).toBeGreaterThan(0)
    const store = manager.getChild("/repo")
    expect(store?.getState().permission["session-1"]?.[0]?.id).toBe("permission-1")

    manager.disposeAll()
  })
})