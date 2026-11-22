"use client";

import { useMemo } from "react";

import {
  ArrowLeft,
  Database,
  KeyRound,
  Server,
  Settings2,
  Workflow,
} from "lucide-react";
import type { RagProviderSummary } from "@/features/knowledge/api/types";
import {
  kbDocCount,
  kbProvider,
  providerConnectionStatus,
  resolveKbStatus,
  type KnowledgeBase,
} from "@/lib/knowledge-helpers";
import { PageIndexConfigForm } from "@/components/knowledge/PageIndexSettingsModal";
import KnowledgeEngineIcon from "@/components/knowledge/KnowledgeEngineIcon";
import { INSTALL_HINTS } from "./engine-constants";
import { ModeSelector, Section, StatusBadge } from "./EngineFormPrimitives";
import { LlamaIndexForm } from "./LlamaIndexForm";
import { ImaForm } from "./ImaForm";
import {
  GraphRagForm,
  LightRagForm,
  LightRagModelsForm,
  LightRagServerForm,
} from "./GraphRagAndLightRagForms";
import { ModelsSection } from "./EngineModelsSection";
import { EnvRequirements } from "./EngineEnvRequirements";

export {
  LlamaIndexForm,
  ImaForm,
  GraphRagForm,
  LightRagForm,
  LightRagModelsForm,
};

export interface EngineDetailProps {
  provider: RagProviderSummary;
  kbs: KnowledgeBase[];
  onBack: () => void;
  onOpenKb: (name: string) => void;
  onSelectMode: (providerId: string, mode: string) => Promise<void> | void;
  /** Called after a config change so the parent can refresh provider state. */
  onChanged: () => void;
  onError: (message: string) => void;
}

export default function EngineDetail({
  provider,
  kbs,
  onBack,
  onOpenKb,
  onSelectMode,
  onChanged,
  onError,
}: EngineDetailProps) {
  
  const status = providerConnectionStatus(provider);
  const installHint = INSTALL_HINTS[provider.id];
  const hasModes = (provider.modes?.length ?? 0) > 0;

  const engineKbs = useMemo(
    () => kbs.filter((kb) => kbProvider(kb) === provider.id),
    [kbs, provider.id],
  );

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--background)]">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <button
          type="button"
          onClick={onBack}
          className="mb-3 inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)]"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {"Knowledge Center"}
        </button>

        {/* Header */}
        <div className="flex items-start gap-3">
          <KnowledgeEngineIcon
            engine={provider.id}
            size={38}
            className="mt-0.5"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-serif text-[20px] font-semibold tracking-tight text-[var(--foreground)]">
                {provider.name}
              </h1>
              <StatusBadge status={status} />
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--muted-foreground)]">
              {provider.description}
            </p>
          </div>
        </div>

        {/* Requirements & environment — collapsible, unified across engines.
            Auto-opens when the engine isn't ready so the gap is obvious. */}
        <EnvRequirements
          providerId={provider.id}
          installHint={installHint}
          defaultOpen={status !== "ready"}
          onError={onError}
        />

        {provider.id === "lightrag-server" && (
          <Section label={"Connection defaults"} icon={Server}>
            <LightRagServerForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* Retrieval modes (graphrag / lightrag) */}
        {hasModes && (
          <Section label={"Retrieval mode"} icon={Workflow}>
            <p className="-mt-1 mb-3 text-[11.5px] leading-snug text-[var(--muted-foreground)]">
              {"The default for new searches. A knowledge base can still override it per-KB."}
            </p>
            <ModeSelector provider={provider} onSelectMode={onSelectMode} />
          </Section>
        )}

        {/* LlamaIndex tuning */}
        {provider.id === "llamaindex" && (
          <Section label={"Retrieval & chunking"} icon={Settings2}>
            <LlamaIndexForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* GraphRAG query knobs */}
        {provider.id === "graphrag" && (
          <Section label={"Retrieval parameters"} icon={Settings2}>
            <GraphRagForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* LightRAG query knobs */}
        {provider.id === "lightrag" && (
          <Section label={"Retrieval parameters"} icon={Settings2}>
            <LightRagForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* PageIndex credentials */}
        {provider.id === "pageindex" && (
          <Section label={"Credentials"} icon={KeyRound}>
            <PageIndexConfigForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* Tencent IMA credentials */}
        {provider.id === "ima" && (
          <Section label={"Credentials"} icon={KeyRound}>
            <ImaForm onChanged={onChanged} onError={onError} />
          </Section>
        )}

        {/* Models — in-place pickers for the kinds this engine needs */}
        <ModelsSection
          providerId={provider.id}
          onChanged={onChanged}
          onError={onError}
        />

        {/* Knowledge bases on this engine */}
        <Section
          label={`${"Knowledge bases"} · ${engineKbs.length}`}
          icon={Database}
        >
          {engineKbs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--border)] px-4 py-8 text-center text-[12px] text-[var(--muted-foreground)]">
              {"No knowledge bases use this engine yet."}
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-[var(--border)]">
              {engineKbs.map((kb, i) => {
                const docs = kbDocCount(kb);
                const ready = resolveKbStatus(kb) === "ready";
                return (
                  <button
                    key={kb.name}
                    type="button"
                    onClick={() => onOpenKb(kb.name)}
                    className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--muted)]/40 ${
                      i > 0 ? "border-t border-[var(--border)]" : ""
                    }`}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <KnowledgeEngineIcon engine={provider.id} size={24} />
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
                          ready
                            ? "bg-emerald-500"
                            : "bg-[var(--muted-foreground)]"
                        }`}
                      />
                      <span className="truncate text-[13px] font-medium text-[var(--foreground)]">
                        {kb.name}
                      </span>
                    </div>
                    {docs !== null && (
                      <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                        {docs} {"docs"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  );
}
