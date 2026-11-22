"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";


import { apiFetch, apiUrl } from "@/shared/api/client";
import { EXTENSION_ENDPOINTS } from "@/lib/settings-extensions";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  ToggleRow,
} from "@/components/settings/shared";
import { useSettings } from "@/features/settings/store/SettingsStore";

interface MemorySettingsDTO {
  update: { l2_budget: number; l3_budget: number };
  audit: { l2_budget: number; l3_budget: number };
  dedup: { iterations: number; auto_after_update: boolean };
  merge: {
    auto_after_update: boolean;
    auto_after_audit: boolean;
    auto_after_dedup: boolean;
  };
  chunking: {
    overlap_ratio: number;
    boundary: "paragraph" | "sentence";
    min_chunk_chars: number;
    max_chunk_chars: number;
  };
  reference: {
    enforce_required: boolean;
    drop_invalid_refs: boolean;
  };
}

export default function MemorySettingsPage() {
  
  const { registerExtension, pendingExtensionPayload, draftRevision } =
    useSettings();
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<MemorySettingsDTO | null>(null);
  const [serverSnapshot, setServerSnapshot] =
    useState<MemorySettingsDTO | null>(null);

  useEffect(() => {
    let cancelled = false;
    void apiFetch(apiUrl(EXTENSION_ENDPOINTS.memory))
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<MemorySettingsDTO>;
      })
      .then((data) => {
        if (cancelled) return;
        // A pending edit outlives the page it was made on; the server value is
        // the baseline dirtiness is measured against either way.
        const pending = pendingExtensionPayload("memory") as
          MemorySettingsDTO | undefined;
        setSettings(pending ?? data);
        setServerSnapshot(data);
        setError(null);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [draftRevision, pendingExtensionPayload]);

  const dirty =
    !!settings &&
    !!serverSnapshot &&
    JSON.stringify(settings) !== JSON.stringify(serverSnapshot);

  // Latest-save ref so the closure handed to registerExtension always
  // reflects the current settings without re-registering on each render.
  const settingsRef = useRef<MemorySettingsDTO | null>(null);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const save = useCallback(async () => {
    const current = settingsRef.current;
    if (!current) return;
    const res = await apiFetch(apiUrl(EXTENSION_ENDPOINTS.memory), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as MemorySettingsDTO;
    setSettings(data);
    setServerSnapshot(data);
  }, []);

  useEffect(() => {
    registerExtension("memory", { dirty, save, payload: settings });
    return () => registerExtension("memory", null);
  }, [dirty, save, settings, registerExtension]);

  function patch<K extends keyof MemorySettingsDTO>(
    key: K,
    value: Partial<MemorySettingsDTO[K]>,
  ) {
    if (!settings) return;
    setSettings({ ...settings, [key]: { ...settings[key], ...value } });
  }

  if (error)
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {"Failed to load settings."} {error}
      </p>
    );

  if (!settings) {
    return (
      <div className="grid h-[60vh] place-items-center text-[13px] text-[var(--muted-foreground)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div data-tour="tour-memory">
      <SettingsPageHeader
        title={"Memory"}
        description={"Tune the chunk-based consolidator: how many LLM rounds per Update / Audit / Dedup, how aggressively to chunk, and how strictly to validate references."}
      />
      <SettingSection
        title={"Update mode"}
        description={"Default LLM rounds for chunk-based incremental fact extraction. Per-doc overrides live in the workbench."}
      >
        <NumberRow
          label={"L2 budget (per surface)"}
          help={"Maximum chunks the chunker emits for an L2 update."}
          value={settings.update.l2_budget}
          onChange={(n) => patch("update", { l2_budget: n })}
          min={1}
          max={200}
        />
        <NumberRow
          label={"L3 budget (per slot)"}
          help={"Maximum chunks for an L3 update across the 7 L2 docs."}
          value={settings.update.l3_budget}
          onChange={(n) => patch("update", { l3_budget: n })}
          min={1}
          max={200}
        />
      </SettingSection>

      <SettingSection
        title={"Audit mode"}
        description={"Default LLM rounds for line-level edits against raw evidence."}
      >
        <NumberRow
          label={"L2 budget (per surface)"}
          value={settings.audit.l2_budget}
          onChange={(n) => patch("audit", { l2_budget: n })}
          min={1}
          max={200}
        />
        <NumberRow
          label={"L3 budget (per slot)"}
          value={settings.audit.l3_budget}
          onChange={(n) => patch("audit", { l3_budget: n })}
          min={1}
          max={200}
        />
      </SettingSection>

      <SettingSection
        title={"Dedup"}
        description={"Iterative dedup over the full doc. Stops early when an iteration emits zero edits."}
      >
        <NumberRow
          label={"Iterations"}
          value={settings.dedup.iterations}
          onChange={(n) => patch("dedup", { iterations: n })}
          min={1}
          max={20}
        />
        <ToggleRow
          label={"Run dedup automatically after Update"}
          value={settings.dedup.auto_after_update}
          onChange={(v) => patch("dedup", { auto_after_update: v })}
        />
      </SettingSection>

      <SettingSection
        title={"Merge footnotes"}
        description={"No-LLM consolidation: collapse duplicate ref rows into one footnote each, then renumber. Idempotent, safe to run any time."}
      >
        <ToggleRow
          label={"Merge automatically after Update"}
          value={settings.merge.auto_after_update}
          onChange={(v) => patch("merge", { auto_after_update: v })}
        />
        <ToggleRow
          label={"Merge automatically after Audit"}
          value={settings.merge.auto_after_audit}
          onChange={(v) => patch("merge", { auto_after_audit: v })}
        />
        <ToggleRow
          label={"Merge automatically after Dedup"}
          value={settings.merge.auto_after_dedup}
          onChange={(v) => patch("merge", { auto_after_dedup: v })}
        />
      </SettingSection>

      <SettingSection
        title={"Chunking"}
        description={"Lower-level knobs that shape how content is split."}
      >
        <NumberRow
          label={"Overlap ratio"}
          help={"Fraction of chunk size carried into the next chunk. 0–0.5."}
          value={settings.chunking.overlap_ratio}
          onChange={(n) => patch("chunking", { overlap_ratio: n })}
          min={0}
          max={0.5}
          step={0.05}
          isFloat
        />
        <SelectRow
          label={"Boundary"}
          help={"Where the chunker prefers to cut."}
          value={settings.chunking.boundary}
          options={[
            { value: "paragraph", label: "Paragraph" },
            { value: "sentence", label: "Sentence" },
          ]}
          onChange={(v) =>
            patch("chunking", { boundary: v as "paragraph" | "sentence" })
          }
        />
        <NumberRow
          label={"Min chunk chars"}
          help={"Floor for individual chunk size."}
          value={settings.chunking.min_chunk_chars}
          onChange={(n) => patch("chunking", { min_chunk_chars: n })}
          min={200}
          max={64000}
          step={100}
        />
        <NumberRow
          label={"Max chunk chars"}
          help={"Ceiling for individual chunk size."}
          value={settings.chunking.max_chunk_chars}
          onChange={(n) => patch("chunking", { max_chunk_chars: n })}
          min={200}
          max={64000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={"References"}
        description={"How strictly facts must cite the chunk they were extracted from."}
      >
        <ToggleRow
          label={"Require ref on every fact"}
          help={"Drops facts that come back without a ref."}
          value={settings.reference.enforce_required}
          onChange={(v) => patch("reference", { enforce_required: v })}
        />
        <ToggleRow
          label={"Drop invalid refs (vs reject the whole fact)"}
          help={"On: keep the fact, drop only out-of-pool refs. Off: any bad ref rejects the fact."}
          value={settings.reference.drop_invalid_refs}
          onChange={(v) => patch("reference", { drop_invalid_refs: v })}
        />
      </SettingSection>
    </div>
  );
}

// ── Field components ────────────────────────────────────────────────

interface NumberRowProps {
  label: string;
  help?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  isFloat?: boolean;
}

function NumberRow({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step = 1,
  isFloat = false,
}: NumberRowProps) {
  return (
    <SettingRow
      title={label}
      description={help}
      control={
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = isFloat ? parseFloat(raw) : parseInt(raw, 10);
            if (!Number.isNaN(n)) onChange(n);
          }}
          className="w-24 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-right text-[12px] outline-none focus:border-[var(--primary)]"
        />
      }
    />
  );
}

interface SelectRowProps {
  label: string;
  help?: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}

function SelectRow({ label, help, value, options, onChange }: SelectRowProps) {
  return (
    <SettingRow
      title={label}
      description={help}
      control={
        <div className="flex gap-0.5 rounded-lg bg-[var(--muted)] p-0.5">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onChange(o.value)}
              className={
                "rounded-md px-2.5 py-1 text-[12px] transition-all " +
                (value === o.value
                  ? "bg-[var(--card)] font-medium text-[var(--foreground)] shadow-sm"
                  : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]")
              }
            >
              {o.label}
            </button>
          ))}
        </div>
      }
    />
  );
}
