"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Boxes, ExternalLink, Loader2 } from "lucide-react";
import Link from "@/shared/router/link";
import {
  getEngineModelOptions,
  setEngineActiveModel,
} from "@/features/knowledge/api/engines";
import type { ModelOptionsByKind } from "@/features/knowledge/api/types";
import { ENGINE_MODEL_KINDS, MODEL_KIND_LABEL } from "./engine-constants";
import { FormSkeleton, Section } from "./EngineFormPrimitives";

export function ModelsSection({
  providerId,
  onError,
}: {
  providerId: string;
  onError: (message: string) => void;
}) {
  const kinds = useMemo(
    () => ENGINE_MODEL_KINDS[providerId] ?? [],
    [providerId],
  );
  const [data, setData] = useState<ModelOptionsByKind | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyKind, setBusyKind] = useState<string | null>(null);

  useEffect(() => {
    if (kinds.length === 0) return;
    let cancelled = false;
    setData(null);
    setFailed(false);
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
            const hasOptions = (entry?.options.length ?? 0) > 0;
            return (
              <div key={kind} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-medium text-[var(--foreground)]">
                    {MODEL_KIND_LABEL[kind] ?? kind}
                  </span>
                  {busyKind === kind && (
                    <Loader2 className="h-3 w-3 animate-spin text-[var(--muted-foreground)]" />
                  )}
                </div>
                {hasOptions ? (
                  <select
                    value={activeKey}
                    disabled={busyKind === kind}
                    onChange={(e) => {
                      const [pid, mid] = e.target.value.split("::");
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
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
