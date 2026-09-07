import React from 'react';

type ReasoningScrollFollow = {
    handleWheelCapture: (event: React.WheelEvent<HTMLElement>) => void;
    handleScroll: (event: React.UIEvent<HTMLElement>) => void;
};

export const useReasoningScrollFollow = (
    scrollRef: React.RefObject<HTMLElement | null>,
    contentRef: React.RefObject<HTMLElement | null>,
    isStreaming: boolean,
    contentKey: string,
): ReasoningScrollFollow => {
    const isFollowingRef = React.useRef(true);

    const followReasoningScroll = React.useCallback(() => {
        const element = scrollRef.current;
        if (!element || !isFollowingRef.current) {
            return;
        }
        element.scrollTop = element.scrollHeight;
    }, [scrollRef]);

    // Auto-scroll to bottom as new reasoning text streams in.
    React.useLayoutEffect(() => {
        if (!isStreaming) {
            isFollowingRef.current = true;
            return;
        }
        followReasoningScroll();
    }, [contentKey, followReasoningScroll, isStreaming]);

    // Markdown can finish laying out after the text commit that triggered the
    // render. Observe the content itself so a growing body stays pinned even
    // when the scroll container's own size has not changed.
    React.useLayoutEffect(() => {
        if (!isStreaming) {
            return;
        }

        const content = contentRef.current;
        const ResizeObserverConstructor = globalThis.ResizeObserver;
        if (!content || !ResizeObserverConstructor) {
            return;
        }

        const observer = new ResizeObserverConstructor(() => {
            followReasoningScroll();
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [contentRef, followReasoningScroll, isStreaming]);

    const handleWheelCapture = React.useCallback((event: React.WheelEvent<HTMLElement>) => {
        if (isStreaming && event.deltaY < 0) {
            isFollowingRef.current = false;
        }
    }, [isStreaming]);

    const handleScroll = React.useCallback((event: React.UIEvent<HTMLElement>) => {
        if (!isStreaming) {
            return;
        }
        const element = event.currentTarget;
        isFollowingRef.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 4;
    }, [isStreaming]);

    return { handleWheelCapture, handleScroll };
};
