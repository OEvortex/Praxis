// Port of the remaining knowledge.py surface not covered by
// knowledge_connectors.ts / knowledge_rag.ts: KB config CRUD + sync, delete-by-
// body, indexing run/progress/reindex/readiness, visual coverage + source-page,
// and the GitHub/web document-source endpoints.
import { Hono } from "hono";
import type { Context } from "hono";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { getSettings } from "../config.js";
import type { Settings } from "../config.js";
import {
  getKbEntry,
  listKbNames,
  kbDir,
  rawDir,
  kbBaseDir,
  updateKbEntry,
  KbConnectorError,
} from "../services/kb_connectors/store.js";
import {
  assertWritableKb,
  resolveRawDir,
  resolveRawFile,
} from "../services/kb_connectors/files.js";
import { isConnectedKb, normalizeProviderName, type AnyRecord } from "../services/kb_connectors/types.js";
import {
  addGithubSource,
  getGithubSources,
  removeGithubSource,
  addWebSource,
  getWebSources,
  getWebSource,
  removeWebSource,
  updateWebSourceSchedule,
} from "../services/kb_connectors/kb_sources.js";
import { syncGithubSource } from "../services/kb_connectors/github_source.js";
import {
  syncWebSource,
  webSourceSyncRepo,
  webSourceJobPublic,
  WEB_SOURCE_OWNER_ID,
} from "../services/kb_connectors/web_source.js";
import {
  ProgressTracker,
  beginRun,
  loadRun,
  requestCancel,
  runReindexTask,
  visibleRun,
  indexingReadiness,
  sha256File,
} from "../services/kb_connectors/indexing.js";
import { collectSupportedFiles } from "../services/kb_connectors/file_types.js";
import { VisualAssetStore } from "../services/kb_connectors/visual_assets.js";
import { renderPdfPageImage } from "../services/kb_connectors/pdf_page.js";
import {
  buildUniqueTaskId,
  taskStreamManager,
} from "../services/kb_connectors/tasks.js";

export const knowledgeIndexingRouter = new Hono();

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

async function formBody(c: Context): Promise<Record<string, unknown>> {
  const holder = c as unknown as { __formBody?: Promise<Record<string, unknown>> };
  if (!holder.__formBody) {
    holder.__formBody = c.req.parseBody().then((b) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(b)) out[k] = v;
      return out;
    }).catch(() => ({}));
  }
  return holder.__formBody;
}

function connectorError(c: Context, exc: unknown): Response {
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (exc instanceof KbConnectorError) {
    const lower = msg.toLowerCase();
    if (lower.includes("not found")) return httpError(c, 404, msg);
    return httpError(c, 400, msg);
  }
  return httpError(c, 500, msg || "Internal error");
}

// Upstream ``_writable_kb``: resolve a writable local KB or raise.
function writableKb(settings: Settings, kbName: string): { entry: AnyRecord; name: string } {
  const entry = assertWritableKb(settings, kbName);
  return { entry, name: kbName };
}

function kbEntryOr404(settings: Settings, kbName: string): AnyRecord {
  const entry = getKbEntry(settings, kbName);
  if (entry === null) throw new KbConnectorError(`KB '${kbName}' not found`);
  return entry;
}

// ===========================================================================
// Health / configs
// ===========================================================================

// GET /knowledge-bases/health
knowledgeIndexingRouter.get("/api/knowledge-bases/health", (c) => {
  try {
    const settings = getSettings();
    const base = kbBaseDir(settings);
    const configExists = listKbNames(settings).length > 0 || existsSync(join(base, "kb_config.json"));
    return c.json({
      status: "ok",
      config_file: join(base, "kb_config.json"),
      config_exists: configExists,
      base_dir: base,
      base_dir_exists: existsSync(base),
      knowledge_bases_count: listKbNames(settings).length,
    });
  } catch (exc) {
    return c.json({ status: "error", error: exc instanceof Error ? exc.message : String(exc) });
  }
});

// GET /knowledge-bases/configs — all KB configs (upstream kb_config service).
knowledgeIndexingRouter.get("/api/knowledge-bases/configs", (c) => {
  try {
    const settings = getSettings();
    const configs: AnyRecord = {};
    for (const name of listKbNames(settings)) {
      const entry = getKbEntry(settings, name);
      if (entry) {
        const { name: _n, ...rest } = entry;
        configs[name] = rest;
      }
    }
    return c.json(configs);
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/{kb_name}/config
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/config", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const entry = kbEntryOr404(settings, name);
    const { name: _n, ...config } = entry;
    return c.json({ kb_name: name, config });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// PUT /knowledge-bases/{kb_name}/config
knowledgeIndexingRouter.put("/api/knowledge-bases/:kb_name/config", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const config = await body(c);
    const entry = kbEntryOr404(settings, name);
    const current = { ...entry };
    delete current["name"];

    // Upstream: embedding_* fields are immutable here (409).
    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith("embedding_") && JSON.stringify(value) !== JSON.stringify(current[key])) {
        return httpError(c, 409, "Change a knowledge base's embedding model through re-indexing.");
      }
    }

    if ("rag_provider" in config) {
      const requested = normalizeProviderName(config["rag_provider"]);
      const currentProvider = normalizeProviderName(current["rag_provider"]);
      if (requested !== currentProvider) {
        if (!isConnectedKb(entry)) {
          // A ready local index blocks silent provider rebinding (upstream
          // checks has_ready_provider_index; our sqlite index counts docs).
          const { KnowledgeBaseStore } = await import("../store/kb_store.js");
          const docs = new KnowledgeBaseStore(settings).list_documents(name);
          if (docs.length > 0) {
            return httpError(
              c,
              409,
              `Knowledge base '${name}' already has a ready ${currentProvider} index. Provider changes require an explicit re-index/migration instead of a silent config edit.`,
            );
          }
        }
        config["needs_reindex"] = true;
        config["status"] = "needs_reindex";
        config["progress"] = {
          stage: "needs_reindex",
          message: `Provider changed from ${currentProvider} to ${requested}; re-index this knowledge base before use.`,
          percent: 0,
          timestamp: new Date().toISOString(),
        };
      }
      config["rag_provider"] = requested;
    }

    const merged = updateKbEntry(settings, name, (e) => {
      for (const [k, v] of Object.entries(config)) e[k] = v;
    });
    const { name: _n, ...out } = merged;
    return c.json({ status: "success", kb_name: name, config: out });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/configs/sync — upstream syncs metadata.json files into
// kb_config.json; our registry IS the config store, so this is a no-op success.
knowledgeIndexingRouter.post("/api/knowledge-bases/configs/sync", (c) => {
  return c.json({ status: "success", message: "Configurations synced from metadata files" });
});

// POST /knowledge-bases/delete — body-carried name (upstream path-segment fix).
knowledgeIndexingRouter.post("/api/knowledge-bases/delete", async (c) => {
  const b = await body(c);
  const name = str(b["name"]);
  if (!name) return httpError(c, 422, "name is required");
  return deleteKbByName(c, name);
});

async function deleteKbByName(c: Context, name: string): Promise<Response> {
  try {
    const settings = getSettings();
    const entry = kbEntryOr404(settings, name);
    // Mirror upstream _delete_kb: remove registry entry + on-disk dir.
    const { rmSync } = await import("node:fs");
    const dir = kbDir(settings, name);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    // Remove the registry row by writing an empty payload? kb_meta has no
    // delete helper; remove via updateKbEntry is impossible — use database.
    const database = await import("../store/database.js");
    const conn = database.connect(settings);
    try {
      conn.prepare("DELETE FROM kb_meta WHERE name = ?").run(name);
      conn.prepare("DELETE FROM kb_docs WHERE kb = ?").run(name);
      conn.prepare("DELETE FROM kb_chunks WHERE kb = ?").run(name);
    } finally {
      conn.close();
    }
    void entry;
    return c.json({ message: `Knowledge base '${name}' deleted successfully` });
  } catch (exc) {
    return connectorError(c, exc);
  }
}

// ===========================================================================
// Progress / indexing run / reindex / readiness
// ===========================================================================

// GET /knowledge-bases/{kb_name}/progress
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/progress", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    kbEntryOr404(settings, name);
    const progress = new ProgressTracker(settings, name).getProgress();
    if (progress === null) {
      return c.json({ status: "not_started", message: "Initialization not started" });
    }
    return c.json(progress);
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/{kb_name}/progress/clear
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/progress/clear", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKb(settings, name);
    new ProgressTracker(settings, name).clear();
    return c.json({ status: "success", message: `Progress cleared for ${name}` });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/{kb_name}/indexing-run
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/indexing-run", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    kbEntryOr404(settings, name);
    let run: AnyRecord | null;
    try {
      run = visibleRun(kbDir(settings, name));
    } catch {
      run = loadRun(kbDir(settings, name));
    }
    return c.json({ run });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// POST /knowledge-bases/{kb_name}/indexing-run/{task_id}/cancel
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/indexing-run/:task_id/cancel", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const taskId = c.req.param("task_id") ?? "";
    writableKb(settings, name);
    if (!requestCancel(kbDir(settings, name), taskId)) {
      return httpError(c, 409, "This indexing run is no longer active.");
    }
    return c.json({
      cancel_requested: true,
      message: "Cancellation takes effect at the next safe boundary; completed parser outputs remain reusable.",
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// GET /knowledge-bases/{kb_name}/indexing-readiness
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/indexing-readiness", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    kbEntryOr404(settings, name);
    return c.json(indexingReadiness(settings, name));
  } catch (exc) {
    return connectorError(c, exc);
  }
});

function writableKbEntry(settings: Settings, kbName: string): AnyRecord {
  const { entry } = writableKb(settings, kbName);
  return entry;
}

// POST /knowledge-bases/{kb_name}/reindex  (form-encoded like upstream)
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/reindex", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const form = await formBody(c);
    const indexingLlm = str(form["indexing_llm"] ?? "");
    const embeddingModel = str(form["embedding_model"] ?? "");

    const { entry } = writableKb(settings, name);
    const provider = normalizeProviderName(entry["rag_provider"]);

    if (indexingLlm) {
      return httpError(c, 400, "Per-knowledge-base indexing model overrides are no longer supported. Configure models in Settings.");
    }

    // Durable run journal: a live run blocks a second reindex (409).
    let previousRun: AnyRecord | null = null;
    try {
      previousRun = visibleRun(kbDir(settings, name));
    } catch {
      previousRun = null;
    }
    if (previousRun && String(previousRun["state"]) === "running") {
      return httpError(c, 409, "An indexing worker still owns this knowledge base.");
    }
    const forceReindex =
      String(entry["status"] ?? "").toLowerCase() === "error" ||
      ["partial", "failed", "cancelled", "interrupted"].includes(String(previousRun?.["state"] ?? ""));

    // Empty-KB embedding update: upstream short-circuits with a noop when the
    // KB has no supported files and no ready index.
    const raw = rawDir(settings, name);
    const files = collectSupportedFiles(raw, true);
    if (embeddingModel && !files.length) {
      updateKbEntry(settings, name, (e) => {
        e["embedding_model"] = embeddingModel;
        e["needs_reindex"] = false;
        e["status"] = "ready";
      });
      return c.json({
        message: "Embedding model updated for the empty knowledge base.",
        task_id: null,
        noop: true,
      });
    }

    const taskId = buildUniqueTaskId("kb_reindex", `${name}_reindex`);
    taskStreamManager.ensureTask(taskId);
    updateKbStatusViaEntry(settings, name, "processing", {
      stage: "initializing",
      message: "Queueing re-index...",
      percent: 0,
      task_id: taskId,
      timestamp: new Date().toISOString(),
    });
    beginRun(kbDir(settings, name), { taskId, provider, sources: files.map((f) => f.slice(raw.length + 1)) });

    void runReindexTask(settings, name, taskId);

    return c.json({
      message: `Re-indexing '${name}' in the background.`,
      task_id: taskId,
      signature: provider,
      noop: false,
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

function updateKbStatusViaEntry(settings: Settings, name: string, status: string, progress: AnyRecord): void {
  updateKbEntry(settings, name, (e) => {
    e["status"] = status;
    e["progress"] = progress;
  });
}

// POST /knowledge-bases/{kb_name}/retry
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/retry", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const { entry } = writableKb(settings, name);
    const status = String(entry["status"] ?? "").toLowerCase();
    const progress = (entry["progress"] ?? {}) as AnyRecord;
    const progressStage = String(progress["stage"] ?? "").toLowerCase();
    if (status !== "error" && progressStage !== "error") {
      return httpError(
        c,
        409,
        `Knowledge base '${name}' is not in an error state. Use re-index when you want to rebuild a healthy knowledge base.`,
      );
    }
    const provider = normalizeProviderName(entry["rag_provider"]);
    // Delegate to the reindex path (upstream calls reindex_knowledge_base):
    // queue a reindex task directly.
    const taskId = buildUniqueTaskId("kb_reindex", `${name}_retry`);
    taskStreamManager.ensureTask(taskId);
    updateKbStatusViaEntry(settings, name, "processing", {
      stage: "initializing",
      message: "Queueing re-index...",
      percent: 0,
      task_id: taskId,
      timestamp: new Date().toISOString(),
    });
    beginRun(kbDir(settings, name), { taskId, provider });
    void runReindexTask(settings, name, taskId);
    return c.json({
      message: `Re-indexing '${name}' in the background.`,
      task_id: taskId,
      signature: provider,
      noop: false,
    });
  } catch (exc) {
    return connectorError(c, exc);
  }
});

// ===========================================================================
// Visual coverage / source page
// ===========================================================================

function resolveKbRawDir(settings: Settings, kbName: string): string {
  const dir = resolveRawDir(settings, kbName);
  if (dir === null) throw new KbConnectorError(`Knowledge base '${kbName}' has no local files.`);
  return dir;
}

// GET /knowledge-bases/{kb_name}/visual-coverage
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/visual-coverage", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    kbEntryOr404(settings, name);
    const raw = resolveKbRawDir(settings, name);
    const kbPath = kbDir(settings, name);
    const sourcePath = c.req.query("source_path") ?? "";
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 200);

    const store = new VisualAssetStore(kbPath);
    // VisualAssetStore keeps its manifest private; read it via the public read()
    // for assets, and coverage reports from <visual_assets>/coverage/*.json.
    const records = listVisualRecords(store);
    const root = raw;
    const reports: AnyRecord[] = [];
    const files: string[] = [];
    if (sourcePath) {
      const candidate = resolve(join(root, sourcePath));
      if (candidate.startsWith(resolve(root) + sep) && existsSync(candidate) && statSync(candidate).isFile()) {
        files.push(candidate);
      }
    } else if (existsSync(root)) {
      collectFiles(root, files);
    }
    for (const path of files) {
      const key = path.slice(resolve(root).length + 1).split(sep).join("/");
      const digest = sha256File(path);
      const reportPath = join(store.root, "coverage", `${createHash("sha256").update(key, "utf8").digest("hex")}.json`);
      let report: AnyRecord;
      try {
        const parsed = JSON.parse(readFileSync(reportPath, "utf-8")) as AnyRecord;
        if (parsed["source_document_id"] !== digest) throw new Error("stale");
        report = parsed;
      } catch {
        report = {
          source_path: key,
          source_document_id: digest,
          whole_document_verified: false,
          issues: [{ status: "unverified", reason: "extraction_coverage_unknown" }],
          page_fallback: path.toLowerCase().endsWith(".pdf"),
        };
      }
      const retained = Object.values(records).filter(
        (r) => r["source_path"] === key && r["source_document_id"] === digest,
      );
      reports.push({
        ...report,
        retained_count: new Set(retained.map((r) => r["source_locator"])).size,
        indexing_status: "not_verified_by_extraction_report",
      });
    }
    const assets = Object.values(records).filter(
      (r) => !sourcePath || r["source_path"] === sourcePath,
    );
    return c.json({
      documents: reports,
      assets: assets.slice(offset, offset + limit),
      total_assets: assets.length,
      offset,
      limit,
      model_image_limit: 2,
    });
  } catch (exc) {
    if (exc instanceof KbConnectorError) return connectorError(c, exc);
    return httpError(c, 409, "Visual coverage is unreadable; original evidence files have been preserved.");
  }
});

function collectFiles(root: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(root, e.name);
    try {
      if (e.isDirectory()) collectFiles(p, out);
      else if (e.isFile()) out.push(p);
    } catch { /* ignore */ }
  }
}

function listVisualRecords(store: VisualAssetStore): Record<string, AnyRecord> {
  // VisualAssetStore exposes read(assetId) only; enumerate via its manifest file.
  try {
    const manifestPath = join((store as unknown as { root: string }).root, "manifest.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as AnyRecord;
    const assets = parsed["assets"];
    if (assets !== null && typeof assets === "object" && !Array.isArray(assets)) {
      return assets as Record<string, AnyRecord>;
    }
  } catch { /* empty */ }
  return {};
}

// GET /knowledge-bases/{kb_name}/source-page — rasterizes a PDF page (or a
// normalized region of it) via poppler pdftoppm / mutool, matching the
// upstream pymupdf page_image contract: image bytes + X-Source-Document-ID.
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/source-page", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    kbEntryOr404(settings, name);
    const sourcePath = c.req.query("source_path") ?? "";
    const page = Number(c.req.query("page") ?? "0");
    const sourceHash = c.req.query("source_hash") ?? "";
    const region = c.req.query("region") ?? "";
    if (!sourcePath || !Number.isInteger(page) || page < 1) {
      return httpError(c, 422, "source_path and a positive integer page are required");
    }
    resolveKbRawDir(settings, name);
    const resolved = resolveRawFile(settings, name, sourcePath);
    const fsPath = resolved.path ?? "";
    if (!fsPath || !existsSync(fsPath)) return httpError(c, 404, "Source file not found");
    const digest = sha256File(fsPath);
    if (sourceHash && digest !== sourceHash) {
      return httpError(c, 422, "The source changed since this reference was created. Select its current page explicitly.");
    }
    const isPdf = fsPath.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      return httpError(c, 422, "Page/region inspection supports PDF sources. Use the original document for other formats.");
    }
    const image = renderPdfPageImage(fsPath, page, region);
    return new Response(new Uint8Array(image.data), {
      status: 200,
      headers: {
        "Content-Type": image.mime,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Source-Document-ID": digest,
      },
    });
  } catch (exc) {
    if (exc instanceof KbConnectorError) return connectorError(c, exc);
    return httpError(c, 422, exc instanceof Error ? exc.message : String(exc));
  }
});

// ===========================================================================
// GitHub sources
// ===========================================================================

function githubSourceInfo(s: AnyRecord): AnyRecord {
  return {
    id: s["id"], repo: s["repo"], branch: s["branch"], path: s["path"], glob: s["glob"],
    enabled: s["enabled"] ?? true,
    last_synced_sha: s["last_synced_sha"] ?? "",
    last_synced_at: s["last_synced_at"] ?? "",
    last_sync_status: s["last_sync_status"] ?? "pending",
    last_sync_error: s["last_sync_error"] ?? null,
    files_synced: s["files_synced"] ?? 0,
    added_at: s["added_at"] ?? "",
  };
}

function sourceErrors(c: Context, kbName: string, exc: unknown, validationStatus = 404): Response {
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (exc instanceof KbConnectorError) {
    const lower = msg.toLowerCase();
    const status = lower.includes("not found") ? 404 : validationStatus === 404 ? 404 : validationStatus;
    const detail = validationStatus === 404 && !lower.includes("not found") ? `KB '${kbName}' not found` : msg;
    return httpError(c, status, detail);
  }
  return httpError(c, 500, "Knowledge source operation failed");
}

// POST /knowledge-bases/{kb_name}/github-source
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/github-source", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const b = await body(c);
    const { name: resolved } = writableKb(settings, name);
    const info = addGithubSource(settings, resolved, {
      repo: str(b["repo"]),
      branch: str(b["branch"]) || "main",
      path: str(b["path"]),
      glob: str(b["glob"]) || "*.md",
    });
    return c.json(githubSourceInfo(info));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc, 400);
  }
});

// GET /knowledge-bases/{kb_name}/github-sources
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/github-sources", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKbEntry(settings, name);
    return c.json(getGithubSources(settings, name).map(githubSourceInfo));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// DELETE /knowledge-bases/{kb_name}/github-source/{source_id}
knowledgeIndexingRouter.delete("/api/knowledge-bases/:kb_name/github-source/:source_id", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    writableKbEntry(settings, name);
    if (!removeGithubSource(settings, name, sourceId)) {
      return httpError(c, 404, `Source '${sourceId}' not found`);
    }
    return c.json({ message: "Removed", source_id: sourceId });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// POST /knowledge-bases/{kb_name}/sync-github
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/sync-github", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKbEntry(settings, name);
    const sources = getGithubSources(settings, name);
    if (!sources.length) return c.json({ message: "No GitHub sources", results: [] });
    const results: AnyRecord[] = [];
    for (const src of sources) {
      if (src["enabled"] === false) continue;
      const r = await syncGithubSource(settings, name, src);
      results.push({
        source_id: src["id"],
        repo: src["repo"],
        ok: r.ok,
        skipped: r.skipped ?? false,
        files_added: r.files_added ?? 0,
        files_updated: r.files_updated ?? 0,
        files_removed: r.files_removed ?? 0,
        error: r.error ?? null,
      });
    }
    return c.json({ message: `Synced ${results.length} source(s)`, results });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// ===========================================================================
// Web sources
// ===========================================================================

function webSourceInfo(s: AnyRecord): AnyRecord {
  return {
    id: s["id"],
    url: s["url"],
    max_depth: s["max_depth"] ?? 3,
    max_pages: s["max_pages"] ?? 200,
    enabled: s["enabled"] ?? true,
    auto_sync_enabled: s["auto_sync_enabled"] ?? true,
    sync_interval_hours: s["sync_interval_hours"] ?? 24,
    page_count: s["page_count"] ?? 0,
    last_synced_at: s["last_synced_at"] ?? "",
    last_sync_status: s["last_sync_status"] ?? "pending",
    last_sync_error: s["last_sync_error"] ?? null,
    added_at: s["added_at"] ?? "",
    navigation: s["navigation"] ?? null,
    bilingual_pairings: Array.isArray(s["bilingual_pairings"]) ? s["bilingual_pairings"] : [],
  };
}

// POST /knowledge-bases/{kb_name}/web-source
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/web-source", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const b = await body(c);
    const { name: resolved } = writableKb(settings, name);
    const info = addWebSource(settings, resolved, {
      url: str(b["url"]),
      max_depth: b["max_depth"] === undefined ? undefined : Number(b["max_depth"]),
      max_pages: b["max_pages"] === undefined ? undefined : Number(b["max_pages"]),
    });
    const interval = Number(info["sync_interval_hours"] ?? 24) || 24;
    webSourceSyncRepo.ensureSource(settings, [WEB_SOURCE_OWNER_ID, resolved, String(info["id"])], interval);
    return c.json(webSourceInfo(info));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc, 400);
  }
});

// GET /knowledge-bases/{kb_name}/web-sources
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/web-sources", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKbEntry(settings, name);
    return c.json(getWebSources(settings, name).map(webSourceInfo));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// DELETE /knowledge-bases/{kb_name}/web-source/{source_id}
knowledgeIndexingRouter.delete("/api/knowledge-bases/:kb_name/web-source/:source_id", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    writableKbEntry(settings, name);
    if (!removeWebSource(settings, name, sourceId)) {
      return httpError(c, 404, `Source '${sourceId}' not found`);
    }
    const key: [string, string, string] = [WEB_SOURCE_OWNER_ID, name, sourceId];
    webSourceSyncRepo.requestCancel(settings, key);
    webSourceSyncRepo.delete(settings, key);
    return c.json({ message: "Removed", source_id: sourceId });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// GET /knowledge-bases/{kb_name}/web-source-sync
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/web-source-sync", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKbEntry(settings, name);
    const jobs = webSourceSyncRepo.listJobs(settings, WEB_SOURCE_OWNER_ID, name);
    return c.json(jobs.map((j) => webSourceJobPublic(j)));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// GET /knowledge-bases/{kb_name}/web-source/{source_id}/pairings
knowledgeIndexingRouter.get("/api/knowledge-bases/:kb_name/web-source/:source_id/pairings", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    writableKbEntry(settings, name);
    const source = getWebSource(settings, name, sourceId);
    if (source === null) return httpError(c, 404, `Source '${sourceId}' not found`);
    const repoPairings = webSourceSyncRepo.listPairings(settings, WEB_SOURCE_OWNER_ID, name, sourceId);
    if (repoPairings.length) {
      return c.json(repoPairings.map((p) => ({
        pairing_id: p.pairing_id,
        source_url: p.source_url,
        target_url: p.target_url,
        source_file: p.source_file,
        target_file: p.target_file,
        source_lang: p.source_lang,
        target_lang: p.target_lang,
        pairing_method: p.pairing_method,
        updated_at: p.updated_at,
      })));
    }
    const meta = Array.isArray(source["bilingual_pairings"]) ? (source["bilingual_pairings"] as AnyRecord[]) : [];
    return c.json(meta);
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// PUT /knowledge-bases/{kb_name}/web-source/{source_id}/schedule
knowledgeIndexingRouter.put("/api/knowledge-bases/:kb_name/web-source/:source_id/schedule", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    const b = await body(c);
    writableKbEntry(settings, name);
    const info = updateWebSourceSchedule(settings, name, sourceId, {
      auto_sync_enabled: b["auto_sync_enabled"] === true || b["auto_sync_enabled"] === "true",
      sync_interval_hours: Number(b["sync_interval_hours"] ?? 24),
    });
    const key: [string, string, string] = [WEB_SOURCE_OWNER_ID, name, sourceId];
    if (info["auto_sync_enabled"]) {
      webSourceSyncRepo.ensureSource(settings, key, Number(info["sync_interval_hours"] ?? 24) || 24);
    } else {
      webSourceSyncRepo.requestCancel(settings, key);
      webSourceSyncRepo.delete(settings, key);
    }
    return c.json(webSourceInfo(info));
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc, 400);
  }
});

// POST /knowledge-bases/{kb_name}/web-source/{source_id}/cancel
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/web-source/:source_id/cancel", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    writableKbEntry(settings, name);
    if (getWebSource(settings, name, sourceId) === null) {
      return httpError(c, 404, `Source '${sourceId}' not found`);
    }
    const cancelled = webSourceSyncRepo.requestCancel(settings, [WEB_SOURCE_OWNER_ID, name, sourceId]);
    if (!cancelled) {
      return httpError(c, 409, "Synchronization job cannot be cancelled");
    }
    return c.json({ message: "Cancellation requested", source_id: sourceId });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// POST /knowledge-bases/{kb_name}/web-source/{source_id}/retry
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/web-source/:source_id/retry", (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    const sourceId = c.req.param("source_id") ?? "";
    writableKbEntry(settings, name);
    const source = getWebSource(settings, name, sourceId);
    if (source === null) return httpError(c, 404, `Source '${sourceId}' not found`);
    if (source["enabled"] === false || source["auto_sync_enabled"] === false) {
      return httpError(c, 409, "Enable the source and automatic synchronization before retrying");
    }
    const retried = webSourceSyncRepo.retry(settings, [WEB_SOURCE_OWNER_ID, name, sourceId]);
    if (!retried) return httpError(c, 404, "Synchronization job not found");
    return c.json({ message: "Retry scheduled", source_id: sourceId });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});

// POST /knowledge-bases/{kb_name}/sync-web
knowledgeIndexingRouter.post("/api/knowledge-bases/:kb_name/sync-web", async (c) => {
  try {
    const settings = getSettings();
    const name = c.req.param("kb_name") ?? "";
    writableKbEntry(settings, name);
    const sources = getWebSources(settings, name);
    if (!sources.length) return c.json({ message: "No web sources", results: [] });
    const enabled = sources.filter((s) => s["enabled"] !== false);
    if (!enabled.length) return c.json({ message: "No enabled web sources", results: [] });
    const results: AnyRecord[] = [];
    for (const source of enabled) {
      const result = await syncWebSource(settings, name, source, {
        max_depth: source["max_depth"] === undefined ? null : Number(source["max_depth"]),
        max_pages: source["max_pages"] === undefined ? null : Number(source["max_pages"]),
      });
      const refreshed = getWebSources(settings, name);
      const pageCount = Number(
        (refreshed.find((item) => item["id"] === source["id"]) ?? source)["page_count"] ?? 0,
      );
      results.push({
        source_id: source["id"],
        url: source["url"],
        ok: result.ok,
        page_count: pageCount,
        pages_added: result.pages_added,
        pages_updated: result.pages_updated,
        pages_removed: result.pages_removed,
        pages_unchanged: result.pages_unchanged,
        error: result.error || null,
      });
    }
    return c.json({
      message: `Synced ${results.length} source(s)`,
      ok: results.every((r) => r["ok"]),
      results,
    });
  } catch (exc) {
    return sourceErrors(c, c.req.param("kb_name") ?? "", exc);
  }
});
