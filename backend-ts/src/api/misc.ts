// Ports of deeptutor/api/routers/{task_board,personas,modules,capabilities,
// capabilities_settings,imports,creations,dashboard,practice}.py.
// NOTE: several paths overlap handlers.ts stubs (personas GET, creations drafts,
// imports POST, dashboard suggestions/source-library/learning-library,
// capabilities/registered, modules). Mount this router BEFORE handlersRouter
// so the faithful implementations win.
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { get_settings } from "../config.js";
import * as database from "../store/database.js";
import { SessionStore } from "../store/session_store.js";
import { KnowledgeBaseStore } from "../store/kb_store.js";
import {
  boardRevision,
  createCard,
  linkStatus,
  linkTasks,
  readBoard,
  setColors,
  updateCard,
  workspaceBoard,
} from "../services/task_board.js";
import type { StatusColors, TaskBoard } from "../services/task_board.js";
import {
  adminPersonaService,
  getPersonaService,
  InvalidPersonaNameError,
  PersonaExistsError,
  PersonaNotFoundError,
  personaPresets,
} from "../services/persona.js";
import type { PersonaService } from "../services/persona.js";
import { CreationDraftStore, getCreationKind } from "../services/creations.js";
import type { CreationDraft } from "../services/creations.js";
import { PracticeStore, previewImport, MAX_BYTES as PRACTICE_MAX_BYTES, ReviewConflict } from "../services/practice.js";
import type { Rating } from "../services/practice.js";

export const miscRouter = new Hono();

type AnyDict = Record<string, any>;

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

async function body(c: Context): Promise<AnyDict> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as AnyDict)
      : {};
  } catch {
    return {};
  }
}

function now(): number {
  return Date.now() / 1000;
}

let fallbackStore: SessionStore | null = null;
let fallbackKb: KnowledgeBaseStore | null = null;
function store(): SessionStore {
  fallbackStore ??= new SessionStore(get_settings());
  return fallbackStore;
}
function kb(): KnowledgeBaseStore {
  fallbackKb ??= new KnowledgeBaseStore(get_settings());
  return fallbackKb;
}

function epochSeconds(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const t = Date.parse(value.replace("Z", "+00:00"));
    return Number.isNaN(t) ? 0 : t / 1000;
  }
  return 0;
}

// ==========================================================================
// task_board.py — /api/task-board
// ==========================================================================
// Single-tenant: workspace resolves to "" (the general board) unless the
// dt_workspace header/query names one; workspace validation is permissive.

function boardWorkspace(c: Context): string {
  const raw = c.req.header("x-deeptutor-workspace") ?? c.req.query("dt_workspace") ?? "";
  return String(raw || "");
}

miscRouter.get("/api/task-board", (c) => {
  return c.json(workspaceBoard(readBoard(), boardWorkspace(c)));
});

miscRouter.get("/api/task-board/events", (c) => {
  const workspaceId = boardWorkspace(c);
  return streamSSE(c, async (stream) => {
    let revision = -1;
    let heartbeat = 0;
    const deadline = Date.now() + 30_000; // SSE streams are long-lived; cap for tests
    while (Date.now() < deadline) {
      const current = boardRevision();
      if (current !== revision) {
        const board = workspaceBoard(readBoard(), workspaceId);
        revision = board.revision;
        await stream.writeSSE({ id: String(revision), data: JSON.stringify(board) });
      } else if (heartbeat % 30 === 0) {
        await stream.writeSSE({ data: ": heartbeat" });
      }
      heartbeat++;
      await new Promise((r) => setTimeout(r, 500));
    }
  });
});

miscRouter.post("/api/task-board/cards", async (c) => {
  const payload = await body(c);
  const title = String(payload.title ?? "").trim();
  if (!title || title.length > 160) return httpError(c, 422, "title is required (1-160 chars)");
  const note = String(payload.note ?? "");
  if (note.length > 2000) return httpError(c, 422, "note too long");
  const due = payload.due_date ?? null;
  if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(due))) {
    return httpError(c, 422, "due_date must be YYYY-MM-DD");
  }
  const board = createCard({ title, note, due_date: due as string | null }, boardWorkspace(c) || null);
  return c.json(workspaceBoard(board, boardWorkspace(c)), 201);
});

miscRouter.patch("/api/task-board/cards/:card_id", async (c) => {
  const cardId = c.req.param("card_id");
  const payload = await body(c);
  const changes: AnyDict = {};
  if ("title" in payload) {
    const t = String(payload.title ?? "").trim();
    if (!t || t.length > 160) return httpError(c, 422, "title must be 1-160 chars");
    changes.title = t;
  }
  if ("note" in payload) {
    if (payload.note === null) return httpError(c, 422, "Card fields cannot be null.");
    if (String(payload.note).length > 2000) return httpError(c, 422, "note too long");
    changes.note = String(payload.note);
  }
  if ("status" in payload) {
    if (payload.status === null) return httpError(c, 422, "Card fields cannot be null.");
    if (!["todo", "doing", "done"].includes(String(payload.status))) {
      return httpError(c, 422, "status must be todo|doing|done");
    }
    changes.status = payload.status;
  }
  if ("archived" in payload) {
    if (payload.archived === null) return httpError(c, 422, "Card fields cannot be null.");
    changes.archived = !!payload.archived;
  }
  if ("workspace_id" in payload) changes.workspace_id = payload.workspace_id ?? "";
  if ("due_date" in payload) {
    const d = payload.due_date;
    if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
      return httpError(c, 422, "due_date must be YYYY-MM-DD or null");
    }
    changes.due_date = d;
  }
  try {
    const board = updateCard(cardId, changes, boardWorkspace(c));
    return c.json(workspaceBoard(board, boardWorkspace(c)));
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (msg.startsWith("KeyError:")) return httpError(c, 404, "Task card not found.");
    throw exc;
  }
});

miscRouter.put("/api/task-board/colors", async (c) => {
  const payload = await body(c);
  const color = (v: unknown, dflt: string) => {
    const s = String(v ?? dflt);
    return /^#[0-9a-fA-F]{6}$/.test(s) ? s : dflt;
  };
  const colors: StatusColors = {
    todo: color(payload.todo, "#2563eb"),
    doing: color(payload.doing, "#a16207"),
    done: color(payload.done, "#15803d"),
  };
  return c.json(workspaceBoard(setColors(colors), boardWorkspace(c)));
});

async function requireSession(sessionId: string, workspaceId: string, boardWorkspaceId: string): Promise<string> {
  if (workspaceId && workspaceId !== boardWorkspaceId) {
    throw Object.assign(new Error("Conversation not found."), { status: 404 });
  }
  if (!store().get(sessionId)) {
    throw Object.assign(new Error("Conversation not found."), { status: 404 });
  }
  return workspaceId || boardWorkspaceId;
}

miscRouter.put("/api/task-board/sessions/:session_id", async (c) => {
  const sessionId = c.req.param("session_id");
  const payload = await body(c);
  const boardWs = boardWorkspace(c);
  let wsId = String(payload.workspace_id ?? "");
  const ids = Array.isArray(payload.task_ids) ? payload.task_ids.map(String).slice(0, 100) : [];
  try {
    wsId = await requireSession(sessionId, wsId, boardWs);
  } catch (exc) {
    return httpError(c, (exc as AnyDict)?.status ?? 404, exc instanceof Error ? exc.message : String(exc));
  }
  try {
    const board = linkTasks(sessionId, wsId, [...new Set(ids)]);
    return c.json(workspaceBoard(board, boardWs));
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    if (msg.startsWith("KeyError:")) return httpError(c, 404, "Task not found or archived.");
    throw exc;
  }
});

miscRouter.patch("/api/task-board/sessions/:session_id/status", async (c) => {
  const sessionId = c.req.param("session_id");
  const payload = await body(c);
  const boardWs = boardWorkspace(c);
  let wsId = String(payload.workspace_id ?? "");
  try {
    wsId = await requireSession(sessionId, wsId, boardWs);
  } catch (exc) {
    return httpError(c, (exc as AnyDict)?.status ?? 404, exc instanceof Error ? exc.message : String(exc));
  }
  const board = linkStatus(sessionId, wsId, !!payload.enabled);
  return c.json(workspaceBoard(board, boardWs));
});

// ==========================================================================
// personas.py — /api/personas (full upstream surface; overlaps handlers stubs)
// ==========================================================================

function classifyPersonaError(exc: unknown, name: string, c: Context) {
  if (exc instanceof PersonaNotFoundError) return httpError(c, 404, `Persona '${name}' not found`);
  if (exc instanceof PersonaExistsError) return httpError(c, 409, `Persona '${name}' already exists`);
  if (exc instanceof InvalidPersonaNameError) return httpError(c, 400, exc.message);
  throw exc;
}

miscRouter.get("/api/personas", (c) => {
  const service = getPersonaService();
  const own = service.listPersonas().map((i) => ({
    name: i.name, description: i.description, source: "user", read_only: false,
  }));
  const presets = personaPresets(service);
  if (!presets) return c.json({ personas: own });
  const ownNames = new Set(own.map((p) => p.name));
  const merged = [...own];
  for (const preset of presets.listPersonas()) {
    if (ownNames.has(preset.name)) continue;
    merged.push({ name: preset.name, description: preset.description, source: "admin", read_only: true });
  }
  return c.json({ personas: merged });
});

miscRouter.post("/api/personas", async (c) => {
  const payload = await body(c);
  try {
    const info = getPersonaService().create(
      String(payload.name ?? ""), String(payload.description ?? ""), String(payload.content ?? ""),
    );
    return c.json({ name: info.name, description: info.description, source: "user", read_only: false });
  } catch (exc) {
    return classifyPersonaError(exc, String(payload.name ?? ""), c);
  }
});

miscRouter.get("/api/personas/:name", (c) => {
  const name = c.req.param("name");
  const service = getPersonaService();
  try {
    const detail = service.getDetail(name);
    return c.json({ ...toPersonaDict(detail), source: "user", read_only: false });
  } catch (exc) {
    if (!(exc instanceof PersonaNotFoundError) && !(exc instanceof InvalidPersonaNameError)) throw exc;
  }
  const presets = personaPresets(service);
  if (presets) {
    try {
      const detail = presets.getDetail(name);
      return c.json({ ...toPersonaDict(detail), source: "admin", read_only: true });
    } catch { /* fall through */ }
  }
  return httpError(c, 404, `Persona '${name}' not found`);
});

function toPersonaDict(detail: { name: string; description: string; content: string }): AnyDict {
  return { name: detail.name, description: detail.description, content: detail.content };
}

miscRouter.put("/api/personas/:name", async (c) => {
  const name = c.req.param("name");
  const payload = await body(c);
  try {
    const info = getPersonaService().update(name, {
      description: payload.description ?? null,
      content: payload.content ?? null,
      rename_to: payload.rename_to ?? null,
    });
    return c.json({ name: info.name, description: info.description, source: "user", read_only: false });
  } catch (exc) {
    return classifyPersonaError(exc, name, c);
  }
});

miscRouter.delete("/api/personas/:name", (c) => {
  const name = c.req.param("name");
  try {
    getPersonaService().delete(name);
    return c.json({ status: "deleted", name });
  } catch (exc) {
    return classifyPersonaError(exc, name, c);
  }
});

// ==========================================================================
// modules.py — /api/modules
// ==========================================================================

miscRouter.get("/api/modules", (c) => {
  // Static deployment inventory for this backend's supported modules.
  const modules = [
    { id: "core", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: [], navigation: [], capabilities: ["chat"], source: true },
    { id: "calendar", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: ["/calendar"], capabilities: [], source: true },
    { id: "co-writer", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: [], capabilities: ["co_writer"], source: true },
    { id: "cron", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: [], capabilities: [], source: true },
    { id: "notebook", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: ["/learning/practice"], capabilities: ["notebook"], source: true },
    { id: "questions", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: [], capabilities: ["question"], source: true },
    { id: "video-lesson", distribution: "praxis-backend", installed: true, enabled: true, ready: true, issues: [], requires: ["core"], navigation: [], capabilities: ["video_lesson"], source: true },
  ];
  return c.json({ modules });
});

// ==========================================================================
// capabilities.py + capabilities_settings.py — /api/capabilities/*
// ==========================================================================

miscRouter.get("/api/capabilities/registered", (c) => {
  // Describe the turn capabilities this deployment can execute. Derived from
  // the agent capabilities registered in src/agent/*/capability.ts.
  const capabilities = [
    { id: "chat", kind: "turn", available: true, manifest: { name: "chat" }, config_schema: {} },
    { id: "co_writer", kind: "turn", available: true, manifest: { name: "co_writer" }, config_schema: {} },
    { id: "notebook", kind: "turn", available: true, manifest: { name: "notebook" }, config_schema: {} },
    { id: "video_lesson", kind: "turn", available: true, manifest: { name: "video_lesson" }, config_schema: {} },
  ];
  capabilities.sort((a, b) => a.id.localeCompare(b.id));
  return c.json({ capabilities });
});

const CAP_DEFAULTS: AnyDict = {
  chat: { temperature: 0.7, max_tokens: 8192, max_rounds: 12, max_replans: 2 },
  solve: { temperature: 0.3, max_tokens: 8192, max_rounds: 12, max_replans: 2 },
  research: { temperature: 0.5, max_tokens: 16834 },
  question: { temperature: 0.7, max_tokens: 4096 },
  visualize: { temperature: 0.15, max_tokens: 16000 },
  co_writer: { temperature: 0.6, max_tokens: 4096 },
  vision_solver: { temperature: 0.3, max_tokens: 12000 },
  math_animator: { temperature: 0.2, max_tokens: 16834 },
};

function capabilitiesSettings(): AnyDict {
  const stored = database.get_state(get_settings(), "settings/capabilities", {}) as AnyDict;
  const merged: AnyDict = {};
  for (const [key, dflt] of Object.entries(CAP_DEFAULTS)) {
    merged[key] = { ...(dflt as AnyDict), ...((stored[key] as AnyDict) ?? {}) };
  }
  return { capabilities: merged, _stored: stored };
}

miscRouter.get("/api/capabilities/settings", (c) => {
  const { capabilities } = capabilitiesSettings();
  return c.json({ capabilities });
});

miscRouter.put("/api/capabilities/settings", async (c) => {
  const payload = await body(c);
  const current = database.get_state(get_settings(), "settings/capabilities", {}) as AnyDict;
  const incoming = (payload.capabilities ?? payload) as AnyDict;
  const next: AnyDict = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      next[key] = { ...(current[key] as AnyDict ?? {}), ...(value as AnyDict) };
    }
  }
  database.put_state(get_settings(), "settings/capabilities", next);
  const { capabilities } = capabilitiesSettings();
  return c.json({ capabilities });
});

// ==========================================================================
// imports.py — /api/imports/chat-history (GET + POST; overlaps handlers POST stub)
// ==========================================================================

const IMPORTED_PREFIX = "imported_";
const ID_SAFE = /[^a-zA-Z0-9_-]+/g;
const ALLOWED_SOURCES = new Set(["chatgpt", "claude_code", "codex"]);
const MAX_SESSIONS_PER_REQUEST = 1000;
const MAX_MESSAGES_PER_SESSION = 10000;

function makeImportedSessionId(source: string, externalId: string): string {
  const src = String(source || "external").trim().replace(ID_SAFE, "-") || "external";
  const ext = String(externalId || "").trim().replace(ID_SAFE, "-") || crypto.randomUUID().replace(/-/g, "");
  return `${IMPORTED_PREFIX}${src}_${ext}`;
}

miscRouter.post("/api/imports/chat-history", async (c) => {
  const payload = await body(c);
  const source = String(payload.source ?? "").trim().toLowerCase();
  if (!ALLOWED_SOURCES.has(source)) {
    return httpError(c, 422, `Unsupported import source: ${payload.source}`);
  }
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  if (!sessions.length) return httpError(c, 400, "No sessions to import");
  if (sessions.length > MAX_SESSIONS_PER_REQUEST) {
    return httpError(c, 413, `Too many sessions in one request (max ${MAX_SESSIONS_PER_REQUEST})`);
  }
  const agentId = String(payload.agent_id ?? "").slice(0, 256);
  const agentName = String(payload.agent_name ?? "").slice(0, 256);
  const s = store();
  let imported = 0;
  let skipped = 0;
  const results: AnyDict[] = [];
  for (const incoming of sessions as AnyDict[]) {
    const externalId = String(incoming.external_id ?? "").slice(0, 256);
    const rawMessages = Array.isArray(incoming.messages) ? incoming.messages : [];
    const messages = rawMessages
      .filter((m: AnyDict) => String(m?.content ?? "").trim())
      .slice(0, MAX_MESSAGES_PER_SESSION)
      .map((m: AnyDict) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
        created_at: typeof m.created_at === "number" ? m.created_at : undefined,
        metadata: m.metadata && typeof m.metadata === "object" ? m.metadata : {},
      }));
    if (!messages.length) {
      skipped++;
      results.push({ external_id: externalId, imported: false, reason: "empty" });
      continue;
    }
    const sessionId = makeImportedSessionId(source, externalId);
    const importMeta: AnyDict = {
      source,
      source_cwd: String(incoming.source_cwd ?? ""),
      external_id: externalId,
    };
    if (agentId) importMeta.agent_id = agentId;
    if (agentName) importMeta.agent_name = agentName;
    const preferences: AnyDict = { import: importMeta };
    try {
      const existing = s.get(sessionId);
      if (existing) {
        // Backfill agent attribution only (matches upstream idempotency).
        const prefs = (existing.preferences ?? {}) as AnyDict;
        const imp = (prefs.import ?? {}) as AnyDict;
        let updated = false;
        if (agentId && imp.agent_id !== agentId) { imp.agent_id = agentId; updated = true; }
        if (agentName && imp.agent_name !== agentName) { imp.agent_name = agentName; updated = true; }
        if (updated) {
          existing.preferences = prefs;
          s.save(existing);
        }
        skipped++;
        results.push({ external_id: externalId, session_id: sessionId, imported: false, updated, message_count: 0 });
        continue;
      }
      const session = s.create(preferences);
      session.id = sessionId;
      session.title = String(incoming.title ?? "").trim().slice(0, 100) || "Imported conversation";
      const createdAt = Number(incoming.created_at) || now();
      const updatedAt = Number(incoming.updated_at) || createdAt;
      session.created_at = createdAt;
      session.updated_at = updatedAt;
      session.messages = messages.map((m, i) => ({
        id: i + 1,
        session_id: sessionId,
        role: m.role,
        content: m.content,
        events: [],
        attachments: [],
        metadata: m.metadata ?? {},
        created_at: m.created_at ?? createdAt,
        parent_message_id: i > 0 ? i : null,
      }));
      session.status = "idle";
      session.preferences = preferences;
      s.save(session);
      imported++;
      results.push({ external_id: externalId, session_id: sessionId, imported: true, message_count: messages.length });
    } catch (exc) {
      skipped++;
      results.push({ external_id: externalId, imported: false, reason: "error" });
    }
  }
  return c.json({ imported, skipped, sessions: results });
});

miscRouter.get("/api/imports/chat-history", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
  const sessions = store()
    .all()
    .filter((s) => String(s.id ?? "").startsWith(IMPORTED_PREFIX))
    .sort((a, b) => epochSeconds(b.updated_at) - epochSeconds(a.updated_at))
    .slice(offset, offset + limit)
    .map((s) => {
      const prefs = (s.preferences ?? {}) as AnyDict;
      const messages = Array.isArray(s.messages) ? s.messages : [];
      const last = messages[messages.length - 1] ?? {};
      return {
        session_id: s.id,
        title: s.title || "Untitled",
        created_at: epochSeconds(s.created_at),
        updated_at: epochSeconds(s.updated_at),
        message_count: messages.length,
        last_message: String(last.content ?? "").slice(0, 200),
        import: prefs.import ?? null,
      };
    });
  return c.json({ sessions });
});

// ==========================================================================
// creations.py — /api/creations/drafts/* (real publish; overlaps handlers stubs)
// ==========================================================================

function loadDraft(draftId: string): { draft: CreationDraft; kind: NonNullable<ReturnType<typeof getCreationKind>> } {
  const store = new CreationDraftStore();
  const draft = store.get(draftId);
  if (!draft) throw Object.assign(new Error("Creation draft not found"), { status: 404 });
  const kind = getCreationKind(draft.kind);
  if (!kind) throw Object.assign(new Error("Creation draft not found"), { status: 404 });
  return { draft, kind };
}

function classify(draft: CreationDraft, kind: NonNullable<ReturnType<typeof getCreationKind>>, name: string): string {
  if (draft.status === "created") return "done";
  if (!kind.nameInUse(name)) return "create";
  if (new CreationDraftStore().createdBySession(draft.session_id, kind.key, name)) return "update";
  return "conflict";
}

miscRouter.get("/api/creations/drafts/:draft_id", (c) => {
  try {
    const { draft, kind } = loadDraft(c.req.param("draft_id"));
    const store = new CreationDraftStore();
    return c.json({ draft: store.toDict(draft), approval: classify(draft, kind, draft.name) });
  } catch (exc) {
    return httpError(c, (exc as AnyDict)?.status ?? 500, exc instanceof Error ? exc.message : String(exc));
  }
});

miscRouter.post("/api/creations/drafts/:draft_id/approve", async (c) => {
  const draftId = c.req.param("draft_id");
  const payload = await body(c);
  try {
    const store = new CreationDraftStore();
    const { draft, kind } = loadDraft(draftId);
    if (draft.status === "created") {
      return c.json({
        draft: store.toDict(draft),
        saved_name: draft.created_name,
        replaced: draft.replaced,
        already_created: true,
        href: kind.href,
      });
    }
    const edits = payload;
    const fields: AnyDict = {
      name: edits.name ?? draft.name,
      description: edits.description ?? draft.description,
      content: edits.content ?? draft.content,
      tags: edits.tags ?? draft.tags,
      references: draft.references,
    };
    let normalized: AnyDict;
    try {
      normalized = kind.normalize(fields);
    } catch (exc) {
      return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
    }
    const name = String(normalized.name);
    const replace = kind.nameInUse(name);
    if (replace && !store.createdBySession(draft.session_id, kind.key, name)) {
      return httpError(c, 409, `A ${kind.label.toLowerCase()} named "${name}" already exists. Rename the draft.`);
    }
    draft.name = name;
    draft.description = String(normalized.description ?? "");
    draft.content = String(normalized.content ?? "");
    draft.tags = normalized.tags ?? [];
    draft.references = normalized.references ?? draft.references;
    let savedName: string;
    try {
      savedName = kind.publish(draft, replace);
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      if (/already exists/i.test(msg)) return httpError(c, 409, msg);
      return httpError(c, 400, msg);
    }
    store.markCreated(draft, savedName, replace);
    return c.json({
      draft: store.toDict(draft),
      saved_name: savedName,
      replaced: replace,
      already_created: false,
      href: kind.href,
    });
  } catch (exc) {
    return httpError(c, (exc as AnyDict)?.status ?? 500, exc instanceof Error ? exc.message : String(exc));
  }
});

// ==========================================================================
// dashboard.py — missing endpoints: /recent, /learning-index, /{entry_id}
// (suggestions, source-library, learning-library exist in handlers.ts)
// ==========================================================================

miscRouter.get("/api/dashboard/recent", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const type = c.req.query("type") ?? null;
  const sessions = store().list(limit * 3, 0);
  const activities: AnyDict[] = [];
  for (const session of sessions) {
    const capability = String(session.capability ?? "chat");
    const activityType = capability.replace("deep_", "");
    if (type !== null && activityType !== type) continue;
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const last = messages[messages.length - 1] ?? {};
    const prefs = (session.preferences ?? {}) as AnyDict;
    activities.push({
      id: session.id ?? session.session_id,
      type: activityType,
      capability,
      title: session.title || "Untitled",
      timestamp: epochSeconds(session.updated_at ?? session.created_at),
      summary: String(last.content ?? "").slice(0, 160),
      session_ref: `sessions/${session.id ?? session.session_id}`,
      message_count: messages.length,
      status: session.status ?? "idle",
      active_turn_id: session.active_turn_id ?? null,
      content_workspace_id: prefs.workspace_id ?? null,
      content_workspace_name: "",
    });
    if (activities.length >= limit) break;
  }
  return c.json(activities);
});

miscRouter.get("/api/dashboard/learning-index", (c) => {
  // Books/mastery/reading/materials/watchning/practice sources this backend
  // does not implement → empty lists, matching upstream's per-kind failure
  // isolation (they land in `failed` only on exceptions).
  return c.json({
    sources: {
      books: [],
      mastery: [],
      reading: [],
      watching: [],
      practice: [],
    },
    failed: [],
  });
});

// NOTE: GET /api/dashboard/{entry_id} lives in handlers.ts — this router
// mounts before handlers, so a ``/:entry_id`` param route here shadows the
// literal /suggestions, /recent, etc. routes owned downstream.

// ==========================================================================
// practice.py — /api/question-notebook/practice/*
// ==========================================================================

const practice = () => new PracticeStore(get_settings());

function practiceTz(c: Context): string {
  return c.req.query("timezone") ?? "UTC";
}

function mapPracticeError(c: Context, exc: unknown): Response {
  const msg = exc instanceof Error ? exc.message : String(exc);
  if (msg.startsWith("LookupError:")) return httpError(c, 404, msg.slice(11));
  if (exc instanceof ReviewConflict) return httpError(c, 409, msg);
  if (/Unknown timezone|Unknown review rating|incorrect answer|Choose 7|days must|Unsupported|non-empty|required|at most|must be/i.test(msg)) {
    return httpError(c, 422, msg);
  }
  return httpError(c, 500, msg);
}

miscRouter.get("/api/question-notebook/practice/summary", (c) => {
  try {
    return c.json(practice().overview(practiceTz(c)));
  } catch (exc) {
    return mapPracticeError(c, exc);
  }
});

miscRouter.get("/api/question-notebook/practice/queue", (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20) || 20, 1), 100);
  const categoryId = c.req.query("category_id");
  try {
    const ids = practice().queue(
      practiceTz(c),
      categoryId === undefined ? null : Number(categoryId),
      limit,
    );
    const questions: AnyDict[] = [];
    for (const id of ids) {
      const entry = database.get_item(get_settings(), "question-notebook/entries", String(id));
      if (entry) {
        questions.push({
          entry,
          state: practice().state(id),
          content_workspace_id: "",
          content_workspace_name: "",
        });
      }
    }
    return c.json(questions);
  } catch (exc) {
    return mapPracticeError(c, exc);
  }
});

miscRouter.get("/api/question-notebook/practice/analytics", (c) => {
  const days = Number(c.req.query("days") ?? 30);
  try {
    return c.json(practice().analytics(practiceTz(c), days));
  } catch (exc) {
    return mapPracticeError(c, exc);
  }
});

miscRouter.get("/api/question-notebook/practice/questions/:entry_id", (c) => {
  const entryId = Number(c.req.param("entry_id"));
  const entry = Number.isFinite(entryId)
    ? database.get_item(get_settings(), "question-notebook/entries", String(entryId))
    : null;
  if (!entry) return httpError(c, 404, "Question not found");
  return c.json({ entry, state: practice().state(entryId) });
});

miscRouter.post("/api/question-notebook/practice/questions/:entry_id/check", async (c) => {
  const entryId = Number(c.req.param("entry_id"));
  const entry = Number.isFinite(entryId)
    ? database.get_item(get_settings(), "question-notebook/entries", String(entryId))
    : null;
  if (!entry) return httpError(c, 404, "Question not found");
  const payload = await body(c);
  const { checkAnswer } = await import("../services/practice.js");
  return c.json({ correct: checkAnswer(entry, String(payload.answer ?? "")) });
});

miscRouter.post("/api/question-notebook/practice/questions/:entry_id/review", async (c) => {
  const entryId = Number(c.req.param("entry_id"));
  const payload = await body(c);
  const rating = String(payload.rating ?? "") as Rating;
  if (!["again", "hard", "good", "easy"].includes(rating)) {
    return httpError(c, 422, "Unknown review rating");
  }
  const requestId = String(payload.request_id ?? "");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) {
    return httpError(c, 422, "request_id must be 16-100 chars of [a-zA-Z0-9_-]");
  }
  try {
    const outcome = practice().review(
      entryId,
      requestId,
      Number(payload.version ?? 0),
      rating,
      String(payload.answer ?? "").slice(0, 20000),
      !!payload.self_report,
    );
    return c.json(outcome);
  } catch (exc) {
    return mapPracticeError(c, exc);
  }
});

const IMPORT_TEMPLATE_ROWS: string[][] = [
  ["question", "question_type", "A", "B", "C", "D", "correct_answer", "explanation", "tags", "user_answer"],
  ["2 + 2 = ?", "single_choice", "3", "4", "5", "6", "B", "2 + 2 = 4", "Math,Addition", ""],
  ["Select the prime numbers", "multi_choice", "2", "3", "4", "6", "A,B", "2 and 3 are prime", "Math", ""],
  ["The Earth orbits the Sun", "true_false", "", "", "", "", "true", "", "Science", ""],
  ["Explain photosynthesis", "short_answer", "", "", "", "", "Plants convert light into chemical energy.", "", "Biology", ""],
];

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

miscRouter.get("/api/question-notebook/practice/import/template", (c) => {
  const format = c.req.query("format") ?? "csv";
  if (format === "xlsx") {
    // Minimal XLSX: shared strings + one sheet, built as a zip via store method.
    return buildXlsxTemplate(c);
  }
  const csv = IMPORT_TEMPLATE_ROWS.map((r) => r.map(csvEscape).join(",")).join("\r\n") + "\r\n";
  const data = Buffer.from("﻿" + csv, "utf8");
  return new Response(new Uint8Array(data), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="practice-template.csv"',
    },
  });
});

function buildXlsxTemplate(c: Context): Response {
  // Minimal OOXML spreadsheet (inline strings, no sharedStrings needed).
  const sheetRows = IMPORT_TEMPLATE_ROWS.map((row, ri) => {
    const cells = row.map((v, ci) => {
      const ref = `${String.fromCharCode(65 + ci)}${ri + 1}`;
      return `<c r="${ref}" t="inlineStr"><is><t>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</t></is></c>`;
    }).join("");
    return `<row r="${ri + 1}">${cells}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Template" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;

  // Build a minimal zip (stored entries) manually.
  const files: [string, string][] = [
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rels],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", wbRels],
    ["xl/worksheets/sheet1.xml", sheet],
  ];
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...chunks, cdBuf, eocd]);
  return new Response(new Uint8Array(zip), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="practice-template.xlsx"',
    },
  });
}

miscRouter.post("/api/question-notebook/practice/import/preview", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  const file = form?.["file"];
  if (!file || typeof file === "string") return httpError(c, 400, "file is required");
  const target = String(form?.["target"] ?? "bank");
  if (!["bank", "mistakes"].includes(target)) return httpError(c, 422, "target must be bank or mistakes");
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length > PRACTICE_MAX_BYTES + 1) return httpError(c, 413, "File exceeds 5 MB");
  try {
    const parsed = previewImport(data, String(file.name ?? ""));
    let token: string | null = null;
    if (!parsed.errors.length) {
      token = practice().stageImport(String(file.name ?? ""), target, parsed.questions);
    }
    return c.json({
      token,
      total: parsed.questions.length + parsed.errors.length,
      valid: parsed.questions.length,
      errors: parsed.errors,
      samples: parsed.questions.slice(0, 5).map((q) => ({
        question: q.question,
        question_type: q.question_type,
        correct_answer: q.correct_answer,
        tags: q.tags ?? [],
      })),
    });
  } catch (exc) {
    return httpError(c, 422, exc instanceof Error ? exc.message : String(exc));
  }
});

miscRouter.post("/api/question-notebook/practice/import/commit", async (c) => {
  const payload = await body(c);
  const token = String(payload.token ?? "");
  if (!/^[a-f0-9]{32}$/.test(token)) return httpError(c, 422, "token must be 32 lowercase hex chars");
  try {
    return c.json(practice().commitImport(token));
  } catch (exc) {
    return mapPracticeError(c, exc);
  }
});
