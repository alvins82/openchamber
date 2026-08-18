/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2982
 *
 * [Bug] Duplicating an agent does nothing on mobile
 *
 * On mobile, Settings uses staged navigation: the agents list screen
 * (`page-sidebar` stage) and the agent editor screen (`page-content` stage)
 * are separate screens, and advancing requires `onItemSelect` to be invoked.
 * `SettingsView` wires `handleMobilePageSidebarItemSelect` as the sidebar's
 * `onItemSelect` (SettingsView.tsx:749 / :988), which advances the mobile
 * stage to `page-content`.
 *
 * `handleDuplicateAgent` in AgentsSidebar.tsx sets the prefilled draft and
 * selects the copy name, but — unlike `handleCreateNew` and normal list
 * selection — never calls `onItemSelect?.()`. On mobile the editor screen
 * therefore never opens after tapping Duplicate; on desktop the sidebar and
 * the editor render side by side so the selection change is visible anyway.
 *
 * This test mounts the real `AgentsSidebar` and drives the "..." menu →
 * Duplicate interaction, asserting that the item-select callback is invoked
 * (the behavior every other agent action has and the mobile navigation
 * depends on). It fails on the un-fixed code.
 */
import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Agent } from '@opencode-ai/sdk/v2';

// ---------------------------------------------------------------------------
// Module mocks (must be registered before the SUT is imported)
// ---------------------------------------------------------------------------

const FAKE_AGENT: Agent = {
  name: 'coder',
  description: 'A coding agent',
  mode: 'subagent',
  model: { providerID: 'anthropic', modelID: 'claude-3-5-sonnet' },
  temperature: 0.7,
  prompt: 'You are a coding agent.',
  permission: [],
  options: {},
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getDirectory: () => null,
    setDirectory: () => undefined,
    listAgents: async () => [FAKE_AGENT],
    getSdkClient: () => ({}),
    getScopedSdkClient: () => ({}),
  },
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => ({ ok: true, json: async () => ({}) }),
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined, warning: () => undefined, info: () => undefined },
}));

// The real dropdown/context/dialog primitives are base-ui portals with
// floating positioning; a minimal DOM stub cannot drive them. Provide simple
// pass-throughs so the sidebar's real handlers remain reachable.
mock.module('@/components/ui/dropdown-menu', () => {
  const PassThrough: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
  const Item: React.FC<{ children?: React.ReactNode; onClick?: (event: React.MouseEvent) => void }> = ({
    children,
    onClick,
  }) => <button onClick={onClick}>{children}</button>;
  return {
    DropdownMenu: PassThrough,
    DropdownMenuTrigger: PassThrough,
    DropdownMenuContent: PassThrough,
    DropdownMenuItem: Item,
    DropdownMenuLabel: PassThrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuRadioGroup: PassThrough,
    DropdownMenuRadioItem: PassThrough,
    DropdownMenuSub: PassThrough,
    DropdownMenuSubTrigger: PassThrough,
    DropdownMenuSubContent: PassThrough,
  };
});

mock.module('@/components/ui/context-menu', () => {
  const PassThrough: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
  return {
    ContextMenu: PassThrough,
    ContextMenuTrigger: PassThrough,
    // Never rendered by the interaction under test; keep it out of the DOM
    // so the Duplicate button is unambiguous.
    ContextMenuContent: () => null,
    ContextMenuItem: PassThrough,
  };
});

mock.module('@/components/ui/dialog', () => {
  const PassThrough: React.FC<{ children?: React.ReactNode }> = ({ children }) => <>{children}</>;
  return {
    Dialog: PassThrough,
    DialogContent: PassThrough,
    DialogDescription: PassThrough,
    DialogFooter: PassThrough,
    DialogHeader: PassThrough,
    DialogTitle: PassThrough,
  };
});

mock.module('@/components/ui/ScrollableOverlay', () => {
  const ScrollableOverlay: React.FC<{ children?: React.ReactNode }> = ({ children }) => <div>{children}</div>;
  return { ScrollableOverlay };
});

mock.module('@/components/sections/shared/SettingsProjectSelector', () => ({
  SettingsProjectSelector: () => null,
}));

mock.module('@/components/sections/shared/SidebarGroup', () => {
  const SidebarGroup: React.FC<{ children?: React.ReactNode }> = ({ children }) => <div>{children}</div>;
  return { SidebarGroup };
});

// ---------------------------------------------------------------------------
// SUT imports (dynamic: they must resolve after the mocks above)
// ---------------------------------------------------------------------------

const { AgentsSidebar } = await import('@/components/sections/agents/AgentsSidebar');
const { useAgentsStore } = await import('@/stores/useAgentsStore');
const { I18nProvider } = await import('@/lib/i18n');

// ---------------------------------------------------------------------------
// Minimal DOM stub (Bun's test runner provides no DOM)
// ---------------------------------------------------------------------------

// The index signature mirrors a real DOM element: react-dom attaches host
// element props under arbitrary `__reactProps$*` keys, and the stub needs to
// expose them to the test helpers.
interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: FakeNode[];
  parentNode: FakeNode | null;
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  getElementById(_: string): FakeNode | null;
  activeElement: FakeNode | null;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  addEventListener(): void;
  removeEventListener(): void;
  innerWidth?: number;
  screen?: { width?: number };
  location?: { search: string; protocol: string; hostname: string; href: string };
}

/** The stub document installed on globalThis, reachable without re-casting. */
let activeDocument: FakeDocument | null = null;

function makeNode(tag: string, owner: FakeDocument): FakeNode {
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument: owner,
    parentNode: null,
    childNodes: [],
    style: { setProperty() { /* noop */ }, getPropertyValue() { return ''; } },
    classList: {
      add() { /* noop */ },
      remove() { /* noop */ },
      contains() { return false; },
      toString() { return ''; },
    },
    setAttribute() { /* noop */ },
    removeAttribute() { /* noop */ },
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild(child: FakeNode) { this.childNodes.push(child); child.parentNode = this; return child; },
    insertBefore(child: FakeNode, ref: FakeNode) {
      const index = this.childNodes.indexOf(ref);
      if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child: FakeNode) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    contains() { return false; },
    cloneNode() { return node; },
    compareDocumentPosition() { return 0; },
    focus() { /* noop */ },
    blur() { /* noop */ },
    click() { /* noop */ },
    textContent: '',
    innerHTML: '',
  };
  return node;
}

function installDomStub(): () => void {
  let bodyNode: FakeNode;
  let htmlNode: FakeNode;

  // SAFETY: the window stub implements every FakeWindow member; `document`
  // is a getter resolving the document stub built below (the two stubs
  // intentionally reference each other).
  const windowStub = {
    get document() { return documentStub; },
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() { /* noop */ }, removeEventListener() { /* noop */ } }; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    innerWidth: 1024,
    location: { search: '', protocol: 'http:', hostname: 'localhost', href: 'http://localhost/' },
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as FakeWindow;

  // SAFETY: the document stub implements every FakeDocument member:
  // `defaultView` resolves the window stub above, and `body`/`documentElement`
  // resolve the node stubs created immediately below.
  const documentStub = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
    parentNode: null,
    childNodes: [],
    style: {},
    classList: { add() { /* noop */ }, remove() { /* noop */ }, contains() { return false; }, toString() { return ''; } },
    setAttribute() { /* noop */ },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild() { return undefined; },
    insertBefore() { return undefined; },
    removeChild() { return undefined; },
    getElementById() { return null; },
    createTextNode(text: string): FakeNode {
      return {
        nodeType: 3,
        nodeName: '#text',
        tagName: '#text',
        childNodes: [],
        textContent: text,
        parentNode: null,
      };
    },
    createElement(tag: string) { return makeNode(tag, documentStub); },
    createElementNS(_: string, tag: string) { return makeNode(tag, documentStub); },
    get defaultView() { return windowStub; },
    get body() { return bodyNode; },
    get documentElement() { return htmlNode; },
    activeElement: null,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as FakeDocument;

  bodyNode = makeNode('body', documentStub);
  htmlNode = makeNode('html', documentStub);

  const previous = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    IS_REACT_ACT_ENVIRONMENT: Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };

  const setGlobal = (
    key: string,
    value: FakeDocument | FakeWindow | FakeWindow['navigator'] | FakeWindow['location'] | boolean,
  ): void => {
    try {
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    } catch {
      Reflect.set(globalThis, key, value);
    }
  };

  setGlobal('document', documentStub);
  setGlobal('window', windowStub);
  setGlobal('navigator', windowStub.navigator);
  setGlobal('location', windowStub.location);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  activeDocument = documentStub;

  return () => {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) {
        try {
          Object.defineProperty(globalThis, key, descriptor);
        } catch {
          // The runtime rejected the restore; the test process exits shortly.
        }
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    activeDocument = null;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Props react-dom attaches to a host element under `__reactProps$*`. */
interface ReactElementProps {
  onClick?: (event: { preventDefault(): void; stopPropagation(): void; defaultPrevented?: boolean }) => void;
  'data-settings-item'?: string;
}

function readReactProps(node: FakeNode): ReactElementProps | null {
  const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps'));
  if (!propsKey) return null;
  // SAFETY: react-dom attaches the host element's declared props under a
  // `__reactProps$*` key; the interface above declares the subset this test
  // reads, and the real handlers only use the members of that subset.
  return node[propsKey] as ReactElementProps;
}

function findNodeWithProp(root: FakeNode, predicate: (props: ReactElementProps) => boolean): FakeNode | null {
  const props = readReactProps(root);
  if (props && predicate(props)) {
    return root;
  }
  for (const child of root.childNodes ?? []) {
    const found = findNodeWithProp(child, predicate);
    if (found) return found;
  }
  return null;
}

function findNodeByTextChild(root: FakeNode, text: string): FakeNode | null {
  for (const child of root.childNodes ?? []) {
    if (child.nodeType === 3 && child.textContent === text) {
      return root;
    }
    const found = findNodeByTextChild(child, text);
    if (found) return found;
  }
  return null;
}

function clickNode(node: FakeNode): void {
  const props = readReactProps(node);
  if (!props?.onClick) throw new Error('node has no onClick');
  props.onClick({ preventDefault() { /* noop */ }, stopPropagation() { /* noop */ }, defaultPrevented: false });
}

// ---------------------------------------------------------------------------
// The reproduction
// ---------------------------------------------------------------------------

describe('issue 2982: duplicating an agent on mobile', () => {
  const mountSidebar = async (onItemSelect: () => void) => {
    const doc = activeDocument;
    if (!doc) throw new Error('DOM stub not installed');
    const container = doc.createElement('div');
    // SAFETY: the FakeNode stub deliberately implements the DOM surface
    // react-dom's createRoot needs, so it is usable as a root container.
    const root: Root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(
        React.createElement(
          I18nProvider,
          null,
          React.createElement(AgentsSidebar, { onItemSelect }),
        ),
      );
    });
    // Flush the async loadAgents() effect so it cannot re-render mid-test.
    await act(async () => {});
    return { container, root, unmount: () => act(() => root.unmount()) };
  };

  const duplicateAgent = (container: FakeNode): void => {
    const duplicateItem = findNodeByTextChild(container, 'Duplicate');
    if (!duplicateItem) throw new Error('Duplicate menu item not found');
    clickNode(duplicateItem);
  };

  const clickCreateNew = (container: FakeNode): void => {
    const createButton = findNodeWithProp(container, (props) => props['data-settings-item'] === 'agents.create');
    if (!createButton) throw new Error('Create-new agent button not found');
    clickNode(createButton);
  };

  test('regression: Duplicate triggers the sidebar item-select callback so the mobile editor opens', async () => {
    const restoreDom = installDomStub();
    let handle: { container: FakeNode; root: Root; unmount: () => void } | undefined;
    try {
      useAgentsStore.setState({
        agents: [FAKE_AGENT],
        selectedAgentName: null,
        agentDraft: null,
      });

      const itemSelectCalls: number[] = [];
      handle = await mountSidebar(() => itemSelectCalls.push(1));

      await act(async () => {
        duplicateAgent(handle!.container);
      });

      // The prefilled draft and copy-name selection do happen…
      const state = useAgentsStore.getState();
      expect(state.agentDraft?.name).toBe('coder-copy');
      expect(state.selectedAgentName).toBe('coder-copy');

      // …but the mobile navigation callback is never invoked, so on mobile the
      // editor screen never opens. This assertion fails on the un-fixed code
      // (issue 2982): handleDuplicateAgent skips onItemSelect.
      expect(itemSelectCalls).toEqual([1]);
    } finally {
      handle?.unmount();
      await act(async () => {});
      restoreDom();
    }
  });

  test('control: New agent DOES invoke the item-select callback (every other path does)', async () => {
    const restoreDom = installDomStub();
    let handle: { container: FakeNode; root: Root; unmount: () => void } | undefined;
    try {
      useAgentsStore.setState({
        agents: [FAKE_AGENT],
        selectedAgentName: null,
        agentDraft: null,
      });

      const itemSelectCalls: number[] = [];
      handle = await mountSidebar(() => itemSelectCalls.push(1));

      await act(async () => {
        clickCreateNew(handle!.container);
      });

      expect(useAgentsStore.getState().agentDraft?.name).toBe('new-agent');
      expect(itemSelectCalls).toEqual([1]);
    } finally {
      handle?.unmount();
      await act(async () => {});
      restoreDom();
    }
  });
});
