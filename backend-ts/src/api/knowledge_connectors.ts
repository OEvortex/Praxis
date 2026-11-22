// Port of the connector/probe/task/files subset of
import { Hono } from "hono";
import type { Context } from "hono";
import { createReadStream, existsSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getSettings } from "../config.js";
import type { Settings } from "../config.js";
import * as database from "../store/database.js";
import { KnowledgeBaseStore } from "../store/kb_store.js";

import {
  DEFAULT_PROVIDER,
  GRAPHRAG_PROVIDER,
  IMA_PROVIDER,
  KIWIX_PROVIDER,
  LIGHTRAG_PROVIDER,
  LIGHTRAG_SERVER_PROVIDER,
  WEKNORA_PROVIDER,
  isConnectedKb,
  normalizeProviderName,
  type AnyRecord,
} from "../services/kb_connectors/types.js";
import {
  KbConnectorError,
  assertNameAvailable,
  ensureDir,
  folderIdForPath,
  getDefaultKb,
  getKbEntry,
  getLinkedFolders,
  isDir,
  kbBaseDir,
  kbDir,
  kbEntryExists,
  listKbNames,
  rawDir,
  registerKbEntry,
  saveLinkedFolders,
  setDefaultKb,
  updateKbEntry,
  updateKbStatus,
} from "../services/kb_connectors/store.js";
import {
  assertPathAllowed,
  probeLinkedFolder,
} from "../services/kb_connectors/linked_kb.js";
import { signatureFromEmbeddingConfig } from "../services/kb_connectors/embedding_sig.js";
import {
  ImaClient,
  getAccountCredentials,
  pageLimit,
  probeKnowledgeBase,
} from "../services/kb_connectors/ima.js";
import {
  KiwixClient,
  KiwixError,
  normalizeKiwixBaseUrl,
  validateZimName,
} from "../services/kb_connectors/kiwix.js";
import {
  LIGHTRAG_SERVER_SUPPORTED_MODES,
  loadLightRagServerSettings,
  normalizeLightRagServerBaseUrl,
  probeServer,
} from "../services/kb_connectors/lightrag_server.js";
import { probeWeKnora } from "../services/kb_connectors/weknora.js";
import {
  assertWritableKb,
  createKbFolder,
  deleteKbFile,
  DocumentExtractionError,
  listKbRawFiles,
  moveKbFile,
  previewResolvedFile,
  resolveRawFile,
  resolveRawDir,
  MAX_FILE_SIZE,
} from "../services/kb_connectors/files.js";
import { VisualAssetStore } from "../services/kb_connectors/visual_assets.js";
import {
  buildUniqueTaskId,
  getTaskMetadata,
  streamTaskLogs,
  taskStreamManager,
  updateTaskStatus,
} from "../services/kb_connectors/tasks.js";
import {
  IMAGE_EXTENSIONS,
  acceptedUploadExtensions,
  collectSupportedFiles,
} from "../services/kb_connectors/file_types.js";
import { isConnectedKb as _isConnectedKb } from "../services/kb_connectors/types.js";

export const knowledgeConnectorsRouter = new Hono();

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

async function body(c: Context): Promise<AnyRecord> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as AnyRecord)
      : {};
  } catch {
    return {};
  }
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

// Map service errors to HTTP statuses like upstream ValueError→400, missing→404.
function connectorError(c: Context, exc: unknown, fallback = "Internal error"): Response {
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (exc instanceof KbConnectorError) {
    const lower = msg.toLowerCase();
    if (lower.includes("not found")) return httpError(c, 404, msg);
    if (lower.includes("already exists")) return httpError(c, 400, msg);
    return httpError(c, 400, msg);
  }
  if (exc instanceof KiwixError) return httpError(c, 400, msg);
  return httpError(c, 500, msg || fallback);
}

// ===========================================================================
// Connectors
// ===========================================================================

// POST /knowledge-bases/connect-obsidian
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-obsidian", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  const vaultPath = str(b["vault_path"]).trim();
  if (!name || !vaultPath) {
    return httpError(c, 400, "Both name and vault_path are required.");
  }
  try {
    const settings = getSettings();
    const folder = assertPathAllowed(vaultPath);
    let resourceId = "";
    const entry = registerKbEntry(settings, assertNameAvailable(settings, name), {
      path: name,
      type: "obsidian",
      vault_path: folder,
      description: `Obsidian vault: ${name}`,
      status: "ready",
      needs_reindex: false,
    });
    resourceId = str(entry["id"] ?? name);
    return c.json({
      status: "connected",
      id: resourceId,
      name,
      vault_path: entry["vault_path"],
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/connect-marginnote4
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-marginnote4", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  if (!name) return httpError(c, 400, "name is required.");
  try {
    const settings = getSettings();
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "marginnote4",
      description: str(b["description"]).trim() || `MarginNote 4 library: ${safe}`,
      status: "ready",
      needs_reindex: false,
      ...(str(b["db_path"]).trim() ? { db_path: str(b["db_path"]).trim() } : {}),
    });
    const result: AnyRecord = { status: "connected", id: safe, name: safe };
    if (entry["db_path"]) result["db_path"] = entry["db_path"];
    return c.json(result);
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/probe-folder
knowledgeConnectorsRouter.post("/api/knowledge-bases/probe-folder", async (c) => {
  const b = await body(c);
  const folderPath = str(b["folder_path"]).trim();
  if (!folderPath) return httpError(c, 400, "folder_path is required.");
  try {
    const folder = assertPathAllowed(folderPath);
    const settings = getSettings();
    const sig = await signatureFromEmbeddingConfig(settings);
    const result = probeLinkedFolder(
      folder,
      normalizeProviderName(b["rag_provider"] ?? DEFAULT_PROVIDER),
      {
        model: sig?.model ?? null,
        hash: sig ? sigHashLocal(sig) : null,
      },
    );
    return c.json(result);
  } catch (exc) {
    return connectorError(c, exc);
  }
});

import { signatureHash as sigHashLocal } from "../services/kb_connectors/embedding_sig.js";

// POST /knowledge-bases/connect-folder
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-folder", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  const folderPath = str(b["folder_path"]).trim();
  if (!name || !folderPath) {
    return httpError(c, 400, "Both name and folder_path are required.");
  }
  try {
    const settings = getSettings();
    const folder = assertPathAllowed(folderPath);
    const sig = await signatureFromEmbeddingConfig(settings);
    const result = probeLinkedFolder(
      folder,
      normalizeProviderName(b["rag_provider"] ?? DEFAULT_PROVIDER),
      { model: sig?.model ?? null, hash: sig ? sigHashLocal(sig) : null },
    );
    if (!result.ok) {
      return httpError(c, 400, result.error || "Folder is not linkable.");
    }
    const stats: AnyRecord = {
      embedding_model: result.embedding.index_model,
      doc_count: result.doc_count,
    };
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "linked",
      external_path: result.external_path,
      rag_provider: result.provider,
      description: `Linked ${result.provider} index: ${safe}`,
      status: "ready",
      needs_reindex: false,
      ...(stats.embedding_model !== null
        ? {
            embedding_model: stats.embedding_model,
            last_indexed_count: stats.doc_count,
            last_indexed_action: "link",
          }
        : {}),
    });
    return c.json({
      status: "connected",
      id: safe,
      name: safe,
      external_path: entry["external_path"],
      rag_provider: entry["rag_provider"],
      warnings: result.warnings,
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/probe-lightrag-server
knowledgeConnectorsRouter.post("/api/knowledge-bases/probe-lightrag-server", async (c) => {
  const b = await body(c);
  const serverUrl = str(b["server_url"]).trim();
  if (!serverUrl) return httpError(c, 400, "server_url is required.");
  let apiKey = str(b["api_key"]);
  if (b["use_saved_api_key"] === true && !apiKey) {
    const settings = getSettings();
    const defaults = loadLightRagServerSettings(settings);
    if (
      normalizeLightRagServerBaseUrl(defaults["server_url"]) ===
      normalizeLightRagServerBaseUrl(serverUrl)
    ) {
      apiKey = str(defaults["api_key"]);
    }
  }
  const result = await probeServer(serverUrl, apiKey);
  return c.json(result);
});

// POST /knowledge-bases/connect-lightrag-server
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-lightrag-server", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  const serverUrl = str(b["server_url"]).trim();
  if (!name || !serverUrl) {
    return httpError(c, 400, "Both name and server_url are required.");
  }
  const settings = getSettings();
  let apiKey = str(b["api_key"]);
  if (!apiKey) {
    const defaults = loadLightRagServerSettings(settings);
    if (
      normalizeLightRagServerBaseUrl(defaults["server_url"]) ===
      normalizeLightRagServerBaseUrl(serverUrl)
    ) {
      apiKey = str(defaults["api_key"]);
    }
  }
  const result = await probeServer(serverUrl, apiKey);
  if (!result.ok) {
    return httpError(c, 400, result.error || "Could not connect to the LightRAG server.");
  }
  let searchMode = str(b["search_mode"]).trim().toLowerCase();
  if (searchMode && !LIGHTRAG_SERVER_SUPPORTED_MODES.includes(searchMode)) searchMode = "";
  try {
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "lightrag_server",
      rag_provider: LIGHTRAG_SERVER_PROVIDER,
      server_url: result.base_url,
      api_key: apiKey.trim(),
      description: `LightRAG server: ${safe}`,
      status: "ready",
      needs_reindex: false,
      ...(searchMode ? { search_mode: searchMode } : {}),
    });
    return c.json({
      status: "connected",
      id: safe,
      name: safe,
      server_url: entry["server_url"],
      rag_provider: entry["rag_provider"],
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/probe-weknora
knowledgeConnectorsRouter.post("/api/knowledge-bases/probe-weknora", async (c) => {
  const b = await body(c);
  const serverUrl = str(b["server_url"]).trim();
  const kbId = str(b["knowledge_base_id"]).trim();
  if (!serverUrl || !kbId) {
    return httpError(c, 400, "Both server_url and knowledge_base_id are required.");
  }
  const result = await probeWeKnora(serverUrl, str(b["api_key"]), kbId);
  return c.json(result);
});

// POST /knowledge-bases/connect-weknora
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-weknora", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  const serverUrl = str(b["server_url"]).trim();
  const kbId = str(b["knowledge_base_id"]).trim();
  if (!name || !serverUrl || !kbId) {
    return httpError(c, 400, "name, server_url, and knowledge_base_id are required.");
  }
  const result = await probeWeKnora(serverUrl, str(b["api_key"]), kbId);
  if (!result.ok) {
    return httpError(c, 400, result.error || "Could not connect to the WeKnora knowledge base.");
  }
  try {
    const settings = getSettings();
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "weknora",
      rag_provider: WEKNORA_PROVIDER,
      server_url: result.base_url,
      api_key: str(b["api_key"]).trim(),
      knowledge_base_id: result.knowledge_base_id,
      description: `WeKnora knowledge base: ${safe}`,
      status: "ready",
      needs_reindex: false,
    });
    return c.json({
      status: "connected",
      id: safe,
      name: safe,
      server_url: entry["server_url"],
      knowledge_base_id: entry["knowledge_base_id"],
      rag_provider: entry["rag_provider"],
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// -- IMA ---------------------------------------------------------------------

function resolveImaCredentials(settings: Settings, clientId: string, apiKey: string) {
  const supplied = {
    client_id: String(clientId ?? "").trim(),
    api_key: String(apiKey ?? "").trim(),
  };
  if (supplied.client_id || supplied.api_key) return supplied;
  return getAccountCredentials(settings);
}

// POST /knowledge-bases/list-ima
knowledgeConnectorsRouter.post("/api/knowledge-bases/list-ima", async (c) => {
  const b = await body(c);
  const settings = getSettings();
  const credentials = resolveImaCredentials(settings, str(b["client_id"]), str(b["api_key"]));
  if (!credentials.client_id || !credentials.api_key) {
    return httpError(c, 400, "Client ID and API key are required.");
  }
  const limit = Math.min(Math.max(Number(b["limit"]) || 20, 1), 50);
  const client = new ImaClient(credentials.client_id, credentials.api_key);
  try {
    const result = await client.searchKnowledgeBases(
      "",
      str(b["cursor"]).trim(),
      pageLimit(limit),
    );
    return c.json(result);
  } catch (exc) {
    const name = (exc as Error)?.constructor?.name ?? "";
    if (name === "ImaAuthError") return httpError(c, 401, "IMA rejected the supplied credentials.");
    if (name === "ImaRateLimitError") return httpError(c, 429, "IMA rate limit reached. Try again shortly.");
    if (name === "ImaAPIError") return httpError(c, 502, "IMA returned an invalid response.");
    return httpError(c, 502, "Could not reach Tencent IMA.");
  }
});

// POST /knowledge-bases/probe-ima
knowledgeConnectorsRouter.post("/api/knowledge-bases/probe-ima", async (c) => {
  const b = await body(c);
  const settings = getSettings();
  const credentials = resolveImaCredentials(settings, str(b["client_id"]), str(b["api_key"]));
  const result = await probeKnowledgeBase(
    credentials.client_id,
    credentials.api_key,
    str(b["knowledge_base_id"]),
  );
  return c.json(result);
});

// POST /knowledge-bases/connect-ima
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-ima", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  if (!name) return httpError(c, 400, "Knowledge base name is required.");
  const settings = getSettings();
  const overrides = {
    client_id: str(b["client_id"]).trim(),
    api_key: str(b["api_key"]).trim(),
  };
  const credentials = resolveImaCredentials(settings, overrides.client_id, overrides.api_key);
  const result = await probeKnowledgeBase(
    credentials.client_id,
    credentials.api_key,
    str(b["knowledge_base_id"]),
  );
  if (!result.ok) {
    return httpError(c, 400, result.error || "Could not connect to the IMA knowledge base.");
  }
  try {
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "ima",
      rag_provider: IMA_PROVIDER,
      // Credentials omitted from the request stay account-level (not copied).
      ...(overrides.client_id
        ? { client_id: overrides.client_id, api_key: overrides.api_key }
        : {}),
      knowledge_base_id: str(b["knowledge_base_id"]).trim(),
      description: result.description || `Tencent IMA: ${safe}`,
      status: "ready",
      needs_reindex: false,
    });
    return c.json({
      status: "connected",
      id: safe,
      name: safe,
      knowledge_base_id: entry["knowledge_base_id"],
      rag_provider: entry["rag_provider"],
    });
  } catch (exc) {
    if (exc instanceof KbConnectorError) return connectorError(c, exc);
    return httpError(c, 500, "Could not connect the IMA knowledge base.");
  }
});

// -- KiWix ----------------------------------------------------------------------

// GET /knowledge-bases/kiwix-catalog
knowledgeConnectorsRouter.get("/api/knowledge-bases/kiwix-catalog", async (c) => {
  const serverUrl = (c.req.query("server_url") ?? "").trim();
  const q = (c.req.query("q") ?? "").slice(0, 100);
  if (!serverUrl) return httpError(c, 400, "server_url is required.");
  try {
    const archives = await KiwixClient.listArchives(serverUrl, q);
    return c.json({
      archives: archives.map((a) => ({ zim_name: a.zim_name, title: a.title })),
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/probe-kiwix
knowledgeConnectorsRouter.post("/api/knowledge-bases/probe-kiwix", async (c) => {
  const b = await body(c);
  try {
    const client = new KiwixClient(str(b["server_url"]), str(b["zim_name"]));
    const title = await client.probe();
    return c.json({ ok: true, zim_name: client.zimName, title });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/connect-kiwix
knowledgeConnectorsRouter.post("/api/knowledge-bases/connect-kiwix", async (c) => {
  const b = await body(c);
  const name = str(b["name"]).trim();
  try {
    const settings = getSettings();
    const client = new KiwixClient(str(b["server_url"]), str(b["zim_name"]));
    const title = await client.probe();
    const safe = assertNameAvailable(settings, name);
    const entry = registerKbEntry(settings, safe, {
      path: safe,
      type: "kiwix",
      rag_provider: KIWIX_PROVIDER,
      server_url: client.baseUrl,
      zim_name: client.zimName,
      zim_title: title.slice(0, 300),
      description: `Kiwix archive: ${title || client.zimName}`,
      status: "ready",
      needs_reindex: false,
    });
    return c.json({
      status: "connected",
      id: safe,
      name,
      zim_name: entry["zim_name"],
      title: entry["zim_title"],
      rag_provider: entry["rag_provider"],
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/kiwix-articles
knowledgeConnectorsRouter.get("/api/knowledge-bases/kiwix-articles", async (c) => {
  const kbRef = (c.req.query("kb_ref") ?? "").trim();
  const q = (c.req.query("q") ?? "").trim();
  if (!kbRef || !q) return httpError(c, 400, "kb_ref and q are required.");
  try {
    const settings = getSettings();
    const entry = getKbEntry(settings, kbRef);
    if (!entry || entry["type"] !== "kiwix") {
      return httpError(c, 404, "Kiwix knowledge base not found.");
    }
    const client = new KiwixClient(str(entry["server_url"]), str(entry["zim_name"]));
    const results = await client.search(q, 10);
    return c.json({
      articles: results.map(({ hit, content }) => ({
        title: hit.title,
        article_path: hit.article_path,
        excerpt: String(content ?? "").slice(0, 500),
      })),
    });
  } catch (exc) {
    if (exc instanceof KiwixError) return httpError(c, 502, exc.message || "Kiwix search failed.");
    return connectorError(c, exc);
  }
});

// ===========================================================================
// Supported file types / embedding usage / default KB
// ===========================================================================

const IMAGE_ACCEPT_MIME_TYPES: Record<string, string> = {
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

// GET /knowledge-bases/supported-file-types
knowledgeConnectorsRouter.get("/api/knowledge-bases/supported-file-types", (c) => {
  const accepted = acceptedUploadExtensions();
  const allowAny = accepted.size === 0;
  const extensions = [...accepted].sort();
  const acceptItems = allowAny
    ? []
    : [
        ...extensions,
        ...Object.entries(IMAGE_ACCEPT_MIME_TYPES)
          .filter(([ext]) => IMAGE_EXTENSIONS.has(ext))
          .map(([, mime]) => mime),
      ];
  return c.json({
    extensions,
    accept: [...new Set(acceptItems)].join(","),
    max_file_size_bytes: MAX_FILE_SIZE,
    allow_any_extension: allowAny,
  });
});

// GET /knowledge-bases/embedding-usage
knowledgeConnectorsRouter.get("/api/knowledge-bases/embedding-usage", (c) => {
  const settings = getSettings();
  const usage: AnyRecord[] = [];
  const connection = database.connect(settings);
  try {
    const rows = connection.prepare("SELECT name, payload FROM kb_meta").all() as {
      name: string;
      payload: string;
    }[];
    for (const row of rows) {
      let entry: AnyRecord;
      try {
        entry = JSON.parse(row.payload);
      } catch {
        continue;
      }
      const selection = entry["embedding_selection"];
      if (selection !== null && typeof selection === "object" && !Array.isArray(selection)) {
        usage.push({ name: row.name, workspace_name: "", ...selection });
      }
    }
  } finally {
    connection.close();
  }
  return c.json({ knowledge_bases: usage });
});

// GET /knowledge-bases/default
knowledgeConnectorsRouter.get("/api/knowledge-bases/default", (c) => {
  return c.json({ default_kb: getDefaultKb(getSettings()) });
});

// PUT /knowledge-bases/default/{kb_name}
knowledgeConnectorsRouter.put("/api/knowledge-bases/default/:kb_name", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  try {
    setDefaultKb(getSettings(), name);
    return c.json({ status: "success", default_kb: name });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// ===========================================================================
// Tasks
// ===========================================================================

// GET /knowledge-bases/tasks/{task_id}/stream
knowledgeConnectorsRouter.get("/api/knowledge-bases/tasks/:task_id/stream", streamTaskLogs);

// GET /knowledge-bases/tasks/{task_id} — task metadata (status probe)
knowledgeConnectorsRouter.get("/api/knowledge-bases/tasks/:task_id", (c) => {
  const meta = getTaskMetadata(c.req.param("task_id") ?? "");
  if (meta === null) return httpError(c, 404, "task not found");
  return c.json(meta);
});

// ===========================================================================
// Files / folders
// ===========================================================================

// NOTE: GET /knowledge-bases/{kb_name} (detail) is registered in handlers.ts,
// which mounts late. Registering it here would shadow the single-segment
// static routes owned by the later routers (/list, /health, /configs,
// /rag-providers) — Hono is first-match-wins.

// GET /knowledge-bases/{kb_name}/files — NOTE: handlers.ts also defines this;
// this version returns the upstream folder-aware shape. Mount order decides.
knowledgeConnectorsRouter.get("/api/knowledge-bases/:kb_name/files", (c) => {
  const name = c.req.param("kb_name") ?? "";
  try {
    return c.json(listKbRawFiles(getSettings(), name));
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/{kb_name}/folders
knowledgeConnectorsRouter.post("/api/knowledge-bases/:kb_name/folders", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const b = await body(c);
  try {
    return c.json(createKbFolder(getSettings(), name, str(b["path"])));
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/{kb_name}/files/move
knowledgeConnectorsRouter.post("/api/knowledge-bases/:kb_name/files/move", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const b = await body(c);
  try {
    return c.json(
      moveKbFile(getSettings(), name, str(b["source"]), str(b["dest_folder"])),
    );
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/{kb_name}/file-preview-text/{filename}
knowledgeConnectorsRouter.get(
  "/api/knowledge-bases/:kb_name/file-preview-text/*",
  async (c) => {
    const name = c.req.param("kb_name") ?? "";
    const filename = c.req.path.split(`/file-preview-text/`)[1] ?? "";
    try {
      const resolved = resolveRawFile(getSettings(), name, filename);
      const text = previewResolvedFile(resolved);
      return new Response(text, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    } catch (exc) {
      if (exc instanceof DocumentExtractionError) {
        return httpError(c, 422, exc.message);
      }
      if (exc instanceof KbConnectorError && exc.message === "File not found") {
        return httpError(c, 404, "File not found");
      }
      return connectorError(c, exc);
    }
  },
);

// GET /knowledge-bases/{kb_name}/files/{filename} — raw file download/preview
knowledgeConnectorsRouter.get("/api/knowledge-bases/:kb_name/files/*", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const filename = c.req.path.split(`/files/`)[1] ?? "";
  try {
    const resolved = resolveRawFile(getSettings(), name, filename);
    const mime =
      resolved.mime ??
      (resolved.name.endsWith(".pdf")
        ? "application/pdf"
        : "application/octet-stream");
    const headers: Record<string, string> = {
      "Content-Type": mime,
      "Content-Disposition": `inline; filename="${basename(resolved.name).replace(/"/g, "")}"`,
    };
    if (resolved.kind === "fs" && resolved.path) {
      const size = statSync(resolved.path).size;
      headers["Content-Length"] = String(size);
      const stream = Readable.toWeb(createReadStream(resolved.path)) as ReadableStream;
      return new Response(stream, { headers });
    }
    const data = resolved.data ?? new Uint8Array();
    headers["Content-Length"] = String(data.length);
    return new Response(new Blob([new Uint8Array(data)]), { headers });
  } catch (exc) {
    if (exc instanceof KbConnectorError && exc.message === "File not found") {
      return httpError(c, 404, "File not found");
    }
    if (exc instanceof KbConnectorError && exc.message === "Access denied") {
      return httpError(c, 403, "Access denied");
    }
    return connectorError(c, exc);
  }
});

// DELETE /knowledge-bases/{kb_name}/files/{filename}
knowledgeConnectorsRouter.delete("/api/knowledge-bases/:kb_name/files/*", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const filename = c.req.path.split(`/files/`)[1] ?? "";
  try {
    return c.json(deleteKbFile(getSettings(), name, filename));
  } catch (exc) {
    if (exc instanceof DocumentExtractionError) return httpError(c, 422, exc.message);
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/{kb_name}/visual-assets/{asset_id}
knowledgeConnectorsRouter.get(
  "/api/knowledge-bases/:kb_name/visual-assets/:asset_id",
  (c) => {
    const name = c.req.param("kb_name") ?? "";
    const assetId = c.req.param("asset_id") ?? "";
    try {
      const settings = getSettings();
      resolveRawDir(settings, name); // 409 for connected KBs
      const store = new VisualAssetStore(kbDir(settings, name));
      const loaded = store.read(assetId);
      if (loaded === null) return httpError(c, 404, "Visual asset not found");
      const mime = String(loaded.record["mime_type"] ?? "application/octet-stream");
      return new Response(new Uint8Array(loaded.data), {
        headers: {
          "Content-Type": mime,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (exc) {
      return connectorError(c, exc);
    }
  },
);

// ===========================================================================
// Linked folders
// ===========================================================================

// POST /knowledge-bases/{kb_name}/link-folder
knowledgeConnectorsRouter.post("/api/knowledge-bases/:kb_name/link-folder", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const b = await body(c);
  try {
    const settings = getSettings();
    const entry = assertWritableKb(settings, name);
    if (isConnectedKb(entry)) {
      return httpError(c, 400, "Connected knowledge bases cannot link folders.");
    }
    const folderPath = str(b["folder_path"]).trim();
    const folder = resolve(folderSafe(folderPath));
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      throw new KbConnectorError(`Folder does not exist: ${folder}`);
    }
    const files = collectSupportedFiles(folder, true);
    const folderId = folderIdForPath(folder);
    const folders = getLinkedFolders(settings, name);
    const existing = folders.find((f) => f["id"] === folderId);
    if (existing) return c.json(existing);
    const info: AnyRecord = {
      id: folderId,
      path: folder,
      added_at: new Date().toISOString(),
      file_count: files.length,
      last_sync: null,
    };
    folders.push(info);
    saveLinkedFolders(settings, name, folders);
    return c.json(info);
  } catch (exc) {
    if (exc instanceof KbConnectorError && exc.message.toLowerCase().includes("not found")) {
      return httpError(c, 404, exc.message);
    }
    return connectorError(c, exc);
  }
});

function folderSafe(p: string): string {
  let folder = String(p ?? "").trim();
  if (folder.startsWith("~/")) {
    folder = join(homedir(), folder.slice(2));
  }
  return folder;
}

// GET /knowledge-bases/{kb_name}/linked-folders
knowledgeConnectorsRouter.get("/api/knowledge-bases/:kb_name/linked-folders", (c) => {
  const name = c.req.param("kb_name") ?? "";
  try {
    const settings = getSettings();
    if (getKbEntry(settings, name) === null) {
      return httpError(c, 404, `Knowledge base '${name}' not found`);
    }
    return c.json(getLinkedFolders(settings, name));
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// DELETE /knowledge-bases/{kb_name}/linked-folders/{folder_id}
knowledgeConnectorsRouter.delete("/api/knowledge-bases/:kb_name/linked-folders/:folder_id", (c) => {
  const name = c.req.param("kb_name") ?? "";
  const folderId = c.req.param("folder_id") ?? "";
  try {
    const settings = getSettings();
    const entry = assertWritableKb(settings, name);
    if (isConnectedKb(entry)) {
      return httpError(c, 400, "Connected knowledge bases cannot unlink folders.");
    }
    const folders = getLinkedFolders(settings, name);
    const remaining = folders.filter((f) => f["id"] !== folderId);
    if (remaining.length === folders.length) {
      return httpError(c, 404, `Folder '${folderId}' not found`);
    }
    saveLinkedFolders(settings, name, remaining);
    return c.json({ message: "Folder unlinked successfully", folder_id: folderId });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/{kb_name}/sync-folder/{folder_id}
knowledgeConnectorsRouter.post("/api/knowledge-bases/:kb_name/sync-folder/:folder_id", async (c) => {
  const name = c.req.param("kb_name") ?? "";
  const folderId = c.req.param("folder_id") ?? "";
  try {
    const settings = getSettings();
    const entry = assertWritableKb(settings, name);
    const folders = getLinkedFolders(settings, name);
    const folderInfo = folders.find((f) => f["id"] === folderId);
    if (!folderInfo) {
      return httpError(c, 404, `Linked folder '${folderId}' not found`);
    }
    const folderPath = String(folderInfo["path"] ?? "");
    const syncedFiles = (folderInfo["synced_files"] ?? {}) as Record<string, string>;

    // detect changes
    const files = collectSupportedFiles(folderPath, true);
    const newFiles: string[] = [];
    const modifiedFiles: string[] = [];
    for (const filePath of files) {
      const prev = syncedFiles[filePath];
      if (prev === undefined) {
        newFiles.push(filePath);
      } else {
        try {
          const mtime = statSync(filePath).mtime.toISOString();
          if (mtime > prev) modifiedFiles.push(filePath);
        } catch {
          modifiedFiles.push(filePath);
        }
      }
    }
    const filesToProcess = [...newFiles, ...modifiedFiles];

    if (!filesToProcess.length) {
      // persist sync state even when nothing changed
      folderInfo["last_sync"] = new Date().toISOString();
      saveLinkedFolders(settings, name, folders);
      return c.json({
        message: "No new or modified files to sync",
        folder_path: folderPath,
        files: [],
        new_files: 0,
        modified_files: 0,
        file_count: 0,
        task_id: null,
      });
    }

    const taskId = buildUniqueTaskId("kb_upload", `${name}_folder_${folderId}`);
    updateKbStatus(settings, name, "processing", {
      stage: "starting",
      message: `Syncing ${filesToProcess.length} file(s) from linked folder...`,
      percent: 0,
      task_id: taskId,
      timestamp: new Date().toISOString(),
    });

    // Background copy into raw/ preserving relative paths + sqlite index.
    void (async () => {
      try {
        const root = rawDir(settings, name);
        ensureDir(root);
        const synced: Record<string, string> = { ...syncedFiles };
        const kb = new KnowledgeBaseStore(settings);
        let done = 0;
        for (const src of filesToProcess) {
          const rel = src.startsWith(folderPath)
            ? src.slice(folderPath.length).replace(/^\/+/, "")
            : basename(src);
          const dest = join(root, rel);
          ensureDir(join(dest, ".."));
          const { copyFileSync } = await import("node:fs");
          copyFileSync(src, dest);
          synced[src] = statSync(src).mtime.toISOString();
          done++;
          taskStreamManager.emit(taskId, "process_log", {
            level: "INFO",
            message: `Synced ${done}/${filesToProcess.length}: ${rel}`,
            logger: "deeptutor.knowledge.task",
            timestamp: Date.now() / 1000,
            context: { task_id: taskId, capability: "knowledge", sink: "ui" },
          });
        }
        // Mirror into sqlite kb_docs so keyword retrieval sees them.
        for (const src of filesToProcess) {
          const rel = src.startsWith(folderPath)
            ? src.slice(folderPath.length).replace(/^\/+/, "")
            : basename(src);
          const { readFileSync } = await import("node:fs");
          try {
            kb.add_document(name, rel, new Uint8Array(readFileSync(join(root, rel))));
          } catch {
            /* individual file failure is non-fatal */
          }
        }
        const foldersNow = getLinkedFolders(settings, name);
        const target = foldersNow.find((f) => f["id"] === folderId);
        if (target) {
          target["last_sync"] = new Date().toISOString();
          target["synced_files"] = synced;
          target["file_count"] = Object.keys(synced).length;
          saveLinkedFolders(settings, name, foldersNow);
        }
        updateKbStatus(settings, name, "ready", null);
        taskStreamManager.emitComplete(taskId, "Folder sync completed");
        updateTaskStatus(taskId, "completed");
      } catch (exc) {
        const msg = exc instanceof Error ? exc.message : String(exc);
        updateKbStatus(settings, name, "error", {
          stage: "error",
          message: msg,
          percent: 0,
          task_id: taskId,
          timestamp: new Date().toISOString(),
          error: msg,
        });
        taskStreamManager.emitFailed(taskId, msg);
        updateTaskStatus(taskId, "error");
      }
    })();

    return c.json({
      message: `Syncing ${filesToProcess.length} files from linked folder`,
      folder_path: folderPath,
      files: filesToProcess,
      new_files: newFiles.length,
      modified_files: modifiedFiles.length,
      file_count: filesToProcess.length,
      task_id: taskId,
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});
