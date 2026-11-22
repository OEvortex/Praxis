"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  Boxes,
  Check,
  CheckCircle2,
  CircleSlash,
  ExternalLink,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import Link from "@/shared/router/link";
import {
  getEngineModelOptions,
  setEngineActiveModel,
  testGraphRagModelCompatibility,
} from "@/features/knowledge/api/engines";
import type {
  GraphRagModelCompatibility,
  ModelOptionsByKind,
} from "@/features/knowledge/api/types";
import { canApplyGraphRagModelCandidate } from "@/lib/graphrag-model-compatibility";
import { ENGINE_MODEL_KINDS, MODEL_KIND_LABEL } from "./engine-constants";
import { FormSkeleton, Section } from "./EngineFormPrimitives";
import { LightRagModelsForm } from "./GraphRagAndLightRagForms";

export function ModelsSection({
  providerId,
  onChanged,
  onError,
}: {
  providerId: string;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const kinds = useMemo(
    () => ENGINE_MODEL_KINDS[providerId] ?? [],
    [providerId],
  );
  const [data, setData] = useState<ModelOptionsByKind | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyKind, setBusyKind] = useState<string | null>(null);
  const [testingKind, setTestingKind] = useState<string | null>(null);
  const [draftSelections, setDraftSelections] = useState<
    Record<string, string>
  >({});
  const [compatibility, setCompatibility] = useState<{
    testedKey: string;
    result: GraphRagModelCompatibility;
  } | null>(null);

  useEffect(() => {
    if (kinds.length === 0) return;
    let cancelled = false;
    setData(null);
    setFailed(false);
    setDraftSelections({});
    setCompatibility(null);
    getEngineModelOptions(kinds)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [kinds]);

  const select = useCallback(
    async (kind: string, profileId: string, modelId: string) => {
      setBusyKind(kind);
      try {
        const updated = await setEngineActiveModel(kind, profileId, modelId);
        setData((prev) => (prev ? { ...prev, [kind]: updated } : prev));
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKind(null);
      }
    },
    [onError],
  );

  const testCandidate = useCallback(
    async (kind: string, candidateKey: string) => {
      const [profileId, modelId] = candidateKey.split("::");
      setTestingKind(kind);
      try {
        const result = await testGraphRagModelCompatibility(profileId, modelId);
        setCompatibility({ testedKey: candidateKey, result });
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      } finally {
        setTestingKind(null);
      }
    },
    [onError],
  );

  if (kinds.length === 0) return null;

  return (
    <Section label={"Models"} icon={Boxes}>
      {failed ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--border)] p-4">
          <p className="text-[12px] leading-relaxed text-[var(--muted-foreground)]">
            {"This engine uses your active chat and embedding models. Manage them in the model catalog."}
          </p>
          <Link
            href="/settings"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)]"
          >
            {"Open catalog"}
            <ExternalLink className="h-3 w-3" />
          </Link>
        </div>
      ) : !data ? (
        <FormSkeleton />
      ) : (
        <div className="space-y-4 rounded-2xl border border-[var(--border)] p-4">
          {kinds.map((kind) => {
            const entry = data[kind];
            const activeKey = `${entry?.active.profile_id ?? ""}::${entry?.active.model_id ?? ""}`;
            const value = draftSelections[kind] ?? activeKey;
            const hasOptions = (entry?.options.length ?? 0) > 0;
            const isGraphRagChat = providerId === "graphrag" && kind === "llm";
            const visibleCompatibility =
              isGraphRagChat && compatibility?.testedKey === value
                ? compatibility.result
                : null;
            const canApply = canApplyGraphRagModelCandidate({
              activeKey,
              candidateKey: value,
              testedKey: compatibility?.testedKey ?? null,
              result: compatibility?.result ?? null,
            });
            return (
              <div key={kind} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[var(--foreground)]">
                    {(MODEL_KIND_LABEL[kind] ?? kind)}
                  </span>
                  {busyKind === kind && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--muted-foreground)]" />
                  )}
                </div>
                {hasOptions ? (
                  <select
                    value={value}
                    disabled={busyKind === kind || testingKind === kind}
                    onChange={(e) => {
                      const candidateKey = e.target.value;
                      if (isGraphRagChat) {
                        setDraftSelections((prev) => ({
                          ...prev,
                          [kind]: candidateKey,
                        }));
                        setCompatibility(null);
                        return;
                      }
                      const [pid, mid] = candidateKey.split("::");
                      void select(kind, pid, mid);
                    }}
                    className="w-full cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
                  >
                    {entry!.options.map((o) => (
                      <option
                        key={`${o.profile_id}::${o.model_id}`}
                        value={`${o.profile_id}::${o.model_id}`}
                      >
                        {o.label}
                        {o.detail ? ` · ${o.detail}` : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Link
                    href="/settings"
                    className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
                  >
                    {"No models configured — open catalog"}
                    <ExternalLink className="h-3 w-3" />
                  </Link>
                )}
                {hasOptions && isGraphRagChat && (
                  <div className="mt-1.5 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void testCandidate(kind, value)}
                        disabled={testingKind === kind || busyKind === kind}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)] disabled:opacity-50"
                      >
                        {testingKind === kind ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <ShieldCheck className="h-3.5 w-3.5" />
                        )}
                        {(testingKind === kind ? "Testing compatibility…" : "Test compatibility")}
                      </button>
                      {canApply && (
                        <button
                          type="button"
                          onClick={() => {
                            const [pid, mid] = value.split("::");
                            void select(kind, pid, mid);
                          }}
                          disabled={busyKind === kind}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--foreground)] px-3 py-1.5 text-[12px] font-medium text-[var(--background)] transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {busyKind === kind ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Check className="h-3.5 w-3.5" />
                          )}
                          {"Use this model"}
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                      {"Runs one small structured-output request and may incur provider charges. The global active chat model changes only after you choose Use this model."}
                    </p>
                    {visibleCompatibility && (
                      <div
                        className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
                          visibleCompatibility.status === "compatible"
                            ? "border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300"
                            : visibleCompatibility.status === "incompatible"
                              ? "border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-300"
                              : "border-amber-500/25 bg-amber-500/5 text-amber-700 dark:text-amber-300"
                        }`}
                      >
                        {visibleCompatibility.status === "compatible" ? (
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : visibleCompatibility.status === "incompatible" ? (
                          <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        )}
                        <div>
                          <p className="font-medium">
                            {(visibleCompatibility.status === "compatible" ? "Compatible with GraphRAG" : visibleCompatibility.status === "incompatible" ? "Incompatible with GraphRAG" : "Compatibility could not be verified")}
                          </p>
                          <p className="mt-0.5 opacity-90">
                            {(visibleCompatibility.message)}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {kind === "llm" && providerId === "lightrag" && (
                  <span className="text-[11px] text-[var(--muted-foreground)]">
                    {"Multimodal documents need a vision-capable chat model."}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {providerId === "lightrag" && (
        <div className="mt-4">
          <LightRagModelsForm onChanged={onChanged} onError={onError} />
        </div>
      )}
    </Section>
  );
}
