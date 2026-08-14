// Reproduction for https://github.com/openchamber/openchamber/issues/2901
//
// "GitHub pull request panel shows stale merged PR instead of recent PRs"
//
// Scenario modeled from the report:
//   1. The PR panel/watch for a branch resolves to a PR that is later MERGED
//      on GitHub. The store holds that merged PR as the entry's status.
//   2. A NEWER open pull request is then opened for the same head branch (or
//      the branch is re-used), so the server would return it on the next
//      request.
//   3. While the entry is actively watched, the store must refresh so the
//      panel shows the recent PR instead of the stale merged one.
//
// This test drives the real store (useGitHubPrStatusStore) through its public
// API: ensureEntry / setParams / startWatching, exactly like the
// PullRequestSection component does, with the interval callback invoked
// manually (window.setInterval is stubbed to capture callbacks).
import { beforeEach, describe, expect, mock, test } from "bun:test"
import type { GitHubPullRequestStatus, RuntimeAPIs } from "@/lib/api/types"

let runtimeKey = "runtime-a"
mock.module("@/lib/runtime-switch", () => ({ getRuntimeKey: () => runtimeKey }))

// The store calls window.setInterval/window.setTimeout inside startWatching.
// In the bun test environment window is undefined, so provide a stub that
// captures the callbacks instead of scheduling real timers.
const intervalCallbacks: Array<() => void> = []
const timeoutCallbacks: Array<() => void> = []
globalThis.window = {
  setInterval: (callback: () => void) => {
    intervalCallbacks.push(callback)
    return intervalCallbacks.length
  },
  setTimeout: (callback: () => void) => {
    timeoutCallbacks.push(callback)
    return timeoutCallbacks.length
  },
  clearInterval: () => {},
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
} as unknown as Window & typeof globalThis

const { getGitHubPrStatusKey, useGitHubPrStatusStore } = await import("./useGitHubPrStatusStore")

const params = (github: RuntimeAPIs["github"], branch = "feature-x") => ({
  directory: "/repo",
  branch,
  remoteName: "origin",
  canShow: true,
  github,
  githubAuthChecked: true,
  githubConnected: true,
})

const mergedPrStatus = (fetchedAt: number): GitHubPullRequestStatus => ({
  connected: true,
  fetchedAt,
  repo: { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" },
  branch: "feature-x",
  pr: {
    number: 12,
    title: "Old already-merged pull request",
    url: "https://github.com/acme/widgets/pull/12",
    state: "merged",
    draft: false,
    base: "main",
    head: "feature-x",
  },
  resolvedRemoteName: "origin",
})

const newOpenPrStatus = (fetchedAt: number): GitHubPullRequestStatus => ({
  connected: true,
  fetchedAt,
  repo: { owner: "acme", repo: "widgets", url: "https://github.com/acme/widgets" },
  branch: "feature-x",
  pr: {
    number: 15,
    title: "Recent pull request",
    url: "https://github.com/acme/widgets/pull/15",
    state: "open",
    draft: false,
    base: "main",
    head: "feature-x",
  },
  resolvedRemoteName: "origin",
})

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("stale merged PR never revalidated while watched (issue #2901)", () => {
  beforeEach(() => {
    runtimeKey = "runtime-a"
    intervalCallbacks.length = 0
    timeoutCallbacks.length = 0
    useGitHubPrStatusStore.setState({ entries: {}, activeRequestCount: 0, totalRequestCount: 0 })
    useGitHubPrStatusStore.getState().resetForRuntimeSwitch()
  })

  test("a watched entry holding a merged PR is never re-fetched, so a newer open PR for the same branch is never discovered", async () => {
    let requests: GitHubPullRequestStatus[] = [mergedPrStatus(1_000)]
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        const next = requests.shift()
        if (!next) throw new Error("unexpected request")
        return next
      },
    } as unknown as RuntimeAPIs["github"]

    const key = getGitHubPrStatusKey("/repo", "feature-x", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))

    // Same lifecycle as PullRequestSection: watch the key (fires an immediate
    // forced refresh, bootstrap retries at 2s/5s, and a 15s revalidation
    // interval while watchers > 0).
    useGitHubPrStatusStore.getState().startWatching(key)
    await flushMicrotasks()

    // Initial resolution: the branch's PR was merged.
    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.state).toBe("merged")

    // A newer, open PR now exists for the same head branch; the server would
    // return it on the next request.
    requests = [newOpenPrStatus(2_000)]

    // The PullRequestSection focus/visibility effect only refreshes when the
    // held state is NOT terminal, so the periodic store revalidation is the
    // only path that can discover the new PR here. Invoke the watcher's
    // 15-second interval callback: for a merged (terminal) PR it must NOT
    // issue a refresh.
    const intervalCallback = intervalCallbacks[intervalCallbacks.length - 1]
    expect(typeof intervalCallback).toBe("function")
    intervalCallback()
    await flushMicrotasks()

    // BUG: the entry is never re-fetched — the stale merged PR is kept
    // indefinitely, and the recent open PR is never picked up.
    expect(requestCount).toBe(1)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.state).toBe("merged")
  })

  test("a forced manual refresh (refresh button) does update a merged entry", async () => {
    let requests: GitHubPullRequestStatus[] = [mergedPrStatus(1_000), newOpenPrStatus(2_000)]
    let requestCount = 0
    const github = {
      prStatus: async () => {
        requestCount += 1
        const next = requests.shift()
        if (!next) throw new Error("unexpected request")
        return next
      },
    } as unknown as RuntimeAPIs["github"]

    const key = getGitHubPrStatusKey("/repo", "feature-x", "origin")
    useGitHubPrStatusStore.getState().ensureEntry(key)
    useGitHubPrStatusStore.getState().setParams(key, params(github))
    useGitHubPrStatusStore.getState().startWatching(key)
    await flushMicrotasks()

    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(12)

    // The manual refresh button calls refresh({ force: true }) — this DOES
    // re-fetch and would surface the newer open PR, which is why the stale
    // display only persists for users who do not (or cannot) hit refresh.
    await useGitHubPrStatusStore.getState().refresh(key, { force: true })

    expect(requestCount).toBe(2)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.number).toBe(15)
    expect(useGitHubPrStatusStore.getState().entries[key]?.status?.pr?.state).toBe("open")
  })
})
