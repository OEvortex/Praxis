"use client";

import { useEffect, useMemo, useState } from "react";

import { Check, Loader2 } from "lucide-react";
import {
  getLlamaIndexConfig,
  updateLlamaIndexConfig,
  type LlamaIndexConfig,
} from "@/features/knowledge/api/engines";
import { NumberField, TextField } from "./EngineFormPrimitives";

export function LlamaIndexForm({
  onChanged,
  onError,
}: {
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  
  const [loaded, setLoaded] = useState<LlamaIndexConfig | null>(null);
  const [form, setForm] = useState<LlamaIndexConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getLlamaIndexConfig({ force: true })
      .then((cfg) => {
        if (cancelled) return;
        setLoaded(cfg);
        setForm(cfg);
      })
      .catch((err) =>
        onError(err instanceof Error ? err.message : String(err)),
      );
    return () => {
      cancelled = true;
    };
    // onError is stable enough; we only want this on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = useMemo(
    () => !!form && !!loaded && JSON.stringify(form) !== JSON.stringify(loaded),
    [form, loaded],
  );

  if (!form) {
    return (
      <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] py-10">
        <Loader2 className="h-4 w-4 animate-spin text-[var(--muted-foreground)]" />
      </div>
    );
  }

  const set = (patch: Partial<LlamaIndexConfig>) =>
    setForm((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (!form) return;
    setSaving(true);
    try {
      const next = await updateLlamaIndexConfig({
        retrieval_profile: form.retrieval_profile,
        top_k: form.top_k,
        vector_top_k_multiplier: form.vector_top_k_multiplier,
        bm25_top_k_multiplier: form.bm25_top_k_multiplier,
        reranker_model: form.reranker_model,
        rerank_top_k: form.rerank_top_k,
        vector_index_type: form.vector_index_type,
        hnsw_m: form.hnsw_m,
        hnsw_ef_construction: form.hnsw_ef_construction,
        hnsw_ef_search: form.hnsw_ef_search,
        chunk_size: form.chunk_size,
        chunk_overlap: form.chunk_overlap,
        image_description_concurrency: form.image_description_concurrency,
        image_description_timeout_seconds:
          form.image_description_timeout_seconds,
      });
      setLoaded(next);
      setForm(next);
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const isHybrid = form.retrieval_profile === "hybrid";
  const isHnsw = form.vector_index_type === "hnsw";
  const profiles: {
    id: LlamaIndexConfig["retrieval_profile"];
    desc: string;
  }[] = [
    {
      id: "hybrid",
      desc: "BM25 keyword + vector semantic retrieval, fused and re-ranked. More robust recall.",
    },
    {
      id: "vector",
      desc: "Vector semantic retrieval only. Faster, but leans entirely on embedding quality.",
    },
  ];

  const vectorIndexes: {
    id: LlamaIndexConfig["vector_index_type"];
    desc: string;
  }[] = [
    {
      id: "flat",
      desc: "Exact nearest-neighbor search. Best for small and medium knowledge bases.",
    },
    {
      id: "hnsw",
      desc: "Approximate graph search for large knowledge bases. Faster at scale with a small recall trade-off.",
    },
  ];

  return (
    <div className="space-y-6 rounded-2xl border border-[var(--border)] p-4">
      {/* Retrieval profile */}
      <div>
        <div className="mb-2 text-[12px] font-medium text-[var(--foreground)]">
          {"Retrieval profile"}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {profiles.map((p) => {
            const active = form.retrieval_profile === p.id;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => set({ retrieval_profile: p.id })}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? "border-[var(--primary)] bg-[var(--primary)]/5"
                    : "border-[var(--border)] hover:border-[var(--ring)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12.5px] font-medium text-[var(--foreground)]">
                    {p.id}
                  </span>
                  {active && (
                    <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                  )}
                </div>
                <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                  {(p.desc)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Retrieval breadth */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <NumberField
          label={"Results per query"}
          value={form.top_k}
          min={1}
          max={50}
          onChange={(v) => set({ top_k: v })}
        />
        <NumberField
          label={"Vector candidate ×"}
          hint={isHybrid ? undefined : "Used by hybrid only"}
          value={form.vector_top_k_multiplier}
          min={1}
          max={10}
          disabled={!isHybrid}
          onChange={(v) => set({ vector_top_k_multiplier: v })}
        />
        <NumberField
          label={"Keyword candidate ×"}
          hint={isHybrid ? undefined : "Used by hybrid only"}
          value={form.bm25_top_k_multiplier}
          min={1}
          max={10}
          disabled={!isHybrid}
          onChange={(v) => set({ bm25_top_k_multiplier: v })}
        />
      </div>

      {/* Reranking */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--foreground)]">
            {"Reranking"}
          </span>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {"Applies on the next query"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[2fr_1fr]">
          <TextField
            label={"Reranker model"}
            hint={"Leave empty to disable. Example: BAAI/bge-reranker-base. Requires the optional rag-rerank extra."}
            value={form.reranker_model}
            maxLength={200}
            onChange={(v) => set({ reranker_model: v })}
          />
          <NumberField
            label={"Rerank candidates"}
            value={form.rerank_top_k}
            min={1}
            max={100}
            onChange={(v) => set({ rerank_top_k: v })}
          />
        </div>
      </div>

      {/* Vector index */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--foreground)]">
            {"Vector index"}
          </span>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {"Applies on the next full re-index"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {vectorIndexes.map((indexType) => {
            const active = form.vector_index_type === indexType.id;
            return (
              <button
                key={indexType.id}
                type="button"
                onClick={() => set({ vector_index_type: indexType.id })}
                className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors ${
                  active
                    ? "border-[var(--primary)] bg-[var(--primary)]/5"
                    : "border-[var(--border)] hover:border-[var(--ring)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12.5px] font-medium text-[var(--foreground)]">
                    {indexType.id}
                  </span>
                  {active && (
                    <Check className="h-3.5 w-3.5 text-[var(--primary)]" />
                  )}
                </div>
                <span className="text-[11.5px] leading-snug text-[var(--muted-foreground)]">
                  {(indexType.desc)}
                </span>
              </button>
            );
          })}
        </div>
        {isHnsw && (
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <NumberField
              label={"HNSW graph degree"}
              value={form.hnsw_m}
              min={4}
              max={64}
              onChange={(v) => set({ hnsw_m: v })}
            />
            <NumberField
              label={"HNSW construction candidates"}
              value={form.hnsw_ef_construction}
              min={16}
              max={512}
              onChange={(v) => set({ hnsw_ef_construction: v })}
            />
            <NumberField
              label={"HNSW search candidates"}
              value={form.hnsw_ef_search}
              min={1}
              max={512}
              onChange={(v) => set({ hnsw_ef_search: v })}
            />
          </div>
        )}
      </div>

      {/* Chunking */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--foreground)]">
            {"Chunking"}
          </span>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {"Applies on the next re-index"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label={"Chunk size"}
            value={form.chunk_size}
            min={64}
            max={8192}
            onChange={(v) => set({ chunk_size: v })}
          />
          <NumberField
            label={"Chunk overlap"}
            value={form.chunk_overlap}
            min={0}
            max={Math.max(0, form.chunk_size - 1)}
            onChange={(v) => set({ chunk_overlap: v })}
          />
        </div>
      </div>

      {/* Image descriptions */}
      <div>
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <span className="text-[12px] font-medium text-[var(--foreground)]">
            {"Image descriptions"}
          </span>
          <span className="text-[11px] text-[var(--muted-foreground)]">
            {"Applies on the next image indexing run"}
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumberField
            label={"Concurrent image descriptions"}
            value={form.image_description_concurrency}
            min={1}
            max={16}
            onChange={(v) => set({ image_description_concurrency: v })}
          />
          <NumberField
            label={"Per-image timeout (seconds)"}
            value={form.image_description_timeout_seconds}
            min={5}
            max={600}
            onChange={(v) => set({ image_description_timeout_seconds: v })}
          />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3.5 py-1.5 text-[12.5px] font-medium text-[var(--primary-foreground)] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {"Save changes"}
        </button>
      </div>
    </div>
  );
}
