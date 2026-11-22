// Port of the RAG-pipeline slice of
//
// Upstream keeps one JSON file per engine under ``data/.../settings/``. Praxis
// persists the same payloads as rows in the shared SQLite database
// (``data/praxis.sqlite3``) under ``settings/runtime/<engine>`` keys, with the
// same defaults, normalizers and env overrides.
//
// The per-KB ``kb_config.json`` defaults slice that owns the per-engine
// ``provider_modes`` map lives under ``kb/kb_config``; only the provider-mode
// plumbing is ported here (full KB config CRUD belongs to the knowledge-base
// handlers).
import type { Settings } from "../../config.js";
import { get_settings as _config_get_settings } from "../../config.js";
import * as database from "../../store/database.js";

export type AnyDict = Record<string, any>;

// ---------------------------------------------------------------------------
// Small coercion helpers (mirror runtime_settings.py)
// ---------------------------------------------------------------------------

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

function isRecord(value: unknown): value is AnyDict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function _str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function _bool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  const text = String(value ?? "").trim().toLowerCase();
  if (TRUTHY.has(text)) return true;
  if (FALSY.has(text)) return false;
  return fallback;
}

function _int(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function _clampedInt(value: unknown, fallback: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, _int(value, fallback)));
}

// ---------------------------------------------------------------------------
// Defaults (ported verbatim from runtime_settings.py)
// ---------------------------------------------------------------------------

export const DEFAULT_IMA_SETTINGS: AnyDict = {
  version: 1,
  client_id: "",
  api_key: "",
};

export const LLAMAINDEX_VECTOR_PROFILE = "vector";
export const LLAMAINDEX_HYBRID_PROFILE = "hybrid";
const LLAMAINDEX_PROFILES = new Set([LLAMAINDEX_VECTOR_PROFILE, LLAMAINDEX_HYBRID_PROFILE]);
export const LLAMAINDEX_FLAT_VECTOR_INDEX = "flat";
export const LLAMAINDEX_HNSW_VECTOR_INDEX = "hnsw";
const LLAMAINDEX_VECTOR_INDEX_TYPES = new Set([
  LLAMAINDEX_FLAT_VECTOR_INDEX,
  LLAMAINDEX_HNSW_VECTOR_INDEX,
]);

export const DEFAULT_LLAMAINDEX_SETTINGS: AnyDict = {
  version: 1,
  retrieval_profile: LLAMAINDEX_HYBRID_PROFILE,
  top_k: 5,
  vector_top_k_multiplier: 2,
  bm25_top_k_multiplier: 2,
  reranker_model: "",
  rerank_top_k: 50,
  vector_index_type: LLAMAINDEX_FLAT_VECTOR_INDEX,
  hnsw_m: 32,
  hnsw_ef_construction: 200,
  hnsw_ef_search: 64,
  chunk_size: 512,
  chunk_overlap: 50,
  image_description_concurrency: 4,
  image_description_batch_size: 1,
  image_description_timeout_seconds: 60,
};

const IGNORE_PROCESS_OVERRIDES_ENV = "DEEPTUTOR_IGNORE_PROCESS_ENV_OVERRIDES";

// ---------------------------------------------------------------------------
// Process-env overrides (subset upstream applies to these slices)
// ---------------------------------------------------------------------------

function _envValue(key: string): string {
  if (_bool(process.env[IGNORE_PROCESS_OVERRIDES_ENV], false)) return "";
  return (process.env[key] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Normalizers (ported)
// ---------------------------------------------------------------------------

function _normalizeResponseType(value: unknown): string {
  const text = _str(value) || "Multiple Paragraphs";
  return text.slice(0, 80);
}

function normalizeIma(settings: AnyDict): AnyDict {
  return { version: 1, client_id: _str(settings["client_id"]), api_key: _str(settings["api_key"]) };
}

function normalizeLlamaindex(settings: AnyDict): AnyDict {
  let profile = _str(settings["retrieval_profile"]).toLowerCase();
  if (!LLAMAINDEX_PROFILES.has(profile)) profile = LLAMAINDEX_HYBRID_PROFILE;
  let vectorIndexType = _str(settings["vector_index_type"]).toLowerCase();
  if (!LLAMAINDEX_VECTOR_INDEX_TYPES.has(vectorIndexType)) {
    vectorIndexType = LLAMAINDEX_FLAT_VECTOR_INDEX;
  }
  const chunkSize = _clampedInt(settings["chunk_size"], 512, 64, 8192);
  const chunkOverlap = _clampedInt(settings["chunk_overlap"], 50, 0, Math.max(0, chunkSize - 1));
  return {
    version: 1,
    retrieval_profile: profile,
    top_k: _clampedInt(settings["top_k"], 5, 1, 50),
    vector_top_k_multiplier: _clampedInt(settings["vector_top_k_multiplier"], 2, 1, 10),
    bm25_top_k_multiplier: _clampedInt(settings["bm25_top_k_multiplier"], 2, 1, 10),
    reranker_model: _str(settings["reranker_model"]).slice(0, 200),
    rerank_top_k: _clampedInt(settings["rerank_top_k"], 50, 1, 100),
    vector_index_type: vectorIndexType,
    hnsw_m: _clampedInt(settings["hnsw_m"], 32, 4, 64),
    hnsw_ef_construction: _clampedInt(settings["hnsw_ef_construction"], 200, 16, 512),
    hnsw_ef_search: _clampedInt(settings["hnsw_ef_search"], 64, 1, 512),
    chunk_size: chunkSize,
    chunk_overlap: chunkOverlap,
    image_description_concurrency: _clampedInt(settings["image_description_concurrency"], 4, 1, 16),
    image_description_batch_size: _clampedInt(settings["image_description_batch_size"], 1, 1, 8),
    image_description_timeout_seconds: _clampedInt(
      settings["image_description_timeout_seconds"], 60, 5, 600,
    ),
  };
}

// ---------------------------------------------------------------------------
// Generic load/save over the kv store
// ---------------------------------------------------------------------------

type Normalizer = (settings: AnyDict) => AnyDict;

function _key(name: string): string {
  return `settings/runtime/${name}`;
}

function _loadOrCreate(
  settings: Settings,
  name: string,
  defaults: AnyDict,
  normalizer: Normalizer,
): AnyDict {
  const stored = database.get_state<unknown>(settings, _key(name), null);
  if (isRecord(stored) && Object.keys(stored).length) {
    const normalized = normalizer({ ...defaults, ...stored });
    // Persist the normalized form when it differs (same as _load_or_create).
    if (JSON.stringify(normalized) !== JSON.stringify(stored)) {
      database.put_state(settings, _key(name), normalized);
    }
    return normalized;
  }
  const normalized = normalizer({ ...defaults });
  database.put_state(settings, _key(name), normalized);
  return normalized;
}

function _save(
  settings: Settings,
  name: string,
  defaults: AnyDict,
  normalizer: Normalizer,
  payload: AnyDict,
): AnyDict {
  const normalized = normalizer({ ...defaults, ...payload });
  database.put_state(settings, _key(name), normalized);
  return normalized;
}

// ---------------------------------------------------------------------------
// Public load/save API — mirrors RuntimeSettingsService
// ---------------------------------------------------------------------------

export function loadIma(settings: Settings = _config_get_settings(), includeOverrides = true): AnyDict {
  const payload = _loadOrCreate(settings, "ima", DEFAULT_IMA_SETTINGS, normalizeIma);
  if (includeOverrides) {
    const clientId = _envValue("IMA_CLIENT_ID");
    const apiKey = _envValue("IMA_API_KEY");
    if (clientId) payload["client_id"] = clientId;
    if (apiKey) payload["api_key"] = apiKey;
    return normalizeIma(payload);
  }
  return payload;
}

export function saveIma(settings: Settings = _config_get_settings(), payload: AnyDict = {}): AnyDict {
  return _save(settings, "ima", DEFAULT_IMA_SETTINGS, normalizeIma, payload);
}

export function loadLlamaindex(settings: Settings = _config_get_settings(), includeOverrides = true): AnyDict {
  const payload = _loadOrCreate(settings, "llamaindex", DEFAULT_LLAMAINDEX_SETTINGS, normalizeLlamaindex);
  if (includeOverrides) {
    const value = _envValue("DEEPTUTOR_RAG_RETRIEVAL_PROFILE") || _envValue("RAG_RETRIEVAL_PROFILE");
    if (value) payload["retrieval_profile"] = value;
    return normalizeLlamaindex(payload);
  }
  return payload;
}

export function saveLlamaindex(settings: Settings = _config_get_settings(), payload: AnyDict = {}): AnyDict {
  return _save(settings, "llamaindex", DEFAULT_LLAMAINDEX_SETTINGS, normalizeLlamaindex, payload);
}

// ---------------------------------------------------------------------------
// kb_config.json provider-mode slice (knowledge_base_config.py)
// ---------------------------------------------------------------------------

const KB_CONFIG_KEY = "kb/kb_config";

function _defaultKbPayload(): AnyDict {
  return {
    defaults: {
      default_kb: null,
      rag_provider: "llamaindex",
      search_mode: "hybrid",
      provider_modes: {},
    },
    knowledge_bases: {},
  };
}

export function loadKbConfig(settings: Settings = _config_get_settings()): AnyDict {
  const stored = database.get_state<unknown>(settings, KB_CONFIG_KEY, null);
  const payload = _defaultKbPayload();
  if (isRecord(stored)) {
    for (const [key, value] of Object.entries(stored)) {
      if (key !== "defaults") payload[key] = value;
    }
    if (isRecord(stored["defaults"])) {
      Object.assign(payload["defaults"], stored["defaults"]);
    }
  }
  if (!isRecord(payload["knowledge_bases"])) payload["knowledge_bases"] = {};
  if (!isRecord(payload["defaults"])) payload["defaults"] = _defaultKbPayload()["defaults"];
  return payload;
}

function _saveKbConfig(settings: Settings, payload: AnyDict): void {
  database.put_state(settings, KB_CONFIG_KEY, payload);
}

export function getProviderMode(settings: Settings, provider: string): string {
  const config = loadKbConfig(settings);
  const modes = config["defaults"]?.["provider_modes"];
  if (!isRecord(modes)) return "";
  return String(modes[provider] ?? "");
}

export function setProviderMode(settings: Settings, provider: string, mode: string): void {
  const config = loadKbConfig(settings);
  const defaults = isRecord(config["defaults"]) ? config["defaults"] : _defaultKbPayload()["defaults"];
  config["defaults"] = defaults;
  const modes = isRecord(defaults["provider_modes"]) ? defaults["provider_modes"] : {};
  defaults["provider_modes"] = modes;
  modes[provider] = mode;
  _saveKbConfig(settings, config);
}

export function listKbConfigEntries(settings: Settings): AnyDict {
  // knowledge_bases map from kb_config.json (used by embedding-usage).
  const config = loadKbConfig(settings);
  return isRecord(config["knowledge_bases"]) ? config["knowledge_bases"] : {};
}
