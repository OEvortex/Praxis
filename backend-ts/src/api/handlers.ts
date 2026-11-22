// the Praxis REST API mounted at
// ``/api/*``. Implements auth-free session/settings/knowledge-base surfaces
// the frontend uses to boot and hold a conversation.
//
// ``request.app.state`` equivalents live on ``appState`` exported by
// ``../main.js``; resolved lazily (dynamic import) to avoid a static import
// cycle, since main.ts mounts this router.
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { getSettings } from "../config.js";
import type { Settings } from "../config.js";
import * as database from "../store/database.js";
import { KnowledgeBaseStore } from "../store/kb_store.js";
import { SessionStore } from "../store/session_store.js";
import * as providerConfig from "../provider-config.js";
import { get_config_test_runner } from "../services/config_test.js";
import { get_co_writer_storage } from "../services/documents/storage.js";
import { usage_for_year } from "../services/usage_stats.js";
import {
  SYSTEM_WORKSPACE_ID,
  WorkspaceError,
  WorkspaceRegistry,
  workspaceSnapshot,
} from "../services/workspace_registry.js";
import {
  getDefaultKb,
  getKbEntry,
  kbDir,
} from "../services/kb_connectors/store.js";
import {
  isConnectedKb,
  normalizeProviderName,
} from "../services/kb_connectors/types.js";

export const handlersRouter = new Hono();

// -- app.state plumbing --------------------------------------------------------

type AnyRecord = Record<string, any>;

interface AppStateLike {
  settings?: Settings;
  store?: SessionStore | null;
  runtime?: { _turns?: unknown } | null;
  kb?: KnowledgeBaseStore | null;
  [key: string]: unknown;
}

let cachedAppState: AppStateLike | null = null;

// TODO(port): app.state is owned by main.ts; resolved lazily to avoid a
// static import cycle (main.ts imports this router).
async function appState(): Promise<AppStateLike> {
  if (cachedAppState) return cachedAppState;
  try {
    const mod = (await import("../main.js")) as unknown as {
      appState?: AppStateLike;
    };
    if (mod?.appState) cachedAppState = mod.appState;
  } catch {
    // main.ts may not be importable in isolation (tests, tooling).
  }
  return cachedAppState ?? {};
}

let fallbackStore: SessionStore | null = null;
let fallbackKb: KnowledgeBaseStore | null = null;

async function _store(): Promise<SessionStore> {
  const s = await appState();
  if (s.store) return s.store;
  if (!fallbackStore) fallbackStore = new SessionStore(getSettings());
  return fallbackStore;
}

async function _kb(): Promise<KnowledgeBaseStore> {
  const s = await appState();
  if (s.kb) return s.kb;
  if (!fallbackKb) fallbackKb = new KnowledgeBaseStore(getSettings());
  return fallbackKb;
}

function _settings(): Settings {
  return getSettings();
}

async function _runtime(): Promise<{ _turns?: unknown } | null> {
  const s = await appState();
  return (s.runtime as { _turns?: unknown } | null | undefined) ?? null;
}

function _turnCount(turns: unknown): number {
  if (turns == null) return 0;
  if (turns instanceof Map) return turns.size;
  if (Array.isArray(turns)) return turns.length;
  if (typeof turns === "object") return Object.keys(turns).length;
  return 0;
}

// -- helpers -------------------------------------------------------------------

function httpError(c: Context, status: number, detail: string) {
  // error shape: {"detail": ...}
  return c.json({ detail }, status as never);
}

function qInt(c: Context, name: string, fallback: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function qStr(c: Context, name: string, fallback = ""): string {
  return c.req.query(name) ?? fallback;
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

function uuid12(): string {
  return randomBytes(16).toString("hex").slice(0, 12);
}

function now(): number {
  return Date.now() / 1000;
}

// -- provider_config ----------------------------------------------------------
// provider-config.ts exports stable snake_case names; call them directly.

type AnyFn = (...args: any[]) => any;

// -- system / runtime ---------------------------------------------------------

// GET /api/system/runtime
handlersRouter.get("/api/system/runtime", async (c) => {
  const settings = _settings();
  const runtime = await _runtime();
  return c.json({
    worker_id: "local",
    worker_count: 1,
    coordination_mode: "memory",
    redis_configured: false,
    redis_status: "not_configured",
    leader_id: null,
    leader_healthy: null,
    owner_turn_count: _turnCount(runtime?._turns),
    recovery_backlog: 0,
    lease_ttl_seconds: 30,
    renew_interval_seconds: 10,
    recovery_interval_seconds: 5,
    protocol_version: "2.0",
    minimum_web_protocol_version: "2.0",
    data_dir: String(settings.data_dir ?? ""),
  });
});

// GET /api/health
handlersRouter.get("/api/health", (c) => c.json({ status: "ok" }));

// -- sessions -----------------------------------------------------------------

function _summary(session: AnyRecord): AnyRecord {
  const messages: AnyRecord[] = Array.isArray(session["messages"])
    ? session["messages"]
    : [];
  const last = messages.length ? messages[messages.length - 1] : {};
  let active: string | null = null;
  const turns = (session["turns"] ?? {}) as Record<string, AnyRecord>;
  const running = Object.values(turns).filter((t) => t["status"] === "running");
  if (running.length) {
    const latest = running.reduce((a, b) =>
      Number(b["created_at"] ?? 0) > Number(a["created_at"] ?? 0) ? b : a,
    );
    for (const [tid, t] of Object.entries(turns)) {
      if (t === latest) {
        active = tid;
        break;
      }
    }
  }
  const prefs = (session["preferences"] ?? {}) as AnyRecord;
  return {
    id: session["id"],
    session_id: session["id"],
    content_workspace_id: prefs["workspace_id"] ?? null,
    title: session["title"] || "Untitled",
    created_at: _epochSeconds(session["created_at"]),
    updated_at: _epochSeconds(session["updated_at"]),
    message_count: messages.length,
    last_message: String(last["content"] ?? "").slice(0, 200),
    status: active ? "running" : session["status"] || "idle",
    active_turn_id: active,
    preferences: session["preferences"] || {},
  };
}

function _epochSeconds(value: unknown): number {
  // Normalize session timestamps to epoch seconds — the wire contract.
  // Stored sessions use numeric epochs; native vtx sessions carry ISO strings.
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const t = Date.parse(value.replace("Z", "+00:00"));
    return Number.isNaN(t) ? 0 : t / 1000;
  }
  return 0;
}

function _sessionUpdatedKey(session: AnyRecord): number {
  return _epochSeconds(session["updated_at"]);
}

// GET /api/sessions
handlersRouter.get("/api/sessions", async (c) => {
  const store = await _store();
  const limit = Math.min(Math.max(qInt(c, "limit", 50), 1), 500);
  const offset = Math.max(qInt(c, "offset", 0), 0);
  const stored = (await store.all()) as AnyRecord[];
  stored.sort((a, b) => _sessionUpdatedKey(b) - _sessionUpdatedKey(a));
  return c.json({ sessions: stored.slice(offset, offset + limit).map(_summary) });
});

// GET /api/sessions/search
handlersRouter.get("/api/sessions/search", async (c) => {
  const store = await _store();
  const q = qStr(c, "q");
  const limit = Math.min(Math.max(qInt(c, "limit", 50), 1), 500);
  const offset = Math.max(qInt(c, "offset", 0), 0);
  const res = (await store.search(q, limit, offset)) as unknown;
  let hits: AnyRecord[];
  let total: number;
  if (Array.isArray(res)) {
    hits = (res[0] ?? []) as AnyRecord[];
    total = Number(res[1] ?? hits.length);
  } else {
    const o = res as AnyRecord;
    hits = (o.hits ?? o.sessions ?? []) as AnyRecord[];
    total = Number(o.total ?? hits.length);
  }
  const results = hits.map((session) => ({
    ..._summary(session),
    match_excerpt: session["_match_excerpt"] ?? "",
  }));
  return c.json({ sessions: results, total, limit, offset });
});

// GET /api/sessions/capabilities
handlersRouter.get("/api/sessions/capabilities", (c) =>
  c.json({ submission_replacement: false }),
);

// GET /api/sessions/{session_id}
handlersRouter.get("/api/sessions/:session_id", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const store = await _store();
  const session = (await store.get(sessionId)) as AnyRecord | null;
  if (session === null || session === undefined) {
    return httpError(c, 404, "session not found");
  }
  const summary = _summary(session);
  const turns = (session["turns"] ?? {}) as Record<string, AnyRecord>;
  const activeTurns = Object.entries(turns).map(([tid, turn]) => ({
    id: tid,
    turn_id: tid,
    session_id: sessionId,
    capability: "chat",
    status: turn["status"] ?? "completed",
    error: "",
    created_at: turn["created_at"],
    updated_at: turn["finished_at"],
    finished_at: turn["finished_at"],
    last_seq: turn["last_seq"] ?? 0,
  }));
  return c.json({
    ...summary,
    messages: session["messages"] ?? [],
    active_turns: activeTurns,
  });
});

// PATCH + PUT /api/sessions/{session_id}
async function updateSession(c: Context) {
  const sessionId = c.req.param("session_id") ?? "";
  const store = await _store();
  const session = (await store.get(sessionId)) as AnyRecord | null;
  if (session === null || session === undefined) {
    return httpError(c, 404, "session not found");
  }
  const b = await body(c);
  if (b["title"] !== undefined && b["title"] !== null) {
    const t = String(b["title"]).trim();
    session["title"] = t || session["title"] || "Untitled";
    session["title_auto"] = false;
  }
  if (b["preferences"] !== undefined && b["preferences"] !== null) {
    session["preferences"] = {
      ...((session["preferences"] as AnyRecord) ?? {}),
      ...(b["preferences"] as AnyRecord),
    };
  }
  await store.save(session);
  return c.json(_summary(session));
}
handlersRouter.patch("/api/sessions/:session_id", updateSession);
handlersRouter.put("/api/sessions/:session_id", updateSession);

// DELETE /api/sessions/{session_id}
handlersRouter.delete("/api/sessions/:session_id", async (c) => {
  const store = await _store();
  const ok = await store.delete(c.req.param("session_id") ?? "");
  if (!ok) return httpError(c, 404, "session not found");
  return c.json({ deleted: true });
});

// DELETE /api/sessions/{session_id}/messages/{message_id}
handlersRouter.delete(
  "/api/sessions/:session_id/messages/:message_id",
  async (c) => {
    const sessionId = c.req.param("session_id") ?? "";
    const messageId = c.req.param("message_id");
    const store = await _store();
    const session = (await store.get(sessionId)) as AnyRecord | null;
    if (session === null || session === undefined) {
      return httpError(c, 404, "session not found");
    }
    const messages: AnyRecord[] = Array.isArray(session["messages"])
      ? session["messages"]
      : [];
    const before = messages.length;
    session["messages"] = messages.filter(
      (m) => String(m?.["id"]) !== messageId,
    );
    if ((session["messages"] as AnyRecord[]).length === before) {
      return httpError(c, 404, "message not found");
    }
    await store.save(session);
    return c.json({ deleted: true });
  },
);

// GET /api/sessions/{session_id}/messages/{message_id}/events
handlersRouter.get(
  "/api/sessions/:session_id/messages/:message_id/events",
  async (c) => {
    const sessionId = c.req.param("session_id") ?? "";
    const messageId = c.req.param("message_id");
    const afterSeq = Math.max(qInt(c, "after_seq", 0), 0);
    const limit = Math.min(Math.max(qInt(c, "limit", 500), 1), 2000);
    const store = await _store();
    const session = (await store.get(sessionId)) as AnyRecord | null;
    if (session === null || session === undefined) {
      return httpError(c, 404, "session not found");
    }
    const messages: AnyRecord[] = Array.isArray(session["messages"])
      ? session["messages"]
      : [];
    const message = messages.find((m) => String(m?.["id"]) === messageId);
    if (message === undefined) {
      return httpError(c, 404, "message not found");
    }
    const allEvents: AnyRecord[] = Array.isArray(message["events"])
      ? message["events"]
      : [];
    const events = allEvents
      .filter((e) => Number(e?.["seq"] ?? 0) > afterSeq)
      .slice(0, limit);
    const lastSeq = allEvents.reduce(
      (mx, e) => Math.max(mx, Number(e?.["seq"] ?? 0)),
      0,
    );
    return c.json({
      session_id: sessionId,
      message_id: messageId,
      turn_id: ((message["metadata"] as AnyRecord) ?? {})["turn_id"] ?? null,
      events,
      total: allEvents.length,
      last_seq: lastSeq,
      next_seq: null,
      complete: true,
    });
  },
);

// -- capabilities ---------------------------------------------------------------

// GET /api/capabilities/registered
handlersRouter.get("/api/capabilities/registered", (c) =>
  c.json({
    capabilities: [
      {
        id: "chat",
        kind: "capability",
        available: true,
        manifest: {
          name: "chat",
          description: "General tutoring conversation",
          version: "1.0.0",
        },
        config_schema: { type: "object", properties: {} },
      },
    ],
  }),
);

// -- settings -------------------------------------------------------------------

async function _savedSelection(): Promise<AnyRecord | null> {
  // Active selection from Praxis's own catalog (legacy file as fallback).
  return (await providerConfig.get_selection(_settings())) as AnyRecord | null;
}

// GET /api/settings/llm-options
handlersRouter.get("/api/settings/llm-options", async (c) => {
  const settings = _settings();
  const options = (await providerConfig.model_options(settings)) as AnyRecord[];
  let active = await _savedSelection();
  if (active === null && options.length) {
    active = {
      profile_id: options[0]["profile_id"],
      model_id: options[0]["model_id"],
      reasoning_effort: null,
    };
    options[0]["is_active_default"] = true;
  }
  return c.json({ active, options });
});

// POST /api/settings/apply/provider
handlersRouter.post("/api/settings/apply/provider", async (c) => {
  const b = await body(c);
  let sel: AnyRecord | null =
    (b["llm_selection"] as AnyRecord | undefined) ?? null;
  if (
    sel === null &&
    b["profile_id"] &&
    b["model_id"]
  ) {
    sel = { profile_id: b["profile_id"], model_id: b["model_id"] };
  }
  const saved = await providerConfig.set_selection(_settings(), sel);
  return c.json({ ok: true, llm_selection: saved });
});

// Resolve probe inputs from the request body, then our catalog/presets.
async function _probeInputs(
  _c: Context,
  opts: {
    binding?: string;
    base_url?: string;
    api_key?: string;
    api_format?: string;
    connection_id?: string;
  },
): Promise<[string, string, string, string | null, AnyRecord | null, AnyRecord | null]> {
  const settings = _settings();
  const catalog = (await providerConfig.load_catalog(settings)) as AnyRecord;
  let slug = String(opts.binding ?? "").trim();
  const connections = (catalog["connections"] ?? []) as AnyRecord[];
  let conn: AnyRecord | null = null;
  if (opts.connection_id) {
    conn =
      connections.find((x) => x["id"] === opts.connection_id) ?? null;
  }
  if (conn === null && slug) {
    conn = connections.find((x) => x["provider"] === slug) ?? null;
  }
  if (conn) {
    slug = slug || String(conn["provider"] ?? "");
  }
  const preset = (await providerConfig.builtin_preset(slug)) as AnyRecord | null;
  const base = String(
    opts.base_url ?? conn?.["base_url"] ?? preset?.["base_url"] ?? "",
  ).trim();
  const key = String(
    opts.api_key ?? conn?.["api_key"] ?? (await providerConfig.preset_api_key(slug)) ?? "",
  ).trim();
  const fmt =
    (opts.api_format as string | null | undefined) ??
    (conn?.["api_format"] as string | null | undefined) ??
    (preset?.["api_format"] as string | null | undefined) ??
    null;
  return [slug, base, key, fmt, conn, preset];
}

// POST /api/settings/test-provider
handlersRouter.post("/api/settings/test-provider", async (c) => {
  const b = await body(c);
  const service = String(b["service"] ?? "llm").trim();
  if (service !== "llm" && service !== "task") {
    return c.json({
      status: "unavailable",
      models: [],
      capabilities: [],
      http_status: null,
    });
  }
  const inputs = await _probeInputs(c, {
    binding: b["binding"] as string | undefined,
    base_url: b["base_url"] as string | undefined,
    api_key: b["api_key"] as string | undefined,
    api_format: b["api_format"] as string | undefined,
    connection_id: b["connection_id"] as string | undefined,
  });
  const [slug, base, key, fmt, conn, preset] = inputs;
  const result = (await providerConfig.probe_models(base, key, fmt, preset)) as AnyRecord;
  const models = (result["models"] ?? []) as AnyRecord[];
  if (result["status"] === "connected" && slug) {
    await providerConfig.store_discovered_models(
      _settings(),
      slug,
      models,
      b["connection_id"] ?? (conn as AnyRecord | null)?.["id"],
    );
  }
  return c.json({
    status: result["status"],
    models,
    capabilities:
      result["status"] === "connected"
        ? [{ category: "llm", evidence: "metadata" }]
        : [],
    checked_at: new Date().toISOString(),
    http_status: result["http_status"] ?? null,
  });
});

// GET /api/settings/model-capabilities
handlersRouter.get("/api/settings/model-capabilities", (c) =>
  c.json({ capabilities: {} }),
);

// POST /api/settings/fetch-models
handlersRouter.post("/api/settings/fetch-models", async (c) => {
  const b = await body(c);
  const inputs = await _probeInputs(c, {
    binding: b["binding"] as string | undefined,
    base_url: b["base_url"] as string | undefined,
    api_key: b["api_key"] as string | undefined,
    api_format: b["api_format"] as string | undefined,
  });
  const [slug, base, key, fmt, conn, preset] = inputs;
  const result = (await providerConfig.probe_models(base, key, fmt, preset)) as AnyRecord;
  const models = (result["models"] ?? []) as AnyRecord[];
  const refreshed = result["status"] === "connected";
  if (refreshed && slug) {
    await providerConfig.store_discovered_models(
      _settings(),
      slug,
      models,
      (conn as AnyRecord | null)?.["id"],
    );
  }
  return c.json({ models, refreshed });
});

// GET /api/settings
handlersRouter.get("/api/settings", async (c) => {
  const settings = _settings();
  const providers = (await providerConfig.provider_options(settings)) as unknown[];
  const connectionTargets = (await providerConfig.connection_targets(settings)) as unknown[];
  return c.json({
    providers: {
      llm: providers,
      task: providers,
      embedding: providers,
      search: [],
      tts: providers,
      stt: providers,
      imagegen: providers,
      videogen: [],
    },
    connection_targets: connectionTargets,
    task_kinds: [],
    ui: { theme: "dark", language: "en", response_language: "en" },
    services: {},
    catalog: await _loadLiveCatalog(),
  });
});

// -- knowledge bases ---------------------------------------------------------

// GET /api/knowledge-bases
handlersRouter.get("/api/knowledge-bases", async (c) => {
  const kb = await _kb();
  return c.json({ knowledge_bases: kb.list() });
});

// POST /api/knowledge-bases
handlersRouter.post("/api/knowledge-bases", async (c) => {
  const b = await body(c);
  const kb = await _kb();
  return c.json(kb.create(String(b["name"] ?? "")));
});

// DELETE /api/knowledge-bases/{name}
handlersRouter.delete("/api/knowledge-bases/:name", async (c) => {
  const kb = await _kb();
  if (!kb.delete(c.req.param("name"))) {
    return httpError(c, 404, "knowledge base not found");
  }
  return c.json({ deleted: true });
});

// GET /api/knowledge-bases/{name}/files
handlersRouter.get("/api/knowledge-bases/:name/files", async (c) => {
  const kb = await _kb();
  const name = c.req.param("name");
  if (!kb.exists(name)) {
    return httpError(c, 404, "knowledge base not found");
  }
  return c.json({ files: kb.list_documents(name) });
});

// POST /api/knowledge-bases/{name}/upload
handlersRouter.post("/api/knowledge-bases/:name/upload", async (c) => {
  const name = c.req.param("name");
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!(file instanceof File)) {
    return httpError(c, 400, "missing file");
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (data.length > 50 * 1024 * 1024) {
    return httpError(c, 413, "file too large");
  }
  const kb = await _kb();
  return c.json(kb.add_document(name, file.name || "upload.bin", data));
});

// -- boot-time stubs -----------------------------------------------------------

function _settingsDir(): string {
  const d = resolve(String(_settings().data_dir ?? "./data"));
  mkdirSync(d, { recursive: true });
  return d; // kept for callers that still resolve provider preset files
}
void _settingsDir;

async function _defaultCatalog(): Promise<AnyRecord> {
  return (await providerConfig.default_catalog()) as AnyRecord;
}

async function _loadLiveCatalog(): Promise<AnyRecord> {
  // Load the Praxis catalog, self-healing base_urls from our own presets.
  const settings = _settings();
  const data = (await providerConfig.load_catalog(settings)) as AnyRecord;
  let dirty = false;
  const connections = (data["connections"] ?? []) as AnyRecord[];
  for (const conn of connections) {
    if (conn["base_url"]) continue;
    const preset = (await providerConfig.builtin_preset(
      String(conn["provider"] ?? ""),
    )) as AnyRecord | null;
    if (preset && preset["base_url"]) {
      conn["base_url"] = preset["base_url"];
      dirty = true;
    }
  }
  if (dirty) await _saveLiveCatalog(data);
  return data;
}

async function _saveLiveCatalog(catalog: AnyRecord): Promise<void> {
  await providerConfig.save_catalog(_settings(), catalog);
}

async function _loadDraft(): Promise<AnyRecord | null> {
  const data = database.get_state<unknown>(_settings(), "settings/draft");
  return data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "catalog" in (data as AnyRecord)
    ? (data as AnyRecord)
    : null;
}

async function _saveDraft(draft: AnyRecord | null): Promise<void> {
  if (draft === null) {
    database.delete_state(_settings(), "settings/draft");
  } else {
    database.put_state(_settings(), "settings/draft", draft);
  }
}

// GET /api/settings/draft
handlersRouter.get("/api/settings/draft", async (c) => {
  return c.json({ draft: await _loadDraft() });
});

async function settingsDraftPut(c: Context) {
  const b = await body(c);
  const stored: AnyRecord = {
    catalog: b["catalog"],
    extensions: b["extensions"] ?? {},
  };
  await _saveDraft(stored);
  return c.json({ draft: stored });
}

// PUT /api/settings/draft
handlersRouter.put("/api/settings/draft", settingsDraftPut);
// POST /api/settings/draft
handlersRouter.post("/api/settings/draft", settingsDraftPut);

// DELETE /api/settings/draft
handlersRouter.delete("/api/settings/draft", async (c) => {
  await _saveDraft(null);
  return c.json({ ok: true });
});

function _svc(catalog: AnyRecord, name: string): AnyRecord {
  const services = (catalog["services"] ??= {}) as AnyRecord;
  return (services[name] ??= { active_profile_id: null, profiles: [] });
}

function _findProfile(
  catalog: AnyRecord,
  service: string,
  profileId: string,
): AnyRecord | null {
  const profiles = (_svc(catalog, service)["profiles"] ?? []) as AnyRecord[];
  return profiles.find((p) => p["id"] === profileId) ?? null;
}

function _applyRegistryEdit(catalog: AnyRecord, edit: AnyRecord): void {
  // Mirror of the frontend's stageRegistryAction + field updates.
  const kind = edit["kind"];
  const ref = (edit["ref"] ?? {}) as AnyRecord;
  const service = edit["service"] as string | undefined;

  if (kind === "task_choice" && edit["task"]) {
    const task = _svc(catalog, "task");
    const t = edit["task"] as AnyRecord;
    const taskKind = t["task_kind"] as string | undefined;
    const choice: AnyRecord = { ...t };
    delete choice["task_kind"];
    if (taskKind) {
      const overrides = { ...((task["overrides"] as AnyRecord) ?? {}) };
      if (choice["mode"] === "global") {
        delete overrides[taskKind];
      } else {
        overrides[taskKind] = choice;
      }
      if (Object.keys(overrides).length) {
        task["overrides"] = overrides;
      } else {
        delete task["overrides"];
      }
    } else {
      Object.assign(task, choice);
    }
    return;
  }

  if (kind === "provider" && edit["delete"] && Object.keys(ref).length) {
    if (ref["connection_id"]) {
      catalog["connections"] = (
        (catalog["connections"] ?? []) as AnyRecord[]
      ).filter((c2) => c2["id"] !== ref["connection_id"]);
    } else if (ref["service"] && ref["profile_id"]) {
      const bucket = _svc(catalog, ref["service"] as string);
      bucket["profiles"] = (
        (bucket["profiles"] ?? []) as AnyRecord[]
      ).filter((p) => p["id"] !== ref["profile_id"]);
    }
    return;
  }

  if (kind === "provider" && Object.keys(ref).length) {
    // Field-level update on a connection or profile.
    const fields = (edit["fields"] ?? {}) as AnyRecord;
    if (ref["connection_id"]) {
      for (const c2 of (catalog["connections"] ?? []) as AnyRecord[]) {
        if (c2["id"] === ref["connection_id"]) {
          Object.assign(c2, fields);
          if (edit["config"]) Object.assign(c2, edit["config"]);
          return;
        }
      }
    } else if (ref["service"] && ref["profile_id"]) {
      const profile = _findProfile(
        catalog,
        ref["service"] as string,
        ref["profile_id"] as string,
      );
      if (profile) {
        Object.assign(profile, fields);
        if (edit["config"]) Object.assign(profile, edit["config"]);
      }
    }
    return;
  }

  if (!service) return;
  const bucket = _svc(catalog, service);
  const profile = _findProfile(catalog, service, String(edit["profile_id"] ?? ""));

  if (kind === "default" && profile !== null) {
    bucket["active_profile_id"] = profile["id"];
    bucket["active_model_id"] = edit["model_id"];
    if (service === "task") bucket["mode"] = "profiles";
    return;
  }

  if (profile === null) return;

  if (kind === "model") {
    const model = edit["model"] as AnyRecord | undefined;
    if (edit["delete"]) {
      const mid = edit["model_id"] ?? model?.["id"];
      profile["models"] = ((profile["models"] ?? []) as AnyRecord[]).filter(
        (m) => m["id"] !== mid,
      );
      if (
        !((profile["models"] as AnyRecord[] | undefined) ?? []).length &&
        profile["provider_ref"]
      ) {
        bucket["profiles"] = ((bucket["profiles"] ?? []) as AnyRecord[]).filter(
          (p) => p !== profile,
        );
      }
    } else if (model) {
      const models = (profile["models"] ??= []) as AnyRecord[];
      const idx = models.findIndex((m) => m["id"] === model["id"]);
      if (idx === -1) {
        models.push(model);
      } else {
        models[idx] = { ...models[idx], ...model };
      }
    }
    return;
  }

  if (edit["config"]) {
    Object.assign(profile, edit["config"]);
  }
}

// POST /api/settings/apply/registry
handlersRouter.post("/api/settings/apply/registry", async (c) => {
  const edit = await body(c);
  const catalog = await _loadLiveCatalog();
  _applyRegistryEdit(catalog, edit);
  await _saveLiveCatalog(catalog);
  await _saveDraft(null);
  return c.json({ catalog });
});

// POST /api/settings/apply/service
handlersRouter.post("/api/settings/apply/service", async (c) => {
  const b = await body(c);
  const catalog = await _loadLiveCatalog();
  const service = b["service"] as string | undefined;
  const config = b["config"];
  const services = (catalog["services"] ?? {}) as AnyRecord;
  if (service && service in services) {
    services[service] = config;
  }
  await _saveLiveCatalog(catalog);
  return c.json({ catalog, draft: await _loadDraft() });
});

// POST /api/settings/apply
handlersRouter.post("/api/settings/apply", async (c) => {
  const draft = await _loadDraft();
  let catalog = (draft?.["catalog"] as AnyRecord | undefined) ?? null;
  if (!catalog) catalog = await _loadLiveCatalog();
  if (catalog) await _saveLiveCatalog(catalog);
  await _saveDraft(null);
  return c.json({ catalog: await _loadLiveCatalog(), draft: null });
});

// GET /api/settings/display
handlersRouter.get("/api/settings/display", (c) => c.json({}));
// POST /api/settings/display
handlersRouter.post("/api/settings/display", (c) => c.json({ ok: true }));

// GET /api/modules
handlersRouter.get("/api/modules", (c) =>
  c.json({
    modules: [
      {
        id: "calendar",
        installed: true,
        enabled: true,
        ready: true,
        navigation: ["/calendar"],
        issues: [],
      },
    ],
  }),
);

// GET /api/settings/page-customization
handlersRouter.get("/api/settings/page-customization", (c) =>
  c.json({
    chat: {
      hidden_modes: [],
      controls: {
        skills: true,
        mcp: true,
        partners: true,
        preferences: true,
        voice: true,
        create: true,
      },
      starters: {},
    },
    learning: { hidden_features: [] },
  }),
);

// -- workspaces -----------------------------------------------------------------

function _workspaces(): WorkspaceRegistry {
  return new WorkspaceRegistry(_settings());
}

function isWorkspaceError(e: unknown): boolean {
  return e instanceof WorkspaceError;
}

// GET /api/settings/workspace/registrations
handlersRouter.get("/api/settings/workspace/registrations", async (c) => {
  const ws = await _workspaces();
  return c.json(ws.describe());
});

// POST /api/settings/workspace/registrations
handlersRouter.post("/api/settings/workspace/registrations", async (c) => {
  const b = await body(c);
  const ws = await _workspaces();
  try {
    const workspace = await ws.create(b["name"], b["path"], {
      resources: b["resources"],
      instructions: b["instructions"],
    });
    return c.json({ workspace });
  } catch (e) {
    if (isWorkspaceError(e)) return httpError(c, 400, String((e as Error).message ?? e));
    throw e;
  }
});

// PATCH /api/settings/workspace/registrations/{workspace_id}
handlersRouter.patch(
  "/api/settings/workspace/registrations/:workspace_id",
  async (c) => {
    const workspaceId = c.req.param("workspace_id");
    const b = await body(c);
    const changes: AnyRecord = {};
    for (const key of ["name", "archived", "resources", "instructions"]) {
      if (key in b) changes[key] = b[key];
    }
    const ws = await _workspaces();
      try {
      const workspace = await ws.update(workspaceId, changes);
      return c.json({ workspace });
    } catch (e) {
      if (isWorkspaceError(e)) return httpError(c, 400, String((e as Error).message ?? e));
      throw e;
    }
  },
);

// POST /api/settings/workspace/registrations/migrate-root
handlersRouter.post(
  "/api/settings/workspace/registrations/migrate-root",
  async (c) => {
    const b = await body(c);
    const ws = await _workspaces();
      try {
      return c.json(await ws.migrateRoot(b["path"]));
    } catch (e) {
      if (isWorkspaceError(e)) return httpError(c, 409, String((e as Error).message ?? e));
      throw e;
    }
  },
);

// POST /api/settings/workspace/registrations/{workspace_id}/migrate
handlersRouter.post(
  "/api/settings/workspace/registrations/:workspace_id/migrate",
  async (c) => {
    const workspaceId = c.req.param("workspace_id");
    const b = await body(c);
    const ws = await _workspaces();
      try {
      return c.json(await ws.migrate(workspaceId, b["path"]));
    } catch (e) {
      if (isWorkspaceError(e)) return httpError(c, 409, String((e as Error).message ?? e));
      throw e;
    }
  },
);

async function workspaceSystemSnapshot(c: Context) {
  const ws = await _workspaces();
  try {
    const described = (await ws.describe()) as AnyRecord;
    const rows = (described["workspaces"] ?? []) as AnyRecord[];
    if (!rows.some((row) => row["workspace_id"] === SYSTEM_WORKSPACE_ID)) {
      throw new Error("The system workspace is unavailable.");
    }
    return c.json(await workspaceSnapshot(_settings()));
  } catch (e) {
    if (isWorkspaceError(e) || e instanceof Error) {
      return httpError(c, 409, String((e as Error).message ?? e));
    }
    throw e;
  }
}
handlersRouter.get(
  "/api/settings/workspace/registrations/system-snapshot",
  workspaceSystemSnapshot,
);
handlersRouter.post(
  "/api/settings/workspace/registrations/system-snapshot",
  workspaceSystemSnapshot,
);

// GET /api/settings/workspace/resources
handlersRouter.get("/api/settings/workspace/resources", async (c) => {
  const kb = await _kb();
  const knowledgeBases = (kb.list() as AnyRecord[]).map((row) => ({
    id: String(row["id"] ?? row["name"] ?? ""),
    name: String(row["name"] ?? row["id"] ?? ""),
    description: "",
    source: "account",
    available: String(row["status"] ?? "ready") === "ready",
  }));
  return c.json({ skills: [], mcp: [], knowledge_bases: knowledgeBases });
});

// GET /api/settings/usage
handlersRouter.get("/api/settings/usage", async (c) => {
  const currentYear = new Date().getUTCFullYear();
  let year = qInt(c, "year", 0);
  if (!year || year < 1970 || year > currentYear + 1) year = currentYear;
  const timezone = qStr(c, "timezone", "UTC");
  return c.json(usage_for_year(_settings(), year, timezone));
});

// GET /api/settings/workspace/resource-usage
handlersRouter.get("/api/settings/workspace/resource-usage", async (c) => {
  const ws = await _workspaces();
  const kind = qStr(c, "kind");
  const resourceId = qStr(c, "resource_id");
  return c.json({
    workspaces: await ws.resourceUsage(kind, resourceId),
  });
});

// GET /api/settings/workspace/folders
handlersRouter.get("/api/settings/workspace/folders", async (c) => {
  const ws = await _workspaces();
  const path = qStr(c, "path");
  try {
    return c.json(await ws.browse(path));
  } catch (e) {
    if (isWorkspaceError(e)) return httpError(c, 400, String((e as Error).message ?? e));
    throw e;
  }
});

// GET /api/system/status
handlersRouter.get("/api/system/status", (c) => c.json({ status: "ok" }));

// GET /api/reading/workspaces/index
handlersRouter.get("/api/reading/workspaces/index", (c) =>
  c.json({ workspaces: [] }),
);

// GET /api/mastery-paths/topics/index
handlersRouter.get("/api/mastery-paths/topics/index", (c) =>
  c.json({ topics: [] }),
);

// GET /api/tools
handlersRouter.get("/api/tools", (c) =>
  // Only tools the agent actually registers: the merged `web` tool is the
  // frontend's `web_search` toggle, and `video` is not user-toggleable.
  c.json({ enabled_optional_tools: ["web_search", "paper_search"] }),
);

// GET /api/subagents/settings
handlersRouter.get("/api/subagents/settings", (c) => c.json({}));
// PUT /api/subagents/settings
handlersRouter.put("/api/subagents/settings", (c) => c.json({}));

function _suggestionsPayload(): AnyRecord {
  return { suggestions: [], stale: false, status: "no-material" };
}

// GET /api/dashboard/suggestions
handlersRouter.get("/api/dashboard/suggestions", (c) =>
  c.json(_suggestionsPayload()),
);
// POST /api/dashboard/suggestions/refresh
handlersRouter.post("/api/dashboard/suggestions/refresh", (c) =>
  c.json(_suggestionsPayload()),
);

// GET /api/dashboard/{entry_id}
//
// Lives here, not in misc.ts: miscRouter mounts before handlersRouter, and
// its ``/:entry_id`` pattern shadowed the literal /suggestions route (the old
// exclusion-list "fix" just 404'd the real endpoint). This param route must
// stay AFTER every literal /api/dashboard/* single-segment route.
handlersRouter.get("/api/dashboard/:entry_id", async (c) => {
  const entryId = c.req.param("entry_id");
  const session = (await _store()).get(entryId);
  if (!session) return httpError(c, 404, "Entry not found");
  const capability = String(session.capability ?? "chat");
  return c.json({
    id: session.id ?? session.session_id,
    type: capability.replace("deep_", ""),
    capability,
    title: session.title ?? null,
    timestamp: _epochSeconds(session.updated_at ?? session.created_at),
    content: {
      messages: session.messages ?? [],
      active_turns: session.active_turns ?? [],
      status: session.status ?? "idle",
      summary: session.compressed_summary ?? "",
    },
  });
});

// GET /api/knowledge-bases/list
handlersRouter.get("/api/knowledge-bases/list", async (c) => {
  const kb = await _kb();
  return c.json(kb.list());
});

// GET /api/knowledge-bases/{kb_name} — detail.
//
// Lives here, not in knowledge_connectors.ts: that router mounts before the
// indexing/rag routers, and its ``/:kb_name`` pattern shadowed the
// single-segment static routes (/list, /health, /configs, /rag-providers).
// handlersRouter mounts late, so every static route wins first; this param
// route must stay AFTER /list within this router for the same reason.
handlersRouter.get("/api/knowledge-bases/:kb_name", (c) => {
  const name = c.req.param("kb_name") ?? "";
  try {
    const settings = _settings();
    const entry = getKbEntry(settings, name);
    if (entry === null) {
      return httpError(c, 404, `Knowledge base '${name}' not found`);
    }
    const connected = isConnectedKb(entry);
    const info: AnyRecord = {
      id: name,
      name,
      is_default: getDefaultKb(settings) === name,
      status: entry["status"] ?? (connected ? "ready" : "unknown"),
      metadata: {
        rag_provider: normalizeProviderName(entry["rag_provider"]),
        type: entry["type"] ?? null,
        description: entry["description"] ?? null,
        created_at: entry["created_at"] ?? null,
        last_updated: entry["updated_at"] ?? entry["last_updated"] ?? null,
        ...(entry["vault_path"] ? { vault_path: entry["vault_path"] } : {}),
        ...(entry["external_path"] ? { external_path: entry["external_path"] } : {}),
        ...(entry["server_url"] ? { server_url: entry["server_url"] } : {}),
        ...(entry["zim_name"]
          ? { zim_name: entry["zim_name"], zim_title: entry["zim_title"] }
          : {}),
        ...(entry["knowledge_base_id"]
          ? { knowledge_base_id: entry["knowledge_base_id"] }
          : {}),
        ...(entry["db_path"] ? { db_path: entry["db_path"] } : {}),
      },
      statistics: {
        status: entry["status"] ?? "ready",
        raw_documents: connected ? 0 : undefined,
      },
      source: "local",
      assigned: false,
      read_only: connected,
    };
    if (connected) {
      // upstream get_metadata allowlist
      const meta: AnyRecord = {};
      for (const key of [
        "name", "description", "rag_provider", "needs_reindex", "created_at",
        "last_updated", "last_indexed_at", "last_indexed_count", "last_indexed_action",
        "type", "vault_path", "external_path", "db_path", "server_url",
        "zim_name", "zim_title", "knowledge_base_id", "agent_kind", "cwd", "partner_id",
        "embedding_model", "embedding_dim", "embedding_selection", "embedding_status",
      ]) {
        if (entry[key] !== undefined && entry[key] !== null) meta[key] = entry[key];
      }
      info["metadata"] = { ...info["metadata"], ...meta };
      delete info["path"];
    } else {
      info["path"] = join(kbDir(settings, name), "raw");
    }
    if (entry["progress"]) info["progress"] = entry["progress"];
    return c.json(info);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return httpError(c, 500, msg || "Internal error");
  }
});

// GET /api/sessions/{session_id}/organization
handlersRouter.get("/api/sessions/:session_id/organization", (c) =>
  c.json({
    session_id: c.req.param("session_id"),
    folders: [],
    tags: [],
  }),
);

// GET /api/sessions/{session_id}/threads
handlersRouter.get("/api/sessions/:session_id/threads", (c) =>
  c.json({ session_id: c.req.param("session_id"), threads: [] }),
);

// ==========================================================================
// Extended surface — memory, notebooks, question bank, partners, skills,
// documents, mastery progress, session sub-actions, settings extras.
// ==========================================================================

// Map the old ``ext/<dir>/<kind>`` path segments to one SQLite collection.
function _collection(...parts: string[]): string {
  return parts.length > 1 ? parts.slice(0, -1).join("/") : parts[0] ?? "misc";
}

function _listDir(...parts: string[]): AnyRecord[] {
  return database.list_items(_settings(), _collection(...parts)) as AnyRecord[];
}

function _getItem(...parts: string[]): AnyRecord | null {
  return database.get_item(
    _settings(),
    _collection(...parts),
    String(parts[parts.length - 1]),
  ) as AnyRecord | null;
}

function _putItem(item: AnyRecord, ...parts: string[]): void {
  if (item["id"] === undefined || item["id"] === null || item["id"] === "") {
    item["id"] = uuid12();
  }
  if (item["created_at"] === undefined || item["created_at"] === null) {
    item["created_at"] = now();
  }
  item["updated_at"] = now();
  database.put_item(_settings(), _collection(...parts), item);
}

function _delItem(itemId: string, ...parts: string[]): boolean {
  return database.delete_item(
    _settings(),
    _collection(...parts),
    String(itemId),
  );
}

// -- memory -----------------------------------------------------------------

// GET /api/memory/doc/{level}/{doc_id}
handlersRouter.get("/api/memory/doc/:level/:doc_id", (c) => {
  const docId = c.req.param("doc_id");
  const level = c.req.param("level");
  const doc = _getItem("memory", "docs", docId);
  return c.json(
    doc ?? { id: docId, level, content: "", lines: [] },
  );
});

// PUT /api/memory/doc/{level}/{doc_id}
handlersRouter.put("/api/memory/doc/:level/:doc_id", async (c) => {
  const docId = c.req.param("doc_id");
  const level = c.req.param("level");
  const b = await body(c);
  b["id"] = docId;
  b["level"] = level;
  _putItem(b, "memory", "docs", docId);
  return c.json({ ok: true });
});

// POST /api/memory/doc/{level}/{doc_id}/lines
handlersRouter.post("/api/memory/doc/:level/:doc_id/lines", async (c) => {
  const docId = c.req.param("doc_id");
  const level = c.req.param("level");
  const b = await body(c);
  const doc =
    _getItem("memory", "docs", docId) ??
    ({ id: docId, level, lines: [] } as AnyRecord);
  const lines = (doc["lines"] ??= []) as AnyRecord[];
  const incoming = Array.isArray(b["lines"]) ? (b["lines"] as AnyRecord[]) : [];
  lines.push(...incoming);
  _putItem(doc, "memory", "docs", docId);
  return c.json({ ok: true, count: lines.length });
});

// POST /api/memory/doc/{level}/{doc_id}/update
handlersRouter.post("/api/memory/doc/:level/:doc_id/update", async (c) => {
  const docId = c.req.param("doc_id");
  const level = c.req.param("level");
  const b = await body(c);
  const doc =
    _getItem("memory", "docs", docId) ?? ({ id: docId, level } as AnyRecord);
  Object.assign(doc, b);
  _putItem(doc, "memory", "docs", docId);
  return c.json({ ok: true });
});

// GET /api/memory/resolve_entry/{entry_id}
handlersRouter.get("/api/memory/resolve_entry/:entry_id", (c) => {
  const entryId = c.req.param("entry_id");
  return c.json(_getItem("memory", "entries", entryId) ?? { id: entryId });
});

// GET /api/memory/runs
handlersRouter.get("/api/memory/runs", (c) =>
  c.json({ runs: _listDir("memory", "runs") }),
);

// POST /api/memory/runs
handlersRouter.post("/api/memory/runs", async (c) => {
  const b = await body(c);
  b["status"] = "completed";
  _putItem(b, "memory", "runs", "run");
  return c.json(b);
});

// POST /api/memory/runs/{run_id}/cancel
handlersRouter.post("/api/memory/runs/:run_id/cancel", (c) =>
  c.json({ ok: true, run_id: c.req.param("run_id"), status: "cancelled" }),
);

// GET /api/memory/runs/{run_id}/events
handlersRouter.get("/api/memory/runs/:run_id/events", (c) =>
  c.json({ events: [] }),
);

// POST /api/memory/runs/{run_id}/undo
handlersRouter.post("/api/memory/runs/:run_id/undo", (c) => c.json({ ok: true }));

// GET /api/memory/snapshot/{snap_id}
handlersRouter.get("/api/memory/snapshot/:snap_id", (c) => {
  const snapId = c.req.param("snap_id");
  return c.json(
    _getItem("memory", "snapshots", snapId) ?? { id: snapId, changes: [] },
  );
});

// GET /api/memory/snapshot/{snap_id}/changes
handlersRouter.get("/api/memory/snapshot/:snap_id/changes", (c) =>
  c.json({ changes: [] }),
);

// POST /api/memory/snapshot/{snap_id}/refresh
handlersRouter.post("/api/memory/snapshot/:snap_id/refresh", (c) =>
  c.json({ ok: true }),
);

// -- question notebook --------------------------------------------------------

// GET /api/question-notebook/categories
handlersRouter.get("/api/question-notebook/categories", (c) =>
  c.json({ categories: _listDir("question-notebook", "categories") }),
);

// POST /api/question-notebook/categories
handlersRouter.post("/api/question-notebook/categories", async (c) => {
  const b = await body(c);
  _putItem(b, "question-notebook", "categories", "cat");
  return c.json(b);
});

// GET /api/question-notebook/categories/{cat_id}
handlersRouter.get("/api/question-notebook/categories/:cat_id", (c) => {
  const catId = c.req.param("cat_id");
  return c.json(
    _getItem("question-notebook", "categories", catId) ?? { id: catId },
  );
});

// GET /api/question-notebook/entries
handlersRouter.get("/api/question-notebook/entries", (c) => {
  const limit = qInt(c, "limit", 50);
  const offset = qInt(c, "offset", 0);
  const search = qStr(c, "search");
  const sort = qStr(c, "sort", "recent");
  let items = _listDir("question-notebook", "entries");
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(
      (e) =>
        String(e["question"] ?? "").toLowerCase().includes(q) ||
        String(e["correct_answer"] ?? "").toLowerCase().includes(q),
    );
  }
  items.sort((a, b) => {
    const ka = Number(a["updated_at"] ?? a["created_at"] ?? 0);
    const kb = Number(b["updated_at"] ?? b["created_at"] ?? 0);
    return sort !== "oldest" ? kb - ka : ka - kb;
  });
  const total = items.length;
  return c.json({ items: items.slice(offset, offset + limit), total });
});

// POST /api/question-notebook/entries
handlersRouter.post("/api/question-notebook/entries", async (c) => {
  const b = await body(c);
  _putItem(b, "question-notebook", "entries", "entry");
  return c.json(b);
});

// GET /api/question-notebook/entries/{entry_id}
handlersRouter.get("/api/question-notebook/entries/:entry_id", (c) => {
  const entryId = c.req.param("entry_id");
  return c.json(
    _getItem("question-notebook", "entries", entryId) ?? { id: entryId },
  );
});

// DELETE /api/question-notebook/entries/{entry_id}
handlersRouter.delete("/api/question-notebook/entries/:entry_id", (c) => {
  const entryId = c.req.param("entry_id");
  return c.json({
    ok: _delItem(entryId, "question-notebook", "entries", "entry"),
  });
});

// GET /api/question-notebook/entries/lookup/by-question
handlersRouter.get(
  "/api/question-notebook/entries/lookup/by-question",
  (c) => {
    const entries = _listDir("question-notebook", "entries");
    const question = qStr(c, "question");
    const questionId = qStr(c, "question_id");
    const originType = qStr(c, "origin_type");
    const originRef = qStr(c, "origin_ref");
    const missingOk = qStr(c, "missing_ok") === "true" || qStr(c, "missing_ok") === "1";
    let hit: AnyRecord | null = null;
    for (const e of entries) {
      if (questionId && String(e["question_id"]) === questionId) {
        hit = e;
        break;
      }
      if (
        originType &&
        String(e["origin_type"] ?? "") === originType &&
        String(e["origin_ref"] ?? "") === originRef &&
        String(e["question_id"] ?? "") === questionId
      ) {
        hit = e;
        break;
      }
    }
    if (hit === null && question) {
      const q = question.toLowerCase();
      hit = entries.find(
        (e) => q && String(e["question"] ?? "").toLowerCase().includes(q),
      ) ?? null;
    }
    if (hit === null) {
      // A missing resource yields 204 or 404.
      if (missingOk) return new Response(null, { status: 204 });
      return httpError(c, 404, "not found");
    }
    return c.json(hit);
  },
);

// POST /api/question-notebook/entries/upsert
handlersRouter.post("/api/question-notebook/entries/upsert", async (c) => {
  const b = await body(c);
  const entries = _listDir("question-notebook", "entries");
  const qid = b["question_id"] ?? b["id"];
  const existing = entries.find(
    (e) =>
      String(e["question_id"]) === String(qid) ||
      String(e["id"]) === String(qid),
  );
  if (existing !== undefined) {
    Object.assign(existing, b);
    _putItem(existing, "question-notebook", "entries", "entry");
    return c.json(existing);
  }
  _putItem(b, "question-notebook", "entries", "entry");
  return c.json(b);
});

// GET /api/question-notebook/entries/{entry_id}/categories
handlersRouter.get(
  "/api/question-notebook/entries/:entry_id/categories",
  (c) => {
    const e =
      _getItem("question-notebook", "entries", c.req.param("entry_id")) ?? {};
    return c.json({ categories: e["categories"] ?? [] });
  },
);

// GET /api/question-notebook/materials
handlersRouter.get("/api/question-notebook/materials", (c) =>
  c.json({ materials: _listDir("question-notebook", "materials") }),
);

// GET /api/question-notebook/stats
handlersRouter.get("/api/question-notebook/stats", (c) => {
  const entries = _listDir("question-notebook", "entries");
  return c.json({ total: entries.length, by_category: {} });
});

// POST /api/question-notebook/entries/categories/bulk
handlersRouter.post(
  "/api/question-notebook/entries/categories/bulk",
  async (c) => {
    const b = await body(c);
    const ids = (b["entry_ids"] ?? b["ids"] ?? []) as unknown[];
    const catIds = (b["category_ids"] ?? b["categories"] ?? []) as unknown[];
    for (const eid of ids) {
      const e = _getItem("question-notebook", "entries", String(eid));
      if (e !== null) {
        e["categories"] = catIds;
        _putItem(e, "question-notebook", "entries", "entry");
      }
    }
    return c.json({ ok: true, updated: ids.length });
  },
);

// DELETE /api/question-notebook/entries/{entry_id}/categories/{cat_id}
handlersRouter.delete(
  "/api/question-notebook/entries/:entry_id/categories/:cat_id",
  (c) => {
    const entryId = c.req.param("entry_id");
    const catId = c.req.param("cat_id");
    const e = _getItem("question-notebook", "entries", entryId);
    if (e === null) return httpError(c, 404, "entry not found");
    e["categories"] = ((e["categories"] ?? []) as unknown[]).filter(
      (x) => String(x) !== catId,
    );
    _putItem(e, "question-notebook", "entries", "entry");
    return c.json({ ok: true });
  },
);

// -- notebooks -----------------------------------------------------------------

// GET /api/notebooks
handlersRouter.get("/api/notebooks", (c) =>
  c.json({ notebooks: _listDir("notebooks") }),
);

// POST /api/notebooks
handlersRouter.post("/api/notebooks", async (c) => {
  const b = await body(c);
  _putItem(b, "notebooks", "nb");
  return c.json(b);
});

// GET /api/notebooks/{nb_id}
handlersRouter.get("/api/notebooks/:nb_id", (c) => {
  const nbId = c.req.param("nb_id");
  return c.json(
    _getItem("notebooks", nbId) ?? { id: nbId, records: [] },
  );
});

// DELETE /api/notebooks/{nb_id}
handlersRouter.delete("/api/notebooks/:nb_id", (c) => {
  const nbId = c.req.param("nb_id");
  return c.json({ ok: _delItem(nbId, "notebooks", "nb") });
});

// GET /api/notebooks/records/{record_id}
handlersRouter.get("/api/notebooks/records/:record_id", (c) => {
  const recordId = c.req.param("record_id");
  for (const nb of _listDir("notebooks")) {
    for (const r of (nb["records"] ?? []) as AnyRecord[]) {
      if (String(r["id"]) === recordId) return c.json(r);
    }
  }
  return httpError(c, 404, "record not found");
});

// GET /api/notebooks/{nb_id}/export
handlersRouter.get("/api/notebooks/:nb_id/export", (c) => {
  const nbId = c.req.param("nb_id");
  const nb = _getItem("notebooks", nbId) ?? { id: nbId };
  const records = (nb["records"] ?? []) as AnyRecord[];
  const markdown =
    `# ${String(nb["title"] ?? "Notebook")}\n\n` +
    records.map((r) => String(r["content"] ?? "")).join("\n");
  return c.json({ markdown });
});

// GET /api/notebooks/{nb_id}/records
handlersRouter.get("/api/notebooks/:nb_id/records", (c) => {
  const nb = _getItem("notebooks", c.req.param("nb_id")) ?? {};
  return c.json({ records: nb["records"] ?? [] });
});

// POST /api/notebooks/{nb_id}/records
handlersRouter.post("/api/notebooks/:nb_id/records", async (c) => {
  const nbId = c.req.param("nb_id");
  const b = await body(c);
  const nb =
    _getItem("notebooks", nbId) ??
    ({ id: nbId, records: [] } as AnyRecord);
  const rec: AnyRecord = { ...b };
  if (rec["id"] === undefined || rec["id"] === null || rec["id"] === "") {
    rec["id"] = uuid12();
  }
  if (rec["created_at"] === undefined || rec["created_at"] === null) {
    rec["created_at"] = now();
  }
  const records = (nb["records"] ??= []) as AnyRecord[];
  records.push(rec);
  _putItem(nb, "notebooks", nbId);
  return c.json(rec);
});

// GET /api/notebooks/{nb_id}/records/{rec_id}
handlersRouter.get("/api/notebooks/:nb_id/records/:rec_id", (c) => {
  const nbId = c.req.param("nb_id");
  const recId = c.req.param("rec_id");
  const nb = _getItem("notebooks", nbId) ?? {};
  for (const r of (nb["records"] ?? []) as AnyRecord[]) {
    if (String(r["id"]) === recId) return c.json(r);
  }
  return c.json({ id: recId });
});

// DELETE /api/notebooks/{nb_id}/records/{rec_id}
handlersRouter.delete("/api/notebooks/:nb_id/records/:rec_id", (c) => {
  const nbId = c.req.param("nb_id");
  const recId = c.req.param("rec_id");
  const nb = _getItem("notebooks", nbId) ?? { records: [] };
  nb["records"] = ((nb["records"] ?? []) as AnyRecord[]).filter(
    (r) => String(r["id"]) !== recId,
  );
  _putItem(nb, "notebooks", nbId);
  return c.json({ ok: true });
});

// POST /api/notebooks/{nb_id}/records/{rec_id}/actions/{action}
handlersRouter.post(
  "/api/notebooks/:nb_id/records/:rec_id/actions/:action",
  async (c) => {
    const nbId = c.req.param("nb_id");
    const recId = c.req.param("rec_id");
    const action = c.req.param("action");
    const b = await body(c);
    const nb = _getItem("notebooks", nbId) ?? { records: [] };
    for (const r of (nb["records"] ?? []) as AnyRecord[]) {
      if (String(r["id"]) === recId) {
        const actions = (r["actions"] ??= []) as AnyRecord[];
        actions.push({ action, at: now(), ...b });
        _putItem(nb, "notebooks", nbId);
        return c.json({ ok: true });
      }
    }
    return c.json({ ok: false });
  },
);

// -- mastery progress -----------------------------------------------------------

// GET /api/mastery-paths/progress/{topic_id}
handlersRouter.get("/api/mastery-paths/progress/:topic_id", (c) => {
  const topicId = c.req.param("topic_id");
  return c.json(
    _getItem("mastery", "progress", topicId) ?? {
      topic_id: topicId,
      modules: [],
      status: "not_started",
    },
  );
});

// POST /api/mastery-paths/progress/{topic_id}/init-modules
handlersRouter.post(
  "/api/mastery-paths/progress/:topic_id/init-modules",
  async (c) => {
    const topicId = c.req.param("topic_id");
    const b = await body(c);
    const prog =
      _getItem("mastery", "progress", topicId) ?? ({ topic_id: topicId } as AnyRecord);
    prog["modules"] = b["modules"] ?? [];
    prog["status"] = "in_progress";
    _putItem(prog, "mastery", "progress", topicId);
    return c.json(prog);
  },
);

// PUT /api/mastery-paths/progress/{topic_id}
handlersRouter.put("/api/mastery-paths/progress/:topic_id", async (c) => {
  const topicId = c.req.param("topic_id");
  const b = await body(c);
  b["topic_id"] = topicId;
  _putItem(b, "mastery", "progress", topicId);
  return c.json({ ok: true });
});

// -- partners -------------------------------------------------------------------

// GET /api/partners
handlersRouter.get("/api/partners", (c) => c.json(_listDir("partners")));

// POST /api/partners
handlersRouter.post("/api/partners", async (c) => {
  const b = await body(c);
  _putItem(b, "partners", "p");
  return c.json(b);
});

// GET /api/partners/{pid}
handlersRouter.get("/api/partners/:pid", (c) => {
  const pid = c.req.param("pid");
  return c.json(_getItem("partners", pid) ?? { id: pid });
});

// DELETE /api/partners/{pid}
handlersRouter.delete("/api/partners/:pid", (c) => {
  const pid = c.req.param("pid");
  return c.json({ ok: _delItem(pid, "partners", "p") });
});

// POST /api/partners/consultation-session
handlersRouter.post("/api/partners/consultation-session", async (c) => {
  const b = await body(c);
  const sess: AnyRecord = {
    id: uuid12(),
    status: "active",
    created_at: now(),
    ...b,
  };
  _putItem(sess, "partners", "sessions", "s");
  return c.json(sess);
});

// POST /api/partners/drafts/{draft_id}
handlersRouter.post("/api/partners/drafts/:draft_id", async (c) => {
  const draftId = c.req.param("draft_id");
  const b = await body(c);
  b["id"] = draftId;
  _putItem(b, "partners", "drafts", draftId);
  return c.json({ ok: true });
});

// GET /api/partners/drafts/{draft_id}
handlersRouter.get("/api/partners/drafts/:draft_id", (c) => {
  const draftId = c.req.param("draft_id");
  return c.json(
    _getItem("partners", "drafts", draftId) ?? { id: draftId },
  );
});

// GET /api/partner-groups/discussion-modes
handlersRouter.get("/api/partner-groups/discussion-modes", (c) => {
  const modes = _listDir("partner-groups", "modes");
  return c.json({
    modes: modes.length
      ? modes
      : [
          { id: "free", name: "Free discussion" },
          { id: "structured", name: "Structured" },
          { id: "debate", name: "Debate" },
        ],
  });
});

// GET /api/partner-groups
handlersRouter.get("/api/partner-groups", (c) =>
  c.json(_listDir("partner-groups")),
);

// POST /api/partner-groups
handlersRouter.post("/api/partner-groups", async (c) => {
  const b = await body(c);
  _putItem(b, "partner-groups", "g");
  return c.json(b);
});

// GET /api/partner-groups/{gid}
handlersRouter.get("/api/partner-groups/:gid", (c) => {
  const gid = c.req.param("gid");
  return c.json(_getItem("partner-groups", gid) ?? { id: gid });
});

// DELETE /api/partner-groups/{gid}
handlersRouter.delete("/api/partner-groups/:gid", (c) => {
  const gid = c.req.param("gid");
  return c.json({ ok: _delItem(gid, "partner-groups", "g") });
});

// -- skills ---------------------------------------------------------------------

// GET /api/skills/hub/catalog
handlersRouter.get("/api/skills/hub/catalog", (c) =>
  c.json({ skills: _listDir("skills") }),
);

// GET /api/skills/hub/detail
handlersRouter.get("/api/skills/hub/detail", (c) =>
  c.json({ skills: _listDir("skills") }),
);

// GET /api/skills/{skill_id}
handlersRouter.get("/api/skills/:skill_id", (c) => {
  const skillId = c.req.param("skill_id");
  return c.json(_getItem("skills", skillId) ?? { id: skillId });
});

// DELETE /api/skills/{skill_id}
handlersRouter.delete("/api/skills/:skill_id", (c) => {
  const skillId = c.req.param("skill_id");
  return c.json({ ok: _delItem(skillId, "skills", "s") });
});

// GET /api/skills/tags/{tag}
handlersRouter.get("/api/skills/tags/:tag", (c) => {
  const tag = c.req.param("tag");
  const skills = _listDir("skills").filter((s) =>
    ((s["tags"] ?? []) as unknown[]).includes(tag),
  );
  return c.json({ skills });
});

// -- documents / imports / personas / misc ---------------------------------------

// GET /api/personas
handlersRouter.get("/api/personas", (c) =>
  c.json({ personas: _listDir("personas") }),
);

// POST /api/creations/drafts/{draft_id}/approve
handlersRouter.post("/api/creations/drafts/:draft_id/approve", async (c) => {
  const draftId = c.req.param("draft_id");
  await body(c);
  const d =
    _getItem("creations", "drafts", draftId) ?? ({ id: draftId } as AnyRecord);
  d["status"] = "approved";
  _putItem(d, "creations", "drafts", draftId);
  return c.json(d);
});

// POST /api/imports/chat-history
handlersRouter.post("/api/imports/chat-history", async (c) => {
  await body(c);
  return c.json({ ok: true, imported: 0 });
});

// GET /api/creations/drafts/{draft_id}
handlersRouter.get("/api/creations/drafts/:draft_id", (c) => {
  const draftId = c.req.param("draft_id");
  return c.json(
    _getItem("creations", "drafts", draftId) ?? { id: draftId },
  );
});

// POST /api/creations/drafts/{draft_id}
handlersRouter.post("/api/creations/drafts/:draft_id", async (c) => {
  const draftId = c.req.param("draft_id");
  const b = await body(c);
  b["id"] = draftId;
  _putItem(b, "creations", "drafts", draftId);
  return c.json({ ok: true });
});

// GET /api/personas/{pid}
handlersRouter.get("/api/personas/:pid", (c) => {
  const pid = c.req.param("pid");
  return c.json(_getItem("personas", pid) ?? { id: pid });
});

// POST /api/personas/{pid}
handlersRouter.post("/api/personas/:pid", async (c) => {
  const pid = c.req.param("pid");
  const b = await body(c);
  b["id"] = pid;
  _putItem(b, "personas", pid);
  return c.json({ ok: true });
});

// GET /api/subagents/backends/{backend_id}
handlersRouter.get("/api/subagents/backends/:backend_id", (c) =>
  c.json({ id: c.req.param("backend_id"), status: "configured" }),
);

// GET /api/subagents/connections/{conn_id}
handlersRouter.get("/api/subagents/connections/:conn_id", (c) =>
  c.json({ id: c.req.param("conn_id"), status: "active" }),
);

// GET /api/video-learning/materials/{mat_id}
handlersRouter.get("/api/video-learning/materials/:mat_id", (c) => {
  const matId = c.req.param("mat_id");
  return c.json(
    _getItem("video-learning", "materials", matId) ?? { id: matId },
  );
});

// GET /api/dashboard/learning-library/{lib_id}
handlersRouter.get("/api/dashboard/learning-library/:lib_id", (c) => {
  const libId = c.req.param("lib_id");
  return c.json(
    _getItem("dashboard", "library", libId) ?? { id: libId, items: [] },
  );
});

// -- session sub-actions ---------------------------------------------------------

// POST /api/sessions/{session_id}/migrate-watching
handlersRouter.post("/api/sessions/:session_id/migrate-watching", (c) =>
  c.json({ session_id: c.req.param("session_id"), migrated: true }),
);

// POST /api/sessions/{session_id}/ask-hint
handlersRouter.post("/api/sessions/:session_id/ask-hint", async (c) => {
  await body(c);
  return c.json({ hint: "", session_id: c.req.param("session_id") });
});

// GET /api/sessions/{session_id}/branch-selection
handlersRouter.get("/api/sessions/:session_id/branch-selection", (c) =>
  c.json({ branches: [] }),
);

// POST /api/sessions/{session_id}/branch-selection
handlersRouter.post("/api/sessions/:session_id/branch-selection", async (c) => {
  await body(c);
  return c.json({ ok: true });
});

// GET /api/sessions/{session_id}/quiz-results
handlersRouter.get("/api/sessions/:session_id/quiz-results", (c) =>
  c.json({ results: [] }),
);

// POST /api/sessions/submission-replacement
handlersRouter.post("/api/sessions/submission-replacement", async (c) => {
  await body(c);
  return c.json({ ok: true, receipt: { id: uuid12() } });
});

// -- settings extras (presets / services preview / tests) --------------------------

// GET /api/settings/presets/{preset_id}/draft
handlersRouter.get("/api/settings/presets/:preset_id/draft", (c) =>
  c.json({ preset_id: c.req.param("preset_id"), draft: {} }),
);

// POST /api/settings/presets/{preset_id}/draft
handlersRouter.post("/api/settings/presets/:preset_id/draft", async (c) => {
  await body(c);
  return c.json({ ok: true });
});

// POST /api/settings/services/{service}/preview
handlersRouter.post("/api/settings/services/:service/preview", async (c) => {
  await body(c);
  return c.json({ service: c.req.param("service"), preview: {} });
});

// POST /api/settings/tests/{service}/start
handlersRouter.post("/api/settings/tests/:service/start", async (c) => {
  // Start a bounded diagnostic probe of the model being configured.
  // The browser sends the whole draft catalog so the test uses unsaved edits.
  // A run id is returned immediately; progress arrives on the SSE events route.
  const runner = get_config_test_runner();
  const b = await body(c);
  let catalog = b["catalog"];
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    catalog = await providerConfig.load_catalog(_settings());
  }
  const run = (await runner.start(c.req.param("service"), catalog)) as AnyRecord;
  return c.json({ run_id: run["id"] });
});

// GET /api/settings/tests/{service}/{run_id}/events
handlersRouter.get(
  "/api/settings/tests/:service/:run_id/events",
  async (c) => {
    // Stream probe events until the run finishes, then close the stream.
    const runner = get_config_test_runner();
    const service = c.req.param("service");
    const runId = c.req.param("run_id");
    const run = (await runner.get(runId)) as AnyRecord | null | undefined;
    if (run === null || run === undefined || run["service"] !== service) {
      return httpError(c, 404, "Test run not found.");
    }

    return streamSSE(c, async (stream) => {
      let sent = 0;
      const signal = c.req.raw.signal;
      try {
        for (;;) {
          if (signal.aborted) return;
          const events = (await run["snapshot"](sent)) as AnyRecord[];
          if (events && events.length) {
            for (const event of events) {
              await stream.writeSSE({ data: JSON.stringify(event) });
            }
            sent += events.length;
            if (await run["isTerminal"]()) return;
          } else {
            await stream.writeSSE({ event: "heartbeat", data: "{}" });
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      } finally {
        let terminal = true;
        try {
          terminal = Boolean(await run["isTerminal"]());
        } catch {
          terminal = true;
        }
        if (!terminal) run["cancelled"] = true;
      }
    });
  },
);

// POST /api/settings/tests/{service}/{run_id}/cancel
handlersRouter.post(
  "/api/settings/tests/:service/:run_id/cancel",
  async (c) => {
    const runner = get_config_test_runner();
    const cancelled = await runner.cancel(c.req.param("run_id"));
    if (!cancelled) return httpError(c, 404, "Test run not found.");
    return c.json({ message: "Cancelled" });
  },
);

// GET /api/dashboard/source-library/{kind}
handlersRouter.get("/api/dashboard/source-library/:kind", async (c) => {
  // Items for the note "Reference a source" picker.
  // The picker asks for six kinds; this backend only has chats (sessions),
  // drafts (co-writer documents) and knowledge bases. The rest return empty.
  const kind = c.req.param("kind");
  const items: AnyRecord[] = [];

  if (kind === "chats") {
    const store = await _store();
    const sessions = (await store.all()) as AnyRecord[];
    sessions.sort((a, b) => _sessionUpdatedKey(b) - _sessionUpdatedKey(a));
    for (const s of sessions.slice(0, 100)) {
      items.push({
        session_id: s["id"],
        title: s["title"] || "Untitled",
        last_message: "",
        content_workspace_id: ((s["preferences"] as AnyRecord) ?? {})[
          "workspace_id"
        ] ?? null,
      });
    }
  } else if (kind === "drafts") {
    const storage = get_co_writer_storage();
    const docs = storage.listDocuments();
    for (const doc of docs.slice(0, 100)) {
      const full = storage.loadDocument(doc.id);
      const content = String(full?.content ?? "");
      items.push({
        id: doc.id,
        title: doc.title || "Untitled",
        preview: content.split(/\s+/).filter(Boolean).join(" ").slice(0, 200),
      });
    }
  } else if (kind === "knowledge") {
    const kb = await _kb();
    for (const kbRow of kb.list() as AnyRecord[]) {
      const name = String(kbRow["name"] ?? kbRow["id"] ?? "");
      if (!name) continue;
      items.push({ id: name, name, metadata: {} });
    }
  }
  // books / notebooks / practice: no such stores in this deployment.

  return c.json({ items, unavailable_workspaces: [], total: items.length });
});

// Catch-all for settings sub-pages/extensions the UI probes (GET/PUT/POST).
// Registered last so specific settings routes (tests, presets, preview, ...)
// always win — an earlier catch-all silently swallowed them and returned {}.
handlersRouter.on(
  ["GET", "PUT", "POST", "DELETE", "PATCH"],
  "/api/settings/*",
  (c) => c.json({}),
);

// Re-export for convenience/tests.
export { _epochSeconds as epochSeconds };
