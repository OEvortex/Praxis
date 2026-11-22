"use client";

import Tooltip from "@/shared/ui/Tooltip";
import { PageContainer } from "@/components/layout/FeaturePage";
import { Loader2, Save, Undo2, Check } from "lucide-react";

import { useSettings } from "@/features/settings/store/SettingsStore";

/** A single, explicit save surface, visible only when there is work to do. */
export function SettingsToolbar() {
  
  const {
    draftState,
    saving,
    applying,
    saveDraft,
    applyCatalog,
    discardDraft,
    toast,
  } = useSettings();
  const busy = saving || applying;
  if (draftState === "clean")
    return toast ? (
      <div
        role="status"
        className="shrink-0 border-t border-[color-mix(in_srgb,var(--border)_50%,transparent)] px-5 py-3 text-center text-xs text-[var(--muted-foreground)]"
      >
        {toast}
      </div>
    ) : null;
  return (
    <div
      data-tour="tour-actions"
      className="shrink-0 border-t border-[var(--border)] bg-[var(--background)]"
    >
      <PageContainer spacing="toolbar" className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0" role="status">
          <p className="text-[13px] font-medium">
            {draftState === "saved"
              ? "Draft not applied yet"
              : "Unsaved changes"}
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">
            {toast || "Applies pending changes across all settings pages."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={discardDraft}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--accent)] disabled:opacity-40"
          >
            <Undo2 size={14} />
            {"Discard"}
          </button>
          <Tooltip label={"Store these changes without putting them into effect."} side="top">
            <button
              type="button"
              onClick={() => void saveDraft()}
              disabled={busy || draftState !== "unsaved"}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-2 text-xs disabled:opacity-40"
            >
              {saving ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              {"Save draft"}
            </button>
          </Tooltip>
          <button
            type="button"
            onClick={applyCatalog}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-2 text-xs font-medium text-[var(--background)] disabled:opacity-40"
          >
            {applying ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Check size={14} />
            )}
            {"Apply changes"}
          </button>
        </div>
      </PageContainer>
    </div>
  );
}
