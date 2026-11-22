// and the model-catalog helpers the knowledge router uses
// (model options payload and active-model switching).
//
// The model catalog itself is Praxis's provider-config store
// (``settings/catalog`` in the shared SQLite db) — the same shape upstream's
// model_catalog.json uses: ``services.<kind>.{active_profile_id,
// active_model_id, profiles[]}`` with per-model rows under ``models[]``.
import type { Settings } from "../../config.js";
import { get_settings as _config_get_settings } from "../../config.js";
import * as providerConfig from "../../provider-config.js";
import {
  loadIma,
} from "./settings.js";
import type { AnyDict } from "./settings.js";

// ---------------------------------------------------------------------------
// Provider catalog
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER = "llamaindex";
export const IMA_PROVIDER = "ima";

export const KNOWN_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  IMA_PROVIDER,
]);

// linked_kb.py: engines whose index lives self-contained on disk.
export const LINKABLE_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
]);

export function normalizeProviderName(name: string | null | undefined): string {
  const candidate = (name ?? "").trim().toLowerCase();
  return KNOWN_PROVIDERS.has(candidate) ? candidate : DEFAULT_PROVIDER;
}

function isRecord(value: unknown): value is AnyDict {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Engine readiness probes used by list_pipelines / preflight
// ---------------------------------------------------------------------------

function _imaConfigured(settings: Settings): boolean {
  try {
    const s = loadIma(settings);
    return Boolean(String(s["client_id"] ?? "").trim() && String(s["api_key"] ?? "").trim());
  } catch {
    return false;
  }
}

export function listRagProviders(settings: Settings = _config_get_settings()): AnyDict[] {
  return [
    {
      id: DEFAULT_PROVIDER,
      name: "LlamaIndex",
      description: "Local vector retrieval with hybrid BM25/vector fusion. Works out of the box.",
      configured: true,
      requires_api_key: false,
    },
    {
      id: IMA_PROVIDER,
      name: "Tencent IMA",
      description:
        "Retrieval offloaded to a knowledge base you keep in Tencent IMA. No local index and no copy — connect a KB to its IMA library and query it over IMA's OpenAPI. Chat can also browse the library's documents, read a full source, search your IMA notes, and (when you ask) collect a web page or save a note. Uploading files still happens in IMA itself. Requires an IMA Client ID and API key.",
      configured: _imaConfigured(settings),
      requires_api_key: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Model catalog helpers
// ---------------------------------------------------------------------------

export const ENGINE_MODEL_KINDS = ["llm", "embedding"] as const;

function _service(catalog: AnyDict, kind: string): AnyDict {
  const services = isRecord(catalog["services"]) ? catalog["services"] : {};
  return isRecord(services[kind]) ? services[kind] : {};
}

export function modelOptionsPayload(settings: Settings, kinds: string[]): AnyDict {
  const catalog = providerConfig.load_catalog(settings);
  const services = isRecord(catalog["services"]) ? catalog["services"] : {};
  const out: AnyDict = {};
  for (const kind of kinds) {
    const svc = isRecord(services[kind]) ? services[kind] : {};
    const options: AnyDict[] = [];
    const profiles = Array.isArray(svc["profiles"]) ? svc["profiles"] : [];
    for (const profile of profiles) {
      if (!isRecord(profile)) continue;
      const pid = profile["id"];
      const pname = profile["name"] || pid;
      const models = Array.isArray(profile["models"]) ? profile["models"] : [];
      for (const model of models) {
        if (!isRecord(model)) continue;
        let detail = "";
        if (kind === "embedding" && model["dimension"]) {
          detail = `${model["dimension"]}d`;
        }
        options.push({
          profile_id: pid,
          profile_name: pname,
          model_id: model["id"],
          label: model["name"] || model["model"] || model["id"],
          model: model["model"] || "",
          detail,
        });
      }
    }
    out[kind] = {
      active: {
        profile_id: svc["active_profile_id"],
        model_id: svc["active_model_id"],
      },
      options,
    };
  }
  return out;
}

export function findProfileAndModel(
  catalog: AnyDict,
  kind: string,
  profileId: string,
  modelId: string,
): { profile: AnyDict; model: AnyDict } | null {
  const svc = _service(catalog, kind);
  const profiles = Array.isArray(svc["profiles"]) ? svc["profiles"] : [];
  const profile = profiles.find((p) => isRecord(p) && p["id"] === profileId);
  if (!isRecord(profile)) return null;
  const models = Array.isArray(profile["models"]) ? profile["models"] : [];
  const model = models.find((m) => isRecord(m) && m["id"] === modelId);
  return isRecord(model) ? { profile, model } : null;
}

// ---------------------------------------------------------------------------
// LlamaIndex effective retrieval profile
// ---------------------------------------------------------------------------

/**
 * Upstream degrades "hybrid" to "vector" when the BM25 package is missing
 * so BM25 is always available and the effective profile equals the configured
 * one — same normalization rules otherwise.
 */
export function effectiveRetrievalProfile(profile: string | null | undefined): string {
  const normalized = String(profile ?? "").trim().toLowerCase();
  if (normalized === "vector") return "vector";
  return "hybrid";
}

// ---------------------------------------------------------------------------
// Preflight (port of services/rag/preflight.py)
// ---------------------------------------------------------------------------

function _check(key: string, label: string, ok: boolean, detail = "", optional = false): AnyDict {
  return { key, label, ok: Boolean(ok), detail, optional };
}

function _finalize(checks: AnyDict[]): AnyDict {
  const ok = checks.every((c) => c["optional"] || c["ok"]);
  return { ok, checks };
}

function _activeEmbedding(settings: Settings): { model: string; dim: number } {
  try {
    const catalog = providerConfig.load_catalog(settings);
    const svc = _service(catalog, "embedding");
    const profileId = svc["active_profile_id"];
    const modelId = svc["active_model_id"];
    if (!profileId || !modelId) return { model: "", dim: 0 };
    const found = findProfileAndModel(catalog, "embedding", String(profileId), String(modelId));
    if (!found) return { model: "", dim: 0 };
    const m = found.model;
    const model = String(m["model"] ?? m["id"] ?? m["name"] ?? "").trim();
    let dim = 0;
    for (const key of ["dimension", "embedding_dim", "dim"]) {
      const n = Number(m[key]);
      if (Number.isFinite(n) && n > 0) {
        dim = Math.trunc(n);
        break;
      }
    }
    if (!dim && Array.isArray(m["supported_dimensions"])) {
      const first = Number(m["supported_dimensions"][0]);
      if (Number.isFinite(first) && first > 0) dim = Math.trunc(first);
    }
    return { model, dim };
  } catch {
    return { model: "", dim: 0 };
  }
}

function _llamaindexPreflight(settings: Settings): AnyDict {
  const { model: embModel, dim: embDim } = _activeEmbedding(settings);
  const checks = [
    _check(
      "embedding",
      "Active embedding model",
      Boolean(embModel) && embDim > 0,
      embModel ? `${embModel} · ${embDim}d` : "Configure one in the model catalog.",
    ),
    // Upstream probes for the optional BM25 package; this backend's keyword
    // retriever is built in, so hybrid fusion is always available.
    _check("bm25", "BM25 hybrid retrieval", true, "Installed.", true),
  ];
  return _finalize(checks);
}

function _imaPreflight(settings: Settings): AnyDict {
  const s = loadIma(settings);
  const clientId = String(s["client_id"] ?? "").trim();
  const complete = Boolean(clientId && String(s["api_key"] ?? "").trim());
  return _finalize([
    _check(
      "credentials",
      "IMA Client ID and API key configured",
      complete,
      complete
        ? clientId
        : "Add them under Credentials, or supply a pair per knowledge base when connecting one.",
    ),
  ]);
}

const _PREFLIGHTS: Record<string, (settings: Settings) => AnyDict> = {
  [DEFAULT_PROVIDER]: _llamaindexPreflight,
  [IMA_PROVIDER]: _imaPreflight,
};

export function enginePreflight(settings: Settings, provider: string): AnyDict {
  const fn = _PREFLIGHTS[normalizeProviderName(provider)];
  if (!fn) {
    const e = new Error(`'${provider}'`);
    e.name = "KeyError";
    throw e;
  }
  return fn(settings);
}

