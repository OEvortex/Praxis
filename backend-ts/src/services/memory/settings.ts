// user-tunable consolidator
// parameters. Upstream stores them in ``data/user/settings/main.yaml`` under
// the ``memory:`` subtree via ConfigManager; here they live in the shared
// SQLite kv store under ``settings/memory`` (kept clear of the ``memory`` key
// used by the agent `memory` tool's fact list).
import * as database from "../../store/database.js";
import { get_settings } from "../../config.js";
import type { Dict } from "../../shared/types.js";

export interface UpdateSettings {
  l2_budget: number;
  l3_budget: number;
}
export interface AuditSettings {
  l2_budget: number;
  l3_budget: number;
}
export interface DedupSettings {
  iterations: number;
  auto_after_update: boolean;
}
export interface MergeSettings {
  auto_after_update: boolean;
  auto_after_audit: boolean;
  auto_after_dedup: boolean;
}
export interface ChunkingSettings {
  overlap_ratio: number;
  boundary: "paragraph" | "sentence";
  min_chunk_chars: number;
  max_chunk_chars: number;
}
export interface ReferenceSettings {
  enforce_required: boolean;
  drop_invalid_refs: boolean;
}
export interface MemorySettings {
  update: UpdateSettings;
  audit: AuditSettings;
  dedup: DedupSettings;
  merge: MergeSettings;
  chunking: ChunkingSettings;
  reference: ReferenceSettings;
}

const DEFAULTS: MemorySettings = {
  update: { l2_budget: 20, l3_budget: 10 },
  audit: { l2_budget: 20, l3_budget: 10 },
  dedup: { iterations: 3, auto_after_update: true },
  merge: {
    auto_after_update: true,
    auto_after_audit: true,
    auto_after_dedup: true,
  },
  chunking: {
    overlap_ratio: 0.1,
    boundary: "paragraph",
    min_chunk_chars: 1000,
    max_chunk_chars: 64000,
  },
  reference: { enforce_required: true, drop_invalid_refs: true },
};

const KV_KEY = "settings/memory";

const MIN_BUDGET = 1;
const MAX_BUDGET = 200;
const MIN_DEDUP_ITER = 1;
const MAX_DEDUP_ITER = 20;
const MIN_OVERLAP = 0.0;
const MAX_OVERLAP = 0.5;
const MIN_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 64000;
const BOUNDARIES = new Set(["paragraph", "sentence"]);

function isRecord(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clampInt(name: string, value: number, _default: number): number {
  if (name.endsWith("budget")) return Math.max(MIN_BUDGET, Math.min(MAX_BUDGET, value));
  if (name === "iterations") return Math.max(MIN_DEDUP_ITER, Math.min(MAX_DEDUP_ITER, value));
  if (name === "min_chunk_chars" || name === "max_chunk_chars") {
    return Math.max(MIN_CHUNK_CHARS, Math.min(MAX_CHUNK_CHARS, value));
  }
  return Math.max(0, value);
}

function coerceScalar(name: string, raw: unknown, dflt: unknown): unknown {
  if (raw === null || raw === undefined) return dflt;
  if (typeof dflt === "boolean") return Boolean(raw);
  if (typeof dflt === "number" && Number.isInteger(dflt)) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return dflt;
    return clampInt(name, Math.trunc(n), dflt);
  }
  if (typeof dflt === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return dflt;
    return name === "overlap_ratio"
      ? Math.max(MIN_OVERLAP, Math.min(MAX_OVERLAP, n))
      : n;
  }
  if (typeof dflt === "string") {
    const s = String(raw);
    if (name === "boundary" && !BOUNDARIES.has(s)) return dflt;
    return s;
  }
  return raw;
}

// Recursively coerce a partial dict onto the defaults shape (mirrors
// settings._from_dict).
function fromDict<T>(defaults: T, raw: unknown): T {
  if (!isRecord(raw)) return defaults;
  const out = (Array.isArray(defaults) ? [] : {}) as Dict;
  for (const [key, dflt] of Object.entries(defaults as Dict)) {
    const provided = raw[key];
    if (isRecord(dflt)) {
      out[key] = fromDict(dflt, provided ?? null);
    } else {
      out[key] = coerceScalar(key, provided, dflt);
    }
  }
  return out as T;
}

export function load_memory_settings(): MemorySettings {
  const raw = database.get_state<unknown>(get_settings(), KV_KEY, {}) ?? {};
  return fromDict(DEFAULTS, raw);
}

export function save_memory_settings(payload: Dict): MemorySettings {
  const merged = fromDict(DEFAULTS, payload);
  database.put_state(get_settings(), KV_KEY, merged);
  return merged;
}

export function memory_settings_dict(): Dict {
  return { ...load_memory_settings() } as Dict;
}

// snake_case aliases mirroring the module surface.
export const loadMemorySettings = load_memory_settings;
export const saveMemorySettings = save_memory_settings;
export const memorySettingsDict = memory_settings_dict;
