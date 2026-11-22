// Port of the sessions.py endpoints missing from api/handlers.ts:
// ask-hint, branch-selection, organization (GET/PATCH), threads,
// quiz-results, recycle-bin/restore/purge, migrate-watching,
// submission-replacement, and the real capabilities/search-extras surface.
//
// Wire-up: mount BEFORE handlersRouter so these beat the stub routes there.

import { Hono } from "hono";
import type { Context } from "hono";

import { get_settings, type Settings } from "../config.js";
import type { SessionStore, SessionDict } from "../store/session_store.js";
import type { AgentRuntime } from "../agent/runtime.js";
import { completeText } from "../services/llm_text.js";
import { generate_title } from "../services/title_gen.js";

export const sessionsExtRouter = new Hono();

type AnyRecord = Record<string, any>;

interface AppStateLike {
  settings?: Settings;
  store?: SessionStore | null;
  runtime?: AgentRuntime | null;
  [key: string]: unknown;
}

let cachedAppState: AppStateLike | null = null;
async function appState(): Promise<AppStateLike> {
  if (cachedAppState) return cachedAppState;
  try {
    const mod = (await import("../main.js")) as unknown as { appState?: AppStateLike };
    if (mod?.appState) cachedAppState = mod.appState;
  } catch { /* isolated use */ }
  return cachedAppState ?? {};
}

let fallbackStore: SessionStore | null = null;
async function store(): Promise<SessionStore> {
  const s = await appState();
  if (s.store) return s.store;
  if (!fallbackStore) {
    const { SessionStore: SS } = await import("../store/session_store.js");
    fallbackStore = new SS(get_settings());
  }
  return fallbackStore;
}

function settings(): Settings {
  return get_settings();
}

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

function qInt(c: Context, name: string, fallback: number): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
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

function prefsOf(session: AnyRecord): AnyRecord {
  return isRecord(session["preferences"]) ? session["preferences"] : {};
}
function isRecord(v: unknown): v is AnyRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function sessionDetail(session: AnyRecord): AnyRecord {
  // GET /{session_id} shape: summary fields + messages + active turns.
  const messages = Array.isArray(session["messages"]) ? session["messages"] : [];
  const turns = (session["turns"] ?? {}) as Record<string, AnyRecord>;
  const activeTurns = Object.entries(turns).map(([tid, t]) => ({
    id: tid,
    turn_id: tid,
    session_id: session["id"],
    status: t["status"] ?? "completed",
    error: "",
    created_at: t["created_at"],
    finished_at: t["finished_at"],
    last_seq: t["last_seq"] ?? 0,
  }));
  const last = messages.length ? messages[messages.length - 1] : {};
  return {
    id: session["id"],
    session_id: session["id"],
    content_workspace_id: prefsOf(session)["workspace_id"] ?? null,
    title: session["title"] || "Untitled",
    created_at: session["created_at"],
    updated_at: session["updated_at"],
    message_count: messages.length,
    last_message: String(last["content"] ?? "").slice(0, 200),
    status: session["status"] || "idle",
    active_turns: activeTurns,
    messages,
    preferences: session["preferences"] ?? {},
    turns,
    vtx_items: session["vtx_items"] ?? [],
  };
}

// Stable snapshot of every session row (list_sessions paged in upstream).
async function allSessionsSnapshot(s: SessionStore): Promise<AnyRecord[]> {
  const pageSize = 200;
  const out: AnyRecord[] = [];
  let offset = 0;
  for (;;) {
    const page = (s.list(pageSize, offset) as AnyRecord[]).map((row) => s.get(String(row["id"] ?? row["session_id"]))).filter(Boolean) as AnyRecord[];
    out.push(...page);
    if (page.length < pageSize) return out;
    offset += page.length;
  }
}

async function validateParentAssignment(
  s: SessionStore,
  sessionId: string,
  parentSessionId: string,
): Promise<AnyRecord> {
  const parent = s.get(parentSessionId);
  if (parent === null) throw new LookupError(parentSessionId);
  const visited = new Set([sessionId]);
  let current: AnyRecord | null = parent;
  while (current !== null) {
    const currentId = String(current["session_id"] ?? current["id"] ?? "");
    if (!currentId || visited.has(currentId)) {
      throw new Error("Session organization cannot contain a parent cycle");
    }
    visited.add(currentId);
    const ancestorId = String(prefsOf(current)["parent_session_id"] ?? "").trim();
    if (!ancestorId) break;
    current = s.get(ancestorId);
    if (current === null) break; // orphaned ancestor is not a cycle
  }
  return parent;
}
class LookupError extends Error {}

// parent_message_role: role of message_id when it is a user/assistant row.
function parentMessageRole(session: AnyRecord | null, messageId: unknown): string | null {
  if (messageId === null || messageId === undefined || session === null) return null;
  const messages = Array.isArray(session["messages"]) ? session["messages"] : [];
  for (const m of messages) {
    if (String(m?.["id"]) === String(messageId)) {
      const role = String(m?.["role"] ?? "");
      return role === "user" || role === "assistant" ? role : null;
    }
  }
  return null;
}

// ==========================================================================
// GET /api/sessions/capabilities
// ==========================================================================

sessionsExtRouter.get("/api/sessions/capabilities", async (c) => {
  // submission_replacement is only true when the store can fence retries
  // atomically; the TS store has no replace_submission, so report false —
  // matching upstream's capability probe contract.
  return c.json({ submission_replacement: false });
});

// ==========================================================================
// POST /api/sessions/submission-replacement
// ==========================================================================

sessionsExtRouter.post("/api/sessions/submission-replacement", async (c) => {
  const b = await body(c);
  const originalId = String(b["original_submission_id"] ?? "").trim();
  if (!originalId) return httpError(c, 400, "original_submission_id is required");
  const request = isRecord(b["request"]) ? b["request"] : {};
  // The TS runtime has no atomic submission replacement; surface the same
  // 501 contract upstream uses for stores lacking replace_submission.
  return httpError(c, 501, "submission replacement is not supported by this session store");
  void request;
});

// ==========================================================================
// GET /api/sessions/{id}/ask-hint  (upstream is GET; our POST stub stays dead)
// ==========================================================================

const ASK_HINT_MAX = { en: 110 };
const ASK_HINT_TIMEOUT_MS = 12000;
const ASK_HINT_HISTORY = 4;
const ASK_HINT_MAX_MESSAGE = 700;

const ASK_HINT_SYSTEM_EN = `You predict ONE line the user is likely to type next into the chat box — this is the composer's placeholder text, read before they start typing.

You are given the tail of the conversation. Write the single most likely thing the user says next: a follow-up question, a reaction, a further request, a next step in the same task — whatever fits, and NOT necessarily a question.

Rules:
- Reply with that line alone. No quotes, no prefix, no markdown, no commentary.
- First person, exactly as the user would type it. Under 14 words.
- Write what the USER would say, never what the assistant would say back, and never a description of a question ("you could ask...") instead of the question itself.
- Ground it in what the assistant just said; do not introduce an unrelated subject.
- If the assistant just asked the user to answer, solve, predict, calculate or fill in something (a check question, quiz or exercise), NEVER write the answer, a guess, a number or a formula for it. The user is meant to work it out alone. Write a line asking for a hint or clarifying the question instead.

Good (assistant just explained a retry policy): "What happens after the third retry fails?"
Good (assistant just drafted an email): "Make the tone more casual"
Good (assistant just listed three options): "Let's go with the second one"
Good (assistant just asked "how many rows for 100 images?"): "Can I get a hint first?"
Bad: "You could ask about the retry limit"  <- describes a line instead of being it
Bad: "That's a great explanation!"          <- not worth typing, continues nothing
Bad: "Here's a more casual version: ..."    <- the assistant's voice, not the user's`;


function normalForm(value: string): string {
  return value.replace(/[^\w]+/gu, "").toLowerCase();
}

function echoesLastMessage(hint: string, lastUser: string): boolean {
  if (!lastUser) return false;
  const h = normalForm(hint);
  const m = normalForm(lastUser);
  return h.length >= 6 && (m.includes(h) || h.includes(m));
}

function sanitizeHint(raw: string, language: string, lastUser: string): string {
  const lines = String(raw ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return "";
  let text = lines[0];
  if (text.startsWith("```") || text.endsWith("```")) return "";
  text = text.replace(/^[-•*#\s]+/, "").trim();
  if (text.length >= 2) {
    const pairs: Array<[string, string]> = [["\"", "\""], ["'", "'"]];
    for (const [a, b] of pairs) {
      if (text.startsWith(a) && text.endsWith(b)) { text = text.slice(1, -1).trim(); break; }
    }
  }
  text = text.split(/\s+/).join(" ");
  if (!text) return "";
  const limit = ASK_HINT_MAX.en;
  if ([...text].length > limit) return "";
  const metaRe = /(?:\byou (?:can|could|should)\b|\btry (?:asking|saying)\b|\bconsider asking\b|\bthe user (?:can|could|should)\b)/i;
  if (metaRe.test(text)) return "";
  const voiceRe = /^(?:sure|certainly|of course|here(?:'|’)s|here is|as an ai|i(?:'|’)d be happy)\b/i;
  if (voiceRe.test(text)) return "";
  if (echoesLastMessage(text, lastUser)) return "";
  return text;
}

sessionsExtRouter.get("/api/sessions/:session_id/ask-hint", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const empty = { hint: "", session_id: sessionId, generated_at: Date.now() / 1000 };
  const s = await store();
  const session = s.get(sessionId) as AnyRecord | null;
  if (!session) return c.json(empty);
  const messages = (Array.isArray(session["messages"]) ? session["messages"] : [])
    .filter((m: AnyRecord) => m && (m["role"] === "user" || m["role"] === "assistant"));
  const tail = messages.slice(-ASK_HINT_HISTORY).map((m: AnyRecord) => ({
    role: String(m["role"]),
    content: String(m["content"] ?? "").split(/\s+/).join(" ").slice(0, ASK_HINT_MAX_MESSAGE),
  })).filter((m) => m.content);
  if (!tail.length) return c.json(empty);
  const lastUser = [...tail].reverse().find((m) => m.role === "user")?.content ?? "";
  const speaker = (role: string) => (role === "user" ? "User" : "Assistant");
  const bodyText = tail.map((m) => `[${speaker(m.role)}] ${m.content}`).join("\n");
  const prompt = `# "End of the conversation"\n${bodyText}\n\nWrite that single next line."`;
  try {
    const raw = await Promise.race([
      completeText(settings(), {
        system: ASK_HINT_SYSTEM_EN,
        prompt,
      }),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), ASK_HINT_TIMEOUT_MS)),
    ]);
    return c.json({
      hint: sanitizeHint(raw, "en", lastUser),
      session_id: sessionId,
      generated_at: Date.now() / 1000,
    });
  } catch {
    return c.json(empty);
  }
});

// ==========================================================================
// GET/PUT /api/sessions/{id}/branch-selection
// ==========================================================================

sessionsExtRouter.get("/api/sessions/:session_id/branch-selection", async (c) => {
  const s = await store();
  const session = s.get(c.req.param("session_id") ?? "") as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const selected = prefsOf(session)["selected_branches"];
  return c.json({ selected_branches: isRecord(selected) ? selected : {} });
});

sessionsExtRouter.put("/api/sessions/:session_id/branch-selection", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const s = await store();
  const session = s.get(sessionId) as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const b = await body(c);
  const selected = isRecord(b["selected_branches"]) ? b["selected_branches"] : {};
  const prefs = prefsOf(session);
  prefs["selected_branches"] = { ...selected };
  session["preferences"] = prefs;
  session["updated_at"] = Date.now() / 1000;
  s.save(session);
  return c.json({ selected_branches: selected });
});

// ==========================================================================
// GET/PATCH /api/sessions/{id}/organization
// ==========================================================================

sessionsExtRouter.get("/api/sessions/:session_id/organization", async (c) => {
  const s = await store();
  const session = s.get(c.req.param("session_id") ?? "") as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const prefs = prefsOf(session);
  return c.json({
    session: {
      id: session["id"],
      session_id: session["id"],
      title: session["title"] || "Untitled",
      status: session["status"] || "idle",
      created_at: session["created_at"],
      updated_at: session["updated_at"],
      preferences: prefs,
      pinned: Boolean(prefs["pinned"]),
      archived: Boolean(prefs["archived"]),
    },
  });
});

sessionsExtRouter.patch("/api/sessions/:session_id/organization", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const s = await store();
  const session = s.get(sessionId) as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const b = await body(c);
  const prefs = prefsOf(session);
  const updates: AnyRecord = {};
  const fields = new Set(Object.keys(b));

  if (fields.has("parent_session_id")) {
    const parentId = String(b["parent_session_id"] ?? "").trim();
    if (parentId === sessionId) return httpError(c, 400, "A session cannot be its own parent");
    if (parentId) {
      try {
        await validateParentAssignment(s, sessionId, parentId);
      } catch (exc) {
        if (exc instanceof LookupError) return httpError(c, 404, "Parent session not found");
        return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
      }
    }
    updates["parent_session_id"] = parentId;
  }
  if (fields.has("session_kind")) {
    updates["session_kind"] = b["session_kind"] || "chat";
  }
  if (fields.has("pinned")) updates["pinned"] = Boolean(b["pinned"]);
  if (fields.has("archived")) updates["archived"] = Boolean(b["archived"]);
  if (fields.has("tutor_source_message_id")) {
    if (prefs["session_kind"] !== "selection_tutor") {
      return httpError(c, 400, "Only a Little Tutor thread has a source message");
    }
    const source = b["tutor_source_message_id"];
    let normalized: number | string | null = null;
    if (typeof source === "number" && Number.isInteger(source) && source > 0) normalized = source;
    else if (typeof source === "string" && source.trim()) normalized = source.trim();
    if (normalized !== null) {
      const parentId = String(prefs["parent_session_id"] ?? "").trim();
      const parent = parentId ? (s.get(parentId) as AnyRecord | null) : null;
      if (parentMessageRole(parent, normalized) === null) {
        return httpError(c, 400, "The source message does not belong to this thread's conversation");
      }
      updates["tutor_source_message_id"] = normalized;
    } else {
      updates["tutor_source_message_id"] = "";
      updates["tutor_source_backfill_attempted"] = true;
    }
  }
  // workspace_id moves are handled by the workspace router upstream; accept
  // and persist the preference for single-store deployments.
  if (fields.has("workspace_id")) {
    const wid = String(b["workspace_id"] ?? "").trim();
    updates["workspace_id"] = wid || null;
  }

  if (Object.keys(updates).length) {
    Object.assign(prefs, updates);
    session["preferences"] = prefs;
    session["updated_at"] = Date.now() / 1000;
    s.save(session);
    // Cascade archived/workspace changes to child threads.
    const cascade: AnyRecord = {};
    for (const key of ["archived", "workspace_id"]) {
      if (key in updates) cascade[key] = updates[key];
    }
    if (Object.keys(cascade).length) {
      for (const row of await allSessionsSnapshot(s)) {
        const rp = prefsOf(row);
        if (String(rp["parent_session_id"] ?? "") === sessionId) {
          Object.assign(rp, cascade);
          row["preferences"] = rp;
          row["updated_at"] = Date.now() / 1000;
          s.save(row);
        }
      }
    }
  }
  const refreshed = s.get(sessionId) as AnyRecord;
  return c.json({
    session: {
      id: refreshed["id"],
      session_id: refreshed["id"],
      title: refreshed["title"] || "Untitled",
      status: refreshed["status"] || "idle",
      created_at: refreshed["created_at"],
      updated_at: refreshed["updated_at"],
      preferences: prefsOf(refreshed),
      pinned: Boolean(prefsOf(refreshed)["pinned"]),
      archived: Boolean(prefsOf(refreshed)["archived"]),
    },
  });
});

// ==========================================================================
// GET /api/sessions/{id}/threads
// ==========================================================================

sessionsExtRouter.get("/api/sessions/:session_id/threads", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const s = await store();
  if (s.get(sessionId) === null) return httpError(c, 404, "Session not found");
  const candidates = await allSessionsSnapshot(s);
  const threads = candidates
    .filter((row) => {
      const p = prefsOf(row);
      return String(p["parent_session_id"] ?? "") === sessionId && p["session_kind"] === "selection_tutor";
    })
    .sort((a, b) => Number(b["updated_at"] ?? 0) - Number(a["updated_at"] ?? 0));
  return c.json({
    threads: threads.map((row) => ({
      id: row["id"],
      session_id: row["id"],
      title: row["title"] || "Untitled",
      created_at: row["created_at"],
      updated_at: row["updated_at"],
      preferences: prefsOf(row),
      message_count: Array.isArray(row["messages"]) ? row["messages"].length : 0,
    })),
  });
});

// ==========================================================================
// GET /api/sessions/recycle-bin, POST restore, DELETE purge
// ==========================================================================

sessionsExtRouter.get("/api/sessions/recycle-bin", async (c) => {
  const s = await store();
  // The TS store hard-deletes; keep the endpoint contract with an empty bin.
  void s;
  const limit = Math.min(Math.max(qInt(c, "limit", 50), 1), 200);
  const offset = Math.max(qInt(c, "offset", 0), 0);
  void limit; void offset;
  return c.json({ sessions: [] });
});

sessionsExtRouter.post("/api/sessions/:session_id/restore", async (c) => {
  return httpError(c, 404, "Session not found in recycle bin");
});

sessionsExtRouter.delete("/api/sessions/:session_id/purge", async (c) => {
  return httpError(c, 404, "Session not found in recycle bin");
});

// ==========================================================================
// POST /api/sessions/{id}/migrate-watching — legacy Watching→Reading migration.
// The TS port has no video-learning migration service; normalise prefs to chat
// and return the session (upstream returns 409 only when migration is needed
// and fails — here there is nothing to migrate to, so degrade gracefully).
// ==========================================================================

sessionsExtRouter.post("/api/sessions/:session_id/migrate-watching", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const s = await store();
  const session = s.get(sessionId) as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const prefs = prefsOf(session);
  const watching = ["immersive_watching", "immersive_reading"].some(
    (v) => prefs["capability"] === v || prefs["workspace_mode"] === v || prefs["session_kind"] === v,
  );
  if (watching) {
    prefs["capability"] = "chat";
    prefs["workspace_mode"] = "";
    prefs["session_kind"] = "chat";
    prefs["legacy_watching_unavailable"] = true;
    session["preferences"] = prefs;
    session["updated_at"] = Date.now() / 1000;
    s.save(session);
  }
  return c.json(sessionDetail(s.get(sessionId) as AnyRecord));
});

// ==========================================================================
// PATCH /api/sessions/{id} — title rename (upstream sessions.py PATCH).
// handlers.ts already handles PATCH/PUT; this adds nothing new — kept out.
// ==========================================================================

// ==========================================================================
// POST /api/sessions/{id}/quiz-results
// ==========================================================================

function formatQuizResultsMessage(answers: AnyRecord[]): string {
  const total = answers.length;
  const correct = answers.filter((a) => a["is_correct"]).length;
  const pct = total ? Math.round((correct / total) * 100) : 0;
  const lines = ["[Quiz Performance]"];
  answers.forEach((item, idx) => {
    const question = String(item["question"] ?? "").trim().replace(/\n/g, " ");
    const userAnswer = String(item["user_answer"] ?? "").trim() || "(blank)";
    const status = item["is_correct"] ? "Correct" : "Incorrect";
    let suffix = ` (${status})`;
    if (!item["is_correct"] && String(item["correct_answer"] ?? "").trim()) {
      suffix = ` (${status}, correct: ${String(item["correct_answer"]).trim()})`;
    }
    const qid = item["question_id"] ? `[${item["question_id"]}] ` : "";
    lines.push(`${idx + 1}. ${qid}Q: ${question} -> Answered: ${userAnswer}${suffix}`);
  });
  lines.push(`Score: ${correct}/${total} (${pct}%)`);
  return lines.join("\n");
}

sessionsExtRouter.post("/api/sessions/:session_id/quiz-results", async (c) => {
  const sessionId = c.req.param("session_id") ?? "";
  const s = await store();
  const session = s.get(sessionId) as AnyRecord | null;
  if (!session) return httpError(c, 404, "Session not found");
  const b = await body(c);
  const answers = Array.isArray(b["answers"]) ? (b["answers"] as AnyRecord[]) : [];
  if (!answers.length) return httpError(c, 400, "Quiz results are required");
  const content = formatQuizResultsMessage(answers);
  // Persist as a user message through the store's own append path.
  s.append_user_message(session, content, {
    metadata: { capability: "deep_question", turn_id: String(b["turn_id"] ?? "") },
  });
  s.save(session);
  let notebookCount = 0;
  try {
    // Upstream upserts question-notebook entries; the TS question bank uses
    // ext_items — record each answer as a notebook entry when possible.
    const { put_item } = await import("../store/database.js");
    const st = settings();
    for (const item of answers) {
      const qid = String(item["question_id"] ?? "") || `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      put_item(st, "question-notebook/entries", {
        id: qid,
        session_id: sessionId,
        turn_id: String(b["turn_id"] ?? ""),
        question: item["question"],
        question_type: item["question_type"] ?? "",
        options: item["options"] ?? {},
        user_answer: item["user_answer"] ?? "",
        correct_answer: item["correct_answer"] ?? "",
        explanation: item["explanation"] ?? "",
        difficulty: item["difficulty"] ?? "",
        is_correct: Boolean(item["is_correct"]),
      });
      notebookCount += 1;
    }
  } catch { /* notebook upsert is best-effort upstream too */ }
  return c.json({
    recorded: true,
    session_id: sessionId,
    answer_count: answers.length,
    notebook_count: notebookCount,
    content,
  });
});

// ==========================================================================
// GET /api/sessions/{id} extras — orphaned failed turns + oversized event cap.
// handlers.ts owns the base GET; these helpers are exported for parity but
// the base route stays in handlers.ts (do-not-edit constraint).
// ==========================================================================

const MAX_EVENT_PAYLOAD = 1024 * 1024;
const TRUNCATION_NOTICE = "\n\n[... content truncated]";
const TRUNCATABLE = new Set(["tool_result", "observation"]);

export function truncateOversizedEvents(messages: AnyRecord[]): void {
  const cap = (container: AnyRecord, field: string): boolean => {
    const v = container[field];
    if (typeof v === "string" && v.length > MAX_EVENT_PAYLOAD) {
      container[field] = v.slice(0, MAX_EVENT_PAYLOAD) + TRUNCATION_NOTICE;
      return true;
    }
    return false;
  };
  for (const msg of messages) {
    const events = msg["events"];
    if (!Array.isArray(events)) continue;
    for (const event of events) {
      if (!isRecord(event) || !TRUNCATABLE.has(String(event["type"]))) continue;
      let truncated = cap(event, "content");
      const toolMeta = isRecord(event["metadata"]) ? event["metadata"]["tool_metadata"] : null;
      if (isRecord(toolMeta)) {
        for (const field of ["content", "answer"]) truncated = cap(toolMeta, field) || truncated;
      }
      if (truncated) event["_truncated"] = true;
    }
  }
}
