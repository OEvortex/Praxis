import { useCallback, useEffect, useMemo } from "react";
import type { LLMSelection } from "@/features/chat/model/protocol";
import { sameLLMSelection, type LLMOption } from "@/lib/llm-options";
import { effectiveReasoningEffort } from "@/lib/reasoning-effort";

interface UseModelSelectionParams {
  llmOptions: LLMOption[];
  activeLLMDefault: LLMSelection | null;
  llmSelection: LLMSelection | null;
  onSelectLLM: (selection: LLMSelection | null) => void;
}

/**
 * Derives the active model option and handles model / reasoning-effort changes,
 * clearing stale reasoning-effort overrides unsupported by the current model.
 */
export function useModelSelection({
  llmOptions,
  activeLLMDefault,
  llmSelection,
  onSelectLLM,
}: UseModelSelectionParams) {
  // The model backing the effort selector: the conversation's selection,
  // falling back to the account default exactly like ModelSelector renders.
  const effortModelOption = useMemo(
    () =>
      llmOptions.find((option) =>
        sameLLMSelection(option, llmSelection ?? activeLLMDefault),
      ) ?? null,
    [llmOptions, llmSelection, activeLLMDefault],
  );

  // Switching models drops any reasoning-effort override: the new model may
  // not support the stored level, and #641's contract is that only values
  // the selected model supports are sent.
  const handleSelectLLM = useCallback(
    (selection: LLMSelection | null) => {
      onSelectLLM(
        selection
          ? { profile_id: selection.profile_id, model_id: selection.model_id }
          : null,
      );
    },
    [onSelectLLM],
  );

  const handleSelectReasoningEffort = useCallback(
    (effort: string | null) => {
      const base = llmSelection ?? activeLLMDefault;
      if (!base) return;
      onSelectLLM(
        effort
          ? {
              profile_id: base.profile_id,
              model_id: base.model_id,
              reasoning_effort: effort,
            }
          : { profile_id: base.profile_id, model_id: base.model_id },
      );
    },
    [llmSelection, activeLLMDefault, onSelectLLM],
  );

  // A persisted override the selected model no longer supports (#641 —
  // e.g. a saved `xhigh` after the catalog restricts the model to
  // low/high) is dropped from the conversation's selection once the model
  // options are loaded, reusing the selector's own onChange persist path.
  // While the option is still unresolved (loading, or the catalog no
  // longer lists the profile) nothing is cleared, so a legit value
  // survives startup; the send path instead omits an override it cannot
  // validate.
  useEffect(() => {
    const override = llmSelection?.reasoning_effort;
    if (!override || !effortModelOption) return;
    if (effectiveReasoningEffort(effortModelOption, override)) return;
    handleSelectReasoningEffort(null);
  }, [llmSelection, effortModelOption, handleSelectReasoningEffort]);

  return {
    effortModelOption,
    handleSelectLLM,
    handleSelectReasoningEffort,
  };
}
