/**
 * Reproduction for https://github.com/openchamber/openchamber/issues/2940
 *
 * Reported symptom: on Desktop Web 1.18.4, subagent sessions no longer show
 * what the subagent is doing — only a working-status line ("… is inspecting …",
 * "… is running command …") renders inside the session-chat panel, plus the
 * "Subagent sessions cannot be prompted." banner. The full subagent transcript
 * was visible in 1.18.2.
 *
 * Root cause (regression introduced in v1.18.3 by commit 9fb31095a, shipped
 * in v1.18.4; same root cause as #2903/#2892):
 *   1. App.tsx boots the embedded session-chat iframe with
 *      `isEmbeddedVisible=false` → ChatView receives `active={false}`.
 *   2. ChatContainer reads message records with
 *      `useSessionMessageRecords(..., { enabled: active })`. With
 *      `enabled:false` the hook always returns 0 records (sync-context
 *      getSnapshot gate) even when the subagent session is fully materialized
 *      in the store — the data arrives over SSE but is never read.
 *   3. With 0 records and a busy session (`sessionIsWorking`), the empty-state
 *      branch (`sessionMessages.length === 0 && !sessionIsWorking`) is
 *      skipped, so ChatContainer renders the full ChatViewport whose
 *      transcript contains only the working-status row + read-only banner.
 *   4. The visibility channel is one-way postMessage; a lost message leaves
 *      the panel inactive forever.
 *
 * This file runs against the v1.18.4 code (the version the reporter used) and
 * asserts the two facts that make the bug visible:
 *   - a fully materialized subagent session returns 0 message records while
 *     the embedded panel is inactive (`enabled:false`);
 *   - the same session returns all records once active (`enabled:true`).
 *
 * Run:  bun test ./packages/ui/src/components/chat/__tests__/issue-2940-subagent-activity-hidden.test.tsx
 */
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Message, Part } from "@opencode-ai/sdk/v2/client";

// ---------------------------------------------------------------------------
// Module mocks required to import sync-context outside the app shell.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const srcPath = (relative: string): string => path.join(__dirname, relative);
const readSource = (relative: string): string => readFileSync(srcPath(relative), "utf8");

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

// ---------------------------------------------------------------------------
// Behavior test: the embedded iframe's inactive boot hides a fully
// materialized subagent session — this is what renders only the working-status
// row ("… is inspecting …") and hides what the subagent is doing.
// ---------------------------------------------------------------------------
describe("issue #2940 — inactive embedded chat hides subagent activity", () => {
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
            // the fully-fetched history is invisible → the transcript shows
            // only the working-status line, not what the subagent is doing.
            expect(inactiveCount).toBe(0);

            // The same store content is fully visible once the panel is active.
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
// Source assertions: the v1.18.4 wiring that produces the bug.
// ---------------------------------------------------------------------------
describe("issue #2940 — v1.18.4 source wiring", () => {
    test("App.tsx boots the embedded session-chat inactive (isEmbeddedVisible = useState(false))", () => {
        const source = readSource("../../../App.tsx");
        // Regression: v1.18.2 had `useState(true)`; v1.18.3+ starts `false`.
        expect(source).toContain("const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);");
        expect(source).toContain("const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;");
        expect(source).toContain("active={embeddedBackgroundWorkEnabled}");
    });

    test("ChatContainer reads records gated by active (enabled: active)", () => {
        const source = readSource("../../../components/chat/ChatContainer.tsx");
        // v1.18.4: message reads are gated on the same visibility flag used to
        // keep the composer from stealing focus.
        expect(source).toContain("useSessionMessageRecords(currentSessionId ?? '', effectiveSessionDirectory, {");
        expect(source).toContain("enabled: active,");
        // Busy session with zero records skips the empty state → ChatViewport
        // renders only the working-status row.
        expect(source).toContain("if (sessionMessages.length === 0 && !sessionIsWorking) {");
        expect(source).toContain("<StatusRowContainer />");
    });

    test("useSessionMessageRecords with enabled:false never reads the store (getSnapshot gate)", () => {
        const source = readSource("../../../sync/sync-context.tsx");
        expect(source).toContain("if (options?.enabled === false) {");
        expect(source).toContain("EMPTY_SESSION_MESSAGE_RECORDS");
    });

    test("the embedded-visibility channel is one-way: a lost postMessage is never re-sent", () => {
        const appSource = readSource("../../../App.tsx");
        expect(appSource).toContain("data?.type !== 'openchamber:embedded-visibility'");
        expect(appSource).toContain("window.addEventListener('message', handleMessage);");
    });
});
