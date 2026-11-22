// engine/provider config, model options, preflight.
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

const EMBEDDING_PROVIDERS = new Set(["llamaindex"]);

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
