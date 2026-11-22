"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookMarked, BookOpen, Bot, Brain, ClipboardList, Database, Loader2, MessageSquare, Pencil, RotateCcw, UserRound, UsersRound, X, type LucideIcon } from "lucide-react";

import type { SelectedHistorySession } from "@/components/chat/HistorySessionPicker";
import type { SelectedQuestionEntry } from "@/components/chat/QuestionBankPicker";
import { LearningText } from "@/components/common/LearningText";
import Tooltip from "@/shared/ui/Tooltip";
import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import { docIconFor } from "@/lib/doc-attachments";
import { isQuoteAttachment, quoteText } from "@/lib/quote-attachments";
import { QUOTE_RULE_CLASS } from "@/components/chat/home/QuotedPassage";
import type { SelectedBookReference } from "@/lib/book-references";
import type { SessionSummary } from "@/lib/session-api";
import { readingPassageHref } from "@/lib/reading-citations";
import { shouldSubmitOnEnter } from "@/lib/composer-keyboard";
import { useImeComposing } from "@/lib/use-ime-composing";
import type { SpaceMemoryFile } from "@/lib/space-items";
import ContextReferenceTree, { type ContextTreeItem } from "@/components/chat/home/ContextReferenceTree";
import { supportsSubmissionReplacement } from "@/lib/session-api";
import { useConsultationReference } from "@/hooks/useConsultationReference";
import { useConnectedAgentKinds } from "@/hooks/useConnectedAgentKinds";
import { turnAnchorKey } from "@/lib/chat-outline";
import { buildVisiblePath, type SiblingInfo } from "@/lib/message-branches";
import { agentGlyph } from "@/components/agents/agent-icons";
import { parseAnswerBy } from "@/features/chat/trace/answerer";
import { GeneratedFileCards, humanizeFilename, imageSrcForAttachment } from "./GeneratedFileCards";
import { BranchNavigator, CopyActionButton, DeleteTurnButton, HandedToBadge, ReadingPassageQuote, RoughActionButton, type CopyHandler } from "./MessageActions";
import { ROW_GUTTER, getModeBadgeLabel, type ChatMessageItem, type NotebookReferenceGroup } from "./types";

export const UserMessage = memo(function UserMessage({
  msg,
  index,
  onPreviewAttachment,
  onCopy,
  onEdit,
  onDiscardFailedSubmission,
  onRetryFailedSubmission,
  editDisabled,
  siblingInfo,
  onSwitchBranch,
  availableKbNames,
  kbDisplayNames,
  showModeBadge,
  onOpenConsultation,
}: {
  msg: ChatMessageItem;
  index: number;
  onPreviewAttachment?: (attachment: MessageAttachment) => void;
  onCopy?: CopyHandler;
  onEdit?: (messageId: number, newContent: string) => void | boolean | Promise<void | boolean>;
  onDiscardFailedSubmission?: (messageId: number) => boolean | Promise<boolean>;
  onRetryFailedSubmission?: (messageId: number) => boolean | Promise<boolean>;
  editDisabled?: boolean;
  siblingInfo?: SiblingInfo;
  onSwitchBranch?: (parentMessageId: number | null, childId: number) => void;
  /** Names of KBs confirmed to exist. Omitted when the KB list is unavailable. */
  availableKbNames?: Set<string>;
  /** Qualified KB ref -> display name from the selection catalog; the chip
   *  label falls back to the raw ref when no entry matches. */
  kbDisplayNames?: Record<string, string>;
  /** Label the bubble with its capability. A single-capability surface
   *  already names the mode in its own chrome. */
  showModeBadge?: boolean;
  onOpenConsultation?: () => void;
}) {
  
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(msg.content);
  const [discarding, setDiscarding] = useState(false);
  const [discardFailed, setDiscardFailed] = useState(false);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [editFailed, setEditFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { isComposingRef, onCompositionStart, onCompositionEnd } =
    useImeComposing();
  // Connected subagents ride in knowledge_bases (same selection path) but are
  // agents, not KBs — this maps a selected name to its backend kind so the
  // reference chip can badge it with the agent's brand icon.
  const agentKinds = useConnectedAgentKinds();
  const consultation = useConsultationReference(msg.requestSnapshot?.config);
  // ``msg.id`` can be a negative client-side sentinel for optimistic
  // (just-sent, not yet reconciled with the server) rows. We still allow
  // the Edit button to surface — ``editMessage`` in the context handles
  // the optimistic case by triggering a session reload to resolve the
  // real id before submitting the branch.
  const [replacementAvailable, setReplacementAvailable] = useState(false);
  const needsReplacement = Boolean(msg.failedSubmission && onEdit);
  useEffect(() => {
    if (!needsReplacement) return;
    let active = true;
    void supportsSubmissionReplacement().then(value => {
      if (active) setReplacementAvailable(value);
    });
    return () => { active = false; };
  }, [needsReplacement]);
  if (msg.content.startsWith("[Quiz Performance]")) return null;
  const canEdit =
    Boolean(onEdit) && typeof msg.id === "number" && !editDisabled && (!msg.failedSubmission || replacementAvailable);
  const discardDraft = async () => {
    if (!onDiscardFailedSubmission || typeof msg.id !== "number" || editDisabled || discarding) return;
    setDiscarding(true);
    setDiscardFailed(false);
    try {
      if (!await onDiscardFailedSubmission(msg.id)) setDiscardFailed(true);
    } catch {
      setDiscardFailed(true);
    } finally {
      setDiscarding(false);
    }
  };
  const startEdit = () => {
    if (!canEdit) return;
    setDraft(msg.content);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft(msg.content);
  };
  const submitEdit = async () => {
    if (submittingEdit) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === msg.content) {
      cancelEdit();
      return;
    }
    if (typeof msg.id !== "number") return;
    setSubmittingEdit(true);
    setEditFailed(false);
    try {
      if (await onEdit?.(msg.id, trimmed) === false) setEditFailed(true);
      else setEditing(false);
    } catch {
      setEditFailed(true);
    } finally {
      setSubmittingEdit(false);
    }
  };

  // Everything this turn carried — file attachments plus the request
  // snapshot's Space references — rendered as one collapsed tree under
  // the bubble (the sent-message mirror of the composer's tree).
  const snap = msg.requestSnapshot;
  const handedTo = parseAnswerBy(snap?.config?.answer_by);
  const refTreeItems: ContextTreeItem[] = [
    ...(consultation ? [{
      key: `${consultation.kind}-${consultation.id}`,
      icon: consultation.kind === "partner_group" ? UsersRound : UserRound,
      kind: (consultation.kind === "partner_group" ? "Organize partner discussion" : "Ask partner"),
      label: consultation.name,
      onClick: onOpenConsultation,
    }] : []),
    ...(msg.attachments ?? []).filter((a) => !isQuoteAttachment(a)).map((a, ai): ContextTreeItem => {
      const filename = a.filename || "Attachment";
      const spec = docIconFor(filename);
      const src = a.type === "image" ? imageSrcForAttachment(a) : null;
      return {
        key: `att-${ai}`,
        icon: spec.Icon,
        kind: spec.label,
        label: filename,
        thumbnailUrl: src ?? undefined,
        onClick: onPreviewAttachment ? () => onPreviewAttachment(a) : undefined,
      };
    }),
    ...(snap?.knowledgeBases ?? [])
      .filter(
        (name) =>
          !availableKbNames || availableKbNames.has(name) || agentKinds[name],
      )
      .map((name): ContextTreeItem => {
        const agentKind = agentKinds[name];
        if (agentKind) {
          return {
            key: `agent-${name}`,
            // Brand SVG marks share the lucide call signature (size/strokeWidth/
            // className); cast bridges the structural-variance gap.
            icon: (agentGlyph(agentKind) ?? Bot) as unknown as LucideIcon,
            kind: "Ask subagent",
            label: name,
            onClick: onOpenConsultation,
          };
        }
        return {
          key: `kb-${name}`,
          icon: Database,
          kind: "Knowledge",
          label: kbDisplayNames?.[name] ?? name,
        };
      }),
    ...(snap?.bookReferences ?? []).map((ref): ContextTreeItem => ({
      key: `book-${ref.book_id}`,
      icon: BookOpen,
      kind: "Book",
      label: `${ref.page_ids.length} ${"chapters"}`,
    })),
    ...(snap?.readingReferences ?? []).map((ref): ContextTreeItem => ({
      key: `reading-${ref.material_id}-r${ref.revision}`,
      icon: BookMarked,
      kind: "Reading",
      label: `${ref.locators.length} ${"reading sections"}`,
    })),
    ...(snap?.notebookReferences ?? []).map((ref): ContextTreeItem => ({
      key: `nb-${ref.notebook_id}`,
      icon: BookOpen,
      kind: "Favorites",
      label: `${ref.record_ids.length} ${"records"}`,
    })),
    // Imported agent conversations are folded into the same history_references
    // payload but carry the `imported_` id prefix — split them back out so they
    // read as "My Agents" rather than "Chat History" (mirrors the composer).
    ...(snap?.historyReferences ?? [])
      .filter((sid) => !sid.startsWith("imported_"))
      .map((sid): ContextTreeItem => ({
        key: `hist-${sid}`,
        icon: MessageSquare,
        kind: "Chat History",
        label: "",
      })),
    ...(snap?.historyReferences ?? [])
      .filter((sid) => sid.startsWith("imported_"))
      .map((sid): ContextTreeItem => ({
        key: `agent-${sid}`,
        icon: Bot,
        kind: "Subagents",
        label: "",
      })),
    ...(snap?.questionNotebookReferences?.length
      ? [
          {
            key: "qb",
            icon: ClipboardList,
            kind: "Question Bank",
            label: `${snap.questionNotebookReferences.length} ${"items"}`,
          } satisfies ContextTreeItem,
        ]
      : []),
    ...(snap?.persona
      ? [
          {
            key: "persona",
            icon: UserRound,
            kind: "Persona",
            label: snap.persona,
          } satisfies ContextTreeItem,
        ]
      : []),
    ...(snap?.memoryReferences ?? []).map((file): ContextTreeItem => ({
      key: `mem-${file}`,
      icon: Brain,
      kind: "Memory",
      label: file === "summary" ? "Summary" : "Profile",
    })),
  ];

  return (
    <div key={`${msg.role}-${index}`} className="group flex justify-end">
      {/* ``data-turn-key`` is the scroll target the turn navigator jumps
          to; ``data-turn-bubble`` is what it flashes on arrival. Both keys
          come from ``turnAnchorKey`` so the rail and the transcript can
          never disagree about which bubble a tick means. */}
      <div
        data-turn-key={turnAnchorKey(msg, index)}
        className="flex max-w-[75%] flex-col items-end gap-1.5"
      >
        {handedTo ? (
          <HandedToBadge kind={handedTo.kind} id={handedTo.id} agentKind={agentKinds[handedTo.id]} />
        ) : showModeBadge ? (
          <div className="flex justify-end pr-1">
            <span className="text-[10px] tracking-wide text-[var(--muted-foreground)]">
              {(getModeBadgeLabel(msg.capability))}
            </span>
          </div>
        ) : null}
        {editing ? (
          <div className="w-[min(620px,75vw)] rounded-2xl border border-[var(--primary)]/40 bg-[var(--secondary)] px-3 py-2.5 text-[14px] leading-relaxed text-[var(--foreground)] shadow-sm">
            <textarea
              autoFocus
              value={draft}
              disabled={submittingEdit}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitEdit();
                } else if (shouldSubmitOnEnter(e, isComposingRef.current)) {
                  e.preventDefault();
                  submitEdit();
                }
              }}
              onCompositionStart={onCompositionStart}
              onCompositionEnd={onCompositionEnd}
              rows={Math.min(8, Math.max(2, draft.split("\n").length))}
              className="w-full resize-none border-0 bg-transparent text-[14px] leading-relaxed text-[var(--foreground)] outline-none focus:outline-none"
            />
            <div className="mt-1 flex items-center justify-between gap-2">
              <span className="text-[10.5px] text-[var(--muted-foreground)]/80">
                {"Enter to send · Esc to cancel"}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={cancelEdit}
                  disabled={submittingEdit}
                  className="rounded-md px-2 py-0.5 text-[11px] font-medium text-[var(--muted-foreground)] hover:bg-[var(--muted)]/40"
                >
                  {"Cancel"}
                </button>
                <button
                  type="button"
                  onClick={submitEdit}
                  disabled={submittingEdit || !draft.trim() || draft.trim() === msg.content}
                  className="rounded-md bg-[var(--primary)] px-2.5 py-0.5 text-[11px] font-medium text-[var(--primary-foreground)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {"Send"}
                </button>
              </div>
            </div>
            {editFailed && <p role="alert" className="text-xs text-[var(--destructive)]">{"The edit could not be sent. Your draft is still here; please retry."}</p>}
          </div>
        ) : (
          <div
            data-turn-bubble="true"
            className="rounded-2xl bg-[var(--secondary)] px-4 py-2.5 text-[14px] leading-relaxed text-[var(--foreground)] shadow-sm"
          >
            {snap?.readingSelection ? (
              <ReadingPassageQuote
                quote={snap.readingSelection.quote}
                href={
                  snap.readingMaterialId && snap.readingSelection.locator
                    ? readingPassageHref(
                        snap.readingMaterialId,
                        snap.readingSelection.locator,
                        snap.readingMaterialRevision,
                      )
                    : undefined
                }
              />
            ) : null}
            {(msg.attachments ?? []).filter(isQuoteAttachment).map((a, qi) => (
              <div
                key={`quote-${qi}`}
                className={`mb-1.5 line-clamp-3 whitespace-pre-line ${QUOTE_RULE_CLASS}`}
              >
                {quoteText(a)}
              </div>
            ))}
            <div dir="auto" className="whitespace-pre-wrap"><LearningText size={14}>{msg.content}</LearningText></div>
          </div>
        )}
        {/* Recovery records are local to this browser. Keep their actions
            visible so an old pending submission can be resolved in place. */}
        {!editing && msg.failedSubmission ? (
          <div
            data-unsent="true"
            className="flex items-center gap-1 pr-1 text-[11px] font-medium text-[var(--destructive)]"
          >
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            {"Not sent"}
            {onRetryFailedSubmission && !msg.failedSubmissionNeedsReview &&
              typeof msg.id === "number" && (
              <button type="button" disabled={editDisabled || retrying} onClick={async () => {
                if (retrying || typeof msg.id !== "number") return;
                setRetrying(true);
                try { await onRetryFailedSubmission(msg.id); } finally { setRetrying(false); }
              }} className="ml-2 rounded-md px-2 py-1 disabled:opacity-40">{"Retry"}</button>
            )}
            {onDiscardFailedSubmission && typeof msg.id === "number" && msg.id < 0 && (
              <button type="button" onClick={() => void discardDraft()} disabled={editDisabled || discarding}
                className="ml-2 rounded-md px-2 py-1 text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)]/50 disabled:cursor-not-allowed disabled:opacity-40">
                {discarding ? "Discarding…" : "Discard unsent draft"}
              </button>
            )}
          </div>
        ) : null}
        {discardFailed && <p role="alert" className="max-w-full text-right text-xs text-[var(--destructive)]">
          {"This draft could not be discarded. Please retry or copy it before leaving."}
        </p>}
        {!editing && refTreeItems.length > 0 && (
          <div className="pr-1">
            <ContextReferenceTree
              items={refTreeItems}
              direction="down"
              align="right"
              summaryNoun={"attachments"}
            />
          </div>
        )}
        {/* Branch navigation is the only way back to the pre-edit branch
            after an edit forks the transcript (#1410): it stays on this
            action row, outside the hover reveal that gates Copy/Edit, so
            the way back to history is visible without hovering. */}
        {!editing && (onCopy || canEdit || siblingInfo) && msg.content && (
          <div className="flex h-7 items-center justify-end gap-1">
            {siblingInfo && siblingInfo.total > 1 && (
              <BranchNavigator
                info={siblingInfo}
                onSwitch={(childId) =>
                  onSwitchBranch?.(siblingInfo.parentId, childId)
                }
              />
            )}
            {(onCopy || canEdit) && (
              <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                {onCopy && (
                  <CopyActionButton content={msg.content} onCopy={onCopy} />
                )}
                {canEdit && (
                  <RoughActionButton
                    icon={Pencil}
                    label={"Edit"}
                    onClick={startEdit}
                  />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

UserMessage.displayName = "UserMessage";

/**
 * The passage a reading question was asked about, at the top of its bubble.
 *
 * A link, not a label: it is written in the reader's citation form, so the
 * reader's own capture-phase handler scrolls the document back to it.
 */
