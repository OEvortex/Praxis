"use client";

import Tooltip from "@/shared/ui/Tooltip";
import { useState } from "react";
import { useEmbeddingModels } from "@/hooks/useEmbeddingModels";
import type { EmbeddingModelSelection } from "@/features/knowledge/model/types";
import EmbeddingModelSelector from "./EmbeddingModelSelector";

import {
  Layers,
  Loader2,
  RefreshCw,
  Star,
} from "lucide-react";
import {
  formatKnowledgeTimestamp,
  kbCanReindex,
  kbHasLiveProgress,
  kbNeedsReindex,
  resolveKbStatus,
  type IndexVersion,
  type KnowledgeBase,
} from "@/lib/knowledge-helpers";
import type { TaskState } from "@/hooks/useKnowledgeProgress";
import Modal from "@/components/common/Modal";
import KbIndexFailureBanner from "./KbIndexFailureBanner";

interface KbIndexVersionsSectionProps {
  kb: KnowledgeBase;
  task?: TaskState;
  onReindex: (embeddingModel?: EmbeddingModelSelection) => Promise<void>;
}

export default function KbIndexVersionsSection({
  kb,
  task,
  onReindex,
}: KbIndexVersionsSectionProps) {
  const [submitting, setSubmitting] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const provider = kb.statistics?.rag_provider || "llamaindex";
  const needsEmbedding = provider === "llamaindex";
  const embeddingCatalog = useEmbeddingModels(
    kb.metadata?.embedding_selection,
    modelDialogOpen && needsEmbedding,
  );
  const versions = kb.statistics?.index_versions ?? [];
  const isEmptyEmbeddingKb =
    needsEmbedding &&
    kb.statistics?.raw_documents === 0 &&
    !versions.some((version) => version.ready);
  const activeSig = kb.statistics?.active_signature ?? null;
  const needsReindex = kbNeedsReindex(kb);
  const isError = resolveKbStatus(kb) === "error";
  const mismatch = Boolean(kb.metadata?.embedding_mismatch);
  const isReindexingHere =
    (task?.kind === "reindex" || task?.kind === "retry") && task.executing;
  const lastIndexed = formatKnowledgeTimestamp(kb.metadata?.last_indexed_at);
  const lastIndexedCount = kb.metadata?.last_indexed_count;

  const handleReindex = async () => {
    if (needsEmbedding) {
      setDialogError(null);
      setModelDialogOpen(true);
      return;
    }
    setSubmitting(true);
    try {
      await onReindex();
    } finally {
      setSubmitting(false);
    }
  };

  const handleModelSubmit = async () => {
    setSubmitting(true);
    setDialogError(null);
    try {
      await onReindex(embeddingCatalog.selection || undefined);
      setModelDialogOpen(false);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  const showReindexCta =
    kbCanReindex(kb) ||
    (needsEmbedding &&
      !kb.read_only &&
      !kbHasLiveProgress(kb) &&
      kb.statistics?.raw_documents === 0 &&
      !versions.some((version) => version.ready));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-[var(--muted-foreground)]" />
          <div>
            <div className="text-[12.5px] font-medium text-[var(--foreground)]">
              {"Index versions"}
              <span className="ml-2 rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-normal text-[var(--muted-foreground)]">
                {versions.length}
              </span>
            </div>
            <p className="text-[11px] text-[var(--muted-foreground)]">
              {"Each embedding configuration gets its own stored vector index."}
            </p>
          </div>
        </div>

        {showReindexCta && (
          <Tooltip label={
              isError
                ? "Retry indexing from the documents already stored in this knowledge base."
                : "Choose an embedding model to rebuild this knowledge base. Existing index versions are preserved."
            } side="top">
            <button
              type="button"
              onClick={() => void handleReindex()}
              disabled={submitting || isReindexingHere}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50 ${
                isError
                  ? "border-red-200 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300"
                  : "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300"
              }`}
            >
              {submitting || isReindexingHere ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {isReindexingHere
                ? isError
                  ? "Retrying…"
                  : "Re-indexing…"
                : isError
                  ? "Retry indexing"
                  : isEmptyEmbeddingKb
                    ? "Change model"
                    : "Re-index"}
            </button>
          </Tooltip>
        )}
      </div>

      {isError && <KbIndexFailureBanner kb={kb} />}
      {kb.metadata?.embedding_status === "missing" && (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 p-3 text-xs text-amber-700"
        >
          {"The bound embedding model was deleted. Your documents and indexes are preserved. Select another model to re-index this knowledge base."}
        </p>
      )}
      {kb.metadata?.embedding_status === "unconfigured" && (
        <p
          role="alert"
          className="rounded-lg border border-amber-300 p-3 text-xs text-amber-700"
        >
          {"The bound embedding model is not configured. Check its provider settings."}
        </p>
      )}

      {!isError && (needsReindex || mismatch) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/80 px-3 py-2 text-[12px] text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-300">
          {"The active embedding configuration doesn't match any ready index version. Re-index to rebuild against the current embedding model."}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--muted)]/30 px-3 py-2 text-[11.5px] text-[var(--muted-foreground)]">
        <span>
          {"Last indexed"}:{" "}
          <span className="font-medium text-[var(--foreground)]">
            {lastIndexed || "Not recorded yet"}
          </span>
        </span>
        {typeof lastIndexedCount === "number" && (
          <span>
            ·{" "}
            {lastIndexedCount === 1
              ? "1 indexed doc"
              : `${lastIndexedCount} indexed docs`}
          </span>
        )}
      </div>

      {versions.length > 0 ? (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--background)]">
          {versions.map((version) => (
            <IndexVersionRow
              key={
                version.version ??
                version.signature ??
                `${version.model}-${version.dimension}-${version.created_at}`
              }
              version={version}
              activeSignature={activeSig}
            />
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-[var(--border)] px-4 py-6 text-center text-[12px] text-[var(--muted-foreground)]">
          {"No index versions yet."}
        </div>
      )}

      <Modal
        isOpen={modelDialogOpen}
        onClose={() => !submitting && setModelDialogOpen(false)}
        title={"Rebuild index with current defaults"}
        width="sm"
        footer={
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setModelDialogOpen(false)}
              disabled={submitting}
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--foreground)] disabled:opacity-50"
            >
              {"Cancel"}
            </button>
            <button
              type="button"
              onClick={() => void handleModelSubmit()}
              disabled={
                submitting ||
                (needsEmbedding &&
                  (!embeddingCatalog.selection ||
                    embeddingCatalog.loading ||
                    !!embeddingCatalog.error))
              }
              className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-[12px] font-medium text-[var(--primary-foreground)] disabled:opacity-50"
            >
              {submitting && <Loader2 className="h-3 w-3 animate-spin" />}
              {isEmptyEmbeddingKb ? "Save model" : "Start full re-index"}
            </button>
          </div>
        }
      >
        <div className="space-y-3 p-4">
          {needsEmbedding && (
            <EmbeddingModelSelector
              catalog={embeddingCatalog}
              disabled={submitting}
            />
          )}
          <p className="text-[12px] text-[var(--muted-foreground)]">
            {"This rebuild uses the selected embedding. The configuration is fixed when you confirm; the previous version is preserved if rebuilding fails."}
          </p>
          {dialogError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
              {dialogError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function IndexVersionRow({
  version,
  activeSignature,
}: {
  version: IndexVersion;
  activeSignature: string | null;
}) {
  const matchesActive =
    !!version.signature && version.signature === activeSignature;
  const isActive = matchesActive && version.ready === true;
  const isPhantom = matchesActive && version.ready !== true;
  const isLegacy = !!version.legacy;

  const title = version.version || (isLegacy ? "Legacy index" : "Unknown");
  const created = formatKnowledgeTimestamp(version.created_at);
  const statusHint = isActive
    ? "Active version"
    : isPhantom
      ? "Stale (matches active config but storage is empty)"
      : isLegacy
        ? "Legacy index format"
        : "Inactive version";

  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <Tooltip label={statusHint} side="top">
        <div
          role="img"
          aria-label={statusHint}
          tabIndex={0}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
            isActive
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-950/30 dark:text-emerald-300"
              : isPhantom
                ? "bg-amber-100 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300"
                : "bg-[var(--muted)] text-[var(--muted-foreground)]"
          }`}
        >
          {isActive ? (
            <Star className="h-3.5 w-3.5" fill="currentColor" />
          ) : (
            <Layers className="h-3.5 w-3.5" />
          )}
        </div>
      </Tooltip>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={`truncate text-[12.5px] font-medium ${
              isPhantom
                ? "text-amber-700 line-through decoration-amber-400/70 dark:text-amber-300"
                : "text-[var(--foreground)]"
            }`}
          >
            {title}
          </span>
          {isActive && (
            <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
              {"Active"}
            </span>
          )}
          {isPhantom && (
            <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
              {"Stale"}
            </span>
          )}
          {isLegacy && !isActive && (
            <span className="rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)]">
              {"Legacy"}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--muted-foreground)]">
          {typeof version.dimension === "number" && (
            <span>
              {version.dimension}
              {"d"}
            </span>
          )}
          {version.binding && <span>{version.binding}</span>}
          {created && <span>{created}</span>}
          {version.signature && (
            <span className="font-mono">{version.signature.slice(0, 10)}</span>
          )}
          {version.failure_summary && (
            <span className="text-red-600 dark:text-red-300">
              {version.failure_summary}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}
