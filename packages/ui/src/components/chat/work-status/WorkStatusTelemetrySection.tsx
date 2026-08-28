import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useSessionMessageRecords } from '@/sync/sync-context';
import {
  WorkStatusCollapsibleSection,
  WorkStatusRow,
  WorkStatusValue,
} from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import {
  formatTelemetryDuration,
  formatTelemetryTokens,
  formatThroughputRate,
  getLatestCompletedTurnStats,
} from './telemetry';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

export const WorkStatusTelemetrySection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();

  const records = useSessionMessageRecords(
    sessionId ?? '',
    directory ?? undefined,
  );

  const stats = React.useMemo(() => {
    if (!sessionId || !records || records.length === 0) return null;
    return getLatestCompletedTurnStats(records);
  }, [sessionId, records]);

  useReportWorkStatusPresence('telemetry', stats !== null);

  if (!sessionId || !stats) return null;

  const {
    stepsCount,
    totalLlmDurationMs,
    totalToolDurationMs,
    avgTtftMs,
    tokensPerSecond,
    inputTokens,
    totalGeneratedTokens,
    cacheHitPercent,
    cost,
  } = stats;

  const headerSummary = tokensPerSecond !== null
    ? `${formatThroughputRate(tokensPerSecond)} · ${formatTelemetryDuration(totalLlmDurationMs)}`
    : formatTelemetryDuration(totalLlmDurationMs);

  return (
    <WorkStatusCollapsibleSection
      id="telemetry"
      title={t('chat.workStatus.section.telemetry')}
      icon="bar-chart-2"
      summary={headerSummary}
      defaultExpanded
    >
      {tokensPerSecond !== null ? (
        <WorkStatusRow
          icon="timer"
          label={t('chat.workStatus.telemetry.speed')}
          value={<WorkStatusValue tone="success">{formatThroughputRate(tokensPerSecond)}</WorkStatusValue>}
        />
      ) : null}

      <WorkStatusRow
        icon="time"
        label={t('chat.workStatus.telemetry.llmDuration')}
        value={<WorkStatusValue>{formatTelemetryDuration(totalLlmDurationMs)}</WorkStatusValue>}
      />

      {totalToolDurationMs > 0 ? (
        <WorkStatusRow
          icon="command-code"
          label={t('chat.workStatus.telemetry.toolDuration')}
          value={<WorkStatusValue>{formatTelemetryDuration(totalToolDurationMs)}</WorkStatusValue>}
        />
      ) : null}

      {avgTtftMs !== null ? (
        <WorkStatusRow
          icon="timer"
          label={t('chat.workStatus.telemetry.ttft')}
          value={<WorkStatusValue>{formatTelemetryDuration(avgTtftMs)}</WorkStatusValue>}
        />
      ) : null}

      {stepsCount > 1 ? (
        <WorkStatusRow
          icon="checkbox-circle"
          label={t('chat.workStatus.telemetry.steps')}
          value={<WorkStatusValue>{stepsCount}</WorkStatusValue>}
        />
      ) : null}

      {inputTokens > 0 || totalGeneratedTokens > 0 ? (
        <WorkStatusRow
          icon="file-code"
          label={t('chat.workStatus.telemetry.tokens')}
          value={(
            <WorkStatusValue>
              {`${formatTelemetryTokens(inputTokens)} in · ${formatTelemetryTokens(totalGeneratedTokens)} out`}
            </WorkStatusValue>
          )}
        />
      ) : null}

      {cacheHitPercent !== null ? (
        <WorkStatusRow
          icon="donut-chart"
          label={t('chat.workStatus.telemetry.cacheHit')}
          value={(
            <WorkStatusValue tone={cacheHitPercent >= 50 ? 'success' : 'default'}>
              {`${cacheHitPercent}%`}
            </WorkStatusValue>
          )}
        />
      ) : null}

      {cost !== null ? (
        <WorkStatusRow
          icon="briefcase"
          label={t('chat.workStatus.telemetry.cost')}
          value={<WorkStatusValue tone="muted">{`$${cost.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`}</WorkStatusValue>}
        />
      ) : null}
    </WorkStatusCollapsibleSection>
  );
};
