// question-notebook HTTP surface (full upstream fidelity; the legacy shim in
// handlers.ts returns different shapes for categories/materials/stats and is
// missing PATCH/DELETE routes, so mount this router FIRST or remove the shim)
// plus the AI quiz-judge WebSocket handler.
import { Hono } from "hono";
import type { Context } from "hono";
import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { get_settings, type Settings } from "../config.js";
import { completeText, streamText } from "../services/llm_text.js";
import * as qn from "../services/question_notebook.js";
import {
  QuestionPipeline,
  QuestionStream,
  loadSessionQuizHistory,
  type QuizTemplate,
} from "../capabilities/question/pipeline.js";
import { parseExamPaperToTemplates } from "../capabilities/question/mimic.js";

export const questionNotebookRouter = new Hono();
export const quizRouter = new Hono();

function httpError(c: Context, status: number, detail: string) {
  return c.json({ detail }, status as never);
}

async function jsonBody(c: Context): Promise<Record<string, any>> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function boolParam(c: Context, name: string): boolean | null {
  const raw = c.req.query(name);
  if (raw === undefined) return null;
  return raw === "true" || raw === "1";
}

function intParam(c: Context, name: string): number | null {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

const ASSESSMENT_TYPES = new Set(["", "quiz", "focus_check", "qualitative", "review"]);
const RESULTS = new Set(["", "correct", "incorrect", "partial", "ungraded"]);
const SCORE_TRENDS = new Set(["", "new", "improved", "declined", "unchanged"]);

// -- entries -------------------------------------------------------------------

// POST /api/question-notebook/entries/upsert
questionNotebookRouter.post("/api/question-notebook/entries/upsert", async (c) => {
  const body = await jsonBody(c);
  try {
    const entry = qn.upsertEntry(body, get_settings());
    return c.json(entry);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("require")) return httpError(c, 400, msg);
    return httpError(c, 500, "Upsert failed");
  }
});

// GET /api/question-notebook/entries
questionNotebookRouter.get("/api/question-notebook/entries", (c) => {
  const assessmentType = c.req.query("assessment_type") ?? "";
  const result = c.req.query("result") ?? "";
  const scoreTrend = c.req.query("score_trend") ?? "";
  if (!ASSESSMENT_TYPES.has(assessmentType)) return httpError(c, 400, "Invalid assessment_type");
  if (!RESULTS.has(result)) return httpError(c, 400, "Invalid result");
  if (!SCORE_TRENDS.has(scoreTrend)) return httpError(c, 400, "Invalid score_trend");
  const sort = c.req.query("sort") ?? "recent";
  if (sort !== "recent" && sort !== "oldest") return httpError(c, 400, "Invalid sort");
  const limitRaw = c.req.query("limit");
  const offsetRaw = c.req.query("offset");
  const limit = limitRaw === undefined ? 50 : Number.parseInt(limitRaw, 10);
  const offset = offsetRaw === undefined ? 0 : Number.parseInt(offsetRaw, 10);
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    return httpError(c, 400, "limit must be between 1 and 200");
  }
  if (!Number.isFinite(offset) || offset < 0) return httpError(c, 400, "offset must be >= 0");
  const search = c.req.query("search") ?? "";
  if (search.length > 200) return httpError(c, 400, "search too long");
  const materialId = c.req.query("material_id") ?? "";
  const sectionId = c.req.query("section_id") ?? "";
  const masteryPathId = c.req.query("mastery_path_id") ?? "";
  const knowledgePointId = c.req.query("knowledge_point_id") ?? "";
  for (const [name, v] of [["material_id", materialId], ["section_id", sectionId], ["mastery_path_id", masteryPathId], ["knowledge_point_id", knowledgePointId]] as const) {
    if (v.length > 500) return httpError(c, 400, `${name} too long`);
  }
  const listing = qn.listEntries(
    {
      category_id: intParam(c, "category_id"),
      mistakes_only: c.req.query("mistakes_only") === "true",
      uncategorized: c.req.query("uncategorized") === "true",
      bookmarked: boolParam(c, "bookmarked"),
      is_correct: boolParam(c, "is_correct"),
      source: c.req.query("source") ?? "",
      material_id: materialId,
      section_id: sectionId,
      assessment_type: assessmentType,
      result,
      mastery_path_id: masteryPathId,
      knowledge_point_id: knowledgePointId,
      resolved: boolParam(c, "resolved"),
      score_trend: scoreTrend,
      search,
      sort,
      limit,
      offset,
    },
    get_settings(),
  );
  return c.json(listing);
});

// GET /api/question-notebook/entries/lookup/by-question
questionNotebookRouter.get("/api/question-notebook/entries/lookup/by-question", (c) => {
  const questionId = c.req.query("question_id") ?? "";
  if (!questionId) return httpError(c, 400, "question_id is required");
  const missingOk = c.req.query("missing_ok") === "true" || c.req.query("missing_ok") === "1";
  const entry = qn.lookupEntry(
    {
      session_id: c.req.query("session_id") ?? "",
      origin_type: (c.req.query("origin_type") as string | undefined) ?? "conversation",
      origin_ref: c.req.query("origin_ref") ?? "",
      question_id: questionId,
      turn_id: c.req.query("turn_id") ?? null,
    },
    get_settings(),
  );
  if (!entry) {
    if (missingOk) return new Response(null, { status: 204 });
    return httpError(c, 404, "Entry not found");
  }
  return c.json(entry);
});

// GET /api/question-notebook/entries/{entry_id}
questionNotebookRouter.get("/api/question-notebook/entries/:entry_id", (c) => {
  const id = Number.parseInt(c.req.param("entry_id"), 10);
  const entry = Number.isFinite(id) ? qn.getEntry(id, get_settings()) : null;
  if (!entry) return httpError(c, 404, "Entry not found");
  return c.json(entry);
});

// PATCH /api/question-notebook/entries/{entry_id}
questionNotebookRouter.patch("/api/question-notebook/entries/:entry_id", async (c) => {
  const id = Number.parseInt(c.req.param("entry_id"), 10);
  const body = await jsonBody(c);
  const updates: Record<string, unknown> = {};
  for (const key of ["bookmarked", "followup_session_id", "ai_judgment", "resolved"] as const) {
    if (body[key] !== undefined) updates[key] = body[key];
  }
  if (!Object.keys(updates).length) return httpError(c, 400, "No fields to update");
  const updated = Number.isFinite(id) ? qn.updateEntry(id, updates, get_settings()) : null;
  if (!updated) return httpError(c, 404, "Entry not found");
  return c.json({ updated: true, id });
});

// DELETE /api/question-notebook/entries/{entry_id}
questionNotebookRouter.delete("/api/question-notebook/entries/:entry_id", (c) => {
  const id = Number.parseInt(c.req.param("entry_id"), 10);
  const deleted = Number.isFinite(id) ? qn.deleteEntry(id, get_settings()) : null;
  if (!deleted) return httpError(c, 404, "Entry not found");
  return c.json({ deleted: true, id });
});

// POST /api/question-notebook/entries/categories/bulk
questionNotebookRouter.post("/api/question-notebook/entries/categories/bulk", async (c) => {
  const body = await jsonBody(c);
  const entryIds = Array.isArray(body.entry_ids) ? body.entry_ids.map(Number).filter(Number.isFinite) : [];
  if (!entryIds.length || entryIds.length > 500) {
    return httpError(c, 400, "entry_ids must contain 1 to 500 ids");
  }
  const categoryId = Number(body.category_id);
  if (!Number.isFinite(categoryId)) return httpError(c, 400, "category_id is required");
  const link = body.link !== false;
  const changed = qn.linkEntriesToCategory(entryIds, categoryId, link, get_settings());
  return c.json({ changed, requested: entryIds.length, category_id: categoryId, link });
});

// POST /api/question-notebook/entries/{entry_id}/categories
questionNotebookRouter.post("/api/question-notebook/entries/:entry_id/categories", async (c) => {
  const entryId = Number.parseInt(c.req.param("entry_id"), 10);
  const body = await jsonBody(c);
  const categoryId = Number(body.category_id);
  if (!Number.isFinite(entryId) || !Number.isFinite(categoryId)) {
    return httpError(c, 400, "entry_id and category_id are required");
  }
  const entry = qn.getEntry(entryId, get_settings());
  if (!entry) return httpError(c, 404, "Entry not found");
  const ok = qn.addEntryToCategory(entryId, categoryId, get_settings());
  if (!ok) return httpError(c, 400, "Failed to add to category");
  return c.json({ added: true, entry_id: entryId, category_id: categoryId });
});

// DELETE /api/question-notebook/entries/{entry_id}/categories/{category_id}
questionNotebookRouter.delete(
  "/api/question-notebook/entries/:entry_id/categories/:category_id",
  (c) => {
    const entryId = Number.parseInt(c.req.param("entry_id"), 10);
    const categoryId = Number.parseInt(c.req.param("category_id"), 10);
    if (!Number.isFinite(entryId) || !Number.isFinite(categoryId)) {
      return httpError(c, 404, "Link not found");
    }
    const removed = qn.removeEntryFromCategory(entryId, categoryId, get_settings());
    if (!removed) return httpError(c, 404, "Link not found");
    return c.json({ removed: true, entry_id: entryId, category_id: categoryId });
  },
);

// -- overview ---------------------------------------------------------------------

// GET /api/question-notebook/stats
questionNotebookRouter.get("/api/question-notebook/stats", (c) => {
  return c.json(qn.questionBankStats(get_settings()));
});

// GET /api/question-notebook/materials
questionNotebookRouter.get("/api/question-notebook/materials", (c) => {
  return c.json(qn.listQuestionBankMaterials(get_settings()));
});

// -- categories ---------------------------------------------------------------------

// GET /api/question-notebook/categories
questionNotebookRouter.get("/api/question-notebook/categories", (c) => {
  return c.json(qn.listCategories(get_settings()));
});

// POST /api/question-notebook/categories
questionNotebookRouter.post("/api/question-notebook/categories", async (c) => {
  const body = await jsonBody(c);
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 100) return httpError(c, 400, "name must be 1-100 characters");
  try {
    return c.json(qn.createCategory(name, get_settings()), 201);
  } catch (e) {
    return httpError(c, 409, e instanceof Error ? e.message : String(e));
  }
});

// PATCH /api/question-notebook/categories/{category_id}
questionNotebookRouter.patch("/api/question-notebook/categories/:category_id", async (c) => {
  const id = Number.parseInt(c.req.param("category_id"), 10);
  const body = await jsonBody(c);
  const name = String(body.name ?? "").trim();
  if (!name || name.length > 100) return httpError(c, 400, "name must be 1-100 characters");
  try {
    const updated = Number.isFinite(id) ? qn.renameCategory(id, name, get_settings()) : null;
    if (!updated) return httpError(c, 404, "Category not found");
    return c.json({ updated: true, id, name });
  } catch (e) {
    return httpError(c, 409, e instanceof Error ? e.message : String(e));
  }
});

// DELETE /api/question-notebook/categories/{category_id}
questionNotebookRouter.delete("/api/question-notebook/categories/:category_id", (c) => {
  const id = Number.parseInt(c.req.param("category_id"), 10);
  const deleted = Number.isFinite(id) ? qn.deleteCategory(id, get_settings()) : false;
  if (!deleted) return httpError(c, 404, "Category not found");
  return c.json({ deleted: true, id });
});

// -- quiz judge (WebSocket upstream; HTTP fallback + WS handler) -------------------

const JUDGE_SYSTEM_PROMPT =
  "You are a rigorous yet encouraging teaching assistant grading a learner's quiz answer. " +
  "Use the question, reference answer, and explanation to deliver a targeted assessment.\n\n" +
  "Requirements:\n" +
  "- Open with one line that states the verdict: ✅ Correct / ⚠️ Partially correct / ❌ Incorrect, " +
  "and the key reason.\n" +
  "- Then list: what the learner got right, what is wrong or missing, and how to fix it.\n" +
  "- If multiple reasonable answers exist, acknowledge what the learner did well.\n" +
  "- Speak directly to the learner's submission — do not give a generic lecture.\n" +
  "- Reply in English.";

interface JudgeRequest {
  question?: string;
  question_type?: string;
  options?: Record<string, string> | null;
  correct_answer?: string;
  explanation?: string;
  user_answer?: string;
  user_answer_images?: Array<Record<string, unknown>> | null;
  user_answer_image?: string | null;
  image_filename?: string | null;
}

function guessImageMime(filename: string | null | undefined): string {
  const ext = filename && filename.includes(".")
    ? filename.split(".").pop()!.toLowerCase()
    : "";
  const mimes: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return mimes[ext] ?? "image/png";
}

function dataUrlMime(value: string): string | null {
  if (!value.startsWith("data:")) return null;
  const comma = value.indexOf(",");
  const header = comma >= 0 ? value.slice(5, comma) : "";
  const mime = header.split(";", 1)[0].trim();
  return mime || null;
}

function buildJudgeUserPrompt(args: {
  question: string;
  question_type: string;
  options: Record<string, string> | null;
  correct_answer: string;
  explanation: string;
  user_answer: string;
  hasImage: boolean;
  imageCount: number;
}): string {
  const optionsBlock = args.options
    ? Object.entries(args.options).map(([k, v]) => `  ${k}. ${v}`).join("\n")
    : "";
  const parts: string[] = [];
  const labels = { qt: "Question type", q: "Question", opts: "Options", ref: "Reference answer", exp: "Reference explanation", ans: "Learner's answer", imgNone: "(only an image was submitted, no typed answer)", imgOne: "The learner attached an image as part of the answer. Read its text/formulas/sketches and factor it into the judgment.", imgMany: (n: number) => `The learner attached ${n} images as part of the answer. Read their text/formulas/sketches and factor them into the judgment.`, final: "Produce an AI judgment that addresses this learner's specific answer." };
  parts.push(`${labels.qt}: ${args.question_type || "unknown"}`);
  parts.push(`${labels.q}:\n${args.question}`);
  if (optionsBlock) parts.push(`${labels.opts}:\n${optionsBlock}`);
  if (args.correct_answer) parts.push(`${labels.ref}:\n${args.correct_answer}`);
  if (args.explanation) parts.push(`${labels.exp}:\n${args.explanation}`);
  const typed = args.user_answer.trim();
  parts.push(`${labels.ans}:\n${typed || labels.imgNone}`);
  if (args.hasImage) {
    parts.push(args.imageCount > 1 ? labels.imgMany(args.imageCount) : labels.imgOne);
  }
  parts.push(labels.final);
  return parts.join("\n\n");
}

interface ResolvedJudgeInput {
  ok: boolean;
  error?: string;
  systemPrompt?: string;
  userPrompt?: string;
}

function resolveJudgeInput(data: JudgeRequest): ResolvedJudgeInput {
  const questionText = String(data.question ?? "").trim();
  if (!questionText) return { ok: false, error: "Question is required" };
  const userAnswer = String(data.user_answer ?? "");

  // Resolve image records (list form + legacy single-image form).
  const imageRecords: Array<{ base64: string; url: string; filename: string; mime_type: string }> = [];
  const rawImages = data.user_answer_images;
  if (Array.isArray(rawImages)) {
    for (const entry of rawImages) {
      if (entry === null || typeof entry !== "object") continue;
      let b64 = String((entry as Record<string, unknown>).base64 ?? "");
      const url = String((entry as Record<string, unknown>).url ?? "");
      let declaredMime: string | null = null;
      if (b64.startsWith("data:")) {
        declaredMime = dataUrlMime(b64);
        b64 = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : "";
      }
      if (!b64 && !url) continue;
      const filename = String((entry as Record<string, unknown>).filename ?? "") || "answer.png";
      const mimeType =
        String((entry as Record<string, unknown>).mime_type ?? "") ||
        declaredMime ||
        guessImageMime(filename);
      imageRecords.push({ base64: b64, url, filename, mime_type: mimeType });
    }
  } else {
    let legacyB64 = String(data.user_answer_image ?? "");
    let legacyMime: string | null = null;
    if (legacyB64.startsWith("data:")) {
      legacyMime = dataUrlMime(legacyB64);
      legacyB64 = legacyB64.includes(",") ? legacyB64.slice(legacyB64.indexOf(",") + 1) : "";
    }
    if (legacyB64) {
      const filename = String(data.image_filename ?? "") || "answer.png";
      imageRecords.push({
        base64: legacyB64,
        url: "",
        filename,
        mime_type: legacyMime || guessImageMime(filename),
      });
    }
  }

  const hasImage = imageRecords.length > 0;
  const optionsValue =
    data.options !== null && typeof data.options === "object" && !Array.isArray(data.options)
      ? data.options
      : null;
  const systemPrompt = JUDGE_SYSTEM_PROMPT;
  const userPrompt = buildJudgeUserPrompt({
    question: questionText,
    question_type: String(data.question_type ?? ""),
    options: optionsValue,
    correct_answer: String(data.correct_answer ?? ""),
    explanation: String(data.explanation ?? ""),
    user_answer: userAnswer,
    hasImage,
    imageCount: imageRecords.length,
  });
  if (!userAnswer.trim() && !hasImage) {
    return { ok: false, error: "No answer to judge — submit a typed answer or attach an image." };
  }
  return { ok: true, systemPrompt, userPrompt };
}

/**
 * WebSocket handler for /questions/judge (upstream quiz_judge.py).
 * Wire with the `ws` package in main.ts/server bootstrap:
 *   ws.on("message", ...) → first JSON frame is the JudgeRequest; subsequent
 *   frames are ignored. Emits {type:"started"|"text"|"done"|"error"}.
 * TODO(port): vision-capable multimodal messages are not supported by
 * llm_text.streamText yet — images are noted in the prompt but not sent as
 * image_url parts.
 */
export async function handleQuizJudgeWebSocket(ws: WebSocket): Promise<void> {
  const send = (payload: Record<string, unknown>) => {
    try {
      ws.send(JSON.stringify(payload));
    } catch { /* closed */ }
  };
  try {
    const raw = await new Promise<string>((resolve, reject) => {
      const onMessage = (data: Buffer) => {
        cleanup();
        resolve(data.toString());
      };
      const onClose = () => {
        cleanup();
        reject(new Error("closed"));
      };
      const onError = (e: Error) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        ws.off("message", onMessage);
        ws.off("close", onClose);
        ws.off("error", onError);
      };
      ws.on("message", onMessage);
      ws.on("close", onClose);
      ws.on("error", onError);
    });
    let data: JudgeRequest;
    try {
      data = JSON.parse(raw) as JudgeRequest;
    } catch {
      send({ type: "error", content: "Invalid request" });
      ws.close();
      return;
    }
    const resolved = resolveJudgeInput(data);
    if (!resolved.ok) {
      send({ type: "error", content: resolved.error });
      ws.close();
      return;
    }
    send({ type: "started" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2 * 60 * 1000);
    try {
      for await (const chunk of streamText(get_settings(), {
        system: resolved.systemPrompt!,
        prompt: resolved.userPrompt!,
      })) {
        if (!chunk) continue;
        send({ type: "text", content: chunk });
      }
      send({ type: "done" });
    } catch (e) {
      if (controller.signal.aborted) {
        send({ type: "error", content: "AI judge timed out. Please try again." });
      } else {
        send({ type: "error", content: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
    }
  } catch {
    try { ws.close(); } catch { /* ignore */ }
  }
}

// HTTP fallback: POST /api/questions/judge → {judgment} (non-streaming).
quizRouter.post("/api/questions/judge", async (c) => {
  const body = await jsonBody(c);
  const resolved = resolveJudgeInput(body as JudgeRequest);
  if (!resolved.ok) return httpError(c, 400, resolved.error ?? "Invalid request");
  try {
    const judgment = await completeText(get_settings(), {
      system: resolved.systemPrompt!,
      prompt: resolved.userPrompt!,
    });
    return c.json({ judgment });
  } catch (e) {
    return httpError(c, 500, e instanceof Error ? e.message : String(e));
  }
});

// -- question.py WebSocket endpoints (/mimic, /generate) -----------------------
//
// port in src/capabilities/question/. Frame protocol:
//   inbound : one JSON config frame, then the socket is server-driven.
//   outbound: upstream StreamEvent dicts ({type:"stage_start"|"stage_end"|
//     "thinking"|"content"|"tool_call"|"tool_result"|"progress"|"result"|...})
//     plus endpoint-level {type:"status"|"task_id"|"batch_summary"|"complete"|
//     "error"} frames.

function questionWorkspaceDir(settings: Settings): string {
  const root = settings.workspace_dir || join(settings.data_dir ?? "./data", "workspace");
  return join(root, "chat", "deep_question");
}

/** Read the single inbound JSON config frame (same contract as the judge
 *  handler: first frame wins, socket closes on parse failure upstream-side). */
function readFirstJsonFrame(ws: WebSocket): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const onMessage = (data: Buffer) => {
      cleanup();
      try {
        const parsed = JSON.parse(data.toString()) as unknown;
        resolve(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {});
      } catch {
        resolve(null);
      }
    };
    const onClose = () => {
      cleanup();
      resolve(null);
    };
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

function wsSend(ws: WebSocket, payload: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(payload));
  } catch { /* closed */ }
}

function wsClose(ws: WebSocket): void {
  try { ws.close(); } catch { /* ignore */ }
}

// TaskIDManager port (api/utils/task_id_manager.py): dedup by task_key,
// id format {type}_{yyyymmddhhmmss}_{uuid8}.
const _taskIds = new Map<string, string>();
function generateTaskId(taskType: string, taskKey: string): string {
  const existing = _taskIds.get(taskKey);
  if (existing) return existing;
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, "")
    .slice(0, 14);
  const id = `${taskType}_${stamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  _taskIds.set(taskKey, id);
  if (_taskIds.size > 512) {
    const first = _taskIds.keys().next().value;
    if (first !== undefined) _taskIds.delete(first);
  }
  return id;
}

function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// DocumentValidator.validate_upload_safety subset: sane filename + .pdf only.
function validatePdfUpload(name: string, byteLength: number): string {
  const safe = String(name ?? "exam.pdf").trim() || "exam.pdf";
  const base = basename(safe);
  if (base !== safe || safe.includes("..") || safe.startsWith("/")) {
    throw new Error("Invalid file name");
  }
  if (!base.toLowerCase().endsWith(".pdf")) {
    throw new Error("Only PDF files are supported");
  }
  const maxBytes = 200 * 1024 * 1024;
  if (byteLength <= 0 || byteLength > maxBytes) {
    throw new Error(`File exceeds maximum size of ${maxBytes} bytes`);
  }
  return base;
}

/**
 * WebSocket handler for /questions/generate (question.py
 * websocket_question_generate). Inbound: {requirement, kb_name, count}.
 * Streams the QuestionPipeline's explore→plan→quiz events, then
 * batch_summary + complete.
 */
export async function handleQuestionGenerateWebSocket(ws: WebSocket): Promise<void> {
  const settings = get_settings();
  const data = await readFirstJsonFrame(ws);
  if (data === null) {
    wsSend(ws, { type: "error", content: "Invalid request" });
    wsClose(ws);
    return;
  }
  const requirement = data["requirement"];
  if (requirement === undefined || requirement === null || requirement === "") {
    wsSend(ws, { type: "error", content: "Requirement is required" });
    wsClose(ws);
    return;
  }
  const kbName = String(data["kb_name"] ?? "ai_textbook") || "ai_textbook";
  const count = Math.max(1, Math.trunc(Number(data["count"] ?? 1) || 1));

  const reqObj =
    requirement !== null && typeof requirement === "object" && !Array.isArray(requirement)
      ? (requirement as Record<string, unknown>)
      : {};
  const userTopic = String(reqObj["knowledge_point"] ?? (typeof requirement === "string" ? requirement : "")).trim();
  const preference = String(reqObj["preference"] ?? "").trim();
  const difficulty = String(reqObj["difficulty"] ?? "").trim();
  const questionType = String(reqObj["question_type"] ?? "").trim();

  const taskKey = `question_${kbName}_${simpleHash(JSON.stringify(requirement))}`;
  const taskId = generateTaskId("question_gen", taskKey);
  wsSend(ws, { type: "task_id", task_id: taskId });

  const stream = new QuestionStream(
    (event) => wsSend(ws, event),
    { session_id: taskId },
  );

  try {
    wsSend(ws, { type: "status", content: "started" });
    const userMessage = preference ? `${userTopic}\n\n${preference}` : userTopic;
    const pipeline = new QuestionPipeline({
      language: "en",
      kb_name: kbName,
      settings,
      session_id: taskId,
    });
    const quizHistory = loadSessionQuizHistory(taskId, settings);
    const result = await pipeline.run(stream, {
      user_message: userMessage,
      num_questions: count,
      difficulty,
      question_types: questionType ? [questionType] : null,
      quiz_history: quizHistory,
    });
    wsSend(ws, {
      type: "batch_summary",
      requested: count,
      completed: result.summary.completed,
      failed: result.summary.failed,
    });
    wsSend(ws, { type: "complete" });
  } catch (e) {
    wsSend(ws, { type: "error", content: e instanceof Error ? e.message : String(e) });
  } finally {
    wsClose(ws);
  }
}

/**
 * WebSocket handler for /questions/mimic (question.py
 * websocket_mimic_generate). Inbound: {mode:"upload"|"parsed",
 * pdf_data/pdf_name | paper_path, kb_name, max_questions}.
 */
export async function handleMimicWebSocket(ws: WebSocket): Promise<void> {
  const settings = get_settings();
  const data = await readFirstJsonFrame(ws);
  if (data === null) {
    wsSend(ws, { type: "error", content: "Invalid request" });
    wsClose(ws);
    return;
  }
  const mode = String(data["mode"] ?? "parsed");
  const kbName = String(data["kb_name"] ?? "ai_textbook") || "ai_textbook";
  const maxQuestions = data["max_questions"] === undefined || data["max_questions"] === null
    ? null
    : Math.max(1, Math.trunc(Number(data["max_questions"]) || 1));

  const questionDir = questionWorkspaceDir(settings);
  const mimicDir = join(questionDir, "mimic_papers");

  const stream = new QuestionStream(
    (event) => wsSend(ws, event),
    { session_id: "mimic" },
  );

  try {
    wsSend(ws, { type: "status", stage: "init", content: "Initializing..." });

    let pdfPath: string | null = null;
    let paperDir: string | null = null;
    let outputDir: string;

    if (mode === "upload") {
      const pdfData = data["pdf_data"];
      const pdfName = String(data["pdf_name"] ?? "exam.pdf");
      if (!pdfData) {
        wsSend(ws, { type: "error", content: "PDF data is required for upload mode" });
        wsClose(ws);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(String(pdfData), "base64");
      } catch (e) {
        wsSend(ws, { type: "error", content: `Invalid base64 PDF data: ${e}` });
        wsClose(ws);
        return;
      }
      let safeName: string;
      try {
        safeName = validatePdfUpload(pdfName, bytes.length);
      } catch (e) {
        wsSend(ws, { type: "error", content: e instanceof Error ? e.message : String(e) });
        wsClose(ws);
        return;
      }
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const stem = safeName.replace(/\.pdf$/i, "");
      const batchDir = join(mimicDir, `mimic_${stamp}_${stem}`);
      mkdirSync(batchDir, { recursive: true });
      const target = join(batchDir, safeName);
      wsSend(ws, { type: "status", stage: "upload", content: `Saving PDF: ${safeName}` });
      writeFileSync(target, bytes);
      wsSend(ws, { type: "status", stage: "parsing", content: "Parsing PDF exam paper..." });
      pdfPath = target;
      outputDir = batchDir;
    } else if (mode === "parsed") {
      const paperPath = data["paper_path"];
      if (!paperPath) {
        wsSend(ws, { type: "error", content: "paper_path is required for parsed mode" });
        wsClose(ws);
        return;
      }
      paperDir = String(paperPath);
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
      const batchDir = join(mimicDir, `mimic_${stamp}_${basename(paperDir)}`);
      mkdirSync(batchDir, { recursive: true });
      outputDir = batchDir;
    } else {
      wsSend(ws, { type: "error", content: `Unknown mode: ${mode}` });
      wsClose(ws);
      return;
    }

    const progressLines: string[] = [];
    const emitProgress = (line: string) => {
      progressLines.push(line);
      wsSend(ws, {
        type: "progress",
        source: "deep_question",
        stage: "parsing",
        content: line,
        metadata: { current: 0, total: 0 },
        session_id: "",
        turn_id: "",
        seq: 0,
        timestamp: Date.now() / 1000,
      });
    };

    wsSend(ws, {
      type: "status",
      stage: "processing",
      content: "Executing question generation workflow...",
    });

    const parsed = await parseExamPaperToTemplates(pdfPath ?? paperDir ?? "", {
      maxQuestions: maxQuestions ?? 10,
      paperMode: mode === "upload" ? "upload" : "parsed",
      outputDir,
      settings,
      onProgress: emitProgress,
    });

    if (!parsed.templates.length) {
      wsSend(ws, { type: "error", content: "No questions could be extracted from the exam paper." });
      wsClose(ws);
      return;
    }

    const pipeline = new QuestionPipeline({
      language: "en",
      kb_name: kbName,
      settings,
      session_id: basename(outputDir),
    });
    const templates: QuizTemplate[] = parsed.templates;
    const result = await pipeline.run(stream, {
      user_message: "Mimic this exam paper",
      num_questions: templates.length,
      templates_override: templates,
      // Upstream attaches the parse trace to the summary envelope.
      extra_summary: { trace: parsed.trace },
    });
    void result;
    wsSend(ws, { type: "complete" });
  } catch (e) {
    wsSend(ws, { type: "error", content: e instanceof Error ? e.message : String(e) });
  } finally {
    wsClose(ws);
  }
}
