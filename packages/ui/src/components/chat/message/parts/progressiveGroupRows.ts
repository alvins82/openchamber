import type { TurnActivityRecord as TurnActivityPart } from '../../lib/turns/types';
import { isExpandableTool, isStandaloneTool, isStaticTool } from './toolRenderUtils';

export type ToolActivityCategory = 'files' | 'exploration' | 'commands' | 'web-search';

export interface ToolActivitySummaryPart {
    category: ToolActivityCategory;
    count: number;
}

const FILE_ACTIVITY_TOOL_NAMES = new Set([
    'apply_patch',
    'create',
    'edit',
    'file_write',
    'multiedit',
    'patch',
    'str_replace',
    'str_replace_based_edit_tool',
    'write',
]);

const COMMAND_ACTIVITY_TOOL_NAMES = new Set(['bash', 'cmd', 'shell', 'shell_command', 'terminal']);
const EXPLORATION_ACTIVITY_TOOL_NAMES = new Set(['dir', 'find', 'glob', 'grep', 'list', 'list_files', 'ls', 'read', 'ripgrep', 'search']);
const WEB_SEARCH_ACTIVITY_TOOL_NAMES = new Set(['bing', 'codesearch', 'duckduckgo', 'google', 'perplexity', 'search_web', 'web-search', 'web_search', 'websearch']);

const TOOL_ACTIVITY_CATEGORY_ORDER: ToolActivityCategory[] = ['files', 'exploration', 'commands', 'web-search'];

const normalizeActivityToolName = (toolName: string | undefined): string => {
    const normalized = toolName?.trim().toLowerCase().replace(/:\d+$/, '') ?? '';
    const parts = normalized.split('.').filter(Boolean);
    return parts.at(-1) ?? normalized;
};

const getToolActivityCategory = (toolName: string | undefined): ToolActivityCategory | null => {
    const normalizedToolName = normalizeActivityToolName(toolName);
    if (FILE_ACTIVITY_TOOL_NAMES.has(normalizedToolName)) {
        return 'files';
    }
    if (COMMAND_ACTIVITY_TOOL_NAMES.has(normalizedToolName)) {
        return 'commands';
    }
    if (EXPLORATION_ACTIVITY_TOOL_NAMES.has(normalizedToolName)) {
        return 'exploration';
    }
    if (WEB_SEARCH_ACTIVITY_TOOL_NAMES.has(normalizedToolName)) {
        return 'web-search';
    }
    return null;
};

const getToolActivitySummaryForPart = (activity: TurnActivityPart): ToolActivitySummaryPart | null => {
    if (activity.kind !== 'tool' || activity.part.type !== 'tool') {
        return null;
    }

    const category = getToolActivityCategory(activity.part.tool);
    return category ? { category, count: 1 } : null;
};

export const getContiguousToolActivityRun = (
    parts: readonly (TurnActivityPart | null)[],
    startIndex: number,
): { activities: TurnActivityPart[]; nextIndex: number } | null => {
    const first = parts[startIndex];
    if (!first || !getToolActivitySummaryForPart(first)) {
        return null;
    }

    const activities = [first];
    let nextIndex = startIndex + 1;
    while (nextIndex < parts.length) {
        const nextActivity = parts[nextIndex];
        if (!nextActivity || !getToolActivitySummaryForPart(nextActivity)) {
            break;
        }
        activities.push(nextActivity);
        nextIndex += 1;
    }

    return { activities, nextIndex };
};

const isActivityGroupMember = (activity: TurnActivityPart): boolean => {
    return activity.kind === 'reasoning' || getToolActivitySummaryForPart(activity) !== null;
};

/**
 * Find a contiguous activity run that may contain tool calls and Thinking
 * parts. Non-activity content is represented by null in the live path and
 * remains a boundary for the run.
 */
export const getContiguousActivityRun = (
    parts: readonly (TurnActivityPart | null)[],
    startIndex: number,
): { activities: TurnActivityPart[]; nextIndex: number } | null => {
    const first = parts[startIndex];
    if (!first || !isActivityGroupMember(first)) {
        return null;
    }

    const activities = [first];
    let nextIndex = startIndex + 1;
    while (nextIndex < parts.length) {
        const nextActivity = parts[nextIndex];
        if (!nextActivity || !isActivityGroupMember(nextActivity)) {
            break;
        }
        activities.push(nextActivity);
        nextIndex += 1;
    }

    return { activities, nextIndex };
};

const summarizeToolActivities = (activities: TurnActivityPart[]): ToolActivitySummaryPart[] => {
    const counts = new Map<ToolActivityCategory, number>();

    for (const activity of activities) {
        const summary = getToolActivitySummaryForPart(activity);
        if (!summary) {
            continue;
        }
        counts.set(summary.category, (counts.get(summary.category) ?? 0) + summary.count);
    }

    return TOOL_ACTIVITY_CATEGORY_ORDER.flatMap((category) => {
        const count = counts.get(category) ?? 0;
        return count > 0 ? [{ category, count }] : [];
    });
};

export type AggregatedRow =
    | { type: 'tool-expandable'; activity: TurnActivityPart }
    | { type: 'tool-activity-group'; activities: TurnActivityPart[]; summaryParts: ToolActivitySummaryPart[] }
    | { type: 'tool-static-group'; toolName: string; activities: TurnActivityPart[] }
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart }
    | { type: 'tool-fallback'; activity: TurnActivityPart };

/**
 * Aggregate sorted activity parts into display rows.
 * Consecutive file-changing, exploration, shell, and web-search tools are
 * rendered as one collapsed row with a runtime-derived summary. Adjacent
 * Thinking parts are folded into that same row when the run contains a
 * groupable tool activity.
 * Static tools are rendered as one row per call.
 * Reasoning/justification become inline text.
 * Other expandable tools stay as individual rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
export const aggregateRows = (parts: TurnActivityPart[]): AggregatedRow[] => {
    const rows: AggregatedRow[] = [];

    let i = 0;
    while (i < parts.length) {
        const activity = parts[i];

        if (activity.kind === 'reasoning') {
            const activityRun = getContiguousActivityRun(parts, i);
            const hasToolActivity = activityRun?.activities.some((runActivity) => runActivity.kind === 'tool') ?? false;
            if (activityRun && hasToolActivity) {
                rows.push({
                    type: 'tool-activity-group',
                    activities: activityRun.activities,
                    summaryParts: summarizeToolActivities(activityRun.activities),
                });
                i = activityRun.nextIndex;
                continue;
            }
            if (activityRun) {
                activityRun.activities.forEach((runActivity) => {
                    rows.push({ type: 'reasoning', activity: runActivity });
                });
                i = activityRun.nextIndex;
                continue;
            }
            rows.push({ type: 'reasoning', activity });
            i++;
            continue;
        }

        if (activity.kind === 'justification') {
            rows.push({ type: 'justification', activity });
            i++;
            continue;
        }

        // Tool part. The runtime guard keeps malformed activity records out of
        // the tool-specific branches without hiding them behind a guessed shape.
        if (activity.part.type !== 'tool') {
            rows.push({ type: 'tool-fallback', activity });
            i++;
            continue;
        }
        const toolName = normalizeActivityToolName(activity.part.tool);

        if (isStandaloneTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        const activityRun = getContiguousActivityRun(parts, i);
        if (activityRun) {
            const { activities, nextIndex } = activityRun;

            if (activities.length > 1) {
                rows.push({
                    type: 'tool-activity-group',
                    activities,
                    summaryParts: summarizeToolActivities(activities),
                });
            } else if (isStaticTool(toolName)) {
                rows.push({ type: 'tool-static-group', toolName, activities: [activity] });
            } else {
                rows.push({ type: 'tool-expandable', activity });
            }
            i = nextIndex;
            continue;
        }

        if (isStaticTool(toolName)) {
            rows.push({ type: 'tool-static-group', toolName, activities: [activity] });
            i++;
            continue;
        }

        if (isExpandableTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        // Unknown/fallback tool — keep as expandable
        rows.push({ type: 'tool-fallback', activity });
        i++;
    }

    return rows;
};
