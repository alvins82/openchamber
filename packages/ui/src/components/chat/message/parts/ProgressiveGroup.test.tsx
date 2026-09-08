import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import { I18nProvider } from '@/lib/i18n';
import type { TurnActivityRecord } from '../../lib/turns/types';
import { aggregateRows, getContiguousActivityRun } from './progressiveGroupRows';

let ProgressiveGroup: typeof import('./ProgressiveGroup').default;

plugin({
    name: 'progressive-group-worker-url',
    setup(build) {
        build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
            contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`,
            loader: 'js',
        }));
    },
});

type ToolFixtureStatus = 'completed' | 'error' | 'running';

const makeToolActivity = (id: string, tool: string, status: ToolFixtureStatus = 'completed'): TurnActivityRecord => {
    const input = tool === 'bash' ? { command: 'bun test' } : { filePath: 'src/example.ts' };
    const state: ToolPart['state'] = status === 'running'
        ? {
            status: 'running',
            input,
            time: { start: 1 },
        }
        : status === 'error'
            ? {
                status: 'error',
                input,
                error: 'Tool failed',
                metadata: {},
                time: { start: 1, end: 2 },
            }
            : {
                status: 'completed',
                input,
                output: '',
                title: '',
                metadata: {},
                time: { start: 1, end: 2 },
            };

    return {
        id,
        turnId: 'turn-1',
        messageId: 'message-1',
        partIndex: 0,
        kind: 'tool',
        part: {
            id,
            sessionID: 'session-1',
            messageID: 'message-1',
            type: 'tool',
            tool,
            callID: id,
            state,
        } satisfies ToolPart,
    };
};

const DOM_GLOBAL_NAMES = [
    'window',
    'document',
    'navigator',
    'Node',
    'NodeList',
    'Element',
    'HTMLElement',
    'SVGElement',
    'HTMLIFrameElement',
    'customElements',
    'localStorage',
    'fetch',
    'getComputedStyle',
    'ResizeObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'IS_REACT_ACT_ENVIRONMENT',
] as const;

const installDom = () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const values = {
        window: happyWindow,
        document: happyWindow.document,
        navigator: happyWindow.navigator,
        Node: happyWindow.Node,
        NodeList: happyWindow.NodeList,
        Element: happyWindow.Element,
        HTMLElement: happyWindow.HTMLElement,
        SVGElement: happyWindow.SVGElement,
        HTMLIFrameElement: happyWindow.HTMLIFrameElement,
        customElements: happyWindow.customElements,
        localStorage: happyWindow.localStorage,
        fetch: async () => new Response(JSON.stringify({ home: '/home' }), { headers: { 'Content-Type': 'application/json' } }),
        getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
        ResizeObserver: happyWindow.ResizeObserver,
        requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
        cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
        IS_REACT_ACT_ENVIRONMENT: true,
    };

    for (const name of DOM_GLOBAL_NAMES) {
        Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
    }

    const container = document.createElement('div');
    document.body.appendChild(container);

    return {
        container,
        restore: () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) {
                    Object.defineProperty(globalThis, name, descriptor);
                } else {
                    Reflect.deleteProperty(globalThis, name);
                }
            }
            void happyWindow.happyDOM.close();
        },
    };
};

const makeReasoningActivity = (id: string): TurnActivityRecord => ({
    id,
    turnId: 'turn-1',
    messageId: 'message-1',
    partIndex: 0,
    kind: 'reasoning',
    // SAFETY: This fixture supplies the reasoning fields consumed by the grouping helpers.
    part: {
        id,
        sessionID: 'session-1',
        messageID: 'message-1',
        type: 'reasoning',
        text: 'Checking the next step.',
        time: { start: 1, end: 2 },
    } as Part,
});

describe('ProgressiveGroup tool activity rows', () => {
    test('collapses consecutive file and shell tools into one summary row', () => {
        const rows = aggregateRows([
            makeToolActivity('edit-1', 'edit'),
            makeToolActivity('bash-1', 'bash'),
            makeToolActivity('write-1', 'write'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('tool-activity-group');
        if (rows[0]?.type !== 'tool-activity-group') {
            throw new Error('Expected a collapsed tool activity group');
        }
        expect(rows[0].activities.map((activity) => activity.id)).toEqual(['edit-1', 'bash-1', 'write-1']);
        expect(rows[0].summaryParts).toEqual([
            { category: 'files', count: 2 },
            { category: 'commands', count: 1 },
        ]);
    });

    test('leaves a single file tool as an individual row', () => {
        const rows = aggregateRows([makeToolActivity('edit-1', 'edit')]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('tool-expandable');
    });

    test('includes exploration tools in the contiguous summary', () => {
        const rows = aggregateRows([
            makeToolActivity('edit-1', 'edit'),
            makeToolActivity('read-1', 'read'),
            makeToolActivity('bash-1', 'bash'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('tool-activity-group');
        if (rows[0]?.type !== 'tool-activity-group') {
            throw new Error('Expected a collapsed tool activity group');
        }
        expect(rows[0].summaryParts).toEqual([
            { category: 'files', count: 1 },
            { category: 'exploration', count: 1 },
            { category: 'commands', count: 1 },
        ]);
    });

    test('folds consecutive Thinking parts into the tool activity group', () => {
        const rows = aggregateRows([
            makeToolActivity('edit-1', 'edit'),
            makeReasoningActivity('thinking-1'),
            makeToolActivity('bash-1', 'bash'),
        ]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('tool-activity-group');
        if (rows[0]?.type !== 'tool-activity-group') {
            throw new Error('Expected a collapsed tool activity group');
        }
        expect(rows[0].activities.map((activity) => activity.id)).toEqual([
            'edit-1',
            'thinking-1',
            'bash-1',
        ]);
        expect(rows[0].summaryParts).toEqual([
            { category: 'files', count: 1 },
            { category: 'commands', count: 1 },
        ]);
    });

    test('keeps Thinking-only runs as individual reasoning rows', () => {
        const rows = aggregateRows([
            makeReasoningActivity('thinking-1'),
            makeReasoningActivity('thinking-2'),
        ]);

        expect(rows.map((row) => row.type)).toEqual(['reasoning', 'reasoning']);
    });

    test('keeps unrelated tools as boundaries', () => {
        const rows = aggregateRows([
            makeToolActivity('edit-1', 'edit'),
            makeToolActivity('question-1', 'question'),
            makeToolActivity('bash-1', 'bash'),
        ]);

        expect(rows.map((row) => row.type)).toEqual([
            'tool-expandable',
            'tool-expandable',
            'tool-expandable',
        ]);
    });

    test('keeps failed tools individual so their error state stays visible', () => {
        const rows = aggregateRows([
            makeToolActivity('edit-1', 'edit'),
            makeToolActivity('write-1', 'write'),
            makeToolActivity('read-failed', 'read', 'error'),
            makeToolActivity('bash-1', 'bash'),
            makeToolActivity('shell-1', 'shell'),
        ]);

        expect(rows.map((row) => row.type)).toEqual([
            'tool-activity-group',
            'tool-expandable',
            'tool-activity-group',
        ]);
        expect(rows[1]?.type === 'tool-expandable' ? rows[1].activity.id : null).toBe('read-failed');
    });

    test('orders summary categories independently of tool order', () => {
        const rows = aggregateRows([
            makeToolActivity('search-1', 'websearch'),
            makeToolActivity('bash-1', 'bash'),
            makeToolActivity('read-1', 'read'),
            makeToolActivity('edit-1', 'edit'),
        ]);

        expect(rows[0]?.type).toBe('tool-activity-group');
        if (rows[0]?.type !== 'tool-activity-group') {
            throw new Error('Expected a collapsed tool activity group');
        }
        expect(rows[0].summaryParts).toEqual([
            { category: 'files', count: 1 },
            { category: 'exploration', count: 1 },
            { category: 'commands', count: 1 },
            { category: 'web-search', count: 1 },
        ]);
    });

    test('keeps standalone task tools visible', () => {
        const rows = aggregateRows([makeToolActivity('task-1', 'task')]);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.type).toBe('tool-expandable');
    });

    test('finds live contiguous runs that include Thinking parts', () => {
        const run = getContiguousActivityRun([
            makeToolActivity('edit-1', 'edit'),
            makeReasoningActivity('thinking-1'),
            makeToolActivity('bash-1', 'bash'),
            null,
            makeReasoningActivity('thinking-2'),
        ], 0);

        expect(run?.activities.map((activity) => activity.id)).toEqual([
            'edit-1',
            'thinking-1',
            'bash-1',
        ]);
        expect(run?.nextIndex).toBe(3);
    });
});

describe('Tool activity group disclosure', () => {
    let dom: ReturnType<typeof installDom>;
    let root: Root;

    beforeEach(async () => {
        dom = installDom();
        ({ default: ProgressiveGroup } = await import('./ProgressiveGroup'));
        root = createRoot(dom.container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        dom.restore();
    });

    test('allows a user to collapse a live auto-expanded group', async () => {
        await act(async () => root.render(
            <I18nProvider>
                <ProgressiveGroup
                    parts={[
                        makeToolActivity('read-running', 'read', 'running'),
                        makeToolActivity('read-completed', 'read'),
                    ]}
                    isExpanded={true}
                    onToggle={() => undefined}
                    isMobile={false}
                    expandedTools={new Set()}
                    onToggleTool={() => undefined}
                    onShowPopup={() => undefined}
                    streamPhase="streaming"
                    showHeader={false}
                    animateRows={false}
                />
            </I18nProvider>,
        ));

        const header = dom.container.querySelector<HTMLButtonElement>('button[aria-expanded]');
        if (!header) {
            throw new Error('Expected an activity group disclosure button');
        }
        expect(header.getAttribute('aria-expanded')).toBe('true');

        await act(async () => header.click());

        expect(header.getAttribute('aria-expanded')).toBe('false');
    });
});
