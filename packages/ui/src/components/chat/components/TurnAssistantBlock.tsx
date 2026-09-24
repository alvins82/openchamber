import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const isCompactionSummaryMessage = (message: ChatMessageEntry): boolean => {
    // SAFETY: Runtime message metadata can carry an optional boolean summary
    // marker; only true denotes an internal context snapshot.
    return (message.info as { summary?: boolean }).summary === true;
};

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage }) => {
    const visibleAssistantMessages = assistantMessages.filter((message) => !isCompactionSummaryMessage(message));

    return (
        <div className="relative z-0">
            {visibleAssistantMessages.map((message) => renderMessage(message))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
