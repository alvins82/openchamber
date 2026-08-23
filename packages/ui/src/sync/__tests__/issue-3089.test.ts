import { beforeEach, describe, expect, mock, test } from "bun:test"

/**
 * Regression for openchamber/openchamber#3089:
 * v1.20.0 introduced project-less chat sessions. On app start (or "New
 * session" with no active session) the new-session draft now defaults to
 * "chat" and ignores the persisted last-project selection
 * (`oc.chatInput.lastDraftTarget`), so every session starts in chat mode
 * instead of the user's project.
 */

const storage = new Map<string, string>()
const sessionDirectoryRegistry = new Map<string, string>()

mock.module("zustand", () => ({
  create: () => (initializer: (
    set: (patch: unknown | ((state: unknown) => unknown)) => void,
    get: () => unknown,
    api?: unknown,
  ) => Record<string, unknown>) => {
    let state: Record<string, unknown>
    const get = () => state
    const set = (patch: unknown | ((current: Record<string, unknown>) => unknown)) => {
      const next = typeof patch === "function" ? patch(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }

    state = initializer(set, get, {
      setState: set,
      getState: get,
      getInitialState: get,
      subscribe: () => () => undefined,
    } as never)

    const store = ((selector?: (current: Record<string, unknown>) => unknown) => (
      typeof selector === "function" ? selector(state) : state
    )) as unknown as {
      getState: () => Record<string, unknown>
      setState: (patch: unknown | ((current: Record<string, unknown>) => unknown)) => void
      subscribe: () => () => void
    }

    store.getState = () => state
    store.setState = (patch) => set(patch)
    store.subscribe = () => () => undefined

    return store
  },
}))

const deferredStorage: Storage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, value)
  },
  removeItem: (key: string) => {
    storage.delete(key)
  },
  clear: () => {
    storage.clear()
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size
  },
}

mock.module("@/stores/utils/safeStorage", () => ({
  getDeferredSafeStorage: () => deferredStorage,
  createDeferredSafeJSONStorage: () => ({
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  }),
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => null,
    getFilesystemHome: mock(async () => "/home/test"),
    createDirectory: mock(async (path: string) => ({ success: true, path })),
    setDirectory: mock(() => undefined),
  },
}))

mock.module("@/stores/permissionStore", () => ({
  usePermissionStore: {
    getState: () => ({
      setSessionAutoAccept: mock(async () => undefined),
    }),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: "agent-default",
      agents: [],
      activateDirectory: mock(async () => undefined),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}))

const project = {
  id: "proj_1",
  path: "/workspace/project-a",
  label: "Project A",
}

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [project],
      activeProjectId: "proj_1",
      getActiveProject: () => project,
    }),
  },
}))

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: null,
      setDirectory: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
    }),
  },
  resolveGlobalSessionDirectory: () => null,
}))

mock.module("@/stores/useSessionFoldersStore", () => ({
  useSessionFoldersStore: {
    getState: () => ({
      addSessionToFolder: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: {
    getState: () => ({
      commands: [],
    }),
  },
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
    }),
  },
}))

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: () => undefined,
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: () => "",
  getRuntimeKey: () => "test-runtime",
  initializeRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}))

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: () => undefined,
}))

mock.module("../sync-context", () => ({
  setActiveSession: () => undefined,
}))

mock.module("../notification-store", () => ({
  markSessionViewed: () => undefined,
}))

mock.module("../session-navigation", () => ({
  setSessionOpener: () => undefined,
}))

mock.module("../session-worktree-contract", () => ({
  getAttachedSessionDirectory: () => null,
}))

mock.module("../session-worktree-store", () => ({
  useSessionWorktreeStore: {
    getState: () => ({
      getAttachment: () => undefined,
      setAttachment: () => undefined,
      clearAttachment: () => undefined,
    }),
  },
}))

mock.module("../viewport-store", () => ({
  getViewportSessionMemory: () => null,
  viewportSessionKey: (sessionId: string) => sessionId,
  useViewportStore: {
    getState: () => ({
      updateViewportAnchor: mock(() => undefined),
    }),
    setState: () => undefined,
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      setPendingInputText: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}))

mock.module("../sync-refs", () => ({
  getDirectoryState: () => null,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getAllSyncSessions: () => [],
  getSyncSessionDirectory: (sessionId: string) => sessionDirectoryRegistry.get(sessionId) ?? null,
  registerSessionDirectory: (sessionId: string, directory: string) => {
    sessionDirectoryRegistry.set(sessionId, directory)
  },
}))

mock.module("../session-actions", () => ({
  createSession: mock(async () => null),
  deleteSession: mock(async () => true),
  deleteSessions: mock(async () => ({ deletedIds: [], failedIds: [] })),
  archiveSession: mock(async () => true),
  archiveSessions: mock(async () => ({ archivedIds: [], failedIds: [] })),
  unarchiveSession: mock(async () => true),
  unarchiveSessions: mock(async () => ({ restoredIds: [], failedIds: [] })),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async () => undefined),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  patchSessionMetadata: mock(async () => undefined),
  abortCurrentOperation: mock(async () => undefined),
}))

const { useSessionUIStore } = await import("../session-ui-store")

describe("issue 3089 default draft target after app start", () => {
  beforeEach(() => {
    storage.clear()
    sessionDirectoryRegistry.clear()
    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        draftId: 0,
        open: false,
        directoryOverride: null,
        parentID: null,
        target: "chat",
      },
    })
  })

  test("cold-start draft opens the persisted project, not chat", () => {
    // The user's last session ran in Project A; the app persisted that draft
    // target (materializeOpenDraftSession writes `oc.chatInput.lastDraftTarget`).
    storage.set("oc.chatInput.lastDraftTarget", JSON.stringify({
      projectId: "proj_1",
      directory: "/workspace/project-a",
    }))

    // Cold launch: no session was restored, so ChatContainer/MainLayout
    // auto-open the draft ("New Session" without an active session takes the
    // same path — useMenuActions calls openNewSessionDraft() with no options).
    useSessionUIStore.getState().openNewSessionDraft()

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.open).toBe(true)
    expect(draft.target).toBe("project")
    expect(draft.selectedProjectId).toBe("proj_1")
    expect(draft.directoryOverride).toBe("/workspace/project-a")
  })

  test("new session while a session is active keeps the project via directory override", () => {
    // With an active session the "New Session" action passes the current
    // directory explicitly, which still resolves to the project. This contrast
    // isolates the regression to the no-context default path.
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/workspace/project-a",
    })

    const draft = useSessionUIStore.getState().newSessionDraft
    expect(draft.target).toBe("project")
    expect(draft.selectedProjectId).toBe("proj_1")
  })
})