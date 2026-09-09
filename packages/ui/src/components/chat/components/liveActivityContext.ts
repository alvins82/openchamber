import { createContext } from 'react';

/** The live Activity disclosure owns assistant content while it is mounted. */
export const LiveTurnActivityContext = createContext<boolean | null>(null);

/** Only the final message splits its non-text parts from its answer/footer. */
export const LiveFinalActivityContext = createContext<{
    messageId: string;
    expanded: boolean;
    contentId: string;
    animateCollapse: boolean;
} | null>(null);
