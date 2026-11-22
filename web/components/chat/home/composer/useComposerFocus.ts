import { useCallback, useEffect, useRef, type MutableRefObject } from "react";

interface UseComposerFocusParams {
  hasMessages: boolean;
  focusInputRef?: MutableRefObject<(() => void) | null>;
}

/**
 * Manages composer textarea focus, external `focusInputRef` binding, and
 * restoring focus when returning to the browser tab.
 */
export function useComposerFocus({
  hasMessages,
  focusInputRef,
}: UseComposerFocusParams) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusOnReturnRef = useRef(false);

  const focusTextarea = useCallback(() => {
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!focusInputRef) return;
    focusInputRef.current = focusTextarea;
    return () => {
      focusInputRef.current = null;
    };
  }, [focusInputRef, focusTextarea]);

  useEffect(() => {
    const rememberFocus = () => {
      restoreFocusOnReturnRef.current =
        document.activeElement === textareaRef.current;
    };
    const restoreFocus = () => {
      if (
        restoreFocusOnReturnRef.current &&
        document.visibilityState === "visible"
      ) {
        focusTextarea();
      }
    };

    window.addEventListener("blur", rememberFocus);
    window.addEventListener("focus", restoreFocus);
    document.addEventListener("visibilitychange", restoreFocus);
    return () => {
      window.removeEventListener("blur", rememberFocus);
      window.removeEventListener("focus", restoreFocus);
      document.removeEventListener("visibilitychange", restoreFocus);
    };
  }, [focusTextarea]);

  useEffect(() => {
    if (!hasMessages) focusTextarea();
  }, [hasMessages, focusTextarea]);

  return { textareaRef, focusTextarea };
}
