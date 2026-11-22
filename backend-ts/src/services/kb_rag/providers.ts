// and the model-catalog helpers the knowledge router uses
// (model options payload, active-model switching, GraphRAG compatibility probe,
// LightRAG role validation).
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
  loadLightragServer,
  loadLightrag,
  loadPageindex,
} from "./settings.js";
import type { AnyDict } from "./settings.js";

// ---------------------------------------------------------------------------
// Provider catalog (port of services/rag/factory.py list_pipelines)
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER = "llamaindex";
export const PAGEINDEX_PROVIDER = "pageindex";
export const PAGEINDEX_OSS_PROVIDER = "pageindex-oss";
export const GRAPHRAG_PROVIDER = "graphrag";
export const LIGHTRAG_PROVIDER = "lightrag";
export const LIGHTRAG_SERVER_PROVIDER = "lightrag-server";
export const IMA_PROVIDER = "ima";
export const WEKNORA_PROVIDER = "weknora";
export const KIWIX_PROVIDER = "kiwix";

export const KNOWN_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  PAGEINDEX_PROVIDER,
  PAGEINDEX_OSS_PROVIDER,
  GRAPHRAG_PROVIDER,
  LIGHTRAG_PROVIDER,
  LIGHTRAG_SERVER_PROVIDER,
  IMA_PROVIDER,
  WEKNORA_PROVIDER,
  KIWIX_PROVIDER,
]);

// linked_kb.py: engines whose index lives self-contained on disk.
export const LINKABLE_PROVIDERS = new Set([
  DEFAULT_PROVIDER,
  GRAPHRAG_PROVIDER,
  LIGHTRAG_PROVIDER,
]);

// graphrag/config.py + lightrag/config.py + lightrag_server/config.py
export const GRAPHRAG_MODES = ["local", "global", "drift", "basic"] as const;
export const GRAPHRAG_DEFAULT_MODE = "local";
export const LIGHTRAG_MODES = ["naive", "local", "global", "hybrid", "mix"] as const;
export const LIGHTRAG_DEFAULT_MODE = "hybrid";
export const LIGHTRAG_SERVER_MODES = ["naive", "local", "global", "hybrid", "mix"] as const;
export const LIGHTRAG_SERVER_DEFAULT_MODE = "mix";
// ima/config.py
export const IMA_MODES: string[] = [];
export const IMA_DEFAULT_MODE = "";

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

function _pageindexConfigured(settings: Settings): boolean {
  try {
    return Boolean(String(loadPageindex(settings)["api_key"] ?? "").trim());
  } catch {
    return false;
  }
}

function _imaConfigured(settings: Settings): boolean {
  try {
    const s = loadIma(settings);
    return Boolean(String(s["client_id"] ?? "").trim() && String(s["api_key"] ?? "").trim());
  } catch {
    return false;
  }
}

function _lightragServerDefaultsReady(settings: Settings): boolean {
  try {
    return Boolean(String(loadLightragServer(settings)["server_url"] ?? "").trim());
  } catch {
    return false;
  }
}

/**
 * Upstream asks each pipeline package whether it is importable. This backend
 * here — so availability is reported honestly as false with the same install
 * hint the UI already understands.
 */
const GRAPHRAG_AVAILABLE = false;
const LIGHTRAG_AVAILABLE = false;

function _activeLlmModel(settings: Settings): { model: string; binding: string } {
  try {
    const resolved = providerConfig.resolve_runtime_model(settings, {}) as AnyDict;
    return {
      model: String(resolved["model"] ?? "").trim(),
      binding: String(resolved["provider"] ?? resolved["profile_id"] ?? "").trim(),
    };
  } catch {
    return { model: "", binding: "" };
  }
}

function _pageindexOssReady(settings: Settings): { ok: boolean; reason: string } {
  // Indexing needs an API-key or local LLM profile; OAuth-only transports
  // cannot drive PageIndex OSS. There is no task-model indirection in the TS
  // catalog, so the active chat model stands in.
  const { model, binding } = _activeLlmModel(settings);
  if (!model) {
    return { ok: false, reason: "PageIndex OSS needs an LLM. Configure one under Settings → Catalog." };
  }
  const oauthOnly = new Set(["codex", "openai-codex", "github-copilot", "codebuddy", "claude-code"]);
  if (oauthOnly.has(binding.toLowerCase())) {
    return {
      ok: false,
      reason: "PageIndex OSS indexing needs an API-key or local LLM profile; an OAuth-only provider cannot be used.",
    };
  }
  return { ok: true, reason: "" };
}

export function listRagProviders(settings: Settings = _config_get_settings()): AnyDict[] {
  const pageindexOss = _pageindexOssReady(settings);
  const lightragServerDefaults = _lightragServerDefaultsReady(settings);
  return [
    {
      id: DEFAULT_PROVIDER,
      name: "LlamaIndex",
      description: "Local vector retrieval with hybrid BM25/vector fusion. Works out of the box.",
      configured: true,
      requires_api_key: false,
    },
    {
      id: PAGEINDEX_PROVIDER,
      name: "PageIndex Cloud",
      description:
        "Hosted, vectorless engine: the chat agent reads documents through PageIndex SDK tools. Requires an API key; PDF, Office, text and Markdown formats.",
      configured: _pageindexConfigured(settings),
      requires_api_key: true,
    },
    {
      id: PAGEINDEX_OSS_PROVIDER,
      name: "PageIndex OSS",
      description:
        "Local, chunkless and vectorless document indexing. Uses the active LLM and accepts PDF files.",
      configured: pageindexOss.ok,
      requires_api_key: false,
      readiness_reason: pageindexOss.reason,
    },
    {
      id: GRAPHRAG_PROVIDER,
      name: "GraphRAG",
      description:
        "Local knowledge-graph retrieval (global/local/drift/basic). Needs `pip install 'deeptutor[graphrag]'`; indexing is LLM-heavy.",
      configured: GRAPHRAG_AVAILABLE,
      requires_api_key: false,
      modes: [...GRAPHRAG_MODES],
      default_mode: GRAPHRAG_DEFAULT_MODE,
    },
    {
      id: LIGHTRAG_PROVIDER,
      name: "LightRAG",
      description:
        "Graph + vector retrieval with multimodal parsing (naive/local/global/hybrid/mix). Needs `pip install 'deeptutor[rag-lightrag]'`; indexing is LLM-heavy.",
      configured: LIGHTRAG_AVAILABLE,
      requires_api_key: false,
      modes: [...LIGHTRAG_MODES],
      default_mode: LIGHTRAG_DEFAULT_MODE,
    },
    {
      id: LIGHTRAG_SERVER_PROVIDER,
      name: "LightRAG Server",
      description:
        "Retrieval offloaded to an external, standalone LightRAG server you run. No local index — connect a KB to its URL and query it over HTTP (naive/local/global/hybrid/mix).",
      configured: true,
      requires_api_key: false,
      setup_required: !lightragServerDefaults,
      modes: [...LIGHTRAG_SERVER_MODES],
      default_mode: LIGHTRAG_SERVER_DEFAULT_MODE,
    },
    {
      id: IMA_PROVIDER,
      name: "Tencent IMA",
      description:
        "Retrieval offloaded to a knowledge base you keep in Tencent IMA. No local index and no copy — connect a KB to its IMA library and query it over IMA's OpenAPI. Chat can also browse the library's documents, read a full source, search your IMA notes, and (when you ask) collect a web page or save a note. Uploading files still happens in IMA itself. Requires an IMA Client ID and API key.",
      configured: _imaConfigured(settings),
      requires_api_key: true,
    },
    {
      id: WEKNORA_PROVIDER,
      name: "WeKnora",
      description:
        "Retrieval offloaded to a knowledge base in your self-hosted WeKnora deployment. No local index or document copy; connect to its API URL, API key, and knowledge-base ID.",
      configured: true,
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

/** Port of apply_llm_selection_to_catalog validation (catalog copy mutated to point at selection). */
export function applyLlmSelectionToCatalog(catalog: AnyDict, profileId: string, modelId: string): AnyDict {
  const found = findProfileAndModel(catalog, "llm", profileId, modelId);
  if (!found) {
    const e = new Error("Invalid LLM selection: selected profile/model was not found.");
    e.name = "ValueError";
    throw e;
  }
  const services = isRecord(catalog["services"]) ? catalog["services"] : {};
  const svc = isRecord(services["llm"]) ? services["llm"] : {};
  services["llm"] = svc;
  catalog["services"] = services;
  svc["active_profile_id"] = profileId;
  svc["active_model_id"] = modelId;
  return catalog;
}

/**
 * LightRAG role_models catalog validation — port of
 * pipelines/lightrag/roles.py validate_models(): every enabled selection must
 * resolve in the llm catalog; vlm selections must support vision; explicit
 * reasoning_effort must be in the model's supported efforts.
 */
export function validateLightRagRoleModels(settings: Settings, roleModels: AnyDict): void {
  const catalog = providerConfig.load_catalog(settings);
  const selections: { selection: AnyDict; vision: boolean }[] = [];
  const base = roleModels["base"];
  if (isRecord(base)) selections.push({ selection: base, vision: false });
  for (const role of ["extract", "keyword", "query", "vlm"] as const) {
    const roleCfg = roleModels[role];
    if (!isRecord(roleCfg) || roleCfg["mode"] === "disabled") continue;
    const selection = roleCfg["selection"] ?? base;
    const reasoning = roleCfg["reasoning_effort"] ?? null;
    const merged = isRecord(selection)
      ? { ...selection, ...(reasoning ? { reasoning_effort: reasoning } : {}) }
      : null;
    if (merged) selections.push({ selection: merged, vision: role === "vlm" });
  }
  for (const { selection, vision } of selections) {
    const found = findProfileAndModel(
      catalog,
      "llm",
      String(selection["profile_id"]),
      String(selection["model_id"]),
    );
    if (!found) {
      const e = new Error("The selected model is unavailable.");
      e.name = "ValueError";
      throw e;
    }
    const effort = selection["reasoning_effort"];
    const supported = found.model["supported_reasoning_efforts"];
    if (effort && Array.isArray(supported) && supported.length && !supported.includes(effort)) {
      const e = new Error("The selected model does not support this reasoning effort.");
      e.name = "ValueError";
      throw e;
    }
    if (vision) {
      const caps = isRecord(found.model["capabilities"]) ? found.model["capabilities"] : {};
      const profileCaps = isRecord(found.profile["capabilities"]) ? found.profile["capabilities"] : {};
      const preset = providerConfig.builtin_preset(
        String(found.profile["binding"] ?? found.profile["provider"] ?? ""),
      );
      const supportsVision = Boolean(
        caps["vision"] ?? profileCaps["vision"] ?? preset?.["supports_vision"],
      );
      if (!supportsVision) {
        const e = new Error("The selected VLM model does not support image inputs.");
        e.name = "ValueError";
        throw e;
      }
    }
  }
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

function _pageindexPreflight(settings: Settings): AnyDict {
  const configured = _pageindexConfigured(settings);
  return _finalize([
    _check(
      "api_key",
      "API key configured",
      configured,
      configured ? "PageIndex Cloud" : "Add a PageIndex API key under Credentials.",
    ),
  ]);
}

function _pageindexOssPreflight(settings: Settings): AnyDict {
  const { ok, reason } = _pageindexOssReady(settings);
  const { model } = _activeLlmModel(settings);
  return _finalize([_check("chat", "Active LLM for indexing", ok, ok ? model : reason)]);
}

function _graphragPreflight(settings: Settings): AnyDict {
  const { model: chatModel } = _activeLlmModel(settings);
  const { model: embModel, dim: embDim } = _activeEmbedding(settings);
  return _finalize([
    _check(
      "package",
      "GraphRAG package installed",
      GRAPHRAG_AVAILABLE,
      GRAPHRAG_AVAILABLE ? "Installed." : "pip install 'deeptutor[graphrag]'",
    ),
    _check(
      "chat",
      "Active chat model",
      Boolean(chatModel),
      chatModel || "Configure one in the model catalog.",
    ),
    _check(
      "embedding",
      "Active embedding model",
      Boolean(embModel) && embDim > 0,
      embModel ? `${embModel} · ${embDim}d` : "Configure one in the model catalog.",
    ),
  ]);
}

function _lightragPreflight(settings: Settings): AnyDict {
  const packageDetail = "pip install 'deeptutor[rag-lightrag]'";
  const { model: chatModel, binding } = _activeLlmModel(settings);
  let visionOk = false;
  if (chatModel) {
    try {
      const resolved = providerConfig.resolve_runtime_model(settings, {}) as AnyDict;
      const catalog = providerConfig.load_catalog(settings);
      const found = findProfileAndModel(
        catalog,
        "llm",
        String(resolved["profile_id"] ?? ""),
        String(resolved["model_id"] ?? ""),
      );
      const preset = providerConfig.builtin_preset(binding);
      visionOk = Boolean(
        (found && isRecord(found.model["capabilities"]) && found.model["capabilities"]["vision"]) ??
          preset?.["supports_vision"],
      );
    } catch {
      visionOk = false;
    }
  }
  const { model: embModel, dim: embDim } = _activeEmbedding(settings);
  return _finalize([
    _check("package", "LightRAG package installed", LIGHTRAG_AVAILABLE, packageDetail),
    _check(
      "chat",
      "Active chat model",
      Boolean(chatModel),
      chatModel || "Configure one in the model catalog.",
    ),
    _check(
      "embedding",
      "Active embedding model",
      Boolean(embModel) && embDim > 0,
      embModel ? `${embModel} · ${embDim}d` : "Configure one in the model catalog.",
    ),
    _check(
      "vision",
      "Vision model for multimodal",
      visionOk,
      visionOk
        ? "Active chat model supports vision."
        : "Active chat model has no vision — image analysis is disabled.",
      true,
    ),
  ]);
}

function _lightragServerPreflight(settings: Settings): AnyDict {
  const serverUrl = String(loadLightragServer(settings)["server_url"] ?? "").trim();
  return _finalize([
    _check(
      "server_url",
      "Default server configured",
      Boolean(serverUrl),
      serverUrl || "Add a server URL under Connection defaults.",
    ),
  ]);
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
  [PAGEINDEX_PROVIDER]: _pageindexPreflight,
  [PAGEINDEX_OSS_PROVIDER]: _pageindexOssPreflight,
  [GRAPHRAG_PROVIDER]: _graphragPreflight,
  [LIGHTRAG_PROVIDER]: _lightragPreflight,
  [LIGHTRAG_SERVER_PROVIDER]: _lightragServerPreflight,
  [IMA_PROVIDER]: _imaPreflight,
};

export function enginePreflight(settings: Settings, provider: string): AnyDict {
  const fn = _PREFLIGHTS[normalizeProviderName(provider)];
  if (!fn) {
    // Upstream indexes _PREFLIGHTS by normalized name; weknora/kiwix normalize
    // to themselves but have no preflight -> KeyError -> 500 in the API.
    const e = new Error(`'${provider}'`);
    e.name = "KeyError";
    throw e;
  }
  return fn(settings);
}

// ---------------------------------------------------------------------------
// GraphRAG model compatibility probe
// (port of pipelines/graphrag/{compatibility,engine,errors}.py — reduced to the
// OpenAI/Anthropic chat transports this backend can drive)
// ---------------------------------------------------------------------------

const PROBE_MAX_TOKENS = 1024;
const PROBE_TIMEOUT_MS = 25_000;

const MODEL_INCOMPATIBLE_MESSAGE =
  "The model did not accept or return the structured output required by GraphRAG.";
const MODEL_AUTHENTICATION_MESSAGE =
  "GraphRAG compatibility could not be verified because the model credentials were rejected.";
const MODEL_RATE_LIMIT_MESSAGE =
  "GraphRAG compatibility could not be verified because the model provider is rate limiting requests. Try again later.";
const MODEL_CONNECTION_MESSAGE =
  "GraphRAG compatibility could not be verified because the model provider could not be reached. Try again later.";
const MODEL_OUTPUT_TRUNCATED_MESSAGE =
  "GraphRAG compatibility could not be verified because the model response reached its output token limit. Try again.";
const MODEL_ENDPOINT_MESSAGE =
  "The configured GraphRAG model or endpoint was not found. Check its provider URL.";

const PROBE_PROMPT =
  "Return one concise community report for a graph containing one topic named " +
  "'compatibility test'. Include a title, summary, one finding with summary and " +
  "explanation, a numeric rating, and a rating explanation.";

interface ProbeFailure {
  code: string;
  message: string;
  retryable: boolean;
  incompatible: boolean;
}

function _classifyProbeError(status: number | null, detail: string): ProbeFailure {
  const text = detail.toLowerCase();
  const formatRejected =
    /response_format|response format|json_schema|json schema|structured output/.test(text) &&
    /unavailable|unsupported|not supported|does not support|not available|not valid|must be|rejected/.test(text);
  if (formatRejected) {
    return { code: "graphrag_model_incompatible", message: MODEL_INCOMPATIBLE_MESSAGE, retryable: false, incompatible: true };
  }
  if (status === 401 || status === 403) {
    return { code: "graphrag_model_authentication_failed", message: MODEL_AUTHENTICATION_MESSAGE, retryable: false, incompatible: false };
  }
  if (status === 429) {
    return { code: "graphrag_model_rate_limited", message: MODEL_RATE_LIMIT_MESSAGE, retryable: true, incompatible: false };
  }
  if (status === 404) {
    return { code: "graphrag_model_endpoint_failed", message: MODEL_ENDPOINT_MESSAGE, retryable: false, incompatible: false };
  }
  if (status !== null && status >= 500) {
    return { code: "graphrag_model_connection_failed", message: MODEL_CONNECTION_MESSAGE, retryable: true, incompatible: false };
  }
  if (status === null) {
    return { code: "graphrag_model_connection_failed", message: MODEL_CONNECTION_MESSAGE, retryable: true, incompatible: false };
  }
  return { code: "graphrag_model_probe_failed", message: "GraphRAG compatibility could not be verified with this model.", retryable: false, incompatible: false };
}

function _failedProbe(model: string, binding: string, failure: ProbeFailure): AnyDict {
  return {
    status: failure.incompatible ? "incompatible" : "unverifiable",
    compatible: failure.incompatible ? false : null,
    code: failure.code,
    message: failure.message,
    model,
    binding,
    retryable: failure.retryable,
  };
}

function _looksLikeCommunityReport(value: unknown): boolean {
  // GraphRAG's CommunityReportResponse: title, summary, findings[{summary,
  // explanation}], rating, rating_explanation.
  if (!isRecord(value)) return false;
  const findings = value["findings"];
  return (
    typeof value["title"] === "string" &&
    typeof value["summary"] === "string" &&
    Array.isArray(findings) &&
    findings.length > 0 &&
    findings.every(
      (f) => isRecord(f) && typeof f["summary"] === "string" && typeof f["explanation"] === "string",
    ) &&
    typeof value["rating"] === "number" &&
    typeof value["rating_explanation"] === "string"
  );
}

function _extractJson(content: string): unknown {
  const text = content.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json object");
  return JSON.parse(candidate.slice(start, end + 1));
}

async function _probeChatCompletion(resolved: AnyDict): Promise<void> {
  const provider = String(resolved["provider"] ?? "");
  const model = String(resolved["model"] ?? "");
  const key = resolved["api_key"] ? String(resolved["api_key"]) : "";
  const base = String(resolved["base_url"] ?? "").trim().replace(/\/+$/, "");

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let url: string;
  let body: AnyDict;

  if (provider === "anthropic" || provider === "aerolink") {
    url = `${base}/messages`;
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
    body = {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content:
            `${PROBE_PROMPT}\n\nRespond with a single JSON object only, no prose: ` +
            `{"title": string, "summary": string, "findings": [{"summary": string, "explanation": string}], "rating": number, "rating_explanation": string}.`,
        },
      ],
    };
  } else if (provider === "openai-responses") {
    url = `${base}/responses`;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model,
      max_output_tokens: PROBE_MAX_TOKENS,
      input: [
        {
          role: "user",
          content:
            `${PROBE_PROMPT}\n\nRespond with a single JSON object only, no prose: ` +
            `{"title": string, "summary": string, "findings": [{"summary": string, "explanation": string}], "rating": number, "rating_explanation": string}.`,
        },
      ],
    };
  } else {
    url = `${base}/chat/completions`;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model,
      max_tokens: PROBE_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content:
            `${PROBE_PROMPT}\n\nRespond with a single JSON object only, no prose: ` +
            `{"title": string, "summary": string, "findings": [{"summary": string, "explanation": string}], "rating": number, "rating_explanation": string}.`,
        },
      ],
    };
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw Object.assign(new Error("connection failed"), { status: null });
  }
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(text.slice(0, 800)), { status: response.status });
  }

  let content = "";
  let finishReason = "";
  try {
    const data = JSON.parse(text) as AnyDict;
    if (provider === "anthropic" || provider === "aerolink") {
      const blocks = Array.isArray(data["content"]) ? data["content"] : [];
      content = blocks
        .filter((b) => isRecord(b) && b["type"] === "text")
        .map((b) => String(b["text"] ?? ""))
        .join("");
      finishReason = String(data["stop_reason"] ?? "");
    } else if (provider === "openai-responses") {
      const output = Array.isArray(data["output"]) ? data["output"] : [];
      for (const item of output) {
        if (!isRecord(item)) continue;
        const contentParts = Array.isArray(item["content"]) ? item["content"] : [];
        for (const part of contentParts) {
          if (isRecord(part) && typeof part["text"] === "string") content += part["text"];
        }
      }
      finishReason = String(data["status"] ?? "");
    } else {
      const choices = Array.isArray(data["choices"]) ? data["choices"] : [];
      const choice = isRecord(choices[0]) ? choices[0] : {};
      const message = isRecord(choice["message"]) ? choice["message"] : {};
      content = typeof message["content"] === "string" ? message["content"] : "";
      finishReason = String(choice["finish_reason"] ?? "");
    }
  } catch {
    throw Object.assign(new Error("unparseable provider response"), { status: response.status });
  }

  if (finishReason === "length" || finishReason === "max_output_tokens") {
    throw Object.assign(new Error("truncated"), { status: null, truncated: true });
  }
  let parsed: unknown;
  try {
    parsed = _extractJson(content);
  } catch {
    throw Object.assign(new Error("invalid structured output"), { status: null, incompatible: true });
  }
  if (!_looksLikeCommunityReport(parsed)) {
    throw Object.assign(new Error("invalid structured output"), { status: null, incompatible: true });
  }
}

/**
 * Port of probe_configured_completion_model + engine.probe_completion_model:
 * resolve the catalog selection without activating it, then probe the model's
 * structured-output contract. Returns a secret-free result object.
 */
export async function probeGraphRagModelCompatibility(
  settings: Settings,
  profileId: string,
  modelId: string,
): Promise<AnyDict> {
  const catalog = providerConfig.load_catalog(settings);
  if (!findProfileAndModel(catalog, "llm", profileId, modelId)) {
    const e = new Error("Invalid LLM selection: selected profile/model was not found.");
    e.name = "ValueError";
    throw e;
  }
  const resolved = providerConfig.resolve_runtime_model(settings, {
    llm_selection: { profile_id: profileId, model_id: modelId },
  }) as AnyDict;
  const model = String(resolved["model"] ?? "");
  const binding = String(resolved["provider"] ?? "");
  try {
    await _probeChatCompletion(resolved);
  } catch (error) {
    const err = error as { status?: number | null; truncated?: boolean; incompatible?: boolean; message?: string };
    if (err?.truncated) {
      return _failedProbe(model, binding, {
        code: "graphrag_model_output_truncated",
        message: MODEL_OUTPUT_TRUNCATED_MESSAGE,
        retryable: true,
        incompatible: false,
      });
    }
    if (err?.incompatible) {
      return _failedProbe(model, binding, {
        code: "graphrag_model_incompatible",
        message: MODEL_INCOMPATIBLE_MESSAGE,
        retryable: false,
        incompatible: true,
      });
    }
    const status = typeof err?.status === "number" ? err.status : null;
    return _failedProbe(model, binding, _classifyProbeError(status, String(err?.message ?? "")));
  }
  return {
    status: "compatible",
    compatible: true,
    code: "graphrag_model_compatible",
    message: "The model returned valid GraphRAG structured output.",
    model,
    binding,
    retryable: false,
  };
}
