// Port of backend/app/services/cron/service.py — built-in cron service:
// scheduled tasks for chat, with a WAL SQLite repository and an in-process
// scheduler (the Python version used asyncio; here it is a Node timer loop).
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Settings } from "../../config.js";
import { get_settings } from "../../config.js";
import type { CronRepository, CronPayload } from "./repository.js";
import { SQLiteCronRepository } from "./repository.js";
import { nextCronRunMs, isValidTimeZone } from "./cronexpr.js";
import { executeJob } from "./executor.js";

const MAX_SLEEP_SECONDS = 60.0;
const MAX_RUN_HISTORY = 10;

function nowMs(): number {
  return Date.now();
}

function newJobId(): string {
  // uuid.uuid4().hex[:10]
  return randomBytes(5).toString("hex");
}

// -- dataclasses ------------------------------------------------------------

export interface CronSchedule {
  kind: string; // "at" | "every" | "cron"
  at_ms?: number | null;
  every_seconds?: number | null;
  expr?: string | null;
  tz?: string | null;
}

export interface CronOwner {
  kind: string; // "chat" | "partner"
  session_id?: string;
  workspace_id?: string;
  language?: string;
  partner_id?: string;
  channel?: string;
  chat_id?: string;
  session_key?: string;
  channel_meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export function ownerKey(owner: CronOwner): string {
  if (owner.kind === "partner") return `partner:${owner.partner_id ?? ""}`;
  return "chat:local-admin";
}

const OWNER_FIELDS = new Set([
  "kind", "session_id", "workspace_id", "language", "partner_id",
  "channel", "chat_id", "session_key", "channel_meta",
]);

export interface CronRunRecord {
  run_at_ms: number;
  status: string; // "ok" | "error" | "skipped"
  duration_ms?: number;
  error?: string | null;
}

export interface CronJobState {
  next_run_at_ms?: number | null;
  last_run_at_ms?: number | null;
  last_status?: string | null;
  last_error?: string | null;
  run_history?: CronRunRecord[];
}

export interface CronJob {
  id: string;
  name: string;
  message: string;
  schedule: CronSchedule;
  owner: CronOwner;
  enabled?: boolean;
  delete_after_run?: boolean;
  created_at_ms?: number;
  state: CronJobState;
  [k: string]: unknown;
}

export function cronJobFromDict(data: Record<string, unknown>): CronJob {
  const state = { ...((data.state as Record<string, unknown>) ?? {}) };
  const rawHistory = state.run_history;
  state.run_history = (Array.isArray(rawHistory) ? rawHistory : [])
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((record) => ({
      run_at_ms: Number(record.run_at_ms ?? 0) || 0,
      status: String(record.status ?? ""),
      duration_ms: Number(record.duration_ms ?? 0) || 0,
      error: record.error == null ? null : String(record.error),
    }));
  const rawSchedule = data.schedule;
  const rawOwner = data.owner;
  const schedule: CronSchedule =
    rawSchedule && typeof rawSchedule === "object" && !Array.isArray(rawSchedule)
      ? { ...(rawSchedule as CronSchedule) }
      : { kind: "every" };
  let owner: CronOwner;
  if (rawOwner && typeof rawOwner === "object" && !Array.isArray(rawOwner)) {
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawOwner as Record<string, unknown>)) {
      if (OWNER_FIELDS.has(key)) filtered[key] = value;
    }
    owner = filtered as unknown as CronOwner;
  } else {
    owner = { kind: "chat" };
  }
  return {
    ...data,
    id: String(data.id),
    name: String(data.name ?? ""),
    message: String(data.message ?? ""),
    schedule,
    owner,
    enabled: data.enabled !== false,
    delete_after_run: Boolean(data.delete_after_run ?? false),
    created_at_ms: Number(data.created_at_ms ?? 0) || 0,
    state: state as CronJobState,
  };
}

// Python ``dataclasses.asdict(job)`` — deep-plain-object serialization.
function jobToDict(job: CronJob): CronPayload {
  return JSON.parse(JSON.stringify(job)) as CronPayload;
}

// -- schedule math ------------------------------------------------------------

/** Next due time in epoch ms, or null for never/expired. */
export function computeNextRun(schedule: CronSchedule, nowMsValue: number): number | null {
  if (schedule.kind === "at") {
    if (schedule.at_ms && schedule.at_ms > nowMsValue) return schedule.at_ms;
    return null;
  }

  if (schedule.kind === "every") {
    const secs = Number(schedule.every_seconds ?? 0);
    if (!secs || secs <= 0) return null;
    return nowMsValue + secs * 1000;
  }

  if (schedule.kind === "cron" && schedule.expr) {
    try {
      const next = nextCronRunMs(schedule.expr, nowMsValue, schedule.tz);
      return next;
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      throw new Error(`invalid cron expression '${schedule.expr}': ${msg}`);
    }
  }

  return null;
}

export function validateSchedule(schedule: CronSchedule): void {
  if (schedule.kind === "at") {
    if (!schedule.at_ms) throw new Error("'at' schedules need a time");
    if (schedule.at_ms <= nowMs()) throw new Error("'at' time is in the past");
    return;
  }
  if (schedule.kind === "every") {
    const secs = Number(schedule.every_seconds ?? 0);
    if (!secs || secs < 30) throw new Error("'every' interval must be at least 30 seconds");
    return;
  }
  if (schedule.kind === "cron") {
    if (schedule.tz && !isValidTimeZone(schedule.tz)) {
      throw new Error(`unknown timezone '${schedule.tz}'`);
    }
    let next: number | null;
    try {
      next = computeNextRun(schedule, nowMs());
    } catch {
      throw new Error(`cron expression '${schedule.expr ?? ""}' never fires`);
    }
    if (next === null) {
      throw new Error(`cron expression '${schedule.expr ?? ""}' never fires`);
    }
    return;
  }
  throw new Error(`unknown schedule kind '${schedule.kind}'`);
}

// -- service -------------------------------------------------------------------

export type OnJob = (job: CronJob) => Promise<[string, string | null]>;

export class CronService {
  readonly storePath: string | null;
  readonly repository: CronRepository;
  readonly onJob: OnJob | null;
  readonly changeNotifier: (() => void) | null;

  private jobs = new Map<string, CronJob>();
  private loaded = false;
  private loadedRevision = -1;
  private running = false;
  private wakeResolve: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(
    storePath?: string | null,
    onJob?: OnJob | null,
    options?: {
      repository?: CronRepository | null;
      legacyStorePath?: string | null;
      changeNotifier?: (() => void) | null;
    },
  ) {
    let repository = options?.repository ?? null;
    if (!repository) {
      if (storePath == null) throw new Error("store_path or repository is required");
      repository = new SQLiteCronRepository(storePath, options?.legacyStorePath ?? null);
    }
    this.storePath = storePath != null ? storePath : null;
    this.repository = repository;
    this.onJob = onJob ?? null;
    this.changeNotifier = options?.changeNotifier ?? null;
  }

  // -- persistence ---------------------------------------------------------

  private load(force = false): void {
    const revision = this.repository.revision();
    if (this.loaded && !force && revision === this.loadedRevision) return;
    this.loaded = true;
    this.jobs = new Map();
    for (const raw of this.repository.listPayloads()) {
      const job = cronJobFromDict(raw as Record<string, unknown>);
      this.jobs.set(job.id, job);
    }
    this.loadedRevision = revision;
  }

  private changed(): void {
    this.loadedRevision = this.repository.revision();
    this.wake();
    this.changeNotifier?.();
  }

  private wake(): void {
    const resolve = this.wakeResolve;
    this.wakeResolve = null;
    resolve?.();
  }

  private waitWake(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeResolve = null;
        resolve();
      }, Math.max(1, timeoutMs));
      this.wakeResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // -- job management --------------------------------------------------------

  addJob(args: {
    name: string;
    message: string;
    schedule: CronSchedule;
    owner: CronOwner;
    delete_after_run?: boolean | null;
  }): CronJob {
    this.load();
    validateSchedule(args.schedule);
    if (!args.message.trim()) throw new Error("message is required");
    const job: CronJob = {
      id: newJobId(),
      name: args.name.trim() || args.message.trim().slice(0, 48),
      message: args.message.trim(),
      schedule: args.schedule,
      owner: args.owner,
      // One-shot jobs clean up after themselves unless told otherwise.
      delete_after_run:
        args.delete_after_run != null ? args.delete_after_run : args.schedule.kind === "at",
      created_at_ms: nowMs(),
      state: {},
    };
    job.state.next_run_at_ms = computeNextRun(args.schedule, nowMs());
    this.jobs.set(job.id, job);
    this.repository.upsert(jobToDict(job));
    this.changed();
    return job;
  }

  listJobs(ownerKeyFilter?: string | null): CronJob[] {
    this.load();
    let jobs = [...this.jobs.values()];
    if (ownerKeyFilter != null) {
      jobs = jobs.filter((job) => ownerKey(job.owner) === ownerKeyFilter);
    }
    return jobs.sort((a, b) => (a.state.next_run_at_ms ?? 0) - (b.state.next_run_at_ms ?? 0));
  }

  getJob(jobId: string): CronJob | null {
    this.load();
    return this.jobs.get(jobId) ?? null;
  }

  /** Remove a job; `ownerKey` scopes the cancel to its owner. */
  cancelJob(jobId: string, ownerKeyFilter?: string | null): boolean {
    this.load();
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (ownerKeyFilter != null && ownerKey(job.owner) !== ownerKeyFilter) return false;
    const removed = this.repository.delete(jobId, ownerKeyFilter ?? null);
    if (removed) {
      this.jobs.delete(jobId);
      this.changed();
    }
    return removed;
  }

  // -- scheduler --------------------------------------------------------------

  async start(): Promise<void> {
    if (this.running) return;
    this.load();
    // Re-arm interval/cron jobs whose due time passed while the server was
    // down: run once now; expired one-shots are dropped.
    const now = nowMs();
    let changed = false;
    for (const job of [...this.jobs.values()]) {
      if (job.schedule.kind === "at" && (job.schedule.at_ms ?? 0) <= now) {
        this.jobs.delete(job.id);
        this.repository.delete(job.id);
        changed = true;
      }
    }
    if (changed) this.changed();
    this.running = true;
    this.loopPromise = this.loop();
    console.log(`Cron service started (${this.jobs.size} jobs)`);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake(); // unblock any pending waitWake
    if (this.loopPromise) {
      // The loop exits after the current sleep resolves.
      await this.loopPromise.catch(() => undefined);
      this.loopPromise = null;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.tick();
      } catch (exc) {
        console.error("Cron tick failed", exc);
      }
      const sleepS = this.secondsUntilNextDue();
      await this.waitWake(sleepS * 1000);
    }
  }

  private secondsUntilNextDue(): number {
    const dueTimes = [...this.jobs.values()]
      .filter((job) => job.enabled !== false && job.state.next_run_at_ms)
      .map((job) => job.state.next_run_at_ms as number);
    if (!dueTimes.length) return MAX_SLEEP_SECONDS;
    const deltaS = (Math.min(...dueTimes) - nowMs()) / 1000;
    return Math.max(0.05, Math.min(deltaS, MAX_SLEEP_SECONDS));
  }

  private async tick(): Promise<void> {
    this.load();
    const now = nowMs();
    for (const job of [...this.jobs.values()]) {
      if (job.enabled === false || !job.state.next_run_at_ms) continue;
      if (job.state.next_run_at_ms > now) continue;
      await this.runJob(job);
    }
  }

  private async runJob(job: CronJob): Promise<void> {
    const started = nowMs();
    let status = "skipped";
    let error: string | null = null;
    if (this.onJob) {
      try {
        [status, error] = await this.onJob(job);
      } catch (exc) {
        status = "error";
        error = `${exc instanceof Error ? exc.name || exc.constructor.name : "Error"}: ${exc instanceof Error ? exc.message : String(exc)}`;
        console.error(`Cron job ${job.id} (${job.name}) crashed`, exc);
      }
    }

    job.state.last_run_at_ms = started;
    job.state.last_status = status;
    job.state.last_error = error;
    job.state.run_history = job.state.run_history ?? [];
    job.state.run_history.push({
      run_at_ms: started,
      status,
      duration_ms: nowMs() - started,
      error,
    });
    job.state.run_history = job.state.run_history.slice(-MAX_RUN_HISTORY);

    if (job.delete_after_run || job.schedule.kind === "at") {
      this.jobs.delete(job.id);
      this.repository.delete(job.id);
    } else {
      job.state.next_run_at_ms = computeNextRun(job.schedule, nowMs());
      if (job.state.next_run_at_ms == null) {
        this.jobs.delete(job.id);
        this.repository.delete(job.id);
      } else {
        this.repository.upsert(jobToDict(job));
      }
    }
    this.changed();
  }
}

let service: CronService | null = null;

/** Process-wide cron service anchored at Praxis's data directory. */
export function getCronService(): CronService {
  if (!service) {
    const settings: Settings = get_settings();
    service = new CronService(settings.sessions_db, executeJob, {
      legacyStorePath: join(settings.data_dir, "cron", "jobs.json"),
    });
  }
  return service;
}

export { ownerKey as _ownerKeyForTests };
