import type { Message, Part } from '@opencode-ai/sdk/v2';
import { computeCacheHitRate } from '@/stores/utils/tokenUtils';

export type SessionMessageRecord = {
  info: Message;
  parts: Part[];
};

export type CompletedStepStats = {
  stepId: string;
  totalDurationMs: number;
  toolDurationMs: number;
  adjustedLlmDurationMs: number;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | null;
};

export type CompletedTurnStats = {
  lastAssistantMessageId: string;
  stepsCount: number;
  totalLlmDurationMs: number;
  totalToolDurationMs: number;
  avgTtftMs: number | null;
  tokensPerSecond: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalGeneratedTokens: number;
  cacheHitPercent: number | null;
  cost: number | null;
};

type MessageTimeLike = {
  created?: number;
  completed?: number;
  ttftMs?: number;
};

type ToolPartLike = {
  type: string;
  state?: {
    time?: {
      start?: number;
      end?: number;
    };
  };
};

type TextPartLike = {
  type: string;
  time?: {
    start?: number;
  };
  state?: {
    time?: {
      start?: number;
    };
  };
};

type TokenBreakdownLike = {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: {
    read?: number;
    write?: number;
  };
};

/**
 * Merge an array of [start, end] time intervals into a disjoint union of intervals.
 * Correctly accounts for parallel / overlapping tool executions without double-counting.
 */
export function mergeTimeIntervals(intervals: readonly (readonly [number, number])[]): Array<[number, number]> {
  if (intervals.length === 0) return [];

  const valid: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      valid.push([start, end]);
    }
  }

  valid.sort((a, b) => a[0] - b[0]);
  if (valid.length === 0) return [];

  const merged: Array<[number, number]> = [valid[0]];

  for (let i = 1; i < valid.length; i += 1) {
    const current = valid[i];
    const last = merged[merged.length - 1];

    if (current[0] <= last[1]) {
      last[1] = Math.max(last[1], current[1]);
    } else {
      merged.push(current);
    }
  }

  return merged;
}

/**
 * Sum the total duration spanned by an array of disjoint intervals.
 */
export function sumIntervalsDuration(intervals: readonly (readonly [number, number])[]): number {
  return intervals.reduce((sum, [start, end]) => sum + (end - start), 0);
}

export const formatTelemetryDuration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '0.0s';
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
};

export const formatTelemetryTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0';
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(Math.round(tokens));
};

export const formatThroughputRate = (tps: number): string => {
  return `~${Math.round(tps)} tok/s`;
};

const sanitizeTokenCount = (value: number | undefined): number => {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * Calculate stats for a single completed assistant step.
 */
export function calculateCompletedStepStats(record: SessionMessageRecord): CompletedStepStats | null {
  const { info, parts } = record;
  if (info.role !== 'assistant') return null;

  // SAFETY: Message time object with optional completed timestamp
  const messageTime = info.time as MessageTimeLike | undefined;
  const created = messageTime?.created;
  const completed = messageTime?.completed;

  if (created === undefined || completed === undefined || !Number.isFinite(created) || !Number.isFinite(completed) || completed < created) {
    return null;
  }

  const totalDurationMs = completed - created;

  // Collect tool intervals
  const rawToolIntervals: Array<[number, number]> = [];
  for (const part of parts) {
    if (part?.type === 'tool') {
      // SAFETY: Tool parts have optional nested state and time start/end timestamps
      const toolPart = part as ToolPartLike;
      const start = toolPart.state?.time?.start;
      const end = toolPart.state?.time?.end;
      if (start !== undefined && end !== undefined && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        rawToolIntervals.push([start, end]);
      }
    }
  }

  const mergedToolIntervals = mergeTimeIntervals(rawToolIntervals);
  const toolDurationMs = sumIntervalsDuration(mergedToolIntervals);
  const adjustedLlmDurationMs = Math.max(0, totalDurationMs - toolDurationMs);

  // Measure TTFT
  let ttftMs: number | null = null;
  const explicitTtft = messageTime?.ttftMs;
  if (explicitTtft !== undefined && Number.isFinite(explicitTtft) && explicitTtft > 0 && explicitTtft <= totalDurationMs) {
    ttftMs = explicitTtft;
  } else {
    for (const part of parts) {
      if (part && (part.type === 'text' || part.type === 'reasoning')) {
        // SAFETY: Text and reasoning parts carry start timestamps in either time or state.time
        const textPart = part as TextPartLike;
        const partStart = textPart.time?.start ?? textPart.state?.time?.start;
        if (partStart !== undefined && Number.isFinite(partStart) && partStart >= created && partStart <= completed) {
          const delta = partStart - created;
          if (delta >= 0 && delta <= totalDurationMs) {
            ttftMs = delta;
            break;
          }
        }
      }
    }
  }

  // Token breakdown (authoritative numbers only, zero fabricated/character estimates)
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;

  if (info.tokens) {
    // SAFETY: Message tokens breakdown from provider
    const tokenBreakdown = info.tokens as TokenBreakdownLike;
    inputTokens = sanitizeTokenCount(tokenBreakdown.input);
    outputTokens = sanitizeTokenCount(tokenBreakdown.output);
    reasoningTokens = sanitizeTokenCount(tokenBreakdown.reasoning);
    cacheReadTokens = sanitizeTokenCount(tokenBreakdown.cache?.read);
    cacheWriteTokens = sanitizeTokenCount(tokenBreakdown.cache?.write);
  }

  const cost = info.cost !== undefined && Number.isFinite(info.cost) && info.cost > 0
    ? info.cost
    : null;

  return {
    stepId: info.id,
    totalDurationMs,
    toolDurationMs,
    adjustedLlmDurationMs,
    ttftMs,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  };
}

// Module-level memoization cache keyed by last completed assistant message ID.
// Guarantees completed turns are calculated once and never re-evaluated during later streaming.
const turnStatsCache = new Map<string, CompletedTurnStats>();

export function clearTurnStatsCacheForTests(): void {
  turnStatsCache.clear();
}

/**
 * Calculates telemetry metrics for the latest completed turn in the session.
 * A turn encompasses all assistant steps since the preceding user message up to the final completed assistant step.
 */
export function getLatestCompletedTurnStats(
  records: readonly SessionMessageRecord[] | null | undefined,
): CompletedTurnStats | null {
  if (!records || records.length === 0) return null;

  // Find the last completed assistant step index
  let lastCompletedAssistantIdx = -1;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    // SAFETY: Message time timestamps
    const messageTime = record.info.time as MessageTimeLike | undefined;
    const completed = messageTime?.completed;
    if (record.info.role === 'assistant' && completed !== undefined && Number.isFinite(completed)) {
      lastCompletedAssistantIdx = i;
      break;
    }
  }

  if (lastCompletedAssistantIdx === -1) return null;

  const lastAssistantRecord = records[lastCompletedAssistantIdx];
  const cacheKey = lastAssistantRecord.info.id;

  const cached = turnStatsCache.get(cacheKey);
  if (cached) return cached;

  // Find preceding user message index that began this turn
  let turnStartIdx = 0;
  for (let i = lastCompletedAssistantIdx - 1; i >= 0; i -= 1) {
    if (records[i].info.role === 'user') {
      turnStartIdx = i + 1;
      break;
    }
  }

  // Collect all completed assistant steps within this turn
  const stepStatsList: CompletedStepStats[] = [];
  for (let i = turnStartIdx; i <= lastCompletedAssistantIdx; i += 1) {
    const record = records[i];
    if (record.info.role === 'assistant') {
      const stepStats = calculateCompletedStepStats(record);
      if (stepStats) {
        stepStatsList.push(stepStats);
      }
    }
  }

  if (stepStatsList.length === 0) return null;

  let totalLlmDurationMs = 0;
  let totalToolDurationMs = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalReasoningTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalCost = 0;
  const ttftSamples: number[] = [];

  for (const step of stepStatsList) {
    totalLlmDurationMs += step.adjustedLlmDurationMs;
    totalToolDurationMs += step.toolDurationMs;
    totalInputTokens += step.inputTokens;
    totalOutputTokens += step.outputTokens;
    totalReasoningTokens += step.reasoningTokens;
    totalCacheReadTokens += step.cacheReadTokens;
    totalCacheWriteTokens += step.cacheWriteTokens;
    if (step.ttftMs !== null) {
      ttftSamples.push(step.ttftMs);
    }
    if (step.cost !== null) {
      totalCost += step.cost;
    }
  }

  const avgTtftMs = ttftSamples.length > 0
    ? ttftSamples.reduce((sum, val) => sum + val, 0) / ttftSamples.length
    : null;

  const totalGeneratedTokens = totalOutputTokens + totalReasoningTokens;
  const totalLlmSeconds = totalLlmDurationMs / 1000;

  const tokensPerSecond = totalGeneratedTokens > 0 && totalLlmSeconds > 0
    ? Math.round(totalGeneratedTokens / totalLlmSeconds)
    : null;

  const cacheHit = computeCacheHitRate({
    input: totalInputTokens,
    cache: {
      read: totalCacheReadTokens,
      write: totalCacheWriteTokens,
    },
  });

  const result: CompletedTurnStats = {
    lastAssistantMessageId: cacheKey,
    stepsCount: stepStatsList.length,
    totalLlmDurationMs,
    totalToolDurationMs,
    avgTtftMs,
    tokensPerSecond,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    reasoningTokens: totalReasoningTokens,
    totalGeneratedTokens,
    cacheHitPercent: cacheHit.hasInput && totalCacheReadTokens > 0 ? Math.round(cacheHit.percent) : null,
    cost: totalCost > 0 ? totalCost : null,
  };

  turnStatsCache.set(cacheKey, result);
  return result;
}
