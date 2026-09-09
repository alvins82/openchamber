import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { formatTurnDuration } from '../message/timeFormat';

interface TurnWorkedForProps {
    isExpanded: boolean;
    isWorking: boolean;
    startedAt?: number;
    completedAt?: number;
    durationMs?: number;
    onToggle: () => void;
    collapsible?: boolean;
}

const TurnWorkedFor: React.FC<TurnWorkedForProps> = ({
    isExpanded,
    isWorking,
    startedAt,
    completedAt,
    durationMs,
    onToggle,
    collapsible = true,
}) => {
    const { t } = useI18n();
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!isWorking || completedAt !== undefined) {
            return undefined;
        }

        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [completedAt, isWorking]);

    const elapsedMs = React.useMemo(() => {
        if (durationMs !== undefined && Number.isFinite(durationMs)) {
            return Math.max(0, durationMs);
        }
        if (startedAt === undefined || !Number.isFinite(startedAt)) {
            return undefined;
        }

        const end = completedAt !== undefined && Number.isFinite(completedAt)
            ? completedAt
            : now;
        return Math.max(0, end - startedAt);
    }, [completedAt, durationMs, now, startedAt]);

    const durationText = elapsedMs !== undefined && (!isWorking || elapsedMs >= 1000)
        ? formatTurnDuration(elapsedMs)
        : undefined;
    const label = isWorking
        ? (durationText ? t('chat.activity.workingFor', { duration: durationText }) : t('chat.activity.working'))
        : (durationText ? t('chat.activity.workedFor', { duration: durationText }) : t('chat.activity.worked'));
    const headerClassName = 'flex w-full items-center gap-1.5 border-b border-[var(--tools-border)] px-0.5 pb-1.5 pt-1 text-left';
    const labelElement = (
        <span
            className="min-w-0 truncate text-[length:var(--text-meta)] leading-5"
            style={{ color: 'var(--tools-description)' }}
        >
            {label}
        </span>
    );

    return (
        <div className="mt-1 mb-2">
            {isWorking ? (
                <div className={headerClassName} data-turn-worked-for="true">
                    {labelElement}
                </div>
            ) : collapsible ? (
                <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={onToggle}
                    className={`group/worked-for ${headerClassName}`}
                    data-turn-worked-for="true"
                >
                    <Icon
                        name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'}
                        className="h-3 w-3 flex-shrink-0"
                        style={{ color: 'var(--tools-description)' }}
                    />
                    {labelElement}
                </button>
            ) : (
                <div className={headerClassName} data-turn-worked-for="true">
                    {labelElement}
                </div>
            )}
        </div>
    );
};

export default React.memo(TurnWorkedFor);
