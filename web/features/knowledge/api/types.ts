export type EmbeddingModelSelection = { profile_id: string; model_id: string };
export type EmbeddingUsage = EmbeddingModelSelection & {
  name: string;
  workspace_name: string;
};

export interface IndexingLLMSelection {
  profile_id: string;
  model_id: string;
  reasoning_effort?: string;
}

export interface KnowledgeBaseSummary {
  id?: string;
  name: string;
  is_default?: boolean;
  status?: string;
  path?: string;
  metadata?: Record<string, unknown>;
  progress?: Record<string, unknown>;
  statistics?: Record<string, unknown>;
  source?: "admin" | "user";
  assigned?: boolean;
  read_only?: boolean;
  provenance_label?: string;
  available?: boolean;
}

export interface RagProviderSummary {
  id: string;
  name: string;
  description: string;
  /** Whether the engine is ready to use (e.g. its API key is set). */
  configured?: boolean;
  /** Actionable reason when configured is false. */
  readiness_reason?: string;
  /** Whether the engine needs an API key configured before use. */
  requires_api_key?: boolean;
  /** Retrieval modes this engine supports (empty for mode-less engines). */
  modes?: string[];
  /** The active default retrieval mode for this engine. */
  default_mode?: string;
  /** Whether an existing index for this engine can be linked in place. */
  linkable?: boolean;
  /** The engine works, but reusable defaults have not been configured yet. */
  setup_required?: boolean;
}

export interface PageIndexConfig {
  api_key_set: boolean;
  configured: boolean;
}

/** Account-level Tencent IMA credentials, shared by every `ima` KB. */
export interface ImaAccountConfig {
  client_id: string;
  api_key_set: boolean;
  configured: boolean;
}

export interface LlamaIndexConfig {
  version: number;
  /** "hybrid" (BM25 + vector fusion) or "vector" only. */
  retrieval_profile: "hybrid" | "vector";
  /** Default number of chunks a query returns. */
  top_k: number;
  vector_top_k_multiplier: number;
  bm25_top_k_multiplier: number;
  /** Optional Hugging Face cross-encoder model; empty disables reranking. */
  reranker_model: string;
  /** First-stage candidates scored by the optional cross-encoder. */
  rerank_top_k: number;
  /** Vector index type used by the next full index build. */
  vector_index_type: "flat" | "hnsw";
  hnsw_m: number;
  hnsw_ef_construction: number;
  hnsw_ef_search: number;
  /** Chunk geometry — applies to documents indexed after the change. */
  chunk_size: number;
  chunk_overlap: number;
  /** Bounded multimodal LLM work during image-heavy indexing. */
  image_description_concurrency: number;
  image_description_timeout_seconds: number;
}

export interface GraphRagConfig {
  version: number;
  response_type: string;
  community_level: number;
  dynamic_community_selection: boolean;
}

export interface LightRagRoleModel {
  mode: "inherit" | "model" | "disabled";
  selection?: IndexingLLMSelection | null;
  reasoning_effort?: string | null;
  max_async: number;
  timeout: number;
}

export interface LightRagRoleModels {
  base: IndexingLLMSelection;
  extract: LightRagRoleModel;
  keyword: LightRagRoleModel;
  query: LightRagRoleModel;
  vlm: LightRagRoleModel;
}

export interface LightRagIndexingSelection {
  extract: IndexingLLMSelection;
  vlm: { mode: "disabled" | "enabled"; selection?: IndexingLLMSelection };
}

export interface LightRagConfig {
  role_models?: LightRagRoleModels;
  version: number;
  top_k: number;
  response_type: string;
  /** Frozen documents LightRAG parses in parallel while indexing. */
  max_concurrent_files: number;
  /** Concurrent LLM calls LightRAG's internal queue issues. */
  llm_model_max_async: number;
  /** Extra extraction passes per chunk, to recover missed entities. */
  entity_extract_max_gleaning: number;
  /** Per-call timeout for LightRAG's LLM requests, in seconds. */
  llm_timeout: number;
  /** Query model and default indexing selection; empty uses the active chat model. */
  llm_profile_id: string;
  llm_model_id: string;
}

export interface LightRagServerConfig {
  server_url: string;
  api_key_set: boolean;
  configured: boolean;
}

export interface PreflightCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  /** Optional checks don't gate overall readiness (e.g. BM25, vision). */
  optional: boolean;
}

export interface EnginePreflight {
  ok: boolean;
  checks: PreflightCheck[];
}

export interface ModelOption {
  profile_id: string;
  profile_name: string;
  model_id: string;
  label: string;
  model: string;
  detail: string;
}

export interface ModelKindOptions {
  active: { profile_id: string | null; model_id: string | null };
  options: ModelOption[];
}

export interface GraphRagModelCompatibility {
  status: "compatible" | "incompatible" | "unverifiable";
  compatible: boolean | null;
  code: string;
  message: string;
  model: string;
  binding: string;
  retryable: boolean;
}

/** Map of service kind ("llm" | "embedding") → its options + active selection. */
export type ModelOptionsByKind = Record<string, ModelKindOptions>;

export interface KnowledgeUploadPolicy {
  extensions: string[];
  accept: string;
  max_file_size_bytes: number;
  allow_any_extension?: boolean;
}

export interface KnowledgeBaseFile {
  /** POSIX path relative to the KB's raw/ root (may include folders). */
  name: string;
  /** "folder" entries are organizational only; default "file". */
  type?: "file" | "folder";
  size?: number;
  modified?: number;
  mime_type?: string | null;
}

export interface KnowledgeTaskResponse {
  id?: string;
  task_id?: string;
  message?: string;
  noop?: boolean;
}
