import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Message, Part } from "@opencode-ai/sdk/v2/client";

// Issue #2903 — "Some subagents only show one line of output at the top"
//
// Reported symptom: on desktop web (PWA + desktop app), opening a long-running
// subagent shows only the first line of its output, and that line is never real
// output but a status message ("DeepSeek V4 Flash is thinking...", "… is running
// command…"). Android app / mobile PWA render the same subagent sessions fully.
//
// Surface difference: on desktop web a subagent session is opened in the
// EMBEDDED session-chat panel (`?ocPanel=session-chat&sessionId=…`), while on
// Android the same click navigates in place (setCurrentSession) inside the main
// app. The embedded panel is the only surface that boots inactive and waits for
// a one-way `openchamber:embedded-visibility` postMessage.
//
// Root cause chain (all asserted below):
//   1. App.tsx boots the embedded iframe with `isEmbeddedVisible=false`
//      (regression from v1.18.3's commit 9fb3109) → `ChatView active={false}`.
//   2. ChatContainer reads records with `useSessionMessageRecords(..., { enabled: active })`.
//      With `enabled:false` the hook ALWAYS returns 0 records (sync-context
//      `getSnapshot` gate) even when the session is fully materialized in the
//      store — data arrives but is never read.
//   3. With 0 records and a busy session (`sessionIsWorking`), ChatContainer's
//      empty-state branch (`sessionMessages.length === 0 && !sessionIsWorking`)
//      is skipped, so it renders the full ChatViewport whose transcript contains
//      only the `StatusRowContainer` working-status line ("… is running command…")
//      and the read-only banner — the reported "first line".
//   4. The visibility channel is one-way (postMessage, no request/ack). If the
//      parent posts while the iframe is still mounting, the message is dropped
//      and never re-sent → the panel stays inactive forever.

// ---------------------------------------------------------------------------
// Module mocks required to import sync-context outside the app shell (same set
// as packages/ui/src/sync/__tests__/session-switch-resync.test.ts).
// ---------------------------------------------------------------------------
mock.module("sonner", () => ({
    toast: { dismiss: () => undefined, error: () => undefined, info: () => undefined, success: () => undefined },
}));
mock.module("@/components/ui", () => ({
    toast: { info: () => undefined, error: () => undefined, success: () => undefined },
}));
mock.module("@/lib/opencode/client", () => ({
    opencodeClient: {
        getDirectory: () => "/repo",
        setDirectory: () => undefined,
        getSdkClient: () => ({}),
        getScopedSdkClient: () => ({}),
    },
}));
mock.module("@/stores/permissionStore", () => ({
    usePermissionStore: { getState: () => ({ isSessionAutoAccepting: () => false, hydrate: async () => undefined }) },
}));
mock.module("@/stores/useConfigStore", () => ({
    useConfigStore: {
        getState: () => ({ isConnected: true, hasEverConnected: true, settingsMessageStreamTransport: "auto" }),
        setState: () => undefined,
    },
}));
mock.module("@/stores/useTodosPersistStore", () => ({
    useTodosPersistStore: { getState: () => ({ setSessionTodos: () => undefined }) },
}));

const { useSessionMessageRecords } = await import("@/sync/sync-context");
const { ChildStoreManager } = await import("@/sync/child-store");
const { getSessionMaterializationStatus } = await import("@/sync/materialization");
import type { State } from "@/sync/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: Record<string, unknown> = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const container = {
        nodeType: 1,
        tagName: "DIV",
        nodeName: "DIV",
        namespaceURI: "http://www.w3.org/1999/xhtml",
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = container;
    documentStub.body = container;
    setGlobal("document", documentStub);
    setGlobal("window", globalThis);
    setGlobal("location", { search: "", protocol: "http:", hostname: "localhost" });
    setGlobal("Element", ElementStub);
    setGlobal("HTMLElement", ElementStub);
    setGlobal("HTMLIFrameElement", ElementStub);
    setGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    setGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    setGlobal("cancelAnimationFrame", (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    return {
        container: container as unknown as Element,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

const subagentSessionRecord = (id: string, title: string): State["session"][number] => ({
    id,
    title,
    time: { created: 1, updated: 1 },
    version: "1",
    directory: "/repo",
} as State["session"][number]);

const message = (id: string, role: "user" | "assistant", parentID?: string): Message => ({
    id,
    sessionID: "ses_child",
    role,
    ...(parentID ? { parentID } : {}),
    time: { created: 1 },
} as Message);

const textPart = (id: string, messageID: string, text: string): Part => ({
    id,
    messageID,
    sessionID: "ses_child",
    type: "text",
    text,
} as Part);

/** A long-running subagent session: 14 messages, all parts fetched. */
const buildMaterializedSubagentSession = () => {
    const messages: Message[] = [];
    const part: Record<string, Part[]> = {};
    for (let index = 0; index < 14; index += 1) {
        const role: "user" | "assistant" = index % 2 === 0 ? "user" : "assistant";
        const id = `msg_${index}`;
        messages.push(message(id, role, index > 0 ? `msg_${index - 1}` : undefined));
        if (role === "assistant") {
            part[id] = [textPart(`part_${index}`, id, `real subagent output line ${index}`)];
        }
    }
    return { messages, part };
};

// The React context SyncProvider would normally mount; the module stores it on
// globalThis at import time, which lets the harness provide its own SyncSystem.
const syncContext = (globalThis as unknown as {
    __openchamber_sync_context__?: React.Context<unknown>;
}).__openchamber_sync_context__;

if (!syncContext) {
    throw new Error("sync context was not published on globalThis by @/sync/sync-context");
}

const srcPath = (relative: string): string => path.join(path.dirname(fileURLToPath(import.meta.url)), relative);
const readSource = (relative: string): string => readFileSync(srcPath(relative), "utf8");

// ---------------------------------------------------------------------------
// Behavior test: the embedded iframe's inactive boot hides a fully
// materialized subagent session — this is what renders "only the first line".
// ---------------------------------------------------------------------------
describe("issue #2903 — inactive embedded chat hides subagent history", () => {
    test("enabled:false (inactive embedded iframe) returns 0 records for a fully renderable 14-message subagent session, while enabled:true returns all 14", async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);

        const childStores = new ChildStoreManager();
        const store = childStores.ensureChild("/repo", { bootstrap: false });
        const { messages, part } = buildMaterializedSubagentSession();
        store.setState({
            status: "complete",
            session: [subagentSessionRecord("ses_child", "Audit Searchbar implementation")],
            message: { ses_child: messages },
            part,
        } as Partial<State>);

        // The session is fully materialized — exactly what the message loader
        // commits after `GET /api/session/{id}/message` returns 200.
        expect(getSessionMaterializationStatus(store.getState(), "ses_child")).toEqual({
            hasMessages: true,
            renderable: true,
            missingPartMessageIDs: [],
        });

        const system = { childStores, messageLoader: {}, sdk: {}, runtimeKey: "test", directory: "/repo" };
        const Provider = syncContext.Provider as React.Provider<unknown>;

        let inactiveCount = -1;
        let activeCount = -1;
        let enabled = false;

        const Harness = () => {
            const records = useSessionMessageRecords("ses_child", "/repo", { enabled });
            if (enabled) {
                activeCount = records.length;
            } else {
                inactiveCount = records.length;
            }
            return null;
        };

        try {
            await act(async () => {
                root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
            });

            // THE BUG: while the embedded panel is inactive (its boot state),
            // the fully-fetched history is invisible → transcript shows only the
            // working-status line ("DeepSeek V4 Flash is running command…").
            expect(inactiveCount).toBe(0);

            // The same store content is fully visible once the panel is active —
            // this is what Android sees, because it never goes through the
            // inactive embedded boot.
            enabled = true;
            await act(async () => {
                root.render(React.createElement(Provider, { value: system }, React.createElement(Harness)));
            });
            expect(activeCount).toBe(14);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});

// ---------------------------------------------------------------------------
// Source assertions: the boot state, the one-way visibility channel, and the
// render branch that produces the status-line-only transcript.
// ---------------------------------------------------------------------------
describe("issue #2903 — source assertions", () => {
    test("App.tsx boots the embedded session-chat inactive (isEmbeddedVisible = useState(false)), so ChatView gets active=false", () => {
        const source = readSource("../../../App.tsx");
        expect(source).toContain("const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);");
        expect(source).toContain("const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;");
        expect(source).toContain("<ChatView");
        expect(source).toContain("active={embeddedBackgroundWorkEnabled}");
    });

    test("ChatContainer reads records gated by active and renders the status-row transcript when records are empty but the session is working", () => {
        const source = readSource("../../../components/chat/ChatContainer.tsx");
        // Records are only read while the surface is active; the inactive
        // embedded iframe therefore always sees an empty message list.
        expect(source).toContain("useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {");
        expect(source).toContain("enabled: active,");
        // Empty state requires `!sessionIsWorking` — a BUSY session with zero
        // records falls through to the full ChatViewport.
        expect(source).toContain("if (sessionMessages.length === 0 && !sessionIsWorking) {");
        // …whose transcript ends with the working-status row: the "first line"
        // of output the reporter sees ("… is running command…").
        expect(source).toContain("<StatusRowContainer />");
    });

    test("useSessionMessageRecords with enabled:false never reads the store (getSnapshot gate)", () => {
        const source = readSource("../../../sync/sync-context.tsx");
        expect(source).toContain("if (options?.enabled === false) {");
        expect(source).toContain("EMPTY_SESSION_MESSAGE_RECORDS");
    });

    test("the embedded-visibility channel is one-way: a lost postMessage is never re-sent or recovered", () => {
        const panelSource = readSource("../../../components/layout/ContextPanel.tsx");
        const appSource = readSource("../../../App.tsx");
        // Parent pushes visibility; there is no request/ack handshake.
        expect(panelSource).toContain("type: 'openchamber:embedded-visibility'");
        expect(panelSource).toContain("frameWindow.postMessage(");
        // The iframe only listens passively for the message — no retry, no
        // request, no fallback. If it is still mounting when the parent posts
        // (one-shot from the parent's layout effect + iframe onLoad), the
        // message is dropped and the panel stays inactive forever.
        expect(appSource).toContain("data?.type !== 'openchamber:embedded-visibility'");
        expect(appSource).toContain("window.addEventListener('message', handleMessage);");
    });
});
