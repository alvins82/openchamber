import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import type { TurnActivityRecord } from '../../lib/turns/types';
import { aggregateRows, getContiguousActivityRun, getContiguousToolActivityRun } from './progressiveGroupRows';

const makeToolActivity = (id: string, tool: string): TurnActivityRecord => ({
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
        state: {
            status: 'completed',
            input: tool === 'bash' ? { command: 'bun test' } : { filePath: 'src/example.ts' },
            output: '',
            title: '',
            metadata: {},
            time: { start: 1, end: 2 },
        },
    } satisfies ToolPart,
});

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

    test('finds live contiguous runs without crossing non-tool content', () => {
        const run = getContiguousToolActivityRun([
            makeToolActivity('edit-1', 'edit'),
            makeToolActivity('bash-1', 'bash'),
            null,
            makeToolActivity('write-1', 'write'),
        ], 0);

        expect(run?.activities.map((activity) => activity.id)).toEqual(['edit-1', 'bash-1']);
        expect(run?.nextIndex).toBe(2);
        expect(getContiguousToolActivityRun([null], 0)).toBeNull();
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
