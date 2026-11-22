/**
 * Authenticated account calendar and workspace-local learning overlays.
 * Port of backend/app/api/calendar.py — mounted at ``/api/calendar``.
 *
 * The wire contract follows RFC 5545: all-day events carry plain dates with an
 * exclusive end, timed events carry UTC instants. Everything lives in the
 * shared ``data/praxis.sqlite3`` database.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

import { parse_instant, zone } from "../services/calendar/recurrence.js";
import { ics_filename, render_calendar } from "../services/calendar/ics.js";
import { owner_key, read_layers } from "../services/calendar/layers.js";
import { get_calendar_store } from "../services/calendar/store.js";
import { ownerKey as cronOwnerKey, getCronService } from "../services/cron/service.js";
import type * as m from "../services/calendar/models.js";

export const calendarRouter = new Hono();

const UNSAFE = /[^\w.\- ]+/g;
const DAY_MS = 24 * 60 * 60 * 1000;

// -- error mapping (Python `errors()` context manager) ------------------------

function mapError(e: unknown): never {
  if (e instanceof HTTPException) throw e;
  const name = e instanceof Error ? e.name : "";
  const message = e instanceof Error ? e.message : String(e);
  // TODO(verify): depends on how the ported store/models signal
  // KeyError / pydantic ValidationError / ValueError.
  if (name === "KeyError" || name === "NotFoundError" || name === "CalendarNotFound") {
    throw new HTTPException(404, { message: "Calendar item not found." });
  }
  if (name === "ValidationError" || name === "ZodError") {
    throw new HTTPException(422, { message });
  }
  if (name === "ValueError" || name === "RangeError") {
    throw new HTTPException(400, { message });
  }
  throw e;
}

function withErrors<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    mapError(e);
  }
}

async function withErrorsAsync<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    mapError(e);
  }
}

// -- helpers ------------------------------------------------------------------

function bounds(start: string, end: string, tz: string): [number, number] {
  return withErrors(() => {
    const first = parse_instant(start);
    const last = parse_instant(end);
    zone(tz);
    const span = last - first;
    if (!(span > 0) || span > 400 * DAY_MS) {
      // Named so mapError maps it to 400 like Python's ValueError.
      const e = new Error("Choose a range between one second and 400 days.");
      e.name = "ValueError";
      throw e;
    }
    return [first, last];
  });
}

/** The content workspace this request is scoped to; ``""`` is General. */
function boardWorkspace(c: Context): string {
  const params = c.req.query();
  let value = params.dt_workspace;
  if (value === undefined) value = params.workspace;
  if (value === undefined) value = c.req.header("x-dt-workspace") ?? "";
  return value || "";
}

/** RFC 6266 header; the plain name is a fallback for non-UTF-8 clients. */
function contentDisposition(filename: string, disposition = "attachment"): string {
  const clean = filename.replace(UNSAFE, "-").replace(/^[ .]+|[ .]+$/g, "") || "file";
  const quoted = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `${disposition}; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

function queryInt(
  c: Context,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = c.req.query(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new HTTPException(422, { message: `Invalid value for ${name}` });
  }
  return n;
}

function requiredQuery(c: Context, name: string): string {
  return c.req.query(name) ?? "";
}

// -- routes -------------------------------------------------------------------

calendarRouter.get("/api/calendar/export.ics", (c) => {
  const calendarId = c.req.query("calendar_id") ?? undefined;
  const store = get_calendar_store();
  const { calendars, events } = withErrors(() =>
    store.export(calendarId ?? null),
  );
  let name: string;
  let filename: string;
  if (calendarId === undefined) {
    name = "Praxis";
    filename = "praxis.ics";
  } else {
    const first = (calendars as { name?: string }[])[0];
    name = (first?.name ?? "").trim() || "calendar";
    filename = ics_filename(name);
  }
  const body = withErrors(() =>
    render_calendar(calendars, events, { calendar_name: name }),
  );
  return c.body(body, 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": contentDisposition(filename, "attachment"),
  });
});

calendarRouter.get("/api/calendar/calendars", (c) => {
  const store = get_calendar_store();
  return c.json(withErrors(() => store.calendars()) as never);
});

calendarRouter.post("/api/calendar/calendars", async (c) => {
  const payload = (await c.req.json()) as m.CreateCalendar;
  const result = withErrors(() =>
    get_calendar_store().create_calendar(payload),
  );
  return c.json(result as never, 201);
});

calendarRouter.patch("/api/calendar/calendars/:id", async (c) => {
  const payload = (await c.req.json()) as m.UpdateCalendar;
  const result = withErrors(() =>
    get_calendar_store().update_calendar(c.req.param("id"), payload),
  );
  return c.json(result as never);
});

calendarRouter.delete("/api/calendar/calendars/:id", (c) => {
  const result = withErrors(() =>
    get_calendar_store().delete_calendar(c.req.param("id")),
  );
  return c.json(result as never);
});

calendarRouter.get("/api/calendar/events", (c) => {
  const start = requiredQuery(c, "start");
  const end = requiredQuery(c, "end");
  const tz = c.req.query("tz") ?? "UTC";
  const [first, last] = bounds(start, end, tz);
  const result = withErrors(() =>
    get_calendar_store().occurrences(first, last, tz),
  );
  return c.json(result as never);
});

calendarRouter.post("/api/calendar/events", async (c) => {
  const payload = (await c.req.json()) as m.EventInput;
  const result = withErrors(() =>
    get_calendar_store().create(payload),
  );
  return c.json(result as never, 201);
});

calendarRouter.patch("/api/calendar/events/:id", async (c) => {
  const payload = (await c.req.json()) as m.EventPatchRequest;
  const result = withErrors(() =>
    get_calendar_store().update(c.req.param("id"), payload),
  );
  return c.json(result as never);
});

calendarRouter.delete("/api/calendar/events/:id", (c) => {
  const scope = (c.req.query("scope") ?? "all") as m.Scope;
  const occurrence = c.req.query("occurrence") ?? undefined;
  const result = withErrors(() =>
    get_calendar_store().delete(c.req.param("id"), scope, occurrence),
  );
  return c.json(result as never);
});

calendarRouter.post("/api/calendar/undo/:token", (c) => {
  const result = withErrors(() =>
    get_calendar_store().restore(c.req.param("token")),
  );
  return c.json(result as never);
});

calendarRouter.get("/api/calendar/search", (c) => {
  const q = requiredQuery(c, "q");
  if (q.length < 1 || q.length > 200) {
    throw new HTTPException(422, { message: "Invalid value for q" });
  }
  const limit = queryInt(c, "limit", 50, 1, 100);
  const result = withErrors(() =>
    get_calendar_store().search(q, limit),
  );
  return c.json(result as never);
});

calendarRouter.get("/api/calendar/layers", async (c) => {
  const start = requiredQuery(c, "start");
  const end = requiredQuery(c, "end");
  const tz = c.req.query("tz") ?? "UTC";
  const [first, last] = bounds(start, end, tz);
  return c.json((await read_layers(boardWorkspace(c), first, last, tz)) as never);
});

calendarRouter.delete("/api/calendar/automations/:job_id", async (c) => {
  /** Cancel a scheduled reminder created from this workspace's chat. */
  const service = getCronService();
  const jobId = c.req.param("job_id");
  const job = await withErrorsAsync(() => service.getJob(jobId));
  const owner = job?.owner as { kind?: string; workspace_id?: string } | undefined;
  // CronOwner.key is a @property in Python; the port computes it via
  // ownerKey(owner) in services/cron/service.ts — equivalent comparison.
  const key = job ? cronOwnerKey(job.owner) : "";
  if (
    !job ||
    key !== owner_key() ||
    owner?.kind !== "chat" ||
    owner?.workspace_id !== boardWorkspace(c)
  ) {
    throw new HTTPException(404, { message: "Automation not found." });
  }
  const ok = await withErrorsAsync(() => service.cancelJob(jobId, owner_key()));
  return c.json({ ok } as never);
});

calendarRouter.get("/api/calendar/stream", (c) => {
  const store = get_calendar_store();

  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          cancelled = true;
        }
      };
      let revision = -1;
      let tick = 0;
      try {
        while (!cancelled) {
          const current = store.revision();
          if (current !== revision) {
            revision = current;
            push(`id: ${revision}\ndata: {"revision":${revision}}\n\n`);
          } else if (tick % 30 === 0) {
            push(": heartbeat\n\n");
          }
          tick += 1;
          await new Promise((r) => setTimeout(r, 500));
        }
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return c.body(body, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Content-Encoding": "identity",
    "X-Accel-Buffering": "no",
  });
});

calendarRouter.get("/api/calendar/task-blocks", (c) => {
  const result = get_calendar_store().task_blocks(boardWorkspace(c));
  return c.json(result as never);
});
