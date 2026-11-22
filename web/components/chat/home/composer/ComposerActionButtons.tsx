import { ArrowUp, Loader2, Mic, Square } from "lucide-react";

import type { LLMSelection } from "@/features/chat/model/protocol";
import type { LLMOption } from "@/lib/llm-options";
import Tooltip from "@/shared/ui/Tooltip";
import styles from "../ChatComposer.module.css";
import ContextBudgetChip, { type ContextBudget } from "../ContextBudgetChip";
import ModelSelector from "../ModelSelector";
import ReasoningEffortSelector from "../ReasoningEffortSelector";
import { SEND_STATE_CLASS, type SendState } from "./types";

interface ComposerActionButtonsProps {
  llmOptions: LLMOption[];
  activeLLMDefault: LLMSelection | null;
  llmSelection: LLMSelection | null;
  llmOptionsLoading: boolean;
  llmOptionsError: boolean;
  onSelectLLM: (selection: LLMSelection | null) => void;
  onRefreshLLMOptions?: () => void;
  effortModelOption: LLMOption | null;
  onSelectReasoningEffort: (effort: string | null) => void;
  contextBudget: ContextBudget | null;
  showVoiceControl: boolean;
  recorderState: "idle" | "recording" | "transcribing";
  recorderError: string | null;
  onToggleRecorder: () => void;
  isStreaming: boolean;
  queuing: boolean;
  hasIntent: boolean;
  onCancelStreaming: () => void;
  sendState: SendState;
  sendTitle: string;
  sendLabel: string;
  onSendButtonClick: () => void;
}

/**
 * Right-side toolbar actions: model & reasoning-effort pickers, context budget
 * chip, voice input toggle, queue stop button, and primary send/stop button.
 */
export function ComposerActionButtons({
  llmOptions,
  activeLLMDefault,
  llmSelection,
  llmOptionsLoading,
  llmOptionsError,
  onSelectLLM,
  onRefreshLLMOptions,
  effortModelOption,
  onSelectReasoningEffort,
  contextBudget,
  showVoiceControl,
  recorderState,
  recorderError,
  onToggleRecorder,
  isStreaming,
  queuing,
  hasIntent,
  onCancelStreaming,
  sendState,
  sendTitle,
  sendLabel,
  onSendButtonClick,
}: ComposerActionButtonsProps) {
  

  return (
    <div className={styles.actions}>
      <ModelSelector
        options={llmOptions}
        activeDefault={activeLLMDefault}
        value={llmSelection}
        loading={llmOptionsLoading}
        error={llmOptionsError}
        onChange={onSelectLLM}
        onRefresh={onRefreshLLMOptions}
      />

      {/* Per-conversation reasoning-effort override (#641). Hidden
          by the selector itself when the selected model exposes no
          selectable level. */}
      <ReasoningEffortSelector
        option={effortModelOption}
        value={llmSelection?.reasoning_effort ?? null}
        onChange={onSelectReasoningEffort}
        disabled={llmOptionsLoading}
      />

      {contextBudget ? <ContextBudgetChip budget={contextBudget} /> : null}

      {(showVoiceControl || recorderState !== "idle") && (
        <Tooltip
          label={
            recorderState === "recording"
              ? "Stop recording"
              : "Record voice"
          }
          description={recorderError || undefined}
          side="top"
        >
          <button
            type="button"
            onClick={onToggleRecorder}
            disabled={recorderState === "transcribing" || isStreaming}
            className={`group relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] transition-[background-color,color,transform] duration-150 active:scale-90 disabled:opacity-40 ${
              recorderState === "recording"
                ? "bg-red-500/15 text-red-500"
                : "text-[var(--muted-foreground)] hover:bg-[var(--muted)]/55 hover:text-[var(--foreground)]"
            }`}
            aria-label={
              recorderState === "recording"
                ? "Stop recording"
                : "Record voice"
            }
          >
            {recorderState === "recording" && (
              <span className="pointer-events-none absolute inset-0 rounded-[10px] border border-red-500/40 animate-pulse" />
            )}
            {recorderState === "transcribing" ? (
              <Loader2 size={16} strokeWidth={1.9} className="animate-spin" />
            ) : (
              <Mic size={16} strokeWidth={1.9} />
            )}
          </button>
        </Tooltip>
      )}

      {/* The thing you press is the thing that's working is the
          thing you press to stop — one element for the whole turn,
          so the button never swaps out from under the cursor at the
          moment of the click. The glyph crossfades arrow→square in
          place (both stacked in the same grid cell) and the progress
          ring moves to the perimeter, where it can spin without
          fighting the square for the same space. */}
      {queuing && hasIntent ? (
        <Tooltip label={"Stop generating"} side="top">
          <button
            type="button"
            onClick={onCancelStreaming}
            aria-label={"Stop generating"}
            className="relative ml-1 inline-grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--muted-foreground)] ring-1 ring-inset ring-[var(--border)] transition-colors hover:text-[var(--foreground)] active:scale-95"
          >
            <span className="pointer-events-none absolute -inset-[3px] rounded-full border-2 border-[color-mix(in_srgb,var(--primary)_15%,transparent)] border-t-[var(--primary)] animate-spin" />
            <Square size={10} strokeWidth={2.6} className="fill-current" />
          </button>
        </Tooltip>
      ) : null}
      <Tooltip label={sendTitle} side="top">
        <button
          type="button"
          onClick={onSendButtonClick}
          disabled={sendState === "idle"}
          className={`group relative ml-1 inline-grid h-8 w-8 shrink-0 place-items-center rounded-full transition-[background-color,box-shadow,transform] duration-200 active:scale-95 ${SEND_STATE_CLASS[sendState]}`}
          aria-label={sendLabel}
        >
          {sendState === "streaming" && (
            // Outside the fill, so "still working" reads at a glance
            // and dims on hover to hand the control back as "stop".
            <span className="pointer-events-none absolute -inset-[3px] rounded-full border-2 border-[color-mix(in_srgb,var(--primary)_15%,transparent)] border-t-[var(--primary)] animate-spin transition-opacity group-hover:opacity-30" />
          )}
          <ArrowUp
            size={16}
            strokeWidth={2.5}
            className={`col-start-1 row-start-1 transition-[opacity,transform] duration-200 ${
              sendState === "streaming"
                ? "scale-50 opacity-0"
                : "scale-100 opacity-100"
            }`}
          />
          <Square
            size={10}
            strokeWidth={2.6}
            className={`col-start-1 row-start-1 fill-current transition-[opacity,transform] duration-200 ${
              sendState === "streaming"
                ? "scale-100 opacity-100"
                : "scale-50 opacity-0"
            }`}
          />
        </button>
      </Tooltip>
    </div>
  );
}
