import { getCurrentIntlLocale } from '@/lib/i18n';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';
import { formatTimeForPreference } from '@/lib/timeFormat';
import type { TimeFormatPreference } from '@/stores/useUIStore';

const isSameDay = (left: Date, right: Date): boolean => {
    return (
        left.getFullYear() === right.getFullYear() &&
        left.getMonth() === right.getMonth() &&
        left.getDate() === right.getDate()
    );
};

const isYesterday = (date: Date, now: Date): boolean => {
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    return isSameDay(date, yesterday);
};

const isValidTimestamp = (timestamp: number): boolean => {
    return Number.isFinite(timestamp) && !Number.isNaN(new Date(timestamp).getTime());
};

export const formatTimestampForDisplay = (timestamp: number, timeFormatPreference: TimeFormatPreference): string => {
    if (!isValidTimestamp(timestamp)) {
        return '';
    }

    const date = new Date(timestamp);
    const now = new Date();
    const timePart = formatTimeForPreference(date, timeFormatPreference);
    const locale = getCurrentIntlLocale();
    const dictionary = useI18nStore.getState().dictionary;

    if (isSameDay(date, now)) {
        return timePart;
    }

    if (isYesterday(date, now)) {
        return formatMessage(dictionary, 'common.date.yesterdayWithTime', { time: timePart });
    }

    const monthPart = date.toLocaleString(locale, { month: 'short' });
    const dayPart = date.getDate();
    const datePart = `${monthPart} ${dayPart}`;

    if (date.getFullYear() === now.getFullYear()) {
        return `${datePart}, ${timePart}`;
    }

    return `${datePart}, ${date.getFullYear()}, ${timePart}`;
};

export const formatTurnDuration = (durationMs: number): string => {
    const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) {
        return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
    }

    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};
