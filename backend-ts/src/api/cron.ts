/**
 * REST surface for scheduled reminders and review cards.
 *
 * Mounted at ``/api/cron`` (and ``/api/reviews``) and reused by the calendar
 * page, the composer's "Remind me" control, and the reminder runtime.
 * Everything is scoped to the request's content workspace (``dt_workspace``),
 * matching the calendar.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Context } from "hono";

import {
  getCronService,
  ownerKey as jobOwnerKey,
} from "../services/cron/service.js";
import type { CronOwner, CronSchedule } from "../services/cron/service.js";
import * as cronReports from "../services/cron/reports.js";
import { owner_key } from "../services/calendar/layers.js";
import { dueBetween, grade, summary } from "../services/reviews.js";

const ownerKey = owner_key;

export const cronRouter = new Hono();

function workspace(c: Context): string {
  const params = c.req.query();
  let value = params.dt_workspace;
  if (value === undefined) value = params.workspace;
  return value || "";
}

// -- CreateJob (pydantic: extra="forbid") --------------------------------------

interface CreateJobBody {
  message: string;
  name: string;
  at: string;
  every_seconds: number;
  cron_expr: string;
  tz: string;
  session_id: string;
  workspace_id: string;
}

const JOB_FIELDS = new Set([
  "message",
  "name",
  "at",
  "every_seconds",
  "cron_expr",
  "tz",
  "session_id",
  "workspace_id",
]);

async function parseCreateJob(c: Context): Promise<CreateJobBody> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(422, { message: "Invalid JSON body" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HTTPException(422, { message: "Expected a JSON object" });
  }
  const raw = body as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!JOB_FIELDS.has(key)) {
      throw new HTTPException(422, { message: `Extra inputs are not permitted: ${key}` });
    }
  }
  const str = (k: string): string => {
    const v = raw[k];
    return v === undefined || v === null ? "" : String(v);
  };
  const message = str("message");
  if (message.length < 1 || message.length > 2000) {
    throw new HTTPException(422, { message: "message must be 1 to 2000 characters" });
  }
  const everyRaw = raw.every_seconds;
  const everySeconds = everyRaw === undefined || everyRaw === null ? 0 : Number(everyRaw);
  if (!Number.isInteger(everySeconds)) {
    throw new HTTPException(422, { message: "every_seconds must be an integer" });
  }
  return {
    message,
    name: str("name"),
    at: str("at"),
    every_seconds: everySeconds,
    cron_expr: str("cron_expr"),
    tz: str("tz"),
    session_id: str("session_id"),
    workspace_id: str("workspace_id"),
  };
}

function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

function buildSchedule(payload: CreateJobBody): CronSchedule {
  const chosen = [
    payload.at.trim() !== "",
    Boolean(payload.every_seconds),
    payload.cron_expr.trim() !== "",
  ];
  if (chosen.filter(Boolean).length !== 1) {
    badRequest("Provide exactly one of: at, every_seconds or cron_expr.");
  }
  if (payload.at.trim()) {
    // Python datetime.fromisoformat; JS Date parses ISO 8601. A bare date
    // ("2026-06-12") is UTC midnight in JS but local midnight after
    // astimezone() in Python — append T00:00:00 to match. A space separator
    // ("2026-06-12 09:00") is also accepted by fromisoformat.
    // TODO(verify): confirm the ported runtime treats naive ISO as local time.
    let text = payload.at.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) text += "T00:00:00";
    else text = text.replace(" ", "T");
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) {
      badRequest("at must be ISO 8601, e.g. 2026-06-12T09:00");
    }
    // Naive input -> JS Date is already local time, matching astimezone().
    return { kind: "at", at_ms: Math.trunc(parsed.getTime()) };
  }
  if (payload.every_seconds) {
    return { kind: "every", every_seconds: Math.trunc(payload.every_seconds) };
  }
  return {
    kind: "cron",
    expr: payload.cron_expr.trim(),
    tz: payload.tz.trim() || null,
  };
}

// -- job payload ---------------------------------------------------------------

interface CronJobLike {
  id: string;
  name: string;
  message: string;
  schedule: {
    kind: string;
    at_ms?: number | null;
    every_seconds?: number | null;
    expr?: string | null;
    tz?: string | null;
  };
  owner: { session_id?: string; workspace_id?: string; [k: string]: unknown };
  enabled?: boolean;
  state: {
    next_run_at_ms?: number | null;
    last_status?: string | null;
    last_error?: string | null;
  };
}

function jobPayload(job: CronJobLike): Record<string, unknown> {
  return {
    id: job.id,
    name: job.name,
    message: job.message,
    kind: job.schedule.kind,
    at_ms: job.schedule.at_ms ?? null,
    every_seconds: job.schedule.every_seconds ?? null,
    expr: job.schedule.expr ?? null,
    tz: job.schedule.tz ?? null,
    enabled: job.enabled ?? true,
    session_id: job.owner.session_id || "",
    workspace_id: job.owner.workspace_id || "",
    next_run_at_ms: job.state.next_run_at_ms ?? null,
    last_status: job.state.last_status ?? null,
    last_error: job.state.last_error ?? null,
  };
}

// TODO(verify): assumes the ported CronJob keeps snake_case schedule/state
// fields (at_ms, next_run_at_ms, ...); adjust if camelCased.

function queryLimit(c: Context, fallback = 20): number {
  const raw = c.req.query("limit");
  const n = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new HTTPException(422, { message: "Invalid value for limit" });
  }
  return n;
}

// -- routes ---------------------------------------------------------------------
// NOTE: Python mounts this router without a prefix; paths are absolute.

cronRouter.get("/api/cron/jobs", (c) => {
  const service = getCronService();
  const jobs = service
    .listJobs(ownerKey())
    .filter((job) => (job.owner.workspace_id ?? "") === workspace(c));
  return c.json({ jobs: jobs.map((job) => jobPayload(job as CronJobLike)) });
});

cronRouter.post("/api/cron/jobs", async (c) => {
  const payload = await parseCreateJob(c);
  let job;
  try {
    const schedule = buildSchedule(payload);
    job = getCronService().addJob({
      name: payload.name,
      message: payload.message,
      schedule,
      owner: {
        kind: "chat",
        session_id: payload.session_id.trim(),
        workspace_id: payload.workspace_id.trim() || workspace(c),
      } as CronOwner,
    });
  } catch (e) {
    if (e instanceof HTTPException) throw e;
    // validateSchedule/addJob raise plain Errors for bad schedules;
    // Python mapped ValueError -> 400.
    throw new HTTPException(400, { message: e instanceof Error ? e.message : String(e) });
  }
  return c.json({ job: jobPayload(job as CronJobLike), ok: true }, 201);
});

cronRouter.delete("/api/cron/jobs/:job_id", (c) => {
  const service = getCronService();
  const jobId = c.req.param("job_id");
  const job = service.getJob(jobId);
  const owner = job?.owner as { kind?: string; workspace_id?: string } | undefined;
  // Python compares job.owner.key (a property) to owner_key(); the port
  // exposes ownerKey(owner) — same computation.
  const key = job ? jobOwnerKey(job.owner) : "";
  if (
    !job ||
    key !== ownerKey() ||
    owner?.kind !== "chat" ||
    owner?.workspace_id !== workspace(c)
  ) {
    throw new HTTPException(404, { message: "Reminder not found." });
  }
  const ok = service.cancelJob(jobId, ownerKey());
  return c.json({ ok });
});

cronRouter.get("/api/cron/reports", (c) => {
  /** Reminders that fired, for live delivery to open tabs. */
  const since = Number(c.req.query("since") ?? "0");
  const limit = queryLimit(c, 20);
  if (!Number.isFinite(since) || since < 0) {
    throw new HTTPException(422, { message: "Invalid value for since" });
  }
  const reports = cronReports.since(since);
  return c.json({ reports: reports.slice(-limit) });
});

cronRouter.get("/api/reviews/due", (c) => {
  const limit = queryLimit(c, 20);
  const now = Date.now() / 1000;
  return c.json({
    due: dueBetween(now, now + 86400 * 30).slice(0, limit),
    summary: summary(),
  });
});

cronRouter.post("/api/reviews/:key/grade", (c) => {
  const key = c.req.param("key");
  const correctRaw = c.req.query("correct");
  const correct = correctRaw === undefined ? true : correctRaw !== "false" && correctRaw !== "0";
  try {
    const card = grade(key, correct);
    return c.json({ ok: true, card });
  } catch (e) {
    // TODO(verify): Python mapped KeyError -> 404; the ported grade() throws a
    // plain Error with an "unknown review key" message.
    if (e instanceof Error && /unknown review key/i.test(e.message)) {
      throw new HTTPException(404, { message: "Review card not found." });
    }
    throw e;
  }
});
