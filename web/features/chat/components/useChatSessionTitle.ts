"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { usePageBarOffers } from "@/components/layout/PageChrome";
import type { MessageItem } from "@/features/chat/ChatStateAdapter";
import { isPlaceholderSessionTitle } from "@/lib/session-title";

export function useChatSessionTitle({
  messages,
  sessionId,
  sessionTitle,
  renameSessionTitle,
}: {
  messages: MessageItem[];
  sessionId: string | null;
  sessionTitle: string;
  renameSessionTitle: (title: string) => Promise<void>;
}) {
  

  const firstUserTitle = useMemo(
    () =>
      messages
        .find((msg) => msg.role === "user")
        ?.content.trim()
        .replace(/\s+/g, " ")
        .slice(0, 80) || "",
    [messages],
  );
  const persistedSessionTitle = sessionTitle.trim();
  const displaySessionTitle = isPlaceholderSessionTitle(persistedSessionTitle)
    ? firstUserTitle || "New chat"
    : persistedSessionTitle;
  const canRenameSession = Boolean(sessionId);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const skipTitleCommitRef = useRef(false);
  const [sessionTitleDraft, setSessionTitleDraft] =
    useState(displaySessionTitle);
  const [sessionTitleEditing, setSessionTitleEditing] = useState(false);
  const titleInBar = usePageBarOffers("instance");
  const [sessionTitleSaving, setSessionTitleSaving] = useState(false);
  const [sessionTitleError, setSessionTitleError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (sessionTitleEditing) return;
    setSessionTitleDraft(displaySessionTitle);
  }, [displaySessionTitle, sessionTitleEditing]);

  useEffect(() => {
    if (!sessionTitleEditing) return;
    window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
  }, [sessionTitleEditing]);

  const startSessionTitleEdit = useCallback(() => {
    if (!canRenameSession) return;
    skipTitleCommitRef.current = false;
    setSessionTitleError(null);
    setSessionTitleDraft(displaySessionTitle);
    setSessionTitleEditing(true);
  }, [canRenameSession, displaySessionTitle]);

  const cancelSessionTitleEdit = useCallback(() => {
    skipTitleCommitRef.current = true;
    setSessionTitleDraft(displaySessionTitle);
    setSessionTitleError(null);
    setSessionTitleEditing(false);
  }, [displaySessionTitle]);

  const commitSessionTitleEdit = useCallback(async () => {
    if (skipTitleCommitRef.current) {
      skipTitleCommitRef.current = false;
      return;
    }
    const next = sessionTitleDraft.trim();
    if (!next) {
      setSessionTitleDraft(displaySessionTitle);
      setSessionTitleEditing(false);
      return;
    }
    if (!canRenameSession || next === persistedSessionTitle) {
      setSessionTitleDraft(next || displaySessionTitle);
      setSessionTitleEditing(false);
      return;
    }
    setSessionTitleSaving(true);
    setSessionTitleError(null);
    try {
      await renameSessionTitle(next);
      setSessionTitleEditing(false);
    } catch (error) {
      console.error("Failed to rename session:", error);
      setSessionTitleError("Rename failed");
      titleInputRef.current?.focus();
    } finally {
      setSessionTitleSaving(false);
    }
  }, [canRenameSession, displaySessionTitle, persistedSessionTitle, renameSessionTitle, sessionTitleDraft]);

  const handleSessionTitleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitSessionTitleEdit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelSessionTitleEdit();
      }
    },
    [cancelSessionTitleEdit, commitSessionTitleEdit],
  );

  return {
    displaySessionTitle,
    canRenameSession,
    titleInputRef,
    sessionTitleDraft,
    setSessionTitleDraft,
    sessionTitleEditing,
    titleInBar,
    sessionTitleSaving,
    sessionTitleError,
    startSessionTitleEdit,
    cancelSessionTitleEdit,
    commitSessionTitleEdit,
    handleSessionTitleKeyDown,
  };
}
