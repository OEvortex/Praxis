"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Bot, RefreshCcw, RotateCcw, Square } from "lucide-react";

import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import type { SelectedBookReference } from "@/lib/book-references";
import type { SpaceMemoryFile } from "@/lib/space-items";
import type { SessionSummary } from "@/lib/session-api";
import type { MessageAttachment, MessageRequestSnapshot } from "@/features/chat/ChatStateAdapter";
import type { StreamEvent } from "@/features/chat/model/protocol";
import MessageThreadMarker from "./MessageThreadMarker";
import { buildVisiblePath, type SiblingInfo } from "@/lib/message-branches";
import { turnAnchorKey } from "@/lib/chat-outline";
import { agentGlyph } from "@/components/agents/agent-icons";
import { activeWorkspaceId } from "@/lib/workspace-scope";
import { hasVisibleMarkdownContent } from "@/lib/markdown-display";
import { InlineFileCardProvider } from "@/components/common/InlineFileCard";
import { PlayAudioButton } from "@/components/voice/SpeechButton";
import { useVoicePlaybackRate, VOICE_PLAYBACK_RATES } from "@/hooks/useVoicePlaybackRate";
import {
  authoritativeResearchReport,
  isConfirmedResearchFollowup,
  researchFollowupStatus,
} from "@/lib/deep-research-report";
import {
  collectMasteryAnswerRejections,
  collectMasteryGrades,
  collectMasterySkips,
} from "@/lib/mastery-question";
import { UsageFooter } from "./UsageFooter";
import { cumulativeMessageUsage, messageUsage } from "./usage-summary";
import { GeneratedFileCards } from "./GeneratedFileCards";
import {
  CopyActionButton,
  DeleteTurnButton,
  RoughActionButton,
  type CopyHandler,
} from "./MessageActions";
import { AssistantMessage } from "./AssistantMessage";
import { UserMessage } from "./UserMessage";
import { ROW_GUTTER, type ChatMessageItem, type NotebookReferenceGroup } from "./types";

export { PlayAudioButton } from "@/components/voice/SpeechButton";
export { getModeBadgeLabel } from "./types";
export { GeneratedFileCards } from "./GeneratedFileCards";
export { AssistantMessage } from "./AssistantMessage";
export { RoughActionButton, CopyActionButton } from "./MessageActions";
export { UserMessage } from "./UserMessage";

export const ChatMessageList = memo(function ChatMessageList({
  messages,
  isStreaming,
  sessionId,
  language,
  onCopyAssistantMessage,
  onRegenerateMessage,
  canResendLastTurn = false,
  onResendLastTurn,
  onRetryTurn,
  onConfirmOutline,
  onPreviewAttachment,
  onOpenConsultation,
  onDeleteTurn,
  onDiscardFailedSubmission,
  onRetryFailedSubmission,
  selectedBranches,
  onEditMessage,
  onSwitchBranch,
  availableKbNames,
  kbDisplayNames,
  onSubmitUserReply,
  onAnswerMasteryQuestion,
  onSkipMasteryQuestion,
  onChallengeMasteryQuestion,
  onSendFollowUp,
  showModeBadge = true,
  onLoadMessageTrace,
  onReleaseMessageTrace,
  assistantActions,
  compactActions = false,
  threadsByMessageId,
  onOpenThread,
  onDeleteThread,
  onDetachThread,
  renderMarkdown = false,
}: {
  messages: ChatMessageItem[];
  isStreaming: boolean;
  sessionId?: string | null;
  language?: string;
  onCopyAssistantMessage: CopyHandler;
  onRegenerateMessage: () => void;
  /** True when the last turn failed (not cancelled) and streaming has
   *  stopped. Drives the Resend affordance on the trailing assistant. */
  canResendLastTurn?: boolean;
  onResendLastTurn?: () => void;
  /** Take a finished turn back into the composer to edit and send again. */
  onRetryTurn?: (userMessage: ChatMessageItem) => void;
  onConfirmOutline?: (
    outline: Array<{ title: string; overview: string }>,
    topic: string,
    researchConfig?: Record<string, unknown> | null,
    requestSnapshot?: MessageRequestSnapshot | null,
  ) => void;
  onPreviewAttachment?: (attachment: MessageAttachment) => void;
  onOpenConsultation?: (events: StreamEvent[]) => void;
  onDeleteTurn?: (messageId: number) => void;
  onDiscardFailedSubmission?: (messageId: number) => boolean | Promise<boolean>;
  onRetryFailedSubmission?: (messageId: number) => boolean | Promise<boolean>;
  /** Edit-branching: selected sibling at each branch point. */
  selectedBranches?: Record<string, number>;
  onEditMessage?: (messageId: number, newContent: string) => void | boolean | Promise<void | boolean>;
  onSwitchBranch?: (parentMessageId: number | null, childId: number) => void;
  /**
   * Deliver an ``ask_user`` reply back to the backend so the agentic
   * loop resumes on the same turn. Forwarded into each
   * ``AssistantMessage`` so the card UI rendered alongside the paused
   * assistant bubble can submit selections / free-form text. Accepts
   * either a string (legacy) or a structured object with per-question
   * ``answers`` (v2).
   */
  onSubmitUserReply?: (
    reply:
      | string
      | {
          text?: string;
          answers?: Array<{ questionId: string; text: string }>;
        },
  ) => void | boolean | Promise<void | boolean>;
  /**
   * Answer a mastery question card by starting the next turn (see
   * ``AssistantMessage``). Separate from ``onSubmitUserReply`` because these
   * cards outlive their turn by design.
   */
  onAnswerMasteryQuestion?: (answer: {
    questionId: string;
    text: string;
    answers?: Array<{ questionId: string; text: string }>;
  }) => void | boolean | Promise<void | boolean>;
  /** Drop a question instead of answering it; also starts a turn. */
  onSkipMasteryQuestion?: (
    questionId: string,
  ) => void | boolean | Promise<void | boolean>;
  onChallengeMasteryQuestion?: (questionId: string) => void | boolean | Promise<void | boolean>;
  /** OpenUI `continue_conversation` actions become a normal user turn. */
  onSendFollowUp?: (text: string) => void | Promise<void>;
  /** Names of KBs confirmed to exist. Omitted when the KB list is unavailable. */
  availableKbNames?: Set<string>;
  /** Qualified KB ref -> display name, from the same catalog the composer
   *  resolves against. Snapshots store the ref; only the chip label should
   *  show the human-readable name (falls back to the ref when unmapped). */
  kbDisplayNames?: Record<string, string>;
  /** Label each user bubble with its capability. Off on surfaces that run a
   *  single capability and already name it in its own chrome. */
  showModeBadge?: boolean;
  onLoadMessageTrace?: (messageId: number) => Promise<void>;
  onReleaseMessageTrace?: (messageId: number) => void;
  /** A surface's own actions on a finished reply, after the shared ones —
   *  the note companion's "add to the page" lives here. */
  assistantActions?: (message: ChatMessageItem) => ReactNode;
  /** A narrow side surface keeps only copy, regenerate and its own actions:
   *  read-aloud, delete and the usage line belong to the full chat. */
  compactActions?: boolean;
  /** Little Tutor threads opened from a message, keyed by that message id
   *  (``String(message.id)`` so SQLite and PocketBase ids group alike).
   *  Omitted where the surface has no message-level thread entry point. */
  threadsByMessageId?: ReadonlyMap<string, SessionSummary[]>;
  onOpenThread?: (thread: SessionSummary) => void;
  onDeleteThread?: (thread: SessionSummary) => Promise<void>;
  /** Detach a thread from this message without deleting its conversation. */
  onDetachThread?: (thread: SessionSummary) => Promise<void>;
  /** Render assistant replies as Markdown (not OpenUI Lang). Used by notebook
   *  companion threads, whose answers are saved into a Markdown-based page. */
  renderMarkdown?: boolean;
}) {
  
  // One lookup for both bubbles; the map is memoized by the chat page, so a
  // message without threads costs a miss and no render branch.
  const threadsForMessage = (messageId?: number) =>
    messageId != null && threadsByMessageId
      ? threadsByMessageId.get(String(messageId))
      : undefined;
  // Visible path: when no branching has happened the result is identical
  // to the input. After an edit, sibling branches are filtered out so the
  // UI shows exactly one continuous thread, with arrow nav exposed on the
  // user message where branching diverges.
  const { messages: visibleMessages, siblingsByMessageId } = useMemo(
    () => buildVisiblePath(messages, selectedBranches),
    [messages, selectedBranches],
  );

  // Deep-research two-turn merge.
  //
  // The capability runs in two BE turns: turn-1 emits rephrase +
  // decompose + an outline-preview result; turn-2 (after the user
  // confirms the outline) emits the research blocks + the final
  // report. The user wants both turns to live in ONE assistant
  // bubble so the rephrase trace, the Q&A summary, the (collapsed)
  // outline editor, and the research / reporting traces are all
  // visually contiguous instead of split across two bubbles.
  //
  // For each parent (outline-preview) msg with a followup
  // deep_research msg, we synthesise a merged msg with:
  //
  // * events  — parent.events ++ followup.events (preserving order
  //   so TraceFlow's call_id grouping keeps working).
  // * content — followup.content (the report). The parent's
  //   rephrase preface is already represented inside the trace card,
  //   so concatenating again would duplicate it above the report.
  //
  // The followup is dropped from the visible row list so only the
  // merged bubble renders.
  // One callback for every row rather than a closure per row per render.
  // ``AssistantMessage`` is memoized, and a fresh function defeats that
  // outright: every message in the conversation re-rendered on every streamed
  // delta of the turn at the bottom.
  const handleTraceToggle = useCallback(
    (messageId: number, open: boolean) => {
      if (open) {
        void onLoadMessageTrace?.(messageId);
      } else {
        onReleaseMessageTrace?.(messageId);
      }
    },
    [onLoadMessageTrace, onReleaseMessageTrace],
  );

  const deepResearchMergeMap = useMemo(() => {
    const map = new Map<
      number,
      { mergedEvents: StreamEvent[]; mergedContent: string }
    >();
    const followupIndices = new Set<number>();
    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      if (msg.role !== "assistant" || msg.capability !== "deep_research")
        continue;
      const resultEv = msg.events?.find((e) => e.type === "result");
      const meta = resultEv?.metadata as Record<string, unknown> | undefined;
      if (!meta?.outline_preview) continue;
      const nextResearchAssistantIdx = visibleMessages
        .slice(i + 1)
        .findIndex(
          (m) => m.role === "assistant" && m.capability === "deep_research",
        );
      if (nextResearchAssistantIdx === -1) continue;
      const absoluteFollowupIdx = i + 1 + nextResearchAssistantIdx;
      const followup = visibleMessages[absoluteFollowupIdx];
      if (!isConfirmedResearchFollowup(followup.events)) continue;
      const mergedEvents = [...(msg.events ?? []), ...(followup.events ?? [])];
      const mergedContent = authoritativeResearchReport(
        followup.events,
        followup.content || msg.content,
      );
      map.set(i, { mergedEvents, mergedContent });
      followupIndices.add(absoluteFollowupIdx);
    }
    return { mergedByParent: map, followupIndices };
  }, [visibleMessages]);

  // One pass for the whole conversation: a question posed in one turn can be
  // graded in a later one, and the card that asked it shows the verdict.
  const masteryGrades = useMemo(
    () => collectMasteryGrades(visibleMessages),
    [visibleMessages],
  );
  const masterySkips = useMemo(
    () => collectMasterySkips(visibleMessages),
    [visibleMessages],
  );
  const masteryAnswerRejections = useMemo(
    () => collectMasteryAnswerRejections(visibleMessages),
    [visibleMessages],
  );

  const outlineStatusByIndex = useMemo(() => {
    const map = new Map<
      number,
      "editing" | "researching" | "done" | "failed"
    >();
    for (let i = 0; i < visibleMessages.length; i++) {
      const msg = visibleMessages[i];
      if (msg.role !== "assistant" || msg.capability !== "deep_research")
        continue;
      const resultEv = msg.events?.find((e) => e.type === "result");
      const meta = resultEv?.metadata as Record<string, unknown> | undefined;
      if (!meta?.outline_preview) continue;
      const followup = visibleMessages
        .slice(i + 1)
        .find(
          (m) => m.role === "assistant" && m.capability === "deep_research",
        );
      if (followup && isConfirmedResearchFollowup(followup.events)) {
        map.set(i, researchFollowupStatus(followup.events));
      } else {
        // The first deep_research turn only plans/rephrases/decomposes and
        // returns an outline preview. While that turn is still flushing
        // post-result events, the outline must already be editable; only the
        // hidden follow-up turn created by "Start Research" means research is
        // actually underway.
        map.set(i, "editing");
      }
    }
    return map;
  }, [visibleMessages]);

  const messageRows = useMemo(() => {
    // System messages are backend grounding (e.g. quiz follow-up context) and
    // must never be rendered as a chat bubble. Filter them out defensively in
    // addition to the hydration-time filter in UnifiedChatContext.
    return visibleMessages
      .map((msg, index) => ({ msg, originalIndex: index }))
      .filter(({ msg, originalIndex }) => {
        if (msg.role === "system") return false;
        // Drop deep_research followup msgs — their events were merged
        // into the parent (outline-preview) bubble.
        if (deepResearchMergeMap.followupIndices.has(originalIndex))
          return false;
        return true;
      })
      .map(({ msg, originalIndex }) => {
        // Splice in the merged event stream when this row owns a
        // deep_research two-turn pair.
        const merged = deepResearchMergeMap.mergedByParent.get(originalIndex);
        const effectiveMsg: ChatMessageItem = merged
          ? {
              ...msg,
              events: merged.mergedEvents,
              content: merged.mergedContent,
            }
          : msg;
        if (effectiveMsg.role === "user") {
          return {
            msg: effectiveMsg,
            originalIndex,
            pairedUserMessage: null as ChatMessageItem | null,
          };
        }
        const pairedUserMessage =
          [...visibleMessages.slice(0, originalIndex)]
            .reverse()
            .find((previous) => previous.role === "user") ?? null;
        return { msg: effectiveMsg, originalIndex, pairedUserMessage };
      });
  }, [visibleMessages, deepResearchMergeMap]);

  const usageByRow = useMemo(() => {
    const totals = cumulativeMessageUsage(messageRows.map(row => row.msg));
    return new Map(messageRows.map((row, index) => [row.originalIndex, totals[index]]));
  }, [messageRows]);

  const lastRenderedAssistantIndex = useMemo(() => {
    for (let idx = messageRows.length - 1; idx >= 0; idx -= 1) {
      if (messageRows[idx].msg.role === "assistant")
        return messageRows[idx].originalIndex;
    }
    return -1;
  }, [messageRows]);

  // Auto-play (when enabled) must fire only for a reply that JUST finished
  // generating — never when loading history. We capture the last-assistant
  // index at the moment streaming flips off; the matching speaker button
  // plays once. Switching sessions clears the marker. Uses the "adjust state
  // during render" pattern (state-vs-prop comparison, like the API-key reset
  // in ServiceConfigEditor) — both branches are conditional and bounded.
  const [prevStreaming, setPrevStreaming] = useState(isStreaming);
  const [prevSession, setPrevSession] = useState(sessionId);
  const [freshlyCompletedIndex, setFreshlyCompletedIndex] = useState<
    number | null
  >(null);
  if (prevSession !== sessionId) {
    setPrevSession(sessionId);
    setPrevStreaming(false);
    setFreshlyCompletedIndex(null);
  } else if (prevStreaming !== isStreaming) {
    setPrevStreaming(isStreaming);
    if (!isStreaming && lastRenderedAssistantIndex >= 0) {
      setFreshlyCompletedIndex(lastRenderedAssistantIndex);
    }
  }

  const { rate: voiceRate, setRate: setVoiceRate } = useVoicePlaybackRate(
    sessionId ? JSON.stringify([activeWorkspaceId(), sessionId]) : undefined,
  );

  return (
    <>
      {messageRows.map(({ msg, originalIndex, pairedUserMessage }, rowIndex) => {
        const i = originalIndex;
        if (msg.role === "user") {
          const sib =
            msg.id !== undefined ? siblingsByMessageId.get(msg.id) : undefined;
          const reply = messageRows[rowIndex + 1]?.msg;
          const orphanedFailure =
            reply?.role === "assistant" && reply.parentMessageId === msg.id
              ? null
              : msg.orphanedFailedTurn;
          const consultationEvents = reply?.role === "assistant"
            ? (reply.events ?? []).filter(event => event.metadata?.trace_kind === "subagent_event")
            : [];
          return (
            <div
              key={`${msg.role}-${i}`}
              className="w-full"
              data-chat-message-id={msg.id}
              data-chat-message-role={msg.role}
            >
              <UserMessage
                msg={msg}
                index={i}
                onPreviewAttachment={onPreviewAttachment}
                onCopy={onCopyAssistantMessage}
                onEdit={onEditMessage}
                onDiscardFailedSubmission={onDiscardFailedSubmission}
                onRetryFailedSubmission={onRetryFailedSubmission}
                editDisabled={isStreaming}
                siblingInfo={sib}
                onSwitchBranch={onSwitchBranch}
                availableKbNames={availableKbNames}
                kbDisplayNames={kbDisplayNames}
                showModeBadge={showModeBadge}
                onOpenConsultation={consultationEvents.length && onOpenConsultation
                  ? () => onOpenConsultation(consultationEvents)
                  : undefined}
              />
              {orphanedFailure ? (
                <div
                  role="alert"
                  data-orphaned-failed-turn={orphanedFailure.turn_id}
                  className="mt-3 flex w-full max-w-[min(520px,90%)] items-center gap-2 rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2"
                >
                  <AlertCircle className="h-4 w-4 shrink-0 text-[var(--destructive)]" />
                  <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-[var(--foreground)]">
                    {orphanedFailure.error || "The turn was interrupted."}
                  </span>
                  {!isStreaming && rowIndex === messageRows.length - 1 &&
                    canResendLastTurn && orphanedFailure.retryable && onResendLastTurn ? (
                    <button
                      type="button"
                      onClick={onResendLastTurn}
                      className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                    >
                      {"Retry"}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {(() => {
                const threads = threadsForMessage(msg.id);
                return threads?.length && onOpenThread && onDeleteThread ? (
                  <MessageThreadMarker
                    threads={threads}
                    align="right"
                    onOpen={onOpenThread}
                    onDelete={onDeleteThread}
                    onDetach={onDetachThread}
                  />
                ) : null;
              })()}
            </div>
          );
        }

        const isActiveAssistant =
          isStreaming && i === lastRenderedAssistantIndex;
        const msgDone = !isActiveAssistant;
        const showActions = msgDone && hasVisibleMarkdownContent(msg.content);
        const events = msg.events ?? [];
        const terminalError = [...events].reverse().find(
          (event) => event.type === "error" && Boolean(event.metadata?.turn_terminal),
        ) ?? (!hasVisibleMarkdownContent(msg.content)
          ? [...events].reverse().find((event) => event.type === "error")
          : undefined);
        const stopped = terminalError?.metadata?.status === "cancelled" ||
          events.some((event) => event.type === "done" && event.metadata?.status === "cancelled");
        const emptyResponse = !hasVisibleMarkdownContent(msg.content) &&
          !msg.attachments?.length &&
          !events.some((event) => ["result", "tool_call", "tool_result", "wait_for_input"].includes(event.type));
        const terminalErrorRetryable = Boolean(
          (terminalError?.metadata as { retryable?: boolean } | undefined)
            ?.retryable,
        );
        const isLastAssistant = i === lastRenderedAssistantIndex;
        const showRegenerate =
          !isStreaming &&
          isLastAssistant &&
          Boolean(pairedUserMessage) &&
          (!pairedUserMessage?.capability ||
            pairedUserMessage?.capability === "chat") &&
          (showActions || terminalErrorRetryable);
        const showResend =
          !isStreaming &&
          isLastAssistant &&
          canResendLastTurn &&
          Boolean(pairedUserMessage?.requestSnapshot) &&
          Boolean(onResendLastTurn);
        // Retry takes a turn the server has saved: its new attempt is a
        // sibling of this one, under the same parent.
        const retryTarget =
          onRetryTurn &&
          (showRegenerate || showResend) &&
          pairedUserMessage?.id != null &&
          pairedUserMessage.id > 0 &&
          !pairedUserMessage.failedSubmission
            ? pairedUserMessage
            : null;
        const deletableTurnUserId =
          msgDone && pairedUserMessage?.id != null && onDeleteTurn
            ? pairedUserMessage.id
            : null;
        const showDelete = deletableTurnUserId != null;

        const costSummary = msgDone ? messageUsage(msg.events) : null;

        return (
          <div
            key={`${msg.role}-${i}`}
            className="w-full"
            data-chat-message-id={msg.id}
            data-chat-message-role={msg.role}
          >
            <InlineFileCardProvider
              attachments={msg.attachments ?? []}
              events={msg.events}
              onOpen={onPreviewAttachment}
            >
              <AssistantMessage
                msg={msg}
                isStreaming={isActiveAssistant}
                outlineStatus={outlineStatusByIndex.get(i)}
                sessionId={sessionId}
                language={language}
                onConfirmOutline={onConfirmOutline}
                onSubmitUserReply={onSubmitUserReply}
                onAnswerMasteryQuestion={onAnswerMasteryQuestion}
                onSkipMasteryQuestion={onSkipMasteryQuestion}
                onChallengeMasteryQuestion={onChallengeMasteryQuestion}
                onSendFollowUp={onSendFollowUp}
                renderMarkdown={renderMarkdown}
                researchRequestSnapshot={
                  pairedUserMessage?.requestSnapshot ?? null
                }
                onTraceToggle={handleTraceToggle}
                masteryGrades={masteryGrades}
                masterySkips={masterySkips}
                masteryAnswerRejections={masteryAnswerRejections}
              />
            </InlineFileCardProvider>
            <GeneratedFileCards
              attachments={msg.attachments ?? []}
              events={msg.events}
              content={msg.content}
              onOpen={onPreviewAttachment}
            />
            {(() => {
              // A turn that died (LLM/provider failure, interruption) ends
              // with a turn_terminal error event. Surface it as an error
              // card with an inline retry instead of leaving a bare trace.
              if (isActiveAssistant) return null;
              if (stopped) return (
                <div role="status" className="mt-3 flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
                  <Square className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>{"Stopped"}</span>
                </div>
              );
              if (!terminalError && !emptyResponse) return null;
              return (
                <div role="alert" className="mt-3 flex w-full max-w-[min(520px,90%)] items-center gap-2 rounded-xl border border-[var(--destructive)]/30 bg-[var(--destructive)]/5 px-3 py-2">
                  <AlertCircle className="h-4 w-4 shrink-0 text-[var(--destructive)]" />
                  <span className="min-w-0 flex-1 text-[12px] leading-[1.5] text-[var(--foreground)]">
                    {terminalError?.content || (terminalError
                      ? "The turn was interrupted."
                      : "No response was generated. Please try again.")}
                  </span>
                  {showRegenerate ? (
                    <button
                      type="button"
                      onClick={() => onRegenerateMessage()}
                      className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-[var(--destructive)] hover:bg-[var(--destructive)]/10"
                    >
                      {"Retry"}
                    </button>
                  ) : null}
                  {showResend && !showRegenerate ? (
                    <button
                      type="button"
                      onClick={() => onResendLastTurn?.()}
                      className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-[var(--foreground)] hover:bg-[var(--muted)]"
                    >
                      {"Resend"}
                    </button>
                  ) : null}
                </div>
              );
            })()}
            {(showActions || costSummary || showDelete) && (
              <div className="mt-3 flex items-center">
                {(showActions || showDelete) && (
                  <div className="flex shrink-0 items-center gap-1">
                    {showActions && (
                      <CopyActionButton
                        content={msg.content}
                        onCopy={onCopyAssistantMessage}
                      />
                    )}
                    {showActions && !compactActions && (
                      <>
                        <PlayAudioButton
                          playbackRate={voiceRate}
                          content={msg.content}
                          conversationKey={sessionId ?? undefined}
                          autoPlayFresh={
                            isLastAssistant && freshlyCompletedIndex === i
                          }
                        />
                        {i === lastRenderedAssistantIndex && (
                          <select
                            aria-label={"Playback speed"}
                            className="rounded bg-transparent px-1 text-xs text-[var(--muted-foreground)]"
                            value={voiceRate}
                            onChange={(event) => setVoiceRate(Number(event.target.value))}
                          >
                            {VOICE_PLAYBACK_RATES.map((rate) => (
                              <option key={rate} value={rate}>{rate}×</option>
                            ))}
                          </select>
                        )}
                      </>
                    )}
                    {/* One way to try a turn again. Where the surface can
                        take the turn back into its composer, Retry does that
                        and the learner edits before sending; elsewhere it
                        reruns the turn as it was. Regenerate and Resend were
                        two identical icons offered side by side. */}
                    {retryTarget ? (
                      <RoughActionButton
                        icon={RotateCcw}
                        label={"Retry"}
                        onClick={() => onRetryTurn?.(retryTarget)}
                      />
                    ) : showActions && showRegenerate ? (
                      <RoughActionButton
                        icon={RefreshCcw}
                        label={"Regenerate"}
                        onClick={() => onRegenerateMessage()}
                      />
                    ) : showResend ? (
                      <RoughActionButton
                        icon={RefreshCcw}
                        label={"Resend"}
                        onClick={() => onResendLastTurn?.()}
                      />
                    ) : null}
                    {showDelete && !compactActions && (
                      <DeleteTurnButton
                        onDelete={() => onDeleteTurn?.(deletableTurnUserId)}
                      />
                    )}
                    {showActions && assistantActions?.(msg)}
                  </div>
                )}
                {costSummary && !compactActions && (
                  // The room left beside the actions is what the usage pill
                  // measures itself against (see UsageFooter).
                  <div className="flex min-w-0 flex-1 justify-end pl-2 [container-type:inline-size]">
                    <UsageFooter turn={costSummary} session={usageByRow.get(i) ?? costSummary} />
                  </div>
                )}
              </div>
            )}
            {(() => {
              const threads = threadsForMessage(msg.id);
              return threads?.length && onOpenThread && onDeleteThread ? (
                <MessageThreadMarker
                  threads={threads}
                  align="left"
                  onOpen={onOpenThread}
                  onDelete={onDeleteThread}
                  onDetach={onDetachThread}
                />
              ) : null;
            })()}
          </div>
        );
      })}
    </>
  );
});

ChatMessageList.displayName = "ChatMessageList";

/** Above a message handed to someone: their mark and "Handed to <name>". */
