"use client";

import { useState } from "react";

import {
  CheckCircle2,
  ChevronDown,
  CircleSlash,
  Loader2,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import {
  getEnginePreflight,
  type EnginePreflight,
} from "@/features/knowledge/api/engines";
import { ENGINE_PREREQUISITES } from "./engine-constants";
import { CopyableCommand } from "./EngineFormPrimitives";

function CheckRow({
  ok,
  optional,
  label,
  detail,
}: {
  ok: boolean;
  optional: boolean;
  label: string;
  detail: string;
}) {
  
  const Icon = ok ? CheckCircle2 : optional ? CircleSlash : XCircle;
  const tone = ok
    ? "text-emerald-600 dark:text-emerald-400"
    : optional
      ? "text-[var(--muted-foreground)]"
      : "text-red-600 dark:text-red-400";
  return (
    <li className="flex items-start gap-2">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <span className="text-[12px] text-[var(--foreground)]">{(label)}</span>
        {optional && (
          <span className="ml-1.5 text-[10px] text-[var(--muted-foreground)]">
            ({"optional"})
          </span>
        )}
        {detail && (
          <div className="text-[11px] leading-snug text-[var(--muted-foreground)]">
            {(detail)}
          </div>
        )}
      </div>
    </li>
  );
}

export function EnvRequirements({
  providerId,
  installHint,
  defaultOpen,
  onError,
}: {
  providerId: string;
  installHint?: string;
  defaultOpen: boolean;
  onError: (message: string) => void;
}) {
  
  const [open, setOpen] = useState(defaultOpen);
  const [report, setReport] = useState<EnginePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const prereq = ENGINE_PREREQUISITES[providerId];

  const runCheck = async () => {
    setChecking(true);
    try {
      setReport(await getEnginePreflight(providerId));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="mt-7">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg py-1 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          <ShieldCheck className="h-3.5 w-3.5" />
          {"Requirements & environment"}
        </span>
        <ChevronDown
          className={`h-4 w-4 text-[var(--muted-foreground)] transition-transform ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>
      {open && (
        <div className="mt-3 space-y-3 rounded-2xl border border-[var(--border)] p-4">
          {prereq && (
            <p className="text-[12px] leading-relaxed text-[var(--muted-foreground)]">
              {(prereq)}
            </p>
          )}
          {installHint && <CopyableCommand command={installHint} />}
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void runCheck()}
              disabled={checking}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)] disabled:opacity-50"
            >
              {checking ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {"Check environment"}
            </button>
            {report && (
              <span
                className={`inline-flex items-center gap-1 text-[11.5px] font-medium ${
                  report.ok
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-amber-600 dark:text-amber-400"
                }`}
              >
                {report.ok ? "Ready to use" : "Not ready"}
              </span>
            )}
          </div>
          {report && (
            <ul className="space-y-1.5 border-t border-[var(--border)] pt-3">
              {report.checks.map((c) => (
                <CheckRow
                  key={c.key}
                  ok={c.ok}
                  optional={c.optional}
                  label={c.label}
                  detail={c.detail}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
