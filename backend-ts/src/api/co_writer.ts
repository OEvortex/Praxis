// Favorites notebooks REST API.
//
// Upstream mounts this router next to co_writer.py; the co-writer document
// surface (`/api/documents/*`) is already ported in src/api/documents.ts, so
// this module only carries the endpoints that were still missing: the
// file-backed favorites notebooks under `/api/notebooks`.
//
// Storage: src/services/notebook/service.ts (JSON files under
// `<data_dir>/user/workspace/notebook/`, upstream layout).
//
// NOTE for wiring: handlers.ts still registers stub `/api/notebooks*` routes
// and main.ts mounts handlersRouter first, so these routes are shadowed until
// the stubs are removed or this router is mounted ahead of handlersRouter.

import { Hono } from "hono";
import type { StatusCode } from "hono/utils/http-status";

import type { Dict } from "../shared/types.js";
import { cleanThinkingTags } from "../services/llm_text.js";
import {
  get_notebook_manager,
  NotebookCorruptedError,
  NotebookMoveConflictError,
  RECORD_TYPES,
  type RecordType,
} from "../services/notebook/service.js";
import { NotebookSummarizeAgent } from "../agent/notebook/summarize_agent.js";

const coWriterRouter = new Hono();

// ── HTTP error plumbing (FastAPI HTTPException equivalent) ───────────────

class HttpError extends Error {
  constructor(public status: StatusCode, public detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.name = "HttpError";
  }
}

function httpError(status: number, detail: unknown): never {
  throw new HttpError(status as StatusCode, detail);
}

function errDetail(exc: unknown): string {
  return exc instanceof Error ? exc.message : String(exc);
}

coWriterRouter.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ detail: err.detail }, err.status as never);
  }
  console.error(err);
  return c.json({ detail: errDetail(err) }, 500);
});

// ── request helpers ──────────────────────────────────────────────────────

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

function optStr(body: Body, key: string): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") httpError(422, `${key} must be a string`);
  return v as string;
}

function optStrOrNull(body: Body, key: string): string | null | undefined {
  const v = body[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") httpError(422, `${key} must be a string`);
  return v as string;
}

function optDict(body: Body, key: string): Dict | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) {
    httpError(422, `${key} must be an object`);
  }
  return v as Dict;
}

function optStrList(body: Body, key: string): string[] {
  const v = body[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    httpError(422, `${key} must be a list of strings`);
  }
  return v as string[];
}

const RECORD_TYPE_SET = new Set<string>(RECORD_TYPES);

function _unreadable(exc: NotebookCorruptedError): HttpError {
  /** Translate a damaged notebook file into a response the UI can explain.

   * 409 rather than 500: the request was fine, the stored file is not, and
   * the client can act on it (restore a backup, delete the notebook).
   */
  return new HttpError(409, {
    code: "notebook_unreadable",
    notebook_id: exc.notebook_id,
    message: String(exc.message ?? exc),
  });
}

function manager() {
  return get_notebook_manager();
}

// ── shared record-summary builder ────────────────────────────────────────

async function buildRecordSummary(body: Body): Promise<string> {
  const summary = String(body["summary"] ?? "").trim();
  if (summary) return cleanThinkingTags(summary).trim();
  const metadata = optDict(body, "metadata") ?? {};
  const agent = new NotebookSummarizeAgent(
    String(metadata["ui_language"] ?? "en"),
  );
  return cleanThinkingTags(
    await agent.summarize({
      title: String(body["title"] ?? ""),
      record_type: String(body["record_type"] ?? ""),
      user_query: String(body["user_query"] ?? ""),
      output: String(body["output"] ?? ""),
      metadata,
    }),
  ).trim();
}

function addRecordPayload(body: Body): {
  notebook_ids: string[];
  record_type: string;
  title: string;
  summary: string;
  user_query: string;
  output: string;
  metadata: Dict;
  kb_name: string | null;
} {
  const recordType = body["record_type"];
  if (typeof recordType !== "string" || !RECORD_TYPE_SET.has(recordType)) {
    httpError(422, `record_type must be one of: ${RECORD_TYPES.join(", ")}`);
  }
  if (body["notebook_ids"] === undefined) {
    httpError(422, "notebook_ids is required");
  }
  const title = body["title"];
  const userQuery = body["user_query"];
  const output = body["output"];
  if (
    typeof title !== "string" ||
    typeof userQuery !== "string" ||
    typeof output !== "string"
  ) {
    httpError(422, "title, user_query and output are required");
  }
  return {
    notebook_ids: optStrList(body, "notebook_ids"),
    record_type: recordType,
    title,
    summary: optStr(body, "summary") ?? "",
    user_query: userQuery,
    output,
    metadata: optDict(body, "metadata") ?? {},
    kb_name: optStrOrNull(body, "kb_name") ?? null,
  };
}

function* sseFrames(payload: Dict): Generator<string> {
  // Upstream emits bare `data:` frames (no `event:` line); the payload's
  // `type` field discriminates summary_chunk / result / error.
  yield `data: ${JSON.stringify(payload)}\n\n`;
}

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
        // errors are reported as SSE "error" payloads by the generator
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

// NOTE: every literal path below must stay above the `/:notebook_id` routes.
// Routers match in registration order, so a literal declared later is shadowed
// by the parameterised route and becomes unreachable.

// GET /api/notebooks/health
coWriterRouter.get("/api/notebooks/health", (c) =>
  c.json({ status: "healthy", service: "notebook" }),
);

// GET /api/notebooks
coWriterRouter.get("/api/notebooks", (c) => {
  try {
    const notebooks = manager().list_notebooks();
    return c.json({ notebooks, total: notebooks.length });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// GET /api/notebooks/statistics
coWriterRouter.get("/api/notebooks/statistics", (c) => {
  try {
    return c.json(manager().get_statistics());
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// POST /api/notebooks
coWriterRouter.post("/api/notebooks", async (c) => {
  const body = await readJson(c);
  try {
    const notebook = manager().create_notebook(
      String(body["name"] ?? ""),
      optStr(body, "description") ?? "",
      optStr(body, "color") ?? "#3B82F6",
      optStr(body, "icon") ?? "book",
    );
    return c.json({ success: true, notebook });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// POST /api/notebooks/actions/add-record
coWriterRouter.post("/api/notebooks/actions/add-record", async (c) => {
  const payload = addRecordPayload(await readJson(c));
  try {
    const summary = await buildRecordSummary(payload);
    const result = manager().add_record({
      notebook_ids: payload.notebook_ids,
      record_type: payload.record_type as RecordType,
      title: payload.title,
      summary,
      user_query: payload.user_query,
      output: payload.output,
      metadata: payload.metadata,
      kb_name: payload.kb_name,
    });
    return c.json({
      success: true,
      summary,
      record: result.record,
      added_to_notebooks: result.added_to_notebooks,
    });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// POST /api/notebooks/actions/add-record-with-summary — SSE stream.
coWriterRouter.post("/api/notebooks/actions/add-record-with-summary", async (c) => {
  const payload = addRecordPayload(await readJson(c));

  async function* events(): AsyncGenerator<string, void, unknown> {
    try {
      const agent = new NotebookSummarizeAgent(
        String(payload.metadata["ui_language"] ?? "en"),
      );
      const summaryParts: string[] = [];
      if (payload.summary.trim()) {
        const summary = cleanThinkingTags(payload.summary).trim();
        summaryParts.push(summary);
        if (summary) {
          for (const frame of sseFrames({
            type: "summary_chunk",
            content: summary,
          })) {
            yield frame;
          }
        }
      } else {
        for await (const chunk of agent.stream_summary({
          title: payload.title,
          record_type: payload.record_type,
          user_query: payload.user_query,
          output: payload.output,
          metadata: payload.metadata,
        })) {
          if (!chunk) continue;
          summaryParts.push(chunk);
        }
        const streamed = cleanThinkingTags(summaryParts.join("")).trim();
        if (streamed) {
          for (const frame of sseFrames({
            type: "summary_chunk",
            content: streamed,
          })) {
            yield frame;
          }
        }
      }

      const summary = cleanThinkingTags(summaryParts.join("")).trim();
      const result = manager().add_record({
        notebook_ids: payload.notebook_ids,
        record_type: payload.record_type as RecordType,
        title: payload.title,
        summary,
        user_query: payload.user_query,
        output: payload.output,
        metadata: payload.metadata,
        kb_name: payload.kb_name,
      });
      for (const frame of sseFrames({
        type: "result",
        success: true,
        summary,
        record: result.record,
        added_to_notebooks: result.added_to_notebooks,
      })) {
        yield frame;
      }
    } catch (exc) {
      if (exc instanceof NotebookCorruptedError) {
        for (const frame of sseFrames({ type: "error", detail: _unreadable(exc).message })) {
          yield frame;
        }
        return;
      }
      for (const frame of sseFrames({ type: "error", detail: errDetail(exc) })) {
        yield frame;
      }
    }
  }

  return sseResponse(events());
});

// GET /api/notebooks/records/{record_id}/location — literal, above :notebook_id.
coWriterRouter.get("/api/notebooks/records/:record_id/location", (c) => {
  const recordId = c.req.param("record_id");
  const notebookId = c.req.query("notebook_id") ?? "";
  let location: string | null;
  try {
    location = manager().locate_record(recordId, notebookId);
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
  if (location === null) {
    httpError(404, "Favorite not found");
  }
  return c.json({ notebook_id: location, record_id: recordId });
});

// GET /api/notebooks/{notebook_id}
coWriterRouter.get("/api/notebooks/:notebook_id", (c) => {
  const notebookId = c.req.param("notebook_id");
  let notebook: Dict | null;
  try {
    notebook = manager().get_notebook(notebookId);
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
  if (!notebook) httpError(404, "Notebook not found");
  return c.json(notebook);
});

// PUT /api/notebooks/{notebook_id}
coWriterRouter.put("/api/notebooks/:notebook_id", async (c) => {
  const notebookId = c.req.param("notebook_id");
  const body = await readJson(c);
  try {
    const notebook = manager().update_notebook(notebookId, {
      name: optStrOrNull(body, "name") ?? null,
      description: optStrOrNull(body, "description") ?? null,
      color: optStrOrNull(body, "color") ?? null,
      icon: optStrOrNull(body, "icon") ?? null,
    });
    if (!notebook) httpError(404, "Notebook not found");
    return c.json({ success: true, notebook });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// DELETE /api/notebooks/{notebook_id}
coWriterRouter.delete("/api/notebooks/:notebook_id", (c) => {
  const notebookId = c.req.param("notebook_id");
  try {
    const success = manager().delete_notebook(notebookId);
    if (!success) httpError(404, "Notebook not found");
    return c.json({
      success: true,
      message: "Notebook deleted successfully",
    });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// DELETE /api/notebooks/{notebook_id}/records/{record_id}
coWriterRouter.delete("/api/notebooks/:notebook_id/records/:record_id", (c) => {
  const notebookId = c.req.param("notebook_id");
  const recordId = c.req.param("record_id");
  try {
    const success = manager().remove_record(notebookId, recordId);
    if (!success) httpError(404, "Record not found");
    return c.json({ success: true, message: "Record removed successfully" });
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
});

// PUT /api/notebooks/{notebook_id}/records/{record_id}
coWriterRouter.put(
  "/api/notebooks/:notebook_id/records/:record_id",
  async (c) => {
    const notebookId = c.req.param("notebook_id");
    const recordId = c.req.param("record_id");
    const body = await readJson(c);
    try {
      // Forward only what the client actually sent. Passing every field
      // unconditionally would hand `kb_name=null` to the service on every
      // request and clear the record's knowledge-base link as a side effect
      // of renaming it; the service's sentinel default only works if an
      // omitted field never reaches it.
      const changes: Record<string, unknown> = {};
      for (const key of [
        "title",
        "summary",
        "user_query",
        "output",
        "metadata",
        "kb_name",
      ] as const) {
        if (body[key] !== undefined) changes[key] = body[key];
      }
      if ("output" in changes || "user_query" in changes) {
        httpError(
          400,
          "Favorites preserve their original content. Add this record to a note to edit it.",
        );
      }
      if (Object.keys(changes).length === 0) {
        httpError(400, "No fields to update");
      }
      if ("metadata" in changes) {
        changes["metadata"] = optDict(body, "metadata");
      }
      for (const key of ["title", "summary", "user_query", "output"] as const) {
        if (key in changes && changes[key] !== null && typeof changes[key] !== "string") {
          httpError(422, `${key} must be a string or null`);
        }
      }
      if (
        "kb_name" in changes &&
        changes["kb_name"] !== null &&
        typeof changes["kb_name"] !== "string"
      ) {
        httpError(422, "kb_name must be a string or null");
      }
      const updated = manager().update_record(notebookId, recordId, {
        title: changes["title"] as string | null | undefined,
        summary: changes["summary"] as string | null | undefined,
        user_query: changes["user_query"] as string | null | undefined,
        output: changes["output"] as string | null | undefined,
        metadata: changes["metadata"] as Dict | null | undefined,
        kb_name:
          "kb_name" in changes
            ? ((changes["kb_name"] ?? null) as string | null)
            : (undefined as never),
      });
      if (!updated) httpError(404, "Record not found");
      return c.json({ success: true, record: updated });
    } catch (exc) {
      if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
      throw exc;
    }
  },
);

// POST /api/notebooks/{notebook_id}/records/{record_id}/actions/copy
coWriterRouter.post(
  "/api/notebooks/:notebook_id/records/:record_id/actions/copy",
  async (c) => {
    const body = await readJson(c);
    const target = String(body["target_notebook_id"] ?? "");
    try {
      const copied = manager().copy_record(
        c.req.param("notebook_id"),
        c.req.param("record_id"),
        target,
      );
      if (!copied) {
        httpError(404, "Record or target notebook not found");
      }
      return c.json({ success: true, record: copied });
    } catch (exc) {
      if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
      throw exc;
    }
  },
);

// POST /api/notebooks/{notebook_id}/records/{record_id}/actions/move
coWriterRouter.post(
  "/api/notebooks/:notebook_id/records/:record_id/actions/move",
  async (c) => {
    const body = await readJson(c);
    const target = String(body["target_notebook_id"] ?? "");
    try {
      const moved = manager().move_record(
        c.req.param("notebook_id"),
        c.req.param("record_id"),
        target,
      );
      if (!moved) {
        httpError(404, "Record or target notebook not found");
      }
      return c.json({ success: true, record: moved });
    } catch (exc) {
      if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
      if (exc instanceof NotebookMoveConflictError) {
        httpError(409, errDetail(exc));
      }
      throw exc;
    }
  },
);

// GET /api/notebooks/{notebook_id}/export — whole notebook as Markdown.
coWriterRouter.get("/api/notebooks/:notebook_id/export", (c) => {
  const notebookId = c.req.param("notebook_id");
  let markdown: string | null;
  try {
    markdown = manager().export_markdown(notebookId);
  } catch (exc) {
    if (exc instanceof NotebookCorruptedError) throw _unreadable(exc);
    throw exc;
  }
  if (markdown === null) httpError(404, "Notebook not found");
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${notebookId}.md"`,
    },
  });
});

export { coWriterRouter };
export default coWriterRouter;
