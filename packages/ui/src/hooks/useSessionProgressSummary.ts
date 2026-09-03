import React from 'react';
import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

import { useSessionMessages, useSessionStatus } from '@/sync/sync-context';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { getSessionLastAssistantModel } from '@/sync/session-actions';
import { useUIStore } from '@/stores/useUIStore';
import { requestSmallModel } from '@/lib/smallModelRequest';

const LIVE_PROGRESS_SUMMARY_INTERVAL_MS = 30_000;

const PROGRESS_CONTEXT_CHAR_LIMIT = 12_000;
const PROGRESS_PART_CHAR_LIMIT = 1_800;
const PROGRESS_SUMMARY_CHAR_LIMIT = 480;

const PROGRESS_SUMMARY_SYSTEM_PROMPT = [
    'You are a live progress reporter for a coding agent.',
    'Return ONLY a concise user-facing progress update: at most two sentences and 45 words.',
    'Describe what the agent has completed, what it is currently doing, and the next concrete step when the transcript supports it.',
    'Do not expose or quote hidden chain-of-thought or private deliberation. Summarize reasoning only at a high level.',
    'Do not claim that the task is complete unless the transcript clearly says it is complete.',
    'Use the same language as the user request.',
].join('\n');

type ProgressSummaryInternalState = {
    key: string;
    summary: string | null;
    generatedAt: number | null;
    isGenerating: boolean;
};

export type SessionProgressSummaryState = {
    summary: string | null;
    generatedAt: number | null;
    isGenerating: boolean;
};

type ProgressRequestBody = {
    prompt: string;
    system: string;
    maxOutputTokens: number;
    directory?: string;
    restrictToPreferredProvider: boolean;
    preferredProviderID?: string;
    preferredModelID?: string;
};

const EMPTY_PROGRESS_SUMMARY: SessionProgressSummaryState = {
    summary: null,
    generatedAt: null,
    isGenerating: false,
};

const clampText = (text: string, limit: number): string => {
    const normalized = text.trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

const clampContext = (text: string): string => {
    if (text.length <= PROGRESS_CONTEXT_CHAR_LIMIT) return text;

    const headLength = Math.floor(PROGRESS_CONTEXT_CHAR_LIMIT * 0.35);
    const tailLength = PROGRESS_CONTEXT_CHAR_LIMIT - headLength;
    return [
        text.slice(0, headLength).trimEnd(),
        '[middle of transcript omitted]',
        text.slice(-tailLength).trimStart(),
    ].join('\n\n');
};

const formatToolPart = (part: ToolPart): string => {
    const detail = part.state.status === 'completed'
        ? part.state.title || part.state.output
        : part.state.status === 'error'
            ? part.state.error
            : part.state.status === 'running'
                ? part.state.title
                : '';
    const suffix = detail ? `: ${clampText(detail, PROGRESS_PART_CHAR_LIMIT)}` : '';
    return `Tool ${part.tool} (${part.state.status})${suffix}`;
};

const formatProgressPart = (part: Part): string => {
    switch (part.type) {
        case 'text':
            return clampText(part.text, PROGRESS_PART_CHAR_LIMIT);
        case 'reasoning':
            return `Reasoning: ${clampText(part.text, PROGRESS_PART_CHAR_LIMIT)}`;
        case 'tool':
            return formatToolPart(part);
        case 'subtask':
            return `Subtask ${part.agent}: ${clampText(part.description, PROGRESS_PART_CHAR_LIMIT)}`;
        case 'step-finish':
            return `Step completed (${part.reason})`;
        case 'retry':
            return `Retry attempt ${part.attempt}`;
        default:
            return '';
    }
};

const formatMessageForProgress = (message: Message, parts: Part[]): string => {
    const content = parts
        .map(formatProgressPart)
        .filter((part) => part.length > 0)
        .join('\n');
    if (!content) return '';

    const label = message.role === 'user' ? 'User' : 'Assistant';
    return `${label}:\n${content}`;
};

const findLastMessageIndex = (messages: Message[], role: Message['role']): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === role) return index;
    }
    return -1;
};

/**
 * Builds a bounded transcript from the active turn. The part getter is kept
 * imperative so callers can sample the live part store without subscribing a
 * React component to token-frequency updates.
 */
export const buildSessionProgressTranscript = (
    messages: Message[],
    getParts: (messageId: string) => Part[],
): string | null => {
    if (messages.length === 0) return null;

    const lastAssistantIndex = findLastMessageIndex(messages, 'assistant');
    const lastUserIndex = findLastMessageIndex(messages, 'user');
    if (lastAssistantIndex < 0 && lastUserIndex < 0) return null;

    let startIndex = lastUserIndex;
    const lastAssistant = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : null;
    if (lastAssistant?.role === 'assistant' && lastAssistantIndex > lastUserIndex) {
        const parentIndex = messages.findIndex((message) => message.id === lastAssistant.parentID);
        if (parentIndex >= 0) startIndex = parentIndex;
        else startIndex = lastAssistantIndex;
    }

    if (startIndex < 0) startIndex = lastAssistantIndex;
    if (startIndex < 0) return null;

    const sections = messages
        .slice(startIndex)
        .map((message) => formatMessageForProgress(message, getParts(message.id)))
        .filter((section) => section.length > 0);
    if (sections.length === 0) return null;

    return clampContext(sections.join('\n\n'));
};

const isAbortError = (error: Error): boolean => error.name === 'AbortError';

const smallModelResponseSchema = z.object({ text: z.string().optional() });

const parseSummaryResponse = async (response: Response): Promise<string | null> => {
    const parsed = smallModelResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;
    const text = parsed.data.text?.trim() ?? '';
    return text ? clampText(text, PROGRESS_SUMMARY_CHAR_LIMIT) : null;
};

export function useSessionProgressSummary(
    sessionId: string,
    directory?: string,
): SessionProgressSummaryState {
    const status = useSessionStatus(sessionId, directory);
    const messages = useSessionMessages(sessionId, directory);
    const enabled = useUIStore((state) => state.liveProgressSummaryEnabled);
    const statusType = status?.type ?? 'idle';
    const isActive = Boolean(enabled && sessionId && statusType === 'busy');
    const lastUserMessageId = React.useMemo(() => {
        const index = findLastMessageIndex(messages, 'user');
        return index >= 0 ? messages[index]?.id ?? null : null;
    }, [messages]);
    const progressKey = `${directory ?? ''}\u0000${sessionId}\u0000${lastUserMessageId ?? ''}`;
    const [state, setState] = React.useState<ProgressSummaryInternalState>({
        key: progressKey,
        ...EMPTY_PROGRESS_SUMMARY,
    });
    const generationRef = React.useRef(0);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        generationRef.current += 1;
        const generation = generationRef.current;
        let cancelled = false;

        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        abortRef.current?.abort();
        abortRef.current = null;
        setState({ key: progressKey, ...EMPTY_PROGRESS_SUMMARY });

        if (!isActive) {
            return () => {
                cancelled = true;
            };
        }

        const scheduleNext = () => {
            if (cancelled || generationRef.current !== generation) return;
            timerRef.current = setTimeout(() => {
                void generate();
            }, LIVE_PROGRESS_SUMMARY_INTERVAL_MS);
        };

        const generate = async () => {
            if (cancelled || generationRef.current !== generation) return;

            const transcript = buildSessionProgressTranscript(
                getSyncMessages(sessionId, directory),
                (messageId) => getSyncParts(messageId, directory),
            );
            if (!transcript) {
                scheduleNext();
                return;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            setState((previous) => ({ ...previous, key: progressKey, isGenerating: true }));

            try {
                const sessionModel = getSessionLastAssistantModel(sessionId);
                const requestBody: ProgressRequestBody = {
                    prompt: `Summarize the current state of this active turn.\n\n${transcript}`,
                    system: PROGRESS_SUMMARY_SYSTEM_PROMPT,
                    maxOutputTokens: 120,
                    directory,
                    restrictToPreferredProvider: true,
                };
                if (sessionModel?.providerID) requestBody.preferredProviderID = sessionModel.providerID;
                if (sessionModel?.modelID) requestBody.preferredModelID = sessionModel.modelID;

                const response = await requestSmallModel({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify(requestBody),
                }, { silent: true });

                if (response.ok && !cancelled && generationRef.current === generation) {
                    const summary = await parseSummaryResponse(response);
                    if (summary && !cancelled && generationRef.current === generation) {
                        setState({
                            key: progressKey,
                            summary,
                            generatedAt: Date.now(),
                            isGenerating: false,
                        });
                    }
                }
            } catch (error) {
                if (error instanceof Error && isAbortError(error)) return;
                // Progress is advisory. A missing Small Model must not
                // interrupt the user's active turn or create a toast loop.
            } finally {
                if (abortRef.current === controller) abortRef.current = null;
                if (!cancelled && generationRef.current === generation) {
                    setState((previous) => ({ ...previous, key: progressKey, isGenerating: false }));
                    scheduleNext();
                }
            }
        };

        timerRef.current = setTimeout(() => {
            void generate();
        }, LIVE_PROGRESS_SUMMARY_INTERVAL_MS);

        return () => {
            cancelled = true;
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            abortRef.current?.abort();
            abortRef.current = null;
        };
    }, [directory, isActive, progressKey, sessionId]);

    if (!isActive || state.key !== progressKey) return EMPTY_PROGRESS_SUMMARY;
    return {
        summary: state.summary,
        generatedAt: state.generatedAt,
        isGenerating: state.isGenerating,
    };
}
