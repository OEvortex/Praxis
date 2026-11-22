// Read-only projections of the selected workspace onto calendar days.
//
// *Reviews* are due flashcards from the question bank (spaced repetition),
// *automations* are scheduled reminders from the cron service, and *footprints*
// — the days the learner actually studied — are derived from session
// transcripts.
//
// NOTE: the Python version imports the reviews/cron/session services lazily
// inside try/except so a broken store degrades to empty layers. The TS port
// keeps those stores behind static imports plus the same try/except
// degradation inside each helper; `read_layers` is async to match the
// Python signature.

import { get_settings } from "../../config.js";
import type { Settings } from "../../config.js";
import { SessionStore } from "../../store/session_store.js";
import { computeNextRun, getCronService } from "../cron/service.js";
import type { CronJob } from "../cron/service.js";
import { dueBetween } from "../reviews.js";
import { format_instant, utcToWall, zone } from "./recurrence.js";
import type {
  AutomationRun,
  CalendarLayers,
  FootprintDay,
  FootprintSession,
  ReviewDay,
  ReviewPathCount,
} from "./models.js";

const MAX_SESSIONS_PER_DAY = 20;
const MAX_AUTOMATIONS = 1000;

export function owner_key(): string {
  /** One stable owner for locally scheduled jobs (single-user deployment). */
  return "chat:local-admin";
}

interface ReviewCard {
  due_at: number | string;
  topic?: string | null;
}

async function reviews(lo: number, hi: number): Promise<ReviewDay[]> {
  /** Due flashcards per local day, grouped by their bank. */
  let cards: ReviewCard[];
  try {
    cards = dueBetween(lo, hi);
  } catch {
    return []; // a broken review store must not break the calendar
  }
  const days = new Map<string, ReviewDay>();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  for (const card of cards) {
    const wall = utcToWall(Number(card.due_at) * 1000, tz);
    const key = new Date(wall).toISOString().slice(0, 10);
    let day = days.get(key);
    if (!day) {
      day = { date: key, mastery: 0, practice: 0, paths: [] };
      days.set(key, day);
    }
    day.mastery += 1;
    const topic = (card.topic as string | undefined) || "Question bank";
    const existing = day.paths.find((p) => p.title === topic);
    if (!existing) day.paths.push({ id: topic, title: topic, count: 1 });
    else existing.count += 1;
  }
  return [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function automations(workspace_id: string, lo: number, hi: number): Promise<AutomationRun[]> {
  /** Expand this workspace's enabled jobs into the days they will run on. */
  let service: { listJobs: (owner: string) => CronJob[] };
  try {
    service = getCronService();
  } catch {
    return []; // a broken cron store must not break the calendar
  }
  const compute_next_run = computeNextRun;

  const runs: AutomationRun[] = [];
  const nowMs = Date.now();
  const lower = Math.max(Math.floor(lo * 1000), nowMs);
  for (const job of service.listJobs(owner_key())) {
    if (job.owner.workspace_id !== workspace_id || !job.enabled) continue;
    let at = job.state.next_run_at_ms;
    if (at === null || at === undefined) continue;
    if (at < lower) {
      if (job.schedule.kind === "every" && job.schedule.every_seconds) {
        const step = job.schedule.every_seconds * 1000;
        at += Math.max(0, Math.ceil((lower - at) / step)) * step;
      } else {
        at = compute_next_run(job.schedule, lower - 1) ?? undefined;
        if (at === undefined) continue;
      }
    }
    for (let i = 0; i < MAX_AUTOMATIONS; i++) {
      if (at === null || at === undefined || at >= hi * 1000) break;
      runs.push({
        id: `${job.id}:${at}`,
        job_id: job.id,
        name: job.name,
        message: job.message,
        at: format_instant(at),
        kind: job.schedule.kind as AutomationRun["kind"],
        expr: job.schedule.expr ?? null,
        every_seconds: job.schedule.every_seconds ?? null,
        session_id: job.owner.session_id ?? null,
        enabled: job.enabled,
      });
      const next = compute_next_run(job.schedule, at);
      at = next === null ? null : next;
      if (at === null) break;
    }
  }
  return runs;
}

interface SessionLike {
  id: string;
  title?: string;
  preferences?: { workspace_id?: string } | null;
  messages?: { role?: string; created_at?: unknown }[] | null;
}

async function session_store_all(settings: Settings): Promise<SessionLike[]> {
  try {
    return new SessionStore(settings).all() as SessionLike[];
  } catch {
    return []; // a corrupt or missing session store must not break the calendar
  }
}

export async function read_layers(
  workspace_id: string,
  startMs: number,
  endMs: number,
  tzid: string,
): Promise<CalendarLayers> {
  /**
   * Project this workspace's study activity onto days in `tzid`.
   * `startMs`/`endMs` are UTC epoch ms (inclusive lower, exclusive upper bound).
   */
  zone(tzid);
  const lo = startMs / 1000;
  const hi = endMs / 1000;
  const footprints = new Map<string, FootprintDay>();

  const settings = get_settings();
  const sessions = await session_store_all(settings);

  for (const session of sessions) {
    const workspace = session.preferences?.workspace_id || "";
    if (workspace !== workspace_id) continue;
    const title = String(session.title ?? "");
    for (const message of session.messages ?? []) {
      if (message.role !== "user") continue;
      const stamp = message.created_at;
      if (typeof stamp !== "number" || !Number.isFinite(stamp)) continue;
      if (!(stamp >= lo && stamp < hi)) continue;
      const wall = utcToWall(stamp * 1000, tzid);
      const key = new Date(wall).toISOString().slice(0, 10);
      let day = footprints.get(key);
      if (!day) {
        day = { date: key, session_count: 0, sessions: [], practice_reviews: 0, mastery_evidence: 0 };
        footprints.set(key, day);
      }
      if (!day.sessions.some((e) => e.id === session.id)) {
        if (day.sessions.length < MAX_SESSIONS_PER_DAY) {
          day.sessions.push({ id: session.id, title } satisfies FootprintSession);
        }
        day.session_count += 1;
      }
    }
  }

  const [reviewDays, automationRuns] = await Promise.all([
    reviews(lo, hi),
    automations(workspace_id, lo, hi),
  ]);

  return {
    workspace_id,
    reviews: reviewDays,
    automations: automationRuns,
    footprints: [...footprints.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
  };
}
