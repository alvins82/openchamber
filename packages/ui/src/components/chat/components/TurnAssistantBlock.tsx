import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    timelineMessages?: ChatMessageEntry[];
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const isVisibleTimelineMessage = (message: ChatMessageEntry): boolean => {
    if (message.info.role !== 'assistant') {
        return true;
    }
    // SAFETY: OMP may add this marker to an OpenCode v2 assistant message; only
    // the literal boolean value is treated as an internal context snapshot.
    return (message.info as { summary?: unknown }).summary !== true;
};

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ timelineMessages, assistantMessages, renderMessage }) => {
    const visibleTimelineMessages = (timelineMessages ?? assistantMessages).filter(isVisibleTimelineMessage);

    return (
        <div className="relative z-0">
            {visibleTimelineMessages.map((message) => renderMessage(message))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
