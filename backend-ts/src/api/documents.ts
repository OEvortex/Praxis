// Note pages (the Note tab and
// Co-Writer): pages, review queue, assets, threads.
//
// Pages live in the shared SQLite database. A page carries BlockNote blocks, a
// Markdown projection, a revision counter for optimistic concurrency, and a
// review queue of proposed edits that the learner accepts or dismisses one by
// one.
//
// NOTE on conventions (verified against the landed TS ports):
//  - services/documents/* kept snake_case export names.
//  - CoWriterStorage methods are camelCase and take snake_case option keys
//    (parent_id, expected_revision, source_turn_id, ...).
//  - schema validation ``model_dump()`` → plain objects; ``modelDump()`` below tolerates
//    both shapes.
//  - ValueError surfaces as a plain Error (or name === "ValueError") in
//    the TS ports, so isValueError() accepts both — TODO(verify) if the service
//    ports later introduce a dedicated error class.

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";
import { randomBytes } from "node:crypto";

import { get_settings, type Settings } from "../config.js";
import type { Dict } from "../shared/types.js";
import { complete_text, stream_text, resolve } from "../services/llm_text.js";
import * as editing from "../services/documents/editing.js";
import * as threadStore from "../services/documents/threads.js";
import {
  cards_from_storage,
  render_anki_export,
} from "../services/documents/anki.js";
import {
  blocks_to_markdown,
  safe_link,
  validate_blocks,
} from "../services/documents/blocks.js";
import {
  propose as createProposal,
  list_proposals as listProposals,
  review as reviewProposal,
} from "../services/documents/proposals.js";
import {
  due_cards as dueCards,
  page_cards as pageCards,
  grade_card as gradeReviewCard,
} from "../services/documents/review.js";
import {
  getCoWriterStorage,
  RevisionConflict,
} from "../services/documents/storage.js";
import type { CoWriterDocument } from "../services/documents/storage.js";
import {
  DocxConversionError,
  markdownToDocx,
  docxToMarkdown,
} from "../services/documents/docx.js";
import { knowledge_base_search } from "../agent/kb_tools.js";
import { web as webTool } from "../agent/dt_tools.js";

export type { CoWriterDocument };

type CoWriterStorage = ReturnType<typeof getCoWriterStorage>;
// Document rows are plain snake_case objects (see storage.ts CoWriterDocument).
type Doc = Dict & {
  id: string;
  title?: string | null;
  content?: string;
  blocks?: Dict[] | null;
  revision?: number;
  updated_at?: number;
};

const documentsRouter = new Hono();

const MAX_DOC_CHARS = 600_000;

// ── HTTP error plumbing (HTTP error equivalent) ───────────────

class HttpError extends Error {
  constructor(public status: StatusCode, public detail: string) {
    super(detail);
    this.name = "HttpError";
  }
}

function httpError(status: number, detail: string): never {
  throw new HttpError(status as StatusCode, detail);
}

function errDetail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

// ValueError handling. The TS service ports raise plain Errors for
// validation failures; RevisionConflict has its own class.
function isValueError(exc: unknown): boolean {
  if (!(exc instanceof Error)) return false;
  const code = (exc as { code?: unknown }).code;
  return (
    exc.name === "ValueError" ||
    exc.name === "Error" ||
    code === "ValueError"
  );
}

function isRevisionConflict(exc: unknown): boolean {
  return (
    exc instanceof RevisionConflict ||
    (exc instanceof Error && exc.name === "RevisionConflict")
  );
}

documentsRouter.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ detail: err.detail }, err.status as never);
  }
  console.error(err);
  return c.json({ detail: errDetail(err) }, 500);
});

// ── app.state plumbing (mirrors api/handlers.ts) ─────────────────────────

type AppStateLike = { settings?: Settings; store?: unknown; [k: string]: unknown };

let cachedAppState: AppStateLike | null = null;

// Resolved lazily via dynamic import to avoid a static cycle with main.ts.
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

function settingsFor(state: AppStateLike): Settings {
  // App settings are read from request state.
  return state.settings ?? get_settings();
}

// ── helpers ──────────────────────────────────────────────────────────────

function docId(raw: string | undefined): string {
  if (!raw || !/^[0-9a-f]{8,32}$/.test(raw)) {
    httpError(400, "Invalid page ID");
  }
  return raw;
}

function versionId(raw: string | undefined): string {
  if (!raw || !/^[0-9a-f]{8,32}$/.test(raw)) {
    httpError(400, "Invalid version ID");
  }
  return raw;
}

// Model dumps serialize to plain JSON objects. Document/version/proposal rows in
// the TS port are already plain objects; tolerate a modelDump()/model_dump()
// method if a class-based shape ever appears.
function modelDump(value: unknown): Dict {
  if (value === null || value === undefined) return {};
  const v = value as { modelDump?: () => Dict; model_dump?: () => Dict };
  if (typeof v.modelDump === "function") return v.modelDump();
  if (typeof v.model_dump === "function") return v.model_dump();
  return value as Dict;
}

// editing.*_prompt returns a (system, prompt) tuple in both ports.
function promptPair(result: unknown): [string, string] {
  if (Array.isArray(result)) return [String(result[0]), String(result[1])];
  const r = result as { system?: unknown; prompt?: unknown };
  return [String(r.system ?? ""), String(r.prompt ?? "")];
}

// storage._write is `private` in storage.ts but needed here for the clip
function storageWrite(storage: CoWriterStorage, doc: Doc, source: string): void {
  const s = storage as unknown as {
    _write?: (d: unknown, source?: string) => void;
    write?: (d: unknown, source?: string) => void;
  };
  const fn = s._write ?? s.write;
  if (typeof fn !== "function") {
    throw new Error("CoWriterStorage has no _write/write method");
  }
  fn.call(storage, doc, source);
}

function resolveModelName(
  settings: Settings,
  llmSelection: Dict | null | undefined,
): string {
  return String(resolve(settings, llmSelection ?? null).model ?? "");
}

// ── request body validation ──────────────────────────────────────────────

type Body = Dict;

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Body> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    httpError(422, "Invalid JSON body");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    httpError(422, "Invalid JSON body");
  }
  return body as Body;
}

function optStr(body: Body, key: string, max?: number): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") httpError(422, `${key} must be a string`);
  if (max !== undefined && (v as string).length > max) {
    httpError(422, `${key} too long`);
  }
  return v as string;
}

function reqStr(body: Body, key: string, max?: number): string {
  const v = optStr(body, key, max);
  if (v === undefined) httpError(422, `${key} is required`);
  return v as string;
}

function optNum(body: Body, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    httpError(422, `${key} must be a number`);
  }
  return v as number;
}

function optBool(body: Body, key: string): boolean | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") httpError(422, `${key} must be a boolean`);
  return v as boolean;
}

function optBlocks(body: Body, key = "blocks"): Dict[] | undefined | null {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!Array.isArray(v)) httpError(422, `${key} must be a list`);
  return v as Dict[];
}

function optDict(body: Body, key: string): Dict | undefined | null {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "object" || Array.isArray(v)) {
    httpError(422, `${key} must be an object`);
  }
  return v as Dict;
}

function optStrList(body: Body, key: string): string[] | null | undefined {
  const v = body[key];
  if (v === undefined || v === null) return v === null ? null : undefined;
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string")) {
    httpError(422, `${key} must be a list of strings`);
  }
  return v as string[];
}

// ── AI edits (whole draft, selection, auto-mark) ─────────────────────────
//
// These live before the ``{doc_id}`` routes so "/documents/history" is not
// mistaken for a page id. They call the model configured in Settings; a
// provider or model failure surfaces as a 502 with the provider's message
// instead of a silent empty edit.

const ACTION_VERBS = new Set(["rewrite", "shorten", "expand", "polish", "continue"]);

interface EditRequest {
  text: string;
  instruction: string;
  action: string;
  source?: string | null;
  kb_name?: string | null;
  llm_selection?: Dict | null;
}

interface ReactEditRequest {
  selected_text: string;
  instruction: string;
  mode: string;
  tools?: string[] | null;
  kb_name?: string | null;
  llm_selection?: Dict | null;
}

interface AutoMarkRequest {
  text: string;
  llm_selection?: Dict | null;
}

async function referenceContext(
  state: AppStateLike,
  sources: string[],
  kbName: string | null | undefined,
  query: string,
): Promise<[string, string[]]> {
  // Retrieve reference material; a failing tool degrades to a plain edit.
  void state; // tools resolve their own dependencies; kept for parity
  const blocks: string[] = [];
  const used: string[] = [];
  for (const source of sources) {
    if (source === "rag" && kbName) {
      try {
        // Search params are built, then executed.
        // TS port: execute() takes the plain params object (snake_case keys).
        const result = (await knowledge_base_search.execute({
          action: "search",
          query,
          kb_name: kbName,
          top_k: 5,
        })) as { result?: unknown };
        const text = String(result?.result ?? "");
        if (text && !text.startsWith("No ")) {
          blocks.push(`[Knowledge base: ${kbName}]\n${text}`);
          used.push("rag");
        }
      } catch {
        // retrieval must never block the edit
      }
    } else if (source === "web") {
      try {
        const result = (await webTool.execute({
          query,
          max_results: 5,
        })) as { result?: unknown };
        const text = String(result?.result ?? "");
        if (text) {
          blocks.push(`[Web search: ${query}]\n${text}`);
          used.push("web");
        }
      } catch {
        // retrieval must never block the edit
      }
    }
  }
  return [blocks.join("\n\n"), used];
}

documentsRouter.post("/api/documents/actions/edit", async (c) => {
  const state = await appState();
  const body = await readJson(c);
  const payload: EditRequest = {
    text: optStr(body, "text", MAX_DOC_CHARS) ?? "",
    instruction: optStr(body, "instruction", 4000) ?? "",
    action: optStr(body, "action") ?? "rewrite",
    source: optStr(body, "source"),
    kb_name: optStr(body, "kb_name"),
    llm_selection: optDict(body, "llm_selection") ?? null,
  };
  if (!payload.text.trim()) {
    httpError(400, "There is nothing to edit yet.");
  }
  const settings = settingsFor(state);
  const action = ACTION_VERBS.has(payload.action) ? payload.action : "rewrite";
  const [context, used] = await referenceContext(
    state,
    payload.source === "rag" || payload.source === "web" ? [payload.source] : [],
    payload.kb_name,
    (payload.instruction || payload.text.slice(0, 300)).trim(),
  );
  const [system, basePrompt] = promptPair(
    editing.edit_prompt(payload.text, payload.instruction, action),
  );
  const prompt = context
    ? `${basePrompt}\n\nReference material:\n${context}`
    : basePrompt;
  let raw: string;
  try {
    raw = await complete_text(settings, {
      system,
      prompt,
      llm_selection: payload.llm_selection ?? null,
    });
  } catch (exc) {
    httpError(502, errDetail(exc));
  }
  const edited = editing.clean_output(raw);
  if (!edited) {
    httpError(502, "The model returned no text.");
  }
  const operation_id = editing.new_operation_id();
  editing.record({
    operation_id,
    action,
    model: resolveModelName(settings, payload.llm_selection),
    original: payload.text,
    edited,
    instruction: payload.instruction,
    tools: used,
    kb_name: payload.kb_name ?? null,
  });
  return c.json({
    edited_text: edited,
    operation_id,
    tools_used: used,
  });
});

function prepareReactEdit(payload: ReactEditRequest): [string, string, string[]] {
  const tools = (payload.tools ?? []).filter((t) => t === "rag" || t === "web");
  const instruction = payload.instruction.trim();
  if (payload.mode === "none" && !instruction) {
    httpError(
      400,
      "Provide an edit instruction, or choose shorten / expand / rewrite mode.",
    );
  }
  const selected = payload.selected_text.replace(/^\n+|\n+$/g, "");
  if (!selected.trim()) {
    httpError(400, "Please select a text passage first.");
  }
  return [selected, instruction, tools];
}

function parseReactEditBody(body: Body): ReactEditRequest {
  return {
    selected_text: optStr(body, "selected_text", MAX_DOC_CHARS) ?? "",
    instruction: optStr(body, "instruction", 4000) ?? "",
    mode: optStr(body, "mode") ?? "none",
    tools: optStrList(body, "tools") ?? null,
    kb_name: optStr(body, "kb_name"),
    llm_selection: optDict(body, "llm_selection") ?? null,
  };
}

documentsRouter.post("/api/documents/actions/edit-react", async (c) => {
  const state = await appState();
  const payload = parseReactEditBody(await readJson(c));
  const [selected, instruction, tools] = prepareReactEdit(payload);
  const settings = settingsFor(state);
  const [context, used] = await referenceContext(
    state,
    tools,
    payload.kb_name,
    (instruction || selected.slice(0, 400)).trim(),
  );
  const [system, prompt] = promptPair(
    editing.react_edit_prompt({
      selected_text: selected,
      instruction,
      mode: payload.mode,
      context,
    }),
  );
  let raw: string;
  try {
    raw = await complete_text(settings, {
      system,
      prompt,
      llm_selection: payload.llm_selection ?? null,
    });
  } catch (exc) {
    httpError(502, errDetail(exc));
  }
  const edited = editing.clean_output(raw);
  if (!edited) {
    httpError(502, "The model returned no text.");
  }
  const operation_id = editing.new_operation_id();
  editing.record({
    operation_id,
    action: "react_edit",
    mode: payload.mode,
    model: resolveModelName(settings, payload.llm_selection),
    original: selected,
    edited,
    instruction,
    tools: used,
    kb_name: payload.kb_name ?? null,
  });
  return c.json({
    edited_text: edited,
    operation_id,
    tools_used: used,
  });
});

function sse(event: string, data: Dict): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Convert an async generator of SSE frames into a streaming Response
// (streaming response).
function sseResponse(
  events: AsyncGenerator<string, void, unknown>,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of events) {
          controller.enqueue(encoder.encode(frame));
        }
      } catch {
        // the generator reports its own errors as SSE "error" events
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

documentsRouter.post("/api/documents/actions/edit-react/stream", async (c) => {
  const state = await appState();
  const payload = parseReactEditBody(await readJson(c));
  const [selected, instruction, tools] = prepareReactEdit(payload);
  const settings = settingsFor(state);

  async function* events(): AsyncGenerator<string, void, unknown> {
    const operation_id = editing.new_operation_id();
    let used: string[] = [];
    try {
      yield sse("stream", { type: "stage", stage: "exploring" });
      const [context, usedTools] = await referenceContext(
        state,
        tools,
        payload.kb_name,
        (instruction || selected.slice(0, 400)).trim(),
      );
      used = usedTools;
      for (const tool of used) {
        yield sse("stream", {
          type: "tool_call",
          stage: "exploring",
          content: tool,
          metadata: { args: { query: instruction || selected.slice(0, 200) } },
        });
        yield sse("stream", {
          type: "tool_result",
          stage: "exploring",
          content: "[reference collected]",
          metadata: { tool },
        });
      }
      const [system, prompt] = promptPair(
        editing.react_edit_prompt({
          selected_text: selected,
          instruction,
          mode: payload.mode,
          context,
        }),
      );
      yield sse("stream", { type: "stage", stage: "responding" });
      const chunks: string[] = [];
      for await (const delta of stream_text(settings, {
        system,
        prompt,
        llm_selection: payload.llm_selection ?? null,
      })) {
        chunks.push(delta);
        yield sse("stream", {
          type: "content",
          stage: "responding",
          content: delta,
        });
      }
      const edited = editing.clean_output(chunks.join(""));
      if (!edited) {
        yield sse("error", { detail: "The model returned no text." });
        return;
      }
      editing.record({
        operation_id,
        action: "react_edit",
        mode: payload.mode,
        model: resolveModelName(settings, payload.llm_selection),
        original: selected,
        edited,
        instruction,
        tools: used,
        kb_name: payload.kb_name ?? null,
      });
      yield sse("result", {
        edited_text: edited,
        operation_id,
        tools_used: used,
      });
    } catch (exc) {
      yield sse("error", { detail: errDetail(exc) });
    }
  }

  return sseResponse(events());
});

documentsRouter.post("/api/documents/actions/automark", async (c) => {
  const state = await appState();
  const body = await readJson(c);
  const payload: AutoMarkRequest = {
    text: optStr(body, "text", MAX_DOC_CHARS) ?? "",
    llm_selection: optDict(body, "llm_selection") ?? null,
  };
  if (!payload.text.trim()) {
    httpError(400, "Add some content before running auto-mark.");
  }
  const settings = settingsFor(state);
  const [system, prompt] = promptPair(editing.automark_prompt(payload.text));
  let raw: string;
  try {
    raw = await complete_text(settings, {
      system,
      prompt,
      llm_selection: payload.llm_selection ?? null,
    });
  } catch (exc) {
    httpError(502, errDetail(exc));
  }
  const marked = editing.clean_output(raw) || payload.text;
  const operation_id = editing.new_operation_id();
  editing.record({
    operation_id,
    action: "automark",
    model: resolveModelName(settings, payload.llm_selection),
    original: payload.text,
    edited: marked,
    instruction: "AI Auto Mark",
  });
  return c.json({ marked_text: marked, operation_id });
});

documentsRouter.get("/api/documents/history", (c) => {
  const history = editing.load_history();
  return c.json({ history, total: history.length });
});

documentsRouter.get("/api/documents/history/:operation_id", (c) => {
  const operationId = c.req.param("operation_id");
  for (const entry of editing.load_history()) {
    if (entry.id === operationId) {
      return c.json(modelDump(entry));
    }
  }
  httpError(404, "Operation not found");
});

documentsRouter.get("/api/documents/tool-calls/:operation_id", (c) => {
  const operationId = c.req.param("operation_id");
  for (const entry of editing.load_history()) {
    if (entry.id === operationId) {
      return c.json({
        operation_id: operationId,
        tools: entry.tools ?? [],
        kb_name: entry.kb_name ?? null,
      });
    }
  }
  httpError(404, "Tool call not found");
});

// ── Pages ────────────────────────────────────────────────────────────────

documentsRouter.get("/api/documents", (c) => {
  const storage = getCoWriterStorage();
  return c.json({ documents: storage.listDocuments().map(modelDump) });
});

documentsRouter.post("/api/documents", async (c) => {
  const body = await readJson(c);
  const payload = {
    title: optStr(body, "title", 300) ?? null,
    content: optStr(body, "content", MAX_DOC_CHARS) ?? "",
    blocks: optBlocks(body) ?? null,
    parent_id: optStr(body, "parent_id") ?? null,
  };
  let doc: unknown;
  try {
    doc = getCoWriterStorage().createDocument({
      title: payload.title,
      content: payload.content,
      blocks: payload.blocks,
      parent_id: payload.parent_id,
    });
  } catch (exc) {
    if (exc instanceof HttpError) throw exc;
    if (isValueError(exc)) httpError(400, errDetail(exc));
    console.error(exc); // traceback.print_exc()
    httpError(500, errDetail(exc));
  }
  return c.json(modelDump(doc));
});

documentsRouter.get("/api/documents/:doc_id", (c) => {
  const doc = getCoWriterStorage().loadDocument(
    docId(c.req.param("doc_id")),
  ) as unknown as Doc | null;
  if (doc === null || doc === undefined) {
    httpError(404, "Page not found");
  }
  return c.json(modelDump(doc));
});

// updateDocument opts: snake_case keys mirroring the schema validation fields; only keys
// present in the request body are forwarded (model_dump(exclude_unset=True)).
type UpdateDocumentOpts = {
  title?: string | null;
  content?: string | null;
  blocks?: Dict[] | null;
  expected_revision?: number | null;
  parent_id?: string | null;
  icon?: string | null;
  cover?: string | null;
  pinned?: boolean | null;
};

documentsRouter.put("/api/documents/:doc_id", async (c) => {
  const body = await readJson(c);
  const update: UpdateDocumentOpts & Dict = {};
  const keys = [
    "title",
    "content",
    "blocks",
    "expected_revision",
    "parent_id",
    "icon",
    "cover",
    "pinned",
  ] as const;
  for (const key of keys) {
    if (key in body) (update as Dict)[key] = body[key];
  }
  // Type/length checks mirroring the model.
  if ("title" in update && update.title !== null && update.title !== undefined) {
    optStr(update, "title", 300);
  }
  if (
    "content" in update &&
    update.content !== null &&
    update.content !== undefined
  ) {
    optStr(update, "content", MAX_DOC_CHARS);
  }
  if ("blocks" in update) optBlocks(update);
  if ("expected_revision" in update) optNum(update, "expected_revision");
  if ("parent_id" in update && update.parent_id != null) {
    optStr(update, "parent_id");
  }
  if ("icon" in update && update.icon != null) optStr(update, "icon", 16);
  if ("cover" in update && update.cover != null) {
    optStr(update, "cover", 2000);
  }
  if ("pinned" in update) optBool(update, "pinned");

  let doc: unknown;
  try {
    doc = getCoWriterStorage().updateDocument(
      docId(c.req.param("doc_id")),
      update,
    );
  } catch (exc) {
    if (exc instanceof HttpError) throw exc;
    if (isRevisionConflict(exc)) httpError(409, errDetail(exc));
    if (isValueError(exc)) httpError(400, errDetail(exc));
    console.error(exc);
    httpError(500, errDetail(exc));
  }
  if (doc === null || doc === undefined) {
    httpError(404, "Page not found");
  }
  return c.json(modelDump(doc));
});

documentsRouter.delete("/api/documents/:doc_id", (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  if (!storage.docExists(pageId)) {
    httpError(404, "Page not found");
  }
  const deleted = storage.deleteDocument(pageId);
  return c.json({ deleted: Boolean(deleted) });
});

// ── Page version history ─────────────────────────────────────────────────

documentsRouter.get("/api/documents/:doc_id/versions", (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  if (!storage.docExists(pageId)) {
    httpError(404, "Page not found");
  }
  const versions = storage.listVersions(pageId);
  return c.json({
    versions: versions.map(modelDump),
    total: versions.length,
  });
});

documentsRouter.post("/api/documents/:doc_id/versions", async (c) => {
  const body = await readJson(c);
  const source = optStr(body, "source", 40) ?? "manual";
  const version = getCoWriterStorage().createVersion(
    docId(c.req.param("doc_id")),
    source || "manual",
  );
  if (version === null || version === undefined) {
    httpError(404, "Page not found");
  }
  return c.json(modelDump(version));
});

documentsRouter.get("/api/documents/:doc_id/versions/:version_id", (c) => {
  const version = getCoWriterStorage().getVersion(
    docId(c.req.param("doc_id")),
    versionId(c.req.param("version_id")),
  );
  if (version === null || version === undefined) {
    httpError(404, "Version not found");
  }
  return c.json(modelDump(version));
});

documentsRouter.post(
  "/api/documents/:doc_id/versions/:version_id/restore",
  async (c) => {
    const body = await readJson(c);
    const expectedRevision = optNum(body, "expected_revision");
    if (expectedRevision === undefined || expectedRevision < 0) {
      httpError(422, "expected_revision must be a non-negative number");
    }
    let doc: unknown;
    try {
      doc = getCoWriterStorage().restoreVersion(
        docId(c.req.param("doc_id")),
        versionId(c.req.param("version_id")),
        expectedRevision,
      );
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      if (isRevisionConflict(exc)) httpError(409, errDetail(exc));
      if (isValueError(exc)) httpError(400, errDetail(exc));
      throw exc;
    }
    if (doc === null || doc === undefined) {
      httpError(404, "Version not found");
    }
    return c.json(modelDump(doc));
  },
);

documentsRouter.get("/api/documents/:doc_id/backlinks", (c) => {
  // Pages whose text mentions this page's title or id.
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  const doc = storage.loadDocument(pageId) as unknown as Doc | null;
  if (doc === null || doc === undefined) {
    httpError(404, "Page not found");
  }
  const needle = String(doc.title ?? "").trim().toLowerCase();
  const pages: Dict[] = [];
  if (needle.length >= 2) {
    for (const summary of storage.listDocuments()) {
      if (summary.id === pageId) continue;
      const other = storage.loadDocument(summary.id) as unknown as Doc | null;
      if (other === null || other === undefined) continue;
      const body =
        `${other.content ?? ""}\n${JSON.stringify(other.blocks ?? [])}`.toLowerCase();
      if (body.includes(needle) || body.includes(pageId)) {
        pages.push(modelDump(summary));
      }
    }
  }
  return c.json({ pages });
});

// ── Review queue ─────────────────────────────────────────────────────────

documentsRouter.get("/api/documents/:doc_id/suggestions", (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  if (!storage.docExists(pageId)) {
    httpError(404, "Page not found");
  }
  return c.json({ suggestions: listProposals(storage, pageId) });
});

documentsRouter.post("/api/documents/:doc_id/suggestions", async (c) => {
  const body = await readJson(c);
  const payload = {
    operation: optStr(body, "operation") ?? "insert",
    block_id: optStr(body, "block_id") ?? "",
    markdown: optStr(body, "markdown", 200_000) ?? "",
    explanation: optStr(body, "explanation", 10_000) ?? "",
    blocks: optBlocks(body) ?? null,
    source_turn_id: optStr(body, "source_turn_id") ?? "",
  };
  try {
    return c.json(
      modelDump(
        createProposal(getCoWriterStorage(), docId(c.req.param("doc_id")), {
          operation: payload.operation,
          block_id: payload.block_id,
          markdown: payload.markdown,
          explanation: payload.explanation,
          blocks: payload.blocks,
          source_turn_id: payload.source_turn_id,
        }),
      ),
    );
  } catch (exc) {
    if (exc instanceof HttpError) throw exc;
    if (isValueError(exc)) httpError(400, errDetail(exc));
    throw exc;
  }
});

documentsRouter.post(
  "/api/documents/:doc_id/suggestions/:suggestion_id",
  async (c) => {
    const body = await readJson(c);
    const accept = body["accept"];
    if (typeof accept !== "boolean") {
      httpError(422, "accept must be a boolean");
    }
    const payloadBlocks = optBlocks(body) ?? null;
    let doc: unknown;
    try {
      doc = reviewProposal(
        getCoWriterStorage(),
        docId(c.req.param("doc_id")),
        c.req.param("suggestion_id"),
        { accept, blocks: payloadBlocks },
      );
    } catch (exc) {
      if (exc instanceof HttpError) throw exc;
      if (isRevisionConflict(exc)) httpError(409, errDetail(exc));
      if (isValueError(exc)) httpError(400, errDetail(exc));
      throw exc;
    }
    return c.json(modelDump(doc));
  },
);

// ── Attachments ──────────────────────────────────────────────────────────

const ASSET_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_DOCX_BYTES = 40 * 1024 * 1024;

interface UploadedFile {
  data: Uint8Array;
  contentType: string;
  filename: string;
}

// an uploaded file → Hono/undici File from multipart form data.
async function uploadedFile(c: {
  req: { parseBody: () => Promise<Record<string, unknown>> };
}): Promise<UploadedFile> {
  const form = await c.req.parseBody();
  const file = form["file"];
  if (
    file === null ||
    file === undefined ||
    typeof file !== "object" ||
    typeof (file as { arrayBuffer?: unknown }).arrayBuffer !== "function"
  ) {
    httpError(422, "Missing file upload");
  }
  const f = file as File;
  return {
    data: new Uint8Array(await f.arrayBuffer()),
    contentType: String(f.type ?? "")
      .split(";")[0]
      .trim(),
    filename: f.name ?? "",
  };
}

documentsRouter.post("/api/documents/:doc_id/assets", async (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  if (!storage.docExists(pageId)) {
    httpError(404, "Page not found");
  }
  const file = await uploadedFile(c);
  const suffix = ASSET_TYPES[file.contentType];
  if (suffix === undefined) {
    httpError(400, "Unsupported attachment type");
  }
  if (file.data.length === 0 || file.data.length > MAX_ASSET_BYTES) {
    httpError(400, "Attachments must be between 1 byte and 25 MB");
  }
  const name = randomBytes(16).toString("hex") + suffix;
  storage.saveAsset(pageId, name, file.data, file.contentType);
  const workspace = c.req.query("dt_workspace") || "";
  return c.json({
    url:
      `/api/documents/${pageId}/assets/${name}` +
      (workspace ? `?dt_workspace=${encodeURIComponent(workspace)}` : ""),
  });
});

documentsRouter.get("/api/documents/:doc_id/assets/:name", (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  const name = c.req.param("name");
  if (!/^[0-9a-f]{32}\.(png|jpg|webp|gif|mp3|wav|mp4|pdf)$/.test(name)) {
    httpError(404, "Attachment not found");
  }
  const asset = storage.loadAsset(pageId, name);
  if (asset === null || asset === undefined) {
    httpError(404, "Attachment not found");
  }
  const [data, contentType] = asset as [Uint8Array, string];
  return new Response(data as unknown as BodyInit, {
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

// ── Clips ────────────────────────────────────────────────────────────────

documentsRouter.post("/api/documents/:doc_id/clips", async (c) => {
  const body = await readJson(c);
  const payload = {
    title: optStr(body, "title", 200) ?? "",
    markdown: optStr(body, "markdown", 200_000) ?? "",
    source_url: optStr(body, "source_url", 2000) ?? "",
    source_id: optStr(body, "source_id", 200) ?? "",
    favorite_type: optStr(body, "favorite_type", 60) ?? "",
    summary: optStr(body, "summary", 200_000) ?? "",
    favorite_metadata: optDict(body, "favorite_metadata") ?? {},
  };
  if (!safe_link(payload.source_url)) {
    httpError(400, "Unsupported source URL");
  }
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  // storage.locked(fn) is the sync context-manager equivalent.
  return c.json(
    modelDump(
      storage.locked(() => {
        const doc = storage.loadDocument(pageId) as unknown as Doc | null;
        if (doc === null || doc === undefined) {
          httpError(404, "Page not found");
        }
        if (doc.blocks === null || doc.blocks === undefined) {
          doc.blocks = [];
        }
        doc.blocks.push({
          id: randomBytes(16).toString("hex"),
          type: "clip",
          props: {
            title: payload.title,
            markdown: payload.markdown,
            sourceUrl: payload.source_url,
            sourceId: payload.source_id,
            favoriteType: payload.favorite_type,
            summary: payload.summary,
            metadata: JSON.stringify(payload.favorite_metadata),
            expanded: false,
          },
          children: [],
        });
        try {
          validate_blocks(
            doc.blocks as unknown as Parameters<typeof validate_blocks>[0],
          );
        } catch (exc) {
          if (isValueError(exc)) httpError(400, errDetail(exc));
          throw exc;
        }
        doc.content = blocks_to_markdown(
          doc.blocks as unknown as Parameters<typeof blocks_to_markdown>[0],
        );
        doc.revision = (doc.revision ?? 0) + 1;
        doc.updated_at = Date.now() / 1000;
        storageWrite(storage, doc, "clip");
        return doc;
      }),
    ),
  );
});

// ── Flashcards ───────────────────────────────────────────────────────────

function ankiResponse(text: string, filename: string): Response {
  return new Response(new TextEncoder().encode(text), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

documentsRouter.get("/api/documents/review/due", (c) => {
  const raw = c.req.query("limit");
  let limit = 200;
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isInteger(n)) httpError(422, "Invalid value for limit");
    limit = n;
  }
  // due_cards already caps at 200 server-side; the route clamps to [1, 500].
  const cards = dueCards(getCoWriterStorage());
  const clamped = Math.max(1, Math.min(Math.trunc(limit), 500));
  return c.json({ cards: cards.slice(0, clamped) });
});

documentsRouter.post("/api/documents/:doc_id/review", async (c) => {
  const body = await readJson(c);
  const payload = {
    card_id: reqStr(body, "card_id"),
    remembered: optBool(body, "remembered") ?? true,
  };
  try {
    return c.json(
      modelDump(
        gradeReviewCard(
          getCoWriterStorage(),
          docId(c.req.param("doc_id")),
          payload.card_id,
          payload.remembered,
        ),
      ),
    );
  } catch (exc) {
    if (isValueError(exc)) httpError(400, errDetail(exc));
    throw exc;
  }
});

documentsRouter.get("/api/documents/flashcards/export", () => {
  const cards = cards_from_storage(getCoWriterStorage());
  if (!cards || cards.length === 0) {
    httpError(404, "No flashcards to export");
  }
  return ankiResponse(render_anki_export(cards), "praxis-flashcards.txt");
});

documentsRouter.get("/api/documents/:doc_id/flashcards/export", (c) => {
  const storage = getCoWriterStorage();
  const doc = storage.loadDocument(docId(c.req.param("doc_id"))) as unknown as
    | Doc
    | null;
  if (doc === null || doc === undefined) {
    httpError(404, "Page not found");
  }
  const cards = Array.from(
    pageCards(doc as unknown as Parameters<typeof pageCards>[0]),
  );
  if (cards.length === 0) {
    httpError(404, "No flashcards on this page");
  }
  const title = String(doc.title || "page").slice(0, 40);
  return ankiResponse(render_anki_export(cards), `praxis-${title}.txt`);
});

// ── DOCX interchange ─────────────────────────────────────────────────────

function docxFilename(title: string): string {
  const safe = (title || "note")
    .trim()
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, "-")
    .slice(0, 80)
    .replace(/^[ .]+|[ .]+$/g, "");
  return `${safe || "note"}.docx`;
}

documentsRouter.post("/api/documents/export/docx", async (c) => {
  const body = await readJson(c);
  const payload = {
    title: optStr(body, "title") ?? "",
    content: optStr(body, "content", MAX_DOC_CHARS) ?? "",
  };
  let data: Uint8Array;
  try {
    data = markdownToDocx(payload.content, payload.title);
  } catch (exc) {
    if (exc instanceof DocxConversionError) {
      httpError(400, errDetail(exc));
    }
    throw exc;
  }
  return new Response(data as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${docxFilename(payload.title)}"`,
    },
  });
});

documentsRouter.post("/api/documents/import/docx", async (c) => {
  const file = await uploadedFile(c);
  if (file.data.length === 0 || file.data.length > MAX_DOCX_BYTES) {
    httpError(400, "Documents must be between 1 byte and 40 MB");
  }
  let markdown: string;
  try {
    markdown = docxToMarkdown(file.data, file.filename || "document.docx");
  } catch (exc) {
    if (exc instanceof DocxConversionError) {
      httpError(400, errDetail(exc));
    }
    throw exc;
  }
  const title = file.filename.replace(/\.docx$/i, "") || "Imported document";
  const doc = getCoWriterStorage().createDocument({ title, content: markdown });
  return c.json(modelDump(doc));
});

// ── Conversations anchored to a line ─────────────────────────────────────

// A page anchor joined with its conversation's session state.
// The anchor only stores where the conversation lives. Title, status and
// the last message come from the chat session, so a thread whose session was
// deleted has nothing to show and is left out.
function threadFields(
  thread: Dict,
  session: Dict | null | undefined,
): Dict | null {
  if (session === null || session === undefined) return null;
  const messages = (session.messages as unknown[] | undefined) ?? [];
  const last = (messages.length
    ? messages[messages.length - 1]
    : {}) as Dict;
  const turns = (session.turns as Dict | undefined) ?? {};
  const running = Object.values(turns).some(
    (turn) =>
      typeof turn === "object" &&
      turn !== null &&
      (turn as Dict).status === "running",
  );
  return {
    ...thread,
    title: String(session.title ?? ""),
    status: running ? "running" : String(session.status ?? "idle"),
    updated_at:
      session.updated_at ?? thread.updated_at ?? thread.created_at ?? 0,
    message_count: messages.length,
    last_message: String(last.content ?? "").slice(0, 400),
  };
}

documentsRouter.get("/api/documents/:doc_id/threads", async (c) => {
  const storage = getCoWriterStorage();
  const pageId = docId(c.req.param("doc_id"));
  if (!storage.docExists(pageId)) {
    httpError(404, "Page not found");
  }
  // The document store lives on app state.
  const state = await appState();
  const store = state.store as
    | { get?: (id: string) => Dict | null }
    | null
    | undefined;
  const rows: Dict[] = [];
  for (const thread of threadStore.list_threads(
    storage,
    pageId,
  ) as unknown as Dict[]) {
    const sessionId = String(thread.session_id ?? "");
    const session =
      store && typeof store.get === "function" ? store.get(sessionId) : null;
    const row = threadFields(thread, session);
    if (row !== null) rows.push(row);
  }
  return c.json({ threads: rows });
});

documentsRouter.post("/api/documents/:doc_id/threads", async (c) => {
  const body = await readJson(c);
  const sessionId = optStr(body, "session_id", 200);
  if (!sessionId) httpError(422, "session_id is required");
  const payload = {
    session_id: sessionId,
    block_id: optStr(body, "block_id", 100) ?? "",
    quote: optStr(body, "quote", 2000) ?? "",
    origin: optStr(body, "origin") ?? "ask",
  };
  try {
    return c.json(
      modelDump(
        threadStore.anchor(getCoWriterStorage(), docId(c.req.param("doc_id")), {
          session_id: payload.session_id,
          block_id: payload.block_id,
          quote: payload.quote,
          origin: payload.origin,
        }),
      ),
    );
  } catch (exc) {
    if (isValueError(exc)) httpError(404, errDetail(exc));
    throw exc;
  }
});

documentsRouter.delete("/api/documents/:doc_id/threads/:session_id", (c) => {
  const deleted = threadStore.remove(
    getCoWriterStorage(),
    docId(c.req.param("doc_id")),
    c.req.param("session_id"),
  );
  return c.json({ deleted: Boolean(deleted) });
});

export { documentsRouter };
