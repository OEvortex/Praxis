// Port of the RAG-pipeline slice of deeptutor/api/routers/knowledge.py —
// engine/provider config, model options, preflight and the GraphRAG
// compatibility probe. Mounted alongside handlersRouter at ``/api/*``.
//
// Connectors, upload tasks, indexing runs and basic KB CRUD are owned by other
// ports and intentionally absent here.
import { Hono } from "hono";
import type { Context } from "hono";

import { getSettings } from "../config.js";
import type { Settings } from "../config.js";
import * as providerConfig from "../provider-config.js";
import * as kbSettings from "../services/kb_rag/settings.js";
import * as rag from "../services/kb_rag/providers.js";

export const knowledgeRagRouter = new Hono();

type AnyRecord = Record<string, any>;

function _settings(): Settings {
  return getSettings();
}

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

function isRecord(value: unknown): value is AnyRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function body(c: Context): Promise<AnyRecord> {
  try {
    const data: unknown = await c.req.json();
    return isRecord(data) ? data : {};
  } catch {
    return {};
  }
}

function _has(bodyObj: AnyRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(bodyObj, key);
}

function _str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/rag-providers
// ---------------------------------------------------------------------------

knowledgeRagRouter.get("/api/knowledge-bases/rag-providers", async (c) => {
  try {
    const providers = rag.listRagProviders(_settings());
    for (const provider of providers) {
      const modes = provider["modes"];
      if (Array.isArray(modes) && modes.length) {
        const stored = kbSettings.getProviderMode(_settings(), String(provider["id"]));
        if (modes.includes(stored)) {
          provider["default_mode"] = stored;
        }
      }
      provider["linkable"] = rag.LINKABLE_PROVIDERS.has(String(provider["id"]));
    }
    return c.json({ providers });
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// ---------------------------------------------------------------------------
// PUT /api/knowledge-bases/rag-providers/{provider}/mode
// ---------------------------------------------------------------------------

knowledgeRagRouter.put("/api/knowledge-bases/rag-providers/:provider/mode", async (c) => {
  const provider = c.req.param("provider");
  const payload = await body(c);
  const entry = rag
    .listRagProviders(_settings())
    .find((p) => p["id"] === provider);
  const modes = (entry?.["modes"] as string[] | undefined) ?? [];
  if (!entry || !modes.length) {
    return httpError(c, 404, `No retrieval modes for engine '${provider}'.`);
  }
  const mode = _str(payload["mode"]).toLowerCase();
  if (!modes.includes(mode)) {
    return httpError(
      c,
      400,
      `Invalid mode '${payload["mode"]}' for ${provider}. Choose one of: ${modes.join(", ")}.`,
    );
  }
  kbSettings.setProviderMode(_settings(), provider, mode);
  return c.json({ provider, mode });
});

// ---------------------------------------------------------------------------
// Pipeline config endpoints — one pair per engine, upstream shapes.
// ---------------------------------------------------------------------------

// PageIndex Cloud credential (key redacted to a boolean).
function _pageindexConfigPayload(): AnyRecord {
  const settings = kbSettings.loadPageindex(_settings());
  const apiKeySet = Boolean(String(settings["api_key"] ?? ""));
  return { api_key_set: apiKeySet, configured: apiKeySet };
}

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/pageindex/config", async (c) => {
  try {
    return c.json(_pageindexConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/pageindex/config", async (c) => {
  try {
    const payload = await body(c);
    const current = kbSettings.loadPageindex(_settings(), false);
    // Tri-state api_key: absent keeps, "" clears, anything else replaces.
    let apiKey = _str(current["api_key"]);
    if (_has(payload, "api_key") && payload["api_key"] !== null) {
      apiKey = _str(payload["api_key"]);
    }
    kbSettings.savePageindex(_settings(), { api_key: apiKey });
    return c.json(_pageindexConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// Tencent IMA account credentials.
function _imaConfigPayload(): AnyRecord {
  const settings = kbSettings.loadIma(_settings());
  const clientId = _str(settings["client_id"]);
  const apiKeySet = Boolean(String(settings["api_key"] ?? ""));
  return {
    client_id: clientId,
    api_key_set: apiKeySet,
    configured: Boolean(clientId) && apiKeySet,
  };
}

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/ima/config", async (c) => {
  try {
    return c.json(_imaConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/ima/config", async (c) => {
  try {
    const payload = await body(c);
    const current = kbSettings.loadIma(_settings(), false);
    let clientId = _str(current["client_id"]);
    let apiKey = _str(current["api_key"]);
    if (_has(payload, "client_id") && payload["client_id"] !== null) {
      clientId = _str(payload["client_id"]);
    }
    if (_has(payload, "api_key") && payload["api_key"] !== null) {
      apiKey = _str(payload["api_key"]);
    }
    kbSettings.saveIma(_settings(), { client_id: clientId, api_key: apiKey });
    return c.json(_imaConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// LlamaIndex engine knobs.
const LLAMAINDEX_UPDATE_KEYS = [
  "retrieval_profile",
  "top_k",
  "vector_top_k_multiplier",
  "bm25_top_k_multiplier",
  "reranker_model",
  "rerank_top_k",
  "vector_index_type",
  "hnsw_m",
  "hnsw_ef_construction",
  "hnsw_ef_search",
  "chunk_size",
  "chunk_overlap",
  "image_description_concurrency",
  "image_description_batch_size",
  "image_description_timeout_seconds",
];

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/llamaindex/config", async (c) => {
  try {
    const settings = kbSettings.loadLlamaindex(_settings());
    const payload: AnyRecord = { ...settings };
    payload["effective_retrieval_profile"] = rag.effectiveRetrievalProfile(
      settings["retrieval_profile"],
    );
    return c.json(payload);
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/llamaindex/config", async (c) => {
  try {
    const payload = await body(c);
    const current = kbSettings.loadLlamaindex(_settings(), false);
    const updates: AnyRecord = {};
    for (const key of LLAMAINDEX_UPDATE_KEYS) {
      if (_has(payload, key) && payload[key] !== null && payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }
    return c.json(kbSettings.saveLlamaindex(_settings(), { ...current, ...updates }));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// GraphRAG query knobs.
knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/graphrag/config", async (c) => {
  try {
    return c.json(kbSettings.loadGraphrag(_settings()));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/graphrag/config", async (c) => {
  try {
    const payload = await body(c);
    const current = kbSettings.loadGraphrag(_settings());
    const updates: AnyRecord = {};
    for (const key of ["response_type", "community_level", "dynamic_community_selection"]) {
      if (_has(payload, key) && payload[key] !== null && payload[key] !== undefined) {
        updates[key] = payload[key];
      }
    }
    return c.json(kbSettings.saveGraphrag(_settings(), { ...current, ...updates }));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// LightRAG query + indexing knobs (incl. role_models / legacy llm pair).
const LIGHTRAG_UPDATE_KEYS = [
  "role_models",
  "top_k",
  "response_type",
  "max_concurrent_files",
  "llm_model_max_async",
  "entity_extract_max_gleaning",
  "llm_timeout",
  "llm_profile_id",
  "llm_model_id",
];

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/lightrag/config", async (c) => {
  try {
    return c.json(kbSettings.loadLightrag(_settings()));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

function _validateLightRagLlmSelection(profileId: string, modelId: string): void {
  if (Boolean(profileId) !== Boolean(modelId)) {
    const e = new Error("LightRAG model selection requires both profile_id and model_id.");
    e.name = "ValueError";
    throw e;
  }
  if (!profileId) return;
  const catalog = providerConfig.load_catalog(_settings());
  rag.applyLlmSelectionToCatalog(catalog, profileId, modelId);
}

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/lightrag/config", async (c) => {
  try {
    const settings = _settings();
    const payload = await body(c);
    const current = kbSettings.loadLightrag(settings);
    const candidate: AnyRecord = { ...current };
    const fieldsSet = new Set(Object.keys(payload));
    for (const key of LIGHTRAG_UPDATE_KEYS) {
      if (_has(payload, key)) {
        // exclude_none semantics except role_models, which is tri-state:
        // explicit null is rejected below, never "cleared".
        if (key === "role_models" || (payload[key] !== null && payload[key] !== undefined)) {
          candidate[key] = payload[key];
        }
      }
    }

    if (_has(payload, "role_models") && payload["role_models"] === null) {
      return httpError(c, 422, "Role models cannot be cleared.");
    }
    if (
      current["version"] === 2 &&
      (fieldsSet.has("llm_profile_id") || fieldsSet.has("llm_model_id"))
    ) {
      return httpError(c, 422, "Use role_models for this configuration.");
    }
    if (candidate["role_models"] !== null && candidate["role_models"] !== undefined) {
      if (fieldsSet.has("llm_profile_id") || fieldsSet.has("llm_model_id")) {
        return httpError(c, 422, "Use role_models for this configuration.");
      }
      // Contract parse happens inside save; catalog capability check here.
      rag.validateLightRagRoleModels(settings, candidate["role_models"]);
    } else {
      try {
        _validateLightRagLlmSelection(
          _str(candidate["llm_profile_id"]),
          _str(candidate["llm_model_id"]),
        );
      } catch (e) {
        const err = e as Error;
        return httpError(c, 422, err.message);
      }
    }
    return c.json(kbSettings.saveLightrag(settings, candidate));
  } catch (e) {
    const err = e as Error;
    if (err?.name === "ValueError" || err?.name === "LightRagRoleError") {
      return httpError(c, 422, err.message);
    }
    return httpError(c, 500, String(e));
  }
});

// LightRAG role-model options for the editor.
knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/lightrag/model-options", async (c) => {
  try {
    // Port of pipelines/lightrag/roles.py model_options(): the catalog's LLM
    // options plus per-model reasoning/vision capability annotations.
    const settings = _settings();
    const options = (providerConfig.model_options(settings) as AnyRecord[]).map((row) => {
      const out = { ...row };
      const efforts =
        row["supported_reasoning_efforts"] ?? row["vtx_supported_reasoning_efforts"];
      out["supported_reasoning_efforts"] = Array.isArray(efforts)
        ? efforts.map((x) => String(x))
        : [];
      out["supports_vision"] = Boolean(
        row["supports_vision"] ?? row["vtx_capabilities"]?.["vision"],
      );
      return out;
    });
    const catalog = providerConfig.load_catalog(settings);
    const svc = isRecord(catalog["services"]) && isRecord(catalog["services"]["llm"])
      ? catalog["services"]["llm"]
      : {};
    const activeSel = providerConfig.get_selection(settings) as AnyRecord | null;
    const active = activeSel
      ? { profile_id: activeSel["profile_id"], model_id: activeSel["model_id"] }
      : svc["active_profile_id"] && svc["active_model_id"]
        ? {
            profile_id: svc["active_profile_id"],
            model_id: svc["active_model_id"],
          }
        : null;
    return c.json({ active, options });
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// LightRAG Server reusable defaults (key redacted).
function _lightragServerConfigPayload(): AnyRecord {
  const settings = kbSettings.loadLightragServer(_settings());
  const serverUrl = _str(settings["server_url"]);
  const apiKeySet = Boolean(String(settings["api_key"] ?? ""));
  return { server_url: serverUrl, api_key_set: apiKeySet, configured: Boolean(serverUrl) };
}

function normalizeLightRagServerBaseUrl(url: string): string {
  // pipelines/lightrag_server/config.py normalize_base_url
  return url.trim().replace(/\/+$/, "");
}

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/lightrag-server/config", async (c) => {
  try {
    return c.json(_lightragServerConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/lightrag-server/config", async (c) => {
  try {
    const payload = await body(c);
    const current = kbSettings.loadLightragServer(_settings());
    let serverUrl = _str(current["server_url"]);
    let apiKey = _str(current["api_key"]);
    if (_has(payload, "server_url") && payload["server_url"] !== null) {
      serverUrl = normalizeLightRagServerBaseUrl(_str(payload["server_url"]));
    }
    if (_has(payload, "api_key") && payload["api_key"] !== null) {
      apiKey = _str(payload["api_key"]);
    }
    kbSettings.saveLightragServer(_settings(), { server_url: serverUrl, api_key: apiKey });
    return c.json(_lightragServerConfigPayload());
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/rag-pipelines/{provider}/preflight
// ---------------------------------------------------------------------------

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/:provider/preflight", async (c) => {
  try {
    return c.json(rag.enginePreflight(_settings(), c.req.param("provider")));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/rag-pipelines/model-options?kinds=llm,embedding
// ---------------------------------------------------------------------------

knowledgeRagRouter.get("/api/knowledge-bases/rag-pipelines/model-options", async (c) => {
  try {
    const kindsParam = c.req.query("kinds") ?? "llm,embedding";
    const requested = kindsParam
      .split(",")
      .map((k) => k.trim())
      .filter((k) => (rag.ENGINE_MODEL_KINDS as readonly string[]).includes(k));
    const kinds = requested.length ? requested : [...rag.ENGINE_MODEL_KINDS];
    return c.json(rag.modelOptionsPayload(_settings(), kinds));
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// ---------------------------------------------------------------------------
// GET /api/knowledge-bases/embedding-usage
// ---------------------------------------------------------------------------

const EMBEDDING_PROVIDERS = new Set(["llamaindex", "graphrag", "lightrag"]);

knowledgeRagRouter.get("/api/knowledge-bases/embedding-usage", async (c) => {
  try {
    // Upstream walks every content workspace's kb_config.json. Praxis keeps a
    // single account-scoped kb_config in SQLite, so the same scan runs over
    // its knowledge_bases entries.
    const entries = kbSettings.listKbConfigEntries(_settings());
    const usage: AnyRecord[] = [];
    for (const [name, raw] of Object.entries(entries)) {
      if (!isRecord(raw)) continue;
      const provider = rag.normalizeProviderName(
        String(raw["rag_provider"] ?? "llamaindex"),
      );
      // Connected KBs (external_path / server pointers) don't bind embeddings.
      const connected = Boolean(raw["external_path"] || raw["server_url"] || raw["connected"]);
      if (connected || !EMBEDDING_PROVIDERS.has(provider)) continue;
      const selection = raw["embedding_selection"];
      if (isRecord(selection) && selection["profile_id"] && selection["model_id"]) {
        usage.push({
          name,
          workspace_name: "",
          profile_id: selection["profile_id"],
          model_id: selection["model_id"],
        });
      }
    }
    return c.json({ knowledge_bases: usage });
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});

// ---------------------------------------------------------------------------
// POST /api/knowledge-bases/rag-pipelines/graphrag/model-compatibility
// ---------------------------------------------------------------------------

knowledgeRagRouter.post("/api/knowledge-bases/rag-pipelines/graphrag/model-compatibility", async (c) => {
  try {
    const payload = await body(c);
    const profileId = _str(payload["profile_id"]);
    const modelId = _str(payload["model_id"]);
    if (!profileId || !modelId) {
      const e = new Error("profile_id and model_id are required.");
      e.name = "ValueError";
      throw e;
    }
    return c.json(await rag.probeGraphRagModelCompatibility(_settings(), profileId, modelId));
  } catch (e) {
    const err = e as Error;
    if (err?.name === "ValueError") {
      return httpError(c, 400, err.message);
    }
    return httpError(c, 500, "GraphRAG compatibility could not be tested because of an internal error.");
  }
});

// ---------------------------------------------------------------------------
// PUT /api/knowledge-bases/rag-pipelines/active-model
// ---------------------------------------------------------------------------

knowledgeRagRouter.put("/api/knowledge-bases/rag-pipelines/active-model", async (c) => {
  try {
    const settings = _settings();
    const payload = await body(c);
    const kind = _str(payload["kind"]);
    const profileId = _str(payload["profile_id"]);
    const modelId = _str(payload["model_id"]);
    if (!(rag.ENGINE_MODEL_KINDS as readonly string[]).includes(kind)) {
      return httpError(
        c,
        400,
        `Unsupported model kind '${payload["kind"]}'. Choose one of: ${rag.ENGINE_MODEL_KINDS.join(", ")}.`,
      );
    }
    const catalog = providerConfig.load_catalog(settings);
    const svc = isRecord(catalog["services"]) && isRecord(catalog["services"][kind])
      ? catalog["services"][kind]
      : null;
    if (!svc) {
      return httpError(c, 404, `No '${kind}' models configured.`);
    }
    const profiles = Array.isArray(svc["profiles"]) ? svc["profiles"] : [];
    const profile = profiles.find((p) => isRecord(p) && p["id"] === profileId);
    if (!isRecord(profile)) {
      return httpError(c, 400, "Unknown profile for this kind.");
    }
    const models = Array.isArray(profile["models"]) ? profile["models"] : [];
    if (!models.some((m) => isRecord(m) && m["id"] === modelId)) {
      return httpError(c, 400, "Unknown model for this profile.");
    }
    svc["active_profile_id"] = profileId;
    svc["active_model_id"] = modelId;
    providerConfig.save_catalog(settings, catalog);
    return c.json(rag.modelOptionsPayload(settings, [kind])[kind]);
  } catch (e) {
    return httpError(c, 500, String(e));
  }
});
