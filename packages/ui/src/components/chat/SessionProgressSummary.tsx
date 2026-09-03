import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionProgressSummary } from '@/hooks/useSessionProgressSummary';

interface SessionProgressSummaryProps {
    sessionId: string;
    directory?: string;
}

/**
 * A temporary progress card above the composer. It is deliberately outside
 * the transcript: each update describes the active turn without adding a
 * persisted message or shifting historical content.
 */
export const SessionProgressSummary: React.FC<SessionProgressSummaryProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const {
        summary,
        commandSummary,
        isGenerating,
        isCommandGenerating,
    } = useSessionProgressSummary(sessionId, directory);
    const isGeneratingAnySummary = isGenerating || isCommandGenerating;

    if (!summary && !commandSummary && !isGeneratingAnySummary) return null;

    return (
        <div
            className="mb-2 w-full"
            role="status"
            aria-live="polite"
            aria-label={t('chat.progressSummary.aria')}
        >
            <div className="oc-glass-popover flex w-full min-w-0 items-start gap-2 rounded-xl border border-[var(--interactive-border)] px-3 py-2 text-left shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
                <Icon name="pulse" className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <span className="typography-meta font-medium text-foreground">
                            {t('chat.progressSummary.label')}
                        </span>
                        {isGeneratingAnySummary ? <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" /> : null}
                    </div>
                    {commandSummary ? (
                        <p className="mt-0.5 line-clamp-1 typography-meta text-muted-foreground">{commandSummary}</p>
                    ) : null}
                    {summary ? (
                        <p className={`mt-0.5 ${commandSummary ? 'line-clamp-1' : 'line-clamp-2'} typography-meta text-muted-foreground`}>
                            {summary}
                        </p>
                    ) : !commandSummary ? (
                        <p className="mt-0.5 line-clamp-2 typography-meta text-muted-foreground">
                            {t('chat.progressSummary.generating')}
                        </p>
                    ) : null}
                </div>
            </div>
        </div>
    );
});

SessionProgressSummary.displayName = 'SessionProgressSummary';
