"use client";

import Tooltip from "@/shared/ui/Tooltip";
import type { EmbeddingModelSelection } from "@/features/knowledge/model/types";

import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  AlertTriangle,
  Check,
  ChevronRight,
  FolderSearch,
  Link2,
  Loader2,
  Plus,
} from "lucide-react";
import { useEmbeddingModels } from "@/hooks/useEmbeddingModels";
import EmbeddingModelSelector from "./EmbeddingModelSelector";
import Modal from "@/components/common/Modal";
import { useImaConnection } from "@/hooks/useImaConnection";
import { getLlamaIndexConfig } from "@/features/knowledge/api/engines";
import {
  probeLinkedFolder,
  type KnowledgeUploadPolicy,
  type LinkedFolderProbe,
  type RagProviderSummary,
} from "@/features/knowledge/api/catalog";
import {
  createProviders,
  IMA_PROVIDER,
  linkSourceEnabled,
} from "@/lib/ima-connection";
import { validateFiles } from "@/lib/knowledge-helpers";
import { forbiddenKbNameChars, isValidKbName } from "@/lib/kb-name";
import { activeWorkspaceId } from "@/lib/workspace-scope";
import FileDropZone from "./FileDropZone";
import ImaConnectionFields from "./ImaConnectionFields";
import KnowledgeEngineIcon from "./KnowledgeEngineIcon";

const OBSIDIAN_SOURCE = "obsidian";
const MARGINNOTE4_SOURCE = "marginnote4";
const EXAMPLE_INDEX_PATH = "/Users/you/knowledge_bases/my-kb";
const EXAMPLE_VAULT_PATH = "/Users/you/Documents/MyVault";

type Mode = "new" | "link";

interface CreateKbModalProps {
  isOpen: boolean;
  onClose: () => void;
  providers: RagProviderSummary[];
  uploadPolicy: KnowledgeUploadPolicy;
  onCreate: (params: {
    name: string;
    provider: string;
    files: File[];
    storageWorkspaceId?: string;
    searchMode?: string;
    embeddingModel?: EmbeddingModelSelection;
  }) => Promise<void>;
  /** Link a pre-built engine index folder in place (no copy, no re-index). */
  onConnectLinkedFolder: (params: {
    name: string;
    folderPath: string;
    provider: string;
  }) => Promise<void>;
  /** Connect a live Obsidian vault (no index). */
  onConnectObsidian: (params: {
    name: string;
    vaultPath: string;
  }) => Promise<void>;
  /** Connect a MarginNote 4 library (its Add-on pushes objects in; no index). */
  onConnectMarginNote4: (params: { name: string }) => Promise<void>;
  /** Connect a Tencent IMA knowledge base (retrieval only, no local index). */
  onConnectIma: (params: {
    name: string;
    clientId: string;
    apiKey: string;
    knowledgeBaseId: string;
  }) => Promise<void>;
  /** Open the RAG pipeline settings (to add a missing API key). */
  onConfigureProvider?: (providerId: string) => void;
  /** Open straight into a given mode (e.g. "link" from the Obsidian card). */
  initialMode?: Mode;
  /** Pre-select a link source (engine id or "obsidian") when opening in link mode. */
  initialSource?: string;
}

export default function CreateKbModal({
  isOpen,
  onClose,
  providers,
  uploadPolicy,
  onCreate,
  onConnectLinkedFolder,
  onConnectObsidian,
  onConnectMarginNote4,
  onConnectIma,
  onConfigureProvider,
  initialMode = "new",
  initialSource,
}: CreateKbModalProps) {
  const [mode, setMode] = useState<Mode>("new");
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("llamaindex");
  const [files, setFiles] = useState<File[]>([]);
  // Link mode: the source is either an engine id or the Obsidian sentinel.
  const [linkSource, setLinkSource] = useState(OBSIDIAN_SOURCE);
  const [folderPath, setFolderPath] = useState("");
  const [probe, setProbe] = useState<LinkedFolderProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [retrievalMode, setRetrievalMode] = useState("");
  const [engineDefaultSummary, setEngineDefaultSummary] = useState<string[]>(
    [],
  );
  const [submitting, setSubmitting] = useState(false);
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const linkIsObsidian = linkSource === OBSIDIAN_SOURCE;
  const linkIsMarginNote = linkSource === MARGINNOTE4_SOURCE;
  const linkIsIma = linkSource === IMA_PROVIDER;
  const imaConnection = useImaConnection({
    name,
    onNameChange: setName,
    onError: setError,
    active: linkIsIma,
  });

  useEffect(() => {
    if (!isOpen) return;
    const refresh = () => setDefaultsRevision((value) => value + 1);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isOpen]);

  const firstLinkable = providers.find((p) => p.linkable)?.id;

  const handleClose = () => {
    imaConnection.reset();
    onClose();
  };

  const handleModeChange = (nextMode: Mode) => {
    if (nextMode !== "link") imaConnection.reset();
    setMode(nextMode);
  };

  const handleLinkSourceChange = (source: string) => {
    if (source !== IMA_PROVIDER) imaConnection.reset();
    setLinkSource(source);
  };

  // Reset the form only on the closed → open transition. While the modal is
  // open, background indexing polls replace `providers` every few seconds, and
  // a data refresh must never wipe user input (#691).
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const justOpened = isOpen && !wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!justOpened) return;
    setMode(initialMode);
    setName("");
    setFiles([]);
    setError(null);
    const initialProvider = createProviders(providers).find(
      (item) => item.id === initialSource,
    )?.id;
    setProvider(
      initialProvider || createProviders(providers)[0]?.id || "llamaindex",
    );
    setLinkSource(initialSource || firstLinkable || OBSIDIAN_SOURCE);
    setFolderPath("");
    setProbe(null);
    setProbing(false);
    setRetrievalMode("");
  }, [isOpen, providers, firstLinkable, initialMode, initialSource]);

  useEffect(() => {
    if (!isOpen || mode !== "new") return;
    let cancelled = false;
    const load = async () => {
      try {
        let summary: string[] = [];
        if (provider === "llamaindex") {
          const config = await getLlamaIndexConfig();
          summary = [
            `${"Retrieval profile"}: ${config.retrieval_profile}`,
            `${"Results per query"}: ${config.top_k}`,
            `${"Chunk size"}: ${config.chunk_size} / ${"Chunk overlap"}: ${config.chunk_overlap}`,
          ];
        }
        if (!cancelled) setEngineDefaultSummary(summary);
      } catch {
        if (!cancelled) setEngineDefaultSummary([]);
      }
    };
    setEngineDefaultSummary([]);
    void load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, provider, defaultsRevision]);

  // A fresh path / source invalidates a stale probe verdict.
  useEffect(() => {
    setProbe(null);
  }, [folderPath, linkSource]);

  // ---- New mode (build a fresh index) ----------------------------------
  const activeProvider = providers.find((p) => p.id === provider);
  const providerNeedsKey =
    !!activeProvider?.requires_api_key && activeProvider?.configured === false;
  const providerUnavailable = activeProvider?.configured === false;
  const needsEmbedding = provider === "llamaindex";
  const embeddingCatalog = useEmbeddingModels(
    undefined,
    isOpen && mode === "new" && needsEmbedding,
  );
  const modeOptions = activeProvider?.modes ?? [];

  const selection = validateFiles(files, uploadPolicy);

  // ---- Link mode (mount an existing folder) ----------------------------
  const trimmed = name.trim();
  const trimmedPath = folderPath.trim();

  // Mirrors the backend rule so the name is rejected under the field rather
  // than as an English 400 after Create.
  const nameProblems = forbiddenKbNameChars(trimmed);

  const canSubmit = (() => {
    if (submitting) return false;
    if (!trimmed) return false;
    if (!isValidKbName(trimmed)) return false;
    if (mode === "new") {
      if (
        needsEmbedding &&
        (!embeddingCatalog.selection ||
          embeddingCatalog.loading ||
          embeddingCatalog.error)
      )
        return false;
      return !providerUnavailable;
    }
    if (linkIsIma) return imaConnection.canSubmit;
    if (linkIsMarginNote) return true;
    if (!trimmedPath) return false;
    if (linkIsObsidian) return true;
    // An engine index must pass the probe before it can be linked.
    return !!probe?.ok;
  })();

  const handleProbe = async () => {
    if (!trimmedPath || linkIsObsidian || probing) return;
    setProbing(true);
    setError(null);
    try {
      const result = await probeLinkedFolder({
        folderPath: trimmedPath,
        provider: linkSource,
      });
      setProbe(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "new") {
        await onCreate({
          name: trimmed,
          provider,
          files: selection.validFiles,
          // A new base is stored in the workspace the library is opened in.
          storageWorkspaceId: activeWorkspaceId(),
          searchMode: retrievalMode || undefined,
          embeddingModel: needsEmbedding
            ? embeddingCatalog.selection || undefined
            : undefined,
        });
      } else if (linkIsIma) {
        await onConnectIma({
          name: trimmed,
          // Empty when the engine's account credentials are used — the server
          // resolves them and the KB stores no copy.
          clientId: imaConnection.submittedClientId,
          apiKey: imaConnection.submittedApiKey,
          knowledgeBaseId: imaConnection.knowledgeBaseId,
        });
      } else if (linkIsMarginNote) {
        await onConnectMarginNote4({ name: trimmed });
      } else if (linkIsObsidian) {
        await onConnectObsidian({ name: trimmed, vaultPath: trimmedPath });
      } else {
        await onConnectLinkedFolder({
          name: trimmed,
          folderPath: trimmedPath,
          provider: linkSource,
        });
      }
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const submitLabel =
    mode === "new"
      ? "Create"
      : linkIsObsidian || linkIsIma || linkIsMarginNote
        ? "Connect"
        : "Link";

  return (
    <Modal
      isOpen={isOpen}
      onClose={submitting ? () => {} : handleClose}
      title={"Create knowledge base"}
      titleIcon={<Plus size={16} />}
      width="lg"
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      footer={
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={handleClose}
            disabled={submitting}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
          >
            {"Cancel"}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : mode === "new" ? (
              <Plus size={14} />
            ) : (
              <Link2 size={14} />
            )}
            {submitLabel}
          </button>
        </div>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {/* New vs. link existing */}
        <ModeToggle
          mode={mode}
          onChange={handleModeChange}
          disabled={submitting}
        />

        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            {"Knowledge base name"}
          </label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            disabled={submitting}
            placeholder={"e.g. project-papers"}
            aria-invalid={nameProblems.length > 0}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[13px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
          />
          {nameProblems.length > 0 && (
            <p className="mt-1 text-[11px] text-[var(--destructive)]">
              {`A knowledge base name cannot contain ${nameProblems.join(" ")} — these separate paths and URLs.`}
            </p>
          )}
        </div>

        {mode === "new" ? (
          <NewModeFields
            providers={createProviders(providers)}
            provider={provider}
            setProvider={setProvider}
            submitting={submitting}
            providerUnavailable={providerUnavailable}
            providerNeedsKey={providerNeedsKey}
            onConfigureProvider={onConfigureProvider}
            activeProvider={activeProvider}
            engineDefaultSummary={engineDefaultSummary}
            modeOptions={modeOptions}
            retrievalMode={retrievalMode}
            setRetrievalMode={setRetrievalMode}
            files={files}
            setFiles={setFiles}
            policyForProvider={uploadPolicy}
            indexingModelField={
              needsEmbedding ? (
                <EmbeddingModelSelector
                  catalog={embeddingCatalog}
                  disabled={submitting}
                />
              ) : null
            }
          />
        ) : (
          <LinkModeFields
            providers={providers}
            linkSource={linkSource}
            setLinkSource={handleLinkSourceChange}
            linkIsObsidian={linkIsObsidian}
            linkIsIma={linkIsIma}
            linkIsMarginNote={linkIsMarginNote}
            folderPath={folderPath}
            setFolderPath={setFolderPath}
            submitting={submitting}
            probing={probing}
            probe={probe}
            onProbe={handleProbe}
            connectionForm={
              linkIsIma ? (
                <ImaConnectionFields
                  connection={imaConnection}
                  submitting={submitting}
                />
              ) : null
            }
          />
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
            <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
              {error}
            </pre>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ModeToggle({
  mode,
  onChange,
  disabled,
}: {
  mode: Mode;
  onChange: (mode: Mode) => void;
  disabled: boolean;
}) {
  const options: {
    id: Mode;
    label: string;
    hint: string;
    icon: typeof Plus;
  }[] = [
    {
      id: "new",
      label: "Create new",
      hint: "Upload documents and build a fresh index.",
      icon: Plus,
    },
    {
      id: "link",
      label: "Link existing",
      hint: "Reuse an index you already built — read in place, no upload or re-index.",
      icon: Link2,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {options.map((opt) => {
        const selected = mode === opt.id;
        const Icon = opt.icon;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={`flex flex-col gap-1 rounded-2xl border p-3 text-left transition-colors disabled:opacity-50 ${
              selected
                ? "border-[var(--primary)] bg-[var(--primary)]/5"
                : "border-[var(--border)] hover:border-[var(--ring)]"
            }`}
          >
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-[var(--foreground)]">
              <Icon className="h-3.5 w-3.5" />
              {opt.label}
            </span>
            <span className="text-[11px] leading-snug text-[var(--muted-foreground)]">
              {opt.hint}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function NewModeFields({
  providers,
  provider,
  setProvider,
  activeProvider,
  engineDefaultSummary,
  modeOptions,
  retrievalMode,
  setRetrievalMode,
  submitting,
  providerUnavailable,
  providerNeedsKey,
  onConfigureProvider,
  files,
  setFiles,
  policyForProvider,
  indexingModelField,
}: {
  providers: RagProviderSummary[];
  provider: string;
  setProvider: (id: string) => void;
  activeProvider?: RagProviderSummary;
  engineDefaultSummary: string[];
  modeOptions: string[];
  retrievalMode: string;
  setRetrievalMode: (mode: string) => void;
  submitting: boolean;
  providerUnavailable: boolean;
  providerNeedsKey: boolean;
  onConfigureProvider?: (providerId: string) => void;
  files: File[];
  setFiles: (files: File[]) => void;
  policyForProvider: KnowledgeUploadPolicy;
  indexingModelField?: ReactNode;
}) {
  const readinessReason = providers.find(
    (item) => item.id === provider,
  )?.readiness_reason;
  return (
    <>
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {"Index engine"}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          {providers.map((p) => {
            const selected = provider === p.id;
            const needsKey = !!p.requires_api_key && p.configured === false;
            const unavailable = p.configured === false && !p.requires_api_key;
            return (
              <button
                key={p.id}
                type="button"
                disabled={submitting}
                onClick={() => {
                  setProvider(p.id);
                  setRetrievalMode("");
                }}
                className={`group flex w-full flex-1 flex-col gap-1 rounded-2xl border p-3 text-left transition-colors disabled:opacity-50 ${
                  selected
                    ? "border-[var(--primary)] bg-[var(--primary)]/5"
                    : "border-[var(--border)] hover:border-[var(--ring)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--foreground)]">
                    <KnowledgeEngineIcon engine={p.id} size={24} />
                    <span className="truncate">{p.name}</span>
                  </span>
                  {needsKey ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                      {"Needs key"}
                    </span>
                  ) : unavailable ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                      {"Not installed"}
                    </span>
                  ) : selected ? (
                    <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                  ) : null}
                </div>
                <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                  {p.description}
                </span>
              </button>
            );
          })}
        </div>
        {providerUnavailable && (
          <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
            <span className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {providerNeedsKey
                ? "This engine needs an API key. Configure it before creating."
                : (readinessReason ||
                    "This engine isn't ready on the server. Check its requirements before creating.")}
            </span>
            {providerNeedsKey && onConfigureProvider && (
              <button
                type="button"
                onClick={() => onConfigureProvider(provider)}
                className="shrink-0 rounded-md px-2 py-1 text-[11.5px] font-medium text-amber-900 underline-offset-2 hover:underline dark:text-amber-100"
              >
                {"Configure"}
              </button>
            )}
          </div>
        )}
      </div>

      {activeProvider && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--muted)]/25 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[12px] font-medium text-[var(--foreground)]">
                {"Engine defaults"}
              </div>
              <p className="mt-0.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
                {"This knowledge base starts with the saved engine configuration."}
              </p>
            </div>
            {onConfigureProvider && (
              <button
                type="button"
                onClick={() => onConfigureProvider(provider)}
                className="inline-flex shrink-0 items-center gap-1 text-[11.5px] font-medium text-[var(--primary)] hover:underline"
              >
                {"Edit defaults"}
                <ChevronRight className="h-3 w-3" />
              </button>
            )}
          </div>
          {engineDefaultSummary.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {engineDefaultSummary.map((item) => (
                <span
                  key={item}
                  className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-[10.5px] text-[var(--muted-foreground)]"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {indexingModelField && <div>{indexingModelField}</div>}

      {modeOptions.length > 0 && (
        <div>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            {"Retrieval mode"}
          </label>
          <select
            value={retrievalMode}
            onChange={(event) => setRetrievalMode(event.target.value)}
            disabled={submitting}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12.5px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
          >
            <option value="">
              {`Use engine default: ${activeProvider?.default_mode || modeOptions[0]}`}
            </option>
            {modeOptions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
            {"This override applies only to this knowledge base; the engine default stays unchanged."}
          </p>
        </div>
      )}

      <div>
        <label className="mb-2 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {"Initial documents"}
          <span className="ml-1 normal-case tracking-normal text-[var(--muted-foreground)]/80">
            ({"optional"})
          </span>
        </label>
        <FileDropZone
          files={files}
          onChange={setFiles}
          uploadPolicy={policyForProvider}
          disabled={submitting}
        />
        <p className="mt-1.5 text-[11px] text-[var(--muted-foreground)]">
          {"Skip for now — you can add GitHub sources or upload documents after creation."}
        </p>
      </div>
    </>
  );
}

function LinkModeFields({
  providers,
  linkSource,
  setLinkSource,
  linkIsObsidian,
  linkIsIma,
  linkIsMarginNote,
  folderPath,
  setFolderPath,
  submitting,
  probing,
  probe,
  onProbe,
  connectionForm,
}: {
  providers: RagProviderSummary[];
  linkSource: string;
  setLinkSource: (id: string) => void;
  linkIsObsidian: boolean;
  linkIsIma: boolean;
  linkIsMarginNote: boolean;
  folderPath: string;
  setFolderPath: (value: string) => void;
  submitting: boolean;
  probing: boolean;
  probe: LinkedFolderProbe | null;
  onProbe: () => void;
  connectionForm?: ReactNode;
}) {
  return (
    <>
      <div>
        <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          {"Source"}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          {providers.map((p) => {
            const selected =
              !linkIsObsidian && !linkIsMarginNote && linkSource === p.id;
            const enabled = linkSourceEnabled(p);
            const disabled = submitting || !enabled;
            return (
              <Tooltip
                key={p.id}
                label={enabled ? p.name : "This engine's index lives in the cloud and can't be linked."}
                suppressed={enabled}
                side="top"
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => setLinkSource(p.id)}
                  aria-label={p.name}
                  className={`group flex h-full w-full flex-col gap-1 rounded-2xl border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? "border-[var(--primary)] bg-[var(--primary)]/5"
                      : "border-[var(--border)] hover:border-[var(--ring)]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--foreground)]">
                      <KnowledgeEngineIcon engine={p.id} size={24} />
                      <span className="truncate">{p.name}</span>
                    </span>
                    {selected ? (
                      <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                    ) : !enabled ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--muted-foreground)]">
                        {"Cloud index"}
                      </span>
                    ) : p.id === IMA_PROVIDER ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:bg-sky-950/30 dark:text-sky-300">
                        {"Read only"}
                      </span>
                    ) : null}
                  </div>
                  <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                    {p.description}
                  </span>
                </button>
              </Tooltip>
            );
          })}

          {/* Obsidian — a live vault, no index. */}
          <button
            type="button"
            disabled={submitting}
            onClick={() => setLinkSource(OBSIDIAN_SOURCE)}
            className={`group flex flex-col gap-1 rounded-2xl border p-3 text-left transition-colors disabled:opacity-50 ${
              linkIsObsidian
                ? "border-[var(--primary)] bg-[var(--primary)]/5"
                : "border-[var(--border)] hover:border-[var(--ring)]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--foreground)]">
                <KnowledgeEngineIcon engine="obsidian" size={24} />
                {"Obsidian"}
              </span>
              {linkIsObsidian && (
                <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
              )}
            </div>
            <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
              {"A live Obsidian vault — browsed and edited in place, no index."}
            </span>
          </button>

          {/* MarginNote 4 — filled by its Add-on, not by a path on this disk. */}
          <button
            type="button"
            disabled={submitting}
            onClick={() => setLinkSource(MARGINNOTE4_SOURCE)}
            className={`group flex flex-col gap-1 rounded-2xl border p-3 text-left transition-colors disabled:opacity-50 ${
              linkIsMarginNote
                ? "border-[var(--primary)] bg-[var(--primary)]/5"
                : "border-[var(--border)] hover:border-[var(--ring)]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[13px] font-medium text-[var(--foreground)]">
                <KnowledgeEngineIcon engine="marginnote4" size={24} />
                {"MarginNote 4"}
              </span>
              {linkIsMarginNote && (
                <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
              )}
            </div>
            <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
              {"Notes, excerpts and cards pushed in by the MarginNote 4 add-on."}
            </span>
          </button>
        </div>
      </div>

      {linkIsIma ? (
        connectionForm
      ) : linkIsMarginNote ? (
        <p className="rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2 text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
          {"The library starts empty. Pair a device from its Devices tab, then enter the token in the MarginNote 4 add-on to start syncing."}
        </p>
      ) : (
        <>
          <div>
            <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
              {linkIsObsidian ? "Vault path" : "Folder path"}
            </label>
            <div className="flex gap-2">
              <input
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                disabled={submitting}
                placeholder={
                  linkIsObsidian ? EXAMPLE_VAULT_PATH : EXAMPLE_INDEX_PATH
                }
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[12.5px] text-[var(--foreground)] outline-none transition-colors focus:border-[var(--foreground)]/25 disabled:opacity-50"
              />
              {!linkIsObsidian && (
                <button
                  type="button"
                  onClick={onProbe}
                  disabled={
                    submitting || probing || folderPath.trim().length === 0
                  }
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 text-[12px] font-medium text-[var(--foreground)] transition-colors hover:border-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {probing ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <FolderSearch className="h-3.5 w-3.5" />
                  )}
                  {"Check folder"}
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">
              {linkIsObsidian
                ? "The absolute path to the vault folder on this machine."
                : "The absolute path to a knowledge base folder on this machine — nothing is copied."}
            </p>
          </div>

          {!linkIsObsidian && probe && <ProbeVerdict probe={probe} />}
        </>
      )}
    </>
  );
}

function ProbeVerdict({ probe }: { probe: LinkedFolderProbe }) {
  if (!probe.ok) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
        <span className="flex items-center gap-1.5 font-medium">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {"This folder can't be linked"}
        </span>
        {probe.error && <p className="mt-1 leading-relaxed">{probe.error}</p>}
      </div>
    );
  }

  const compatible = probe.embedding.compatible;
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--muted)]/40 px-3 py-2.5 text-[12px]">
      <div className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
        <Check className="h-3.5 w-3.5 shrink-0" />
        {"Ready index found"}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--muted-foreground)]">
        {probe.version && <span className="font-mono">{probe.version}</span>}
        {probe.doc_count != null && (
          <span>{`${probe.doc_count} documents`}</span>
        )}
        {compatible === true && (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
            <Check className="h-3 w-3" />
            {"Embedding model matches"}
          </span>
        )}
      </div>
      {probe.warnings.map((warning, index) => (
        <p
          key={index}
          className="flex items-start gap-1.5 leading-relaxed text-amber-700 dark:text-amber-300"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}
