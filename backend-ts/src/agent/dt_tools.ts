// Port of backend/app/agent/dt_tools.py — Praxis's built-in tools as
// vtx ``BaseTool`` classes. Pydantic param models become TS interfaces plus
// JSON-schema ``params`` objects with the same field descriptions.

import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { get_settings, type Settings } from "../config.js";
import { get_state, put_state } from "../store/database.js";
import { BaseTool, type Ctx, type ToolParamsSchema } from "../shared/vtx.js";
import { ok, fail, type ToolResult } from "../shared/types.js";

const _HEADERS = { "User-Agent": "Praxis/0.1" };
const _WEB_TIMEOUT_MS = 25_000;
const _MAX_FETCH_CHARS = 30_000;
const _VIDEO_LESSON_MARKER = "VIDEO_LESSON_RESULT:";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function rec(v: unknown): Record<string, unknown> {
  return isRecord(v) ? v : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}
function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function chars(s: string): string[] {
  return [...s];
}
function sliceChars(s: string, n: number): string {
  return chars(s).slice(0, Math.max(0, n)).join("");
}
function pyRepr(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  if (isRecord(v)) {
    return `{${Object.entries(v).map(([k, x]) => `${pyRepr(k)}: ${pyRepr(x)}`).join(", ")}}`;
  }
  return String(v);
}
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function now(): number {
  return Date.now() / 1000;
}
function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function localStamp(ms?: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  let tz = "";
  try {
    tz = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch { /* ignore */ }
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${tz ? ` ${tz}` : ""}`;
}

// ---------------------------------------------------------------------------
// question_bank
// ---------------------------------------------------------------------------
export interface QuestionBankParams {
  action: "add" | "list" | "search";
  question?: string;
  answer?: string;
  topic?: string;
}
export const questionBankParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["add", "list", "search"], description: "add = save a Q&A pair; list = recent questions; search = find entries by text (uses question or topic as the query)." },
    question: { type: "string", default: "", description: "The question text." },
    answer: { type: "string", default: "", description: "The answer — add only." },
    topic: { type: "string", default: "", description: "Optional topic tag." },
  },
};
export class QuestionBankTool extends BaseTool<QuestionBankParams> {
  name = "question_bank"; toolIcon = "❓"; params = questionBankParamsSchema; mutating = true;
  description = "Manage the learner's personal Q&A bank: save questions with answers, list recent entries, or search by text.";
  async execute(p: QuestionBankParams): Promise<ToolResult> {
    const settings = get_settings();
    const bank = arr(get_state<unknown>(settings, "question_bank", []) ?? []);
    const verb = p.action.trim().toLowerCase();
    if (verb === "add") {
      if (!(p.question ?? "").trim()) return fail("question is required for add.");
      bank.push({ q: p.question, a: p.answer ?? "", topic: p.topic ?? "", created: now() });
      put_state(settings, "question_bank", bank);
      return ok(`Saved question to bank (${bank.length} total).`);
    }
    if (verb === "list") {
      return ok(bank.slice(-50).map((e) => `- ${str(e["q"])}` + (e["topic"] ? ` [${str(e["topic"])}]` : "")).join("\n") || "Question bank is empty.");
    }
    const q = (p.question ?? "").trim().toLowerCase() || (p.topic ?? "").trim().toLowerCase();
    const hits = bank.filter((e) => q && `${str(e["q"])} ${str(e["a"])}`.toLowerCase().includes(q));
    return ok(hits.slice(0, 10).map((e) => `Q: ${str(e["q"])}\nA: ${str(e["a"])}`).join("\n\n") || "No matches.");
  }
}
export const question_bank = new QuestionBankTool();

// ---------------------------------------------------------------------------
// memory
// ---------------------------------------------------------------------------
export interface MemoryParams { action: "read" | "write"; query?: string; fact?: string; category?: string }
export const memoryParamsSchema: ToolParamsSchema = {
  type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["read", "write"], description: "read = recall stored facts (query filters by substring); write = store a durable fact about the learner." },
    query: { type: "string", default: "", description: "Substring filter — read only." },
    fact: { type: "string", default: "", description: "One-sentence fact to store — write only." },
    category: { type: "string", default: "general", description: "Category for write, e.g. preference|goal|background." },
  },
};
export class MemoryTool extends BaseTool<MemoryParams> {
  name = "memory"; toolIcon = "🧠"; params = memoryParamsSchema; mutating = true;
  description = "Long-term memory about the learner: recall stored facts or save new durable ones (preferences, goals, background).";
  async execute(p: MemoryParams): Promise<ToolResult> {
    const settings = get_settings();
    const memories = arr(get_state<unknown>(settings, "memory", []) ?? []);
    if (p.action === "write") {
      if (!p.fact) return fail("memory write needs a fact.");
      memories.push({ fact: p.fact, category: p.category ?? "general", created: now() });
      put_state(settings, "memory", memories);
      return ok(`Remembered: ${p.fact}`);
    }
    if (!memories.length) return ok("No memories stored yet.");
    const q = (p.query ?? "").trim().toLowerCase();
    const kept = q ? memories.filter((m) => JSON.stringify(m).toLowerCase().includes(q)) : memories;
    return ok(JSON.stringify(kept.slice(-50), null, 1) || "[]");
  }
}
export const memory = new MemoryTool();

// ---------------------------------------------------------------------------
// learning
// ---------------------------------------------------------------------------
export interface LearningParams { action: "status" | "update" | "journal" | "weak"; topic?: string; note?: string; status?: string; minutes?: number }
export const learningParamsSchema: ToolParamsSchema = {
  type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["status", "update", "journal", "weak"], description: "status = overall progress; update = record progress on a topic; journal = append a free-form note; weak = list weak topics." },
    topic: { type: "string", default: "", description: "Topic name — update only." },
    note: { type: "string", default: "", description: "Free-text note — update and journal." },
    status: { type: "string", default: "", description: "learned|learning|weak — update only." },
    minutes: { type: "integer", default: 0, description: "Minutes spent — update only." },
  },
};
export class LearningTool extends BaseTool<LearningParams> {
  name = "learning"; toolIcon = "📚"; params = learningParamsSchema; mutating = true;
  description = "Track the learner's progress across topics: per-topic mastery state, a free-form journal, and a weak-topics list for review.";
  async execute(p: LearningParams): Promise<ToolResult> {
    const settings = get_settings();
    let data = rec(get_state<unknown>(settings, "learning", { topics: {}, journal: [] }) ?? { topics: {}, journal: [] });
    if (!isRecord(data)) data = { topics: {}, journal: [] };
    if (!isRecord(data["topics"])) data["topics"] = {};
    if (!Array.isArray(data["journal"])) data["journal"] = [];
    const topics = data["topics"] as Record<string, Record<string, unknown>>;
    const journal = data["journal"] as Record<string, unknown>[];
    const verb = p.action.toLowerCase();
    if (verb === "update") {
      if (!p.topic) return fail("learning update needs a topic.");
      const t = topics[p.topic] ??= { status: "learning", notes: [], minutes: 0 };
      if (p.status) t["status"] = p.status;
      if (p.note) (t["notes"] as unknown[]).push({ at: now(), note: p.note });
      t["minutes"] = Math.trunc(num(t["minutes"])) + Math.max(0, Math.trunc(num(p.minutes)));
      t["updated_at"] = now();
      put_state(settings, "learning", data);
      return ok(`Recorded: ${p.topic} → ${str(t["status"])}`);
    }
    if (verb === "journal") {
      if (!p.note) return fail("journal needs a note.");
      journal.push({ at: now(), note: p.note });
      put_state(settings, "learning", data);
      return ok("Journal entry saved.");
    }
    if (verb === "weak") {
      const weak = Object.entries(topics).filter(([, v]) => v["status"] === "weak");
      if (!weak.length) return ok("No weak topics recorded.");
      return ok("Weak topics:\n" + weak.map(([k, v]) => `- ${k} (${num(v["minutes"])}min)`).join("\n"));
    }
    const keys = Object.keys(topics).sort();
    if (!keys.length) return ok("No learning progress recorded yet.");
    return ok(["Learning status:", ...keys.map((k) => `- ${k}: ${str(topics[k]["status"] || "?")} (${num(topics[k]["minutes"])}min)`)].join("\n"));
  }
}
export const learning = new LearningTool();

// ---------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------
export interface WorkspaceParams { action: "list" | "read" | "write" | "search" | "delete" | "mkdir" | "info"; path?: string; content?: string; query?: string; max_chars?: number }
export const workspaceParamsSchema: ToolParamsSchema = {
  type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["list", "read", "write", "search", "delete", "mkdir", "info"], description: "list = files under path; read = file contents; write = save content; search = substring match under path; delete = remove file/dir; mkdir = create dir; info = size/mtime." },
    path: { type: "string", default: "", description: "Workspace-relative path (default '.')." },
    content: { type: "string", default: "", description: "File content — write only." },
    query: { type: "string", default: "", description: "Search substring — search only." },
    max_chars: { type: "integer", default: 12000, description: "Read truncation limit." },
  },
};
export class WorkspaceTool extends BaseTool<WorkspaceParams> {
  name = "workspace"; toolIcon = "🗂️"; params = workspaceParamsSchema; mutating = true;
  description = "Full control over the workspace directory: list, read, write, search, delete, mkdir and info. Paths are workspace-relative; '..' escapes are rejected.";
  async execute(p: WorkspaceParams): Promise<ToolResult> {
    const root = resolve(process.env["PRAXIS_WORKSPACE_DIR"] || get_settings().workspace_dir || "./data/workspace");
    await mkdir(root, { recursive: true });
    const resolveIn = (path: string): string => {
      const clean = (path || ".").replace(/^\/+/, "") || ".";
      const cand = resolve(root, clean);
      if (cand !== root && !cand.startsWith(root + sep)) throw new Error(`path escapes workspace: ${path}`);
      return cand;
    };
    const verb = p.action.toLowerCase();
    try {
      if (verb === "list") {
        const base = resolveIn(p.path || ".");
        if (!(await stat(base).then((s) => s.isDirectory()).catch(() => false))) return ok(`Not a directory: ${p.path ?? ""}`);
        const entries = (await readdir(base, { withFileTypes: true })).sort((a, b) => (Number(a.isFile()) - Number(b.isFile())) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        const lines = entries.slice(0, 200).map((e) => `${e.isDirectory() ? "📁" : "📄"} ${relative(root, resolve(base, e.name))}`);
        return ok(lines.join("\n") || "(empty)");
      }
      if (verb === "read") {
        const f = resolveIn(p.path ?? "");
        const s = await stat(f).catch(() => null);
        if (!s?.isFile()) return ok(`Not a file: ${p.path ?? ""}`);
        return ok(sliceChars(await readFile(f, "utf-8"), p.max_chars ?? 12000));
      }
      if (verb === "write") {
        const f = resolveIn(p.path ?? "");
        await mkdir(dirname(f), { recursive: true });
        await writeFile(f, p.content ?? "", "utf-8");
        return ok(`Wrote ${chars(p.content ?? "").length} chars to ${p.path ?? ""}`);
      }
      if (verb === "search") {
        const base = resolveIn(p.path || ".");
        const baseStat = await stat(base).catch(() => null);
        const files: string[] = [];
        const walk = async (dir: string) => {
          for (const e of await readdir(dir, { withFileTypes: true })) {
            const f = resolve(dir, e.name);
            if (e.isDirectory()) await walk(f);
            else if (e.isFile()) files.push(f);
          }
        };
        if (baseStat?.isDirectory()) await walk(base); else files.push(base);
        const hits: string[] = [];
        for (const f of files) {
          const s = await stat(f).catch(() => null);
          if (!s?.isFile() || s.size > 2_000_000) continue;
          let text = "";
          try { text = await readFile(f, "utf-8"); } catch { continue; }
          if (text.toLowerCase().includes((p.query ?? "").toLowerCase())) {
            hits.push(relative(root, f));
            if (hits.length >= 20) break;
          }
        }
        return ok(hits.join("\n") || "No matches.");
      }
      if (verb === "delete") {
        const f = resolveIn(p.path ?? "");
        const s = await stat(f).catch(() => null);
        if (s?.isFile()) { await unlink(f); return ok(`Deleted ${p.path ?? ""}`); }
        if (s?.isDirectory()) { await rm(f, { recursive: true }); return ok(`Deleted dir ${p.path ?? ""}`); }
        return ok(`Not found: ${p.path ?? ""}`);
      }
      if (verb === "mkdir") { await mkdir(resolveIn(p.path ?? ""), { recursive: true }); return ok(`Created ${p.path ?? ""}`); }
      if (verb === "info") {
        const f = resolveIn(p.path ?? "");
        const s = await stat(f).catch(() => null);
        if (!s) return ok(`Not found: ${p.path ?? ""}`);
        return ok(`${p.path ?? ""}: ${s.isDirectory() ? "dir" : "file"}, ${s.size} bytes, mtime ${localStamp(s.mtimeMs)}`);
      }
      return ok(`Unknown workspace action: ${p.action}`);
    } catch (e) {
      return ok(`workspace ${verb} error: ${errorMessage(e)}`);
    }
  }
}
export const workspace = new WorkspaceTool();

// ---------------------------------------------------------------------------
// mastery
// ---------------------------------------------------------------------------
export interface MasteryParams { action: "topics" | "start" | "status" | "quiz" | "grade" | "note" | "leave"; topic?: string; question?: string; answer?: string; score?: number; note?: string }
export const masteryParamsSchema: ToolParamsSchema = {
  type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["topics", "start", "status", "quiz", "grade", "note", "leave"], description: "topics = list mastery state; start = begin a session on a topic; status = session state; quiz = next review question; grade = record an answer with a score; note = attach a note; leave = end the session." },
    topic: { type: "string", default: "", description: "Topic name." },
    question: { type: "string", default: "", description: "Question being answered — grade only." },
    answer: { type: "string", default: "", description: "Learner's answer — grade only." },
    score: { type: "integer", default: -1, description: "0-100 correctness for grade; -1 = ungraded." },
    note: { type: "string", default: "", description: "Free-text note." },
  },
};
export class MasteryTool extends BaseTool<MasteryParams> {
  name = "mastery"; toolIcon = "🎯"; params = masteryParamsSchema; mutating = true;
  description = "Guided Learning mastery loop: start a session on a topic, ask diagnostic questions, grade answers (0-100), and track level 0-5 across reviews.";
  async execute(p: MasteryParams): Promise<ToolResult> {
    const settings = get_settings();
    const data = rec(get_state<unknown>(settings, "mastery", { topics: {}, session: null }) ?? { topics: {}, session: null });
    if (!isRecord(data["topics"])) data["topics"] = {};
    const topics = data["topics"] as Record<string, Record<string, unknown>>;
    const session = isRecord(data["session"]) ? data["session"] : null;
    const defaultTopic = () => ({ level: 0, reviews: 0, notes: [] as unknown[] });
    const verb = p.action.toLowerCase();
    if (verb === "topics") {
      const keys = Object.keys(topics);
      if (!keys.length) return ok("No mastery topics yet. Use mastery(action='start', topic='...').");
      return ok("Mastery topics:\n" + keys.map((k) => `- ${k}: level ${num(topics[k]["level"])}${""}/5, ${num(topics[k]["reviews"])} reviews`).join("\n"));
    }
    if (verb === "start") {
      if (!p.topic) return fail("mastery start needs a topic.");
      topics[p.topic] ??= defaultTopic();
      data["session"] = { topic: p.topic, started_at: now(), turn: 0 };
      put_state(settings, "mastery", data);
      return ok(`Started mastery session on ${p.topic}. Ask a diagnostic question.`);
    }
    if (verb === "status") return ok(session ? `Session: ${pyRepr(session)} ` : `No active session. Topics: ${Object.keys(topics).length}`);
    if (verb === "quiz") {
      const t = session ? topics[str(session["topic"])] : undefined;
      if (!session || !t) return ok("No active session — mastery(action='start', topic='...') first.");
      const lvl = num(t["level"]);
      const topicName = str(session["topic"]);
      const prompts = [
        `Explain ${topicName} from scratch.`,
        `Give a non-trivial example of ${topicName}.`,
        `What are the edge cases of ${topicName}?`,
        `Compare ${topicName} with a related concept.`,
        `Teach ${topicName} to a beginner in 3 steps.`,
      ];
      const q = prompts[Math.min(lvl, prompts.length - 1)];
      return ok(`QUIZ: ${q}\n(INSTRUCTION: ask the learner, then call mastery(action='grade').)`);
    }
    if (verb === "grade") {
      if (!session || !p.question) return fail("mastery grade needs an active session and question.");
      const topicName = str(session["topic"]);
      const t = topics[topicName] ??= defaultTopic();
      t["reviews"] = Math.trunc(num(t["reviews"])) + 1;
      const score = Math.trunc(num(p.score ?? -1));
      if (score >= 0) {
        const delta = score >= 70 ? 1 : score < 40 ? -1 : 0;
        t["level"] = Math.max(0, Math.min(5, Math.trunc(num(t["level"])) + delta));
      }
      if (p.note) (t["notes"] as unknown[]).push({ at: now(), note: p.note });
      t["updated_at"] = now();
      put_state(settings, "mastery", data);
      return ok(`Recorded: level ${num(t["level"])}/5 after ${num(t["reviews"])} reviews on ${topicName}.`);
    }
    if (verb === "note") {
      const tname = p.topic || str(session?.["topic"] ?? "") || "general";
      const t = topics[tname] ??= defaultTopic();
      (t["notes"] as unknown[]).push({ at: now(), note: p.note ?? "" });
      put_state(settings, "mastery", data);
      return ok("Note saved.");
    }
    if (verb === "leave") { data["session"] = null; put_state(settings, "mastery", data); return ok("Mastery session ended."); }
    return fail(`Unknown mastery action: ${p.action}`);
  }
}
export const mastery = new MasteryTool();

// ---------------------------------------------------------------------------
// video / notebook (lazy imports mirror the Python local imports)
// ---------------------------------------------------------------------------
export interface VideoParams { query: string; title?: string }
export const videoParamsSchema: ToolParamsSchema = { type: "object", required: ["query"], properties: {
  query: { type: "string", description: "The learner's request in plain language, e.g. 'explain how photosynthesis works in a one-minute animation'." },
  title: { type: "string", default: "", description: "Optional short title for the lesson card/file slug." },
}};
export class VideoTool extends BaseTool<VideoParams> {
  name = "video"; toolIcon = "🎬"; params = videoParamsSchema; mutating = true;
  description = "Turn a natural-language request into an animated video lesson. A writer sub-agent produces a Remotion scene; the backend compiles it, frame-checks it, and publishes a player page under /files.";
  async execute(p: VideoParams): Promise<ToolResult> {
    const { createLesson } = await import("./video_lesson/capability.js");
    try {
      const lesson = await createLesson(p.query, p.title ?? "");
      return ok(_VIDEO_LESSON_MARKER + JSON.stringify(lesson));
    } catch (e) {
      const msg = errorMessage(e);
      if (e instanceof Error && e.name === "RuntimeError") return fail(msg);
      if (/^Video\b/.test(msg)) return fail(msg);
      return fail(`Video render failed: ${msg}`);
    }
  }
}
export const video = new VideoTool();

export interface NotebookParams { request: string; title?: string; parent_page_id?: string; background?: boolean }
export const notebookParamsSchema: ToolParamsSchema = { type: "object", required: ["request"], properties: {
  request: { type: "string", description: "What the notebook should contain, in plain language — topic, structure, depth and audience, e.g. 'a study notebook on the French Revolution with a timeline and a quiz'." },
  title: { type: "string", default: "", description: "Optional title for the top page / job label." },
  parent_page_id: { type: "string", default: "", description: "Optional notebook page id to build under; empty creates a new top-level page tree." },
  background: { type: "boolean", default: true, description: "true (default) = run in the background and return a task_id immediately; false = wait for the writer and return its report." },
}};
export class NotebookTool extends BaseTool<NotebookParams> {
  name = "notebook"; toolIcon = "📓"; params = notebookParamsSchema; mutating = true;
  description = "Build a study notebook in the background: a dedicated writer sub-agent creates pages, subpages, mermaid diagrams, flowcharts, quizzes and flashcards in the learner's notebook. Use for requests like 'make me notes on X' or 'build a revision notebook'.";
  async execute(p: NotebookParams, ctx?: Ctx): Promise<ToolResult> {
    const { launch_notebook_job } = await import("./notebook_agent/index.js");
    try {
      const text = await launch_notebook_job({
        request: p.request,
        title: p.title ?? "",
        parent_page_id: p.parent_page_id ?? "",
        background: p.background ?? true,
        tool_call_id: typeof ctx?.["tool_call_id"] === "string" ? ctx["tool_call_id"] as string : null,
      });
      return ok(text);
    } catch (e) {
      const msg = errorMessage(e);
      if (e instanceof Error && e.name === "RuntimeError") return fail(msg);
      if (/^Notebook\b/.test(msg)) return fail(msg);
      return fail(`Notebook job failed: ${msg}`);
    }
  }
}
export const notebook = new NotebookTool();

// ---------------------------------------------------------------------------
// web — Exa MCP search + Jina Reader fetch
// ---------------------------------------------------------------------------
const _EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const _JINA_PREFIX = "https://r.jina.ai/";
const _JINA_HEADER_RE = /^(Title|URL Source|Published Time|Warning|Markdown Content):.*\n?/gm;

function _strip_jina_header(text: string): string {
  const marker = text.indexOf("Markdown Content:");
  if (marker !== -1) return text.slice(marker + "Markdown Content:".length).trim();
  return text.replace(_JINA_HEADER_RE, "").trim();
}
async function _fetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(_WEB_TIMEOUT_MS) });
}
function _isTimeout(e: unknown): boolean {
  return e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
}
async function _exa_search(query: string, numResults = 8): Promise<[string | null, string | null]> {
  const headers = { Accept: "application/json, text/event-stream", "Content-Type": "application/json" };
  const payload = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query, type: "auto", numResults, livecrawl: "fallback" } } };
  let resp: Response;
  try {
    resp = await _fetch(_EXA_MCP_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!resp.ok) return [null, `Exa API error ${resp.status}`];
  } catch (e) {
    if (_isTimeout(e)) return [null, `Exa timed out after ${_WEB_TIMEOUT_MS / 1000}s`];
    return [null, `Exa request failed: ${errorMessage(e)}`];
  }
  const extract = (data: unknown): string | null => {
    const content = rec(rec(data)["result"])["content"];
    if (Array.isArray(content) && content.length) return str(rec(content[0])["text"]) || null;
    return null;
  };
  const text = await resp.text();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const found = extract(JSON.parse(line.slice(6)));
      if (found) return [found, null];
    } catch { /* keep scanning */ }
  }
  try {
    const found = extract(JSON.parse(text));
    if (found) return [found, null];
  } catch { /* ignore */ }
  return [null, "No results returned from Exa API"];
}
async function _jina_fetch(url: string): Promise<[string | null, string | null]> {
  let resp: Response;
  try {
    resp = await _fetch(_JINA_PREFIX + url);
  } catch (e) {
    if (_isTimeout(e)) return [null, `Fetch timed out after ${_WEB_TIMEOUT_MS / 1000}s`];
    return [null, `Fetch failed: ${errorMessage(e)}`];
  }
  if (resp.status !== 200) return [null, `Fetch failed: Jina Reader HTTP ${resp.status}`];
  let text = _strip_jina_header(await resp.text());
  if (!text || text.slice(0, 200).toLowerCase().includes("<html")) return [null, "Fetch returned no readable content"];
  if (chars(text).length > _MAX_FETCH_CHARS) text = sliceChars(text, _MAX_FETCH_CHARS) + `\n[truncated at ${_MAX_FETCH_CHARS} chars]`;
  return [text, null];
}
export interface WebParams { query: string; mode?: "search" | "fetch"; max_results?: number; max_chars?: number }
export const webParamsSchema: ToolParamsSchema = { type: "object", required: ["query"], properties: {
  query: { type: "string", description: "Search query, or a full http(s) URL when mode='fetch'." },
  mode: { type: "string", enum: ["search", "fetch"], default: "search", description: "search = web search results (titles/URLs/snippets); fetch = download a URL's readable markdown text." },
  max_results: { type: "integer", default: 8, description: "Max search results (Exa returns up to ~8-10)." },
  max_chars: { type: "integer", default: _MAX_FETCH_CHARS, description: "Fetch truncation limit." },
}};
export class WebTool extends BaseTool<WebParams> {
  name = "web"; toolIcon = "🌐"; params = webParamsSchema; mutating = false;
  description = "Web access: search the web via Exa, or fetch a URL as readable markdown via Jina Reader. Needs internet.";
  async execute(p: WebParams): Promise<ToolResult> {
    if (p.mode === "fetch") {
      const url = (p.query ?? "").trim();
      if (!url.startsWith("http://") && !url.startsWith("https://")) return fail("mode='fetch' requires an http(s) URL");
      const [text, err] = await _jina_fetch(url);
      if (err) return fail(err);
      return ok(text ? sliceChars(text, p.max_chars ?? _MAX_FETCH_CHARS) : "empty");
    }
    const [text, err] = await _exa_search(p.query ?? "", p.max_results ?? 8);
    return err ? ok(err) : ok(text || "No results.");
  }
}
export const web = new WebTool();

// ---------------------------------------------------------------------------
// paper_search — arXiv
// ---------------------------------------------------------------------------
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, ent: string) => {
    if (ent === "amp") return "&"; if (ent === "lt") return "<"; if (ent === "gt") return ">";
    if (ent === "quot") return '"'; if (ent === "apos") return "'";
    const n = ent.startsWith("#x") ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
function tagText(xml: string, tag: string): string {
  const re = new RegExp(`<\\w*:?${tag}\\b[^>]*>([\\s\\S]*?)<\\/\\w*:?${tag}\\s*>`, "i");
  return decodeXml(re.exec(xml)?.[1] ?? "").replace(/\s+/g, " ").trim();
}
function attr(tag: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i");
  return decodeXml(re.exec(tag)?.[1] ?? "");
}
export interface PaperSearchParams { query: string; max_results?: number; sort_by?: "relevance" | "date" }
export const paperSearchParamsSchema: ToolParamsSchema = { type: "object", required: ["query"], properties: {
  query: { type: "string", description: "Search keywords (arXiv query syntax supported)." },
  max_results: { type: "integer", default: 5, description: "Number of papers (max 20)." },
  sort_by: { type: "string", enum: ["relevance", "date"], default: "relevance", description: "Sort order for results." },
}};
export class PaperSearchTool extends BaseTool<PaperSearchParams> {
  name = "paper_search"; toolIcon = "📄"; params = paperSearchParamsSchema; mutating = false;
  description = "Search arXiv for research papers; returns titles, authors, year, URL and abstract.";
  async execute(p: PaperSearchParams): Promise<ToolResult> {
    const query = (p.query ?? "").trim();
    if (!query) return fail("Empty query.");
    const maxResults = Math.max(1, Math.min(Math.trunc(num(p.max_results ?? 5)), 20));
    const sort = p.sort_by === "date" ? "submittedDate" : "relevance";
    const api = "https://export.arxiv.org/api/query?" + new URLSearchParams({ search_query: `all:${query}`, start: "0", max_results: String(maxResults), sortBy: sort, sortOrder: "descending" }).toString();
    try {
      const resp = await fetch(api, { headers: _HEADERS, signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const xml = await resp.text();
      const out: string[] = [];
      const entryRe = /<(?:\w+:)?entry\b[^>]*>([\s\S]*?)<\/(?:\w+:)?entry\s*>/gi;
      let m: RegExpExecArray | null;
      while ((m = entryRe.exec(xml)) !== null) {
        const entry = m[1];
        const title = tagText(entry, "title");
        const summary = tagText(entry, "summary");
        let link = "";
        const linkRe = /<(?:\w+:)?link\b[^>]*>/gi;
        let lm: RegExpExecArray | null;
        while ((lm = linkRe.exec(entry)) !== null) {
          const tag = lm[0];
          if (attr(tag, "title") === "pdf" || attr(tag, "rel") === "related") { link = attr(tag, "href"); break; }
        }
        if (!link) {
          const idRe = /<(?:\w+:)?id\b[^>]*>([\s\S]*?)<\/(?:\w+:)?id\s*>/i;
          link = decodeXml(idRe.exec(entry)?.[1] ?? "").trim();
        }
        const authors: string[] = [];
        const authorRe = /<(?:\w+:)?author\b[^>]*>([\s\S]*?)<\/(?:\w+:)?author\s*>/gi;
        let am: RegExpExecArray | null;
        while ((am = authorRe.exec(entry)) !== null) authors.push(tagText(am[1], "name"));
        const published = tagText(entry, "published");
        out.push(`Title: ${title}\nAuthors: ${authors.join(", ")}\nYear: ${published.slice(0, 4)}\nURL: ${link}\nAbstract: ${summary.slice(0, 800)}`);
      }
      return ok(out.length ? out.join("\n\n---\n\n") : "No papers found.");
    } catch (e) {
      return fail(`arXiv search error: ${errorMessage(e)}`);
    }
  }
}
export const paper_search = new PaperSearchTool();

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------
interface CronScheduleLike {
  kind?: unknown;
  at_ms?: unknown;
  every_seconds?: unknown;
  expr?: unknown;
  tz?: unknown;
}
function _cron_describe(schedule: CronScheduleLike): string {
  if (schedule.kind === "at") return `once at ${localStamp(num(schedule.at_ms))}`;
  if (schedule.kind === "every") return `every ${num(schedule.every_seconds)}s`;
  const tz = schedule.tz ? ` (${str(schedule.tz)})` : "";
  return `cron \`${str(schedule.expr)}\`${tz}`;
}
function _cron_parse_at(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`could not parse time ${pyRepr(value)} — use ISO 8601, e.g. 2026-06-12T09:00`);
  return Math.trunc(ms);
}
export interface CronParams { action: string; message?: string; name?: string; at?: string; every_seconds?: number; cron_expr?: string; tz?: string; job_id?: string }
export const cronParamsSchema: ToolParamsSchema = { type: "object", required: ["action"], properties: {
  action: { type: "string", description: "list = show scheduled reminders; schedule (alias add) = create one; cancel (alias remove) = delete by job_id. Provide exactly one of at / every_seconds / cron_expr when scheduling." },
  message: { type: "string", default: "", description: "Instruction or reminder to deliver when due — schedule only." },
  name: { type: "string", default: "", description: "Optional short label for the task." },
  at: { type: "string", default: "", description: "One-off time, ISO 8601 e.g. '2026-06-12T09:00' — schedule only." },
  every_seconds: { type: "integer", default: 0, description: "Repeat interval in seconds (min 30) — schedule only." },
  cron_expr: { type: "string", default: "", description: "Cron expression e.g. '0 9 * * 1' — schedule only." },
  tz: { type: "string", default: "", description: "IANA timezone for cron_expr e.g. 'Europe/Berlin'." },
  job_id: { type: "string", default: "", description: "Job id from action='list' — cancel only." },
}};
export class CronTool extends BaseTool<CronParams> {
  name = "cron"; toolIcon = "⏰"; params = cronParamsSchema; mutating = true;
  description = "Schedule reminders or automations that run later and manage them. Use when the learner asks to be reminded, nudged or given something on a schedule ('remind me every Monday at 9', 'quiz me tomorrow evening'). The scheduled run lands as a new message in this conversation.";
  async execute(p: CronParams): Promise<ToolResult> {
    const { getCronService, ownerKey } = await import("../services/cron/service.js");
    const { turn_context } = await import("./turn_context.js");
    const [sessionId, workspaceId] = turn_context();
    if (!sessionId) return fail("Scheduling is not available in this context.");
    const owner = { kind: "chat", session_id: sessionId, workspace_id: workspaceId };
    const service = getCronService();
    let verb = p.action.trim().toLowerCase();
    verb = ({ add: "schedule", remove: "cancel" } as Record<string, string>)[verb] ?? verb;
    const describe = (job: { id: string; name: string; schedule: CronScheduleLike; state: { next_run_at_ms?: unknown; last_status?: unknown } }) =>
      `- \`${job.id}\` **${job.name}** — ${_cron_describe(job.schedule)}; next run ${localStamp(num(job.state.next_run_at_ms))}; last: ${str(job.state.last_status || "pending")}`;
    if (verb === "list") {
      const jobs = service.listJobs(ownerKey(owner));
      if (!jobs.length) return ok("No scheduled reminders for this conversation.");
      return ok([`${jobs.length} scheduled reminder(s):`, ...jobs.map(describe)].join("\n"));
    }
    if (verb === "cancel") {
      const key = (p.job_id ?? "").trim();
      if (!key) return fail("cancel needs a job_id (see action='list').");
      return ok(service.cancelJob(key, ownerKey(owner)) ? `Reminder \`${key}\` cancelled.` : `No reminder \`${key}\` found for this conversation.`);
    }
    if (verb === "schedule") {
      const text = (p.message ?? "").trim();
      if (!text) return fail("schedule needs a message — what to deliver when it is due.");
      const chosen = [Boolean((p.at ?? "").trim()), Boolean(p.every_seconds), Boolean((p.cron_expr ?? "").trim())];
      if (chosen.filter(Boolean).length !== 1) return fail("Provide exactly one of: at (one-off), every_seconds (interval), or cron_expr (cron expression).");
      try {
        let schedule: Record<string, unknown>;
        if ((p.at ?? "").trim()) schedule = { kind: "at", at_ms: _cron_parse_at((p.at ?? "").trim()) };
        else if (p.every_seconds) schedule = { kind: "every", every_seconds: Math.trunc(num(p.every_seconds)) };
        else schedule = { kind: "cron", expr: (p.cron_expr ?? "").trim(), tz: (p.tz ?? "").trim() || null };
        const job = service.addJob({ name: p.name ?? "", message: text, schedule: schedule as never, owner });
        const first = localStamp(num(job.state.next_run_at_ms));
        return ok(`Scheduled **${job.name}** (\`${job.id}\`) — ${_cron_describe(job.schedule)}; first run ${first}. The result arrives in this conversation and on the calendar.`);
      } catch (e) {
        return fail(`Could not schedule: ${errorMessage(e)}`);
      }
    }
    return fail(`Unknown action ${pyRepr(p.action)} — use list, schedule or cancel.`);
  }
}
export const cron = new CronTool();

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------
export interface ReviewParams { action: "due" | "grade" | "status"; question?: string; correct?: boolean }
export const reviewParamsSchema: ToolParamsSchema = { type: "object", required: ["action"], properties: {
  action: { type: "string", enum: ["due", "grade", "status"], description: "due = cards due for review now; grade = record an answer; status = schedule summary." },
  question: { type: "string", default: "", description: "Question text exactly as shown by 'due' — grade only." },
  correct: { type: "boolean", default: true, description: "True if the learner answered correctly — grade only." },
}};
export class ReviewTool extends BaseTool<ReviewParams> {
  name = "review"; toolIcon = "🔁"; params = reviewParamsSchema; mutating = true;
  description = "Spaced-repetition reviews of the learner's question bank. Cards are due on a growing schedule (1, 3, 7, 14, 30, 60 days): fetch what's due, ask the learner, then record each outcome.";
  async execute(p: ReviewParams): Promise<ToolResult> {
    const reviews = await import("../services/reviews.js");
    const verb = p.action.toLowerCase();
    if (verb === "status") {
      const s = reviews.summary();
      return ok(`${s.cards} card(s) scheduled, ${s.due_now} due now. ` + Object.entries(s.boxes).filter(([, c]) => c).map(([box, count]) => `box ${box}: ${count}`).join(", "));
    }
    if (verb === "due") {
      const t = now();
      const cards = reviews.dueBetween(t, t + 86400 * 30);
      if (!cards.length) return ok(`Nothing due right now — ${reviews.summary().cards} card(s) scheduled.`);
      return ok([`${cards.length} card(s) due:`, ...cards.slice(0, 20).map((c) => `- [${c.key}] ${c.question} (box ${c.box})`)].join("\n"));
    }
    const text = (p.question ?? "").trim();
    if (!text) return fail("grade needs the question text from action='due'.");
    try {
      const card = reviews.grade(reviews.keyFor(text), Boolean(p.correct));
      const days = Math.trunc((card.due_at - now()) / 86400);
      return ok(`Recorded. Box ${card.box}, next review in about ${Math.max(days, 0)} day(s).`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("unknown review key")) return fail(`No card matches ${pyRepr(text)} — run action='due' first.`);
      throw e;
    }
  }
}
export const review = new ReviewTool();
