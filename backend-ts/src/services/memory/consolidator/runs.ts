// Port of consolidator/runs.py — persistent, cancellable consolidator runs.
// In-memory manager; events buffered per run so clients re-attach by cursor.
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { atomic_write_text } from "./_runtime.js";
import type { Dict } from "../../../shared/types.js";

export type RunMode = "update" | "audit" | "dedup" | "merge";
export type RunStatus = "queued" | "running" | "cancelled" | "done" | "error";

const MAX_EVENTS_PER_RUN = 2000;
const MAX_HISTORY = 200;

export interface RunEvent {
  seq: number;
  ts: string;
  payload: Dict;
}

export interface UndoCheckpoint {
  id: string;
  ts: string;
  layer: string;
  key: string;
  path: string;
  existed: boolean;
  previous_content: string;
  action: string;
  turn?: number | null;
  label?: string | null;
}

export class Run {
  id: string;
  layer: string;
  key: string;
  mode: RunMode;
  params: Dict;
  language: string;
  user_label: string;
  status: RunStatus = "queued";
  started_at = "";
  ended_at: string | null = null;
  error: string | null = null;
  events: RunEvent[] = [];
  undo_stack: UndoCheckpoint[] = [];
  private nextSeq = 0;
  private firstSeq = 0;
  private waiters: Array<() => void> = [];
  private task: Promise<void> | null = null;
  readonly cancelFlag = new AbortController();

  constructor(init: {
    id: string;
    layer: string;
    key: string;
    mode: RunMode;
    params?: Dict;
    language?: string;
    user_label?: string;
  }) {
    this.id = init.id;
    this.layer = init.layer;
    this.key = init.key;
    this.mode = init.mode;
    this.params = init.params ?? {};
    this.language = init.language ?? "en";
    this.user_label = init.user_label ?? "anonymous";
  }

  get active(): boolean {
    return this.status === "queued" || this.status === "running";
  }

  to_dict(): Dict {
    return {
      id: this.id,
      layer: this.layer,
      key: this.key,
      mode: this.mode,
      params: this.params,
      language: this.language,
      status: this.status,
      started_at: this.started_at,
      ended_at: this.ended_at,
      error: this.error,
      event_count: this.events.length,
      undo_count: this.undo_stack.length,
    };
  }

  /** Internal: register a waiter woken on the next emit/terminal. */
  _waitOnce(): Promise<void> {
    return new Promise((res) => this.waiters.push(res));
  }

  _wake(): void {
    const w = this.waiters.splice(0);
    for (const fn of w) fn();
  }

  _setTask(t: Promise<void>): void {
    this.task = t;
  }

  _allocSeq(): number {
    return this.nextSeq++;
  }

  _pushEvent(event: RunEvent): void {
    this.events.push(event);
    if (this.events.length > MAX_EVENTS_PER_RUN) {
      this.events.shift();
      this.firstSeq++;
    }
  }

  async _cancelTask(): Promise<void> {
    // JS cannot cancel a promise; cooperative cancellation via the AbortSignal
    // threaded into mode loops is the equivalent of task.cancel().
    this.cancelFlag.abort();
  }
}

export class RunBusyError extends Error {}

// Per-run context for push_undo_checkpoint: JS has no ContextVar, so the run
// is threaded explicitly through RunContext (see _runtime.ts).
export function push_undo_checkpoint(opts: {
  layer: string;
  key: string;
  path: string;
  existed: boolean;
  previous_content: string;
  action: string;
  turn?: number | null;
  label?: string | null;
  run?: Run | null;
}): number {
  const run = opts.run ?? null;
  if (!run) return 0;
  run.undo_stack.push({
    id: randomUUID().replace(/-/g, ""),
    ts: nowIso(),
    layer: opts.layer,
    key: opts.key,
    path: opts.path,
    existed: opts.existed,
    previous_content: opts.previous_content,
    action: opts.action,
    turn: opts.turn ?? null,
    label: opts.label ?? null,
  });
  return run.undo_stack.length;
}

export type RunRunner = (
  onEvent: (evt: Dict) => Promise<void>,
  run: Run,
) => Promise<void>;

export class RunManager {
  private runs = new Map<string, Run>();
  private order: string[] = [];
  private active = new Map<string, string>(); // "layer/key" -> run_id

  get(runId: string): Run | null {
    return this.runs.get(runId) ?? null;
  }

  active_for(layer: string, key: string): Run | null {
    const runId = this.active.get(`${layer}/${key}`);
    if (runId === undefined) return null;
    const run = this.runs.get(runId);
    return run && run.active ? run : null;
  }

  list_for(opts: { layer?: string | null; key?: string | null } = {}): Run[] {
    const out: Run[] = [];
    for (const rid of this.order) {
      const run = this.runs.get(rid);
      if (!run) continue;
      if (opts.layer != null && run.layer !== opts.layer) continue;
      if (opts.key != null && run.key !== opts.key) continue;
      out.push(run);
    }
    return out;
  }

  async start(opts: {
    layer: string;
    key: string;
    mode: RunMode;
    runner: RunRunner;
    params?: Dict | null;
    language?: string;
    user_label?: string;
  }): Promise<Run> {
    if (this.active_for(opts.layer, opts.key) !== null) {
      throw new RunBusyError(`a run is already in progress for ${opts.layer}/${opts.key}`);
    }
    const run = new Run({
      id: randomUUID().replace(/-/g, ""),
      layer: opts.layer,
      key: opts.key,
      mode: opts.mode,
      params: opts.params ?? {},
      language: opts.language ?? "en",
      user_label: opts.user_label ?? "anonymous",
    });
    run.started_at = nowIso();
    this.runs.set(run.id, run);
    this.order.push(run.id);
    this.active.set(`${opts.layer}/${opts.key}`, run.id);
    this.evictIfNeeded();

    const task = this.drive(run, opts.runner);
    run._setTask(task);
    return run;
  }

  async cancel(runId: string): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || !run.active) return false;
    await run._cancelTask();
    return true;
  }

  async undo_last(runId: string): Promise<RunEvent | null> {
    const run = this.runs.get(runId);
    if (!run) throw new KeyError(runId);
    if (run.active) {
      throw new RunBusyError("cancel the active run before undoing memory edits");
    }
    if (!run.undo_stack.length) return null;

    const checkpoint = run.undo_stack.pop()!;
    if (checkpoint.existed) {
      atomic_write_text(checkpoint.path, checkpoint.previous_content);
    } else {
      removeIfExists(checkpoint.path);
    }
    return this.emit(run, {
      stage: "undo_applied",
      run_id: run.id,
      undo_id: checkpoint.id,
      undo_depth: run.undo_stack.length,
      layer: checkpoint.layer,
      key: checkpoint.key,
      turn: checkpoint.turn ?? null,
      label: checkpoint.label ?? null,
      action: checkpoint.action,
    });
  }

  async wait_for_events(run: Run, since: number): Promise<RunEvent[]> {
    if (since < 0) since = 0;
    const buffered = run.events.filter((e) => e.seq >= since);
    if (buffered.length) return buffered;
    if (!run.active) return [];
    await run._waitOnce();
    return run.events.filter((e) => e.seq >= since);
  }

  private async drive(run: Run, runner: RunRunner): Promise<void> {
    run.status = "running";
    await this.emit(run, {
      stage: "run_started",
      run_id: run.id,
      mode: run.mode,
    });
    try {
      const onEvent = async (evt: Dict) => {
        await this.emit(run, evt);
      };
      await runner(onEvent, run);
      if (run.status === "running") run.status = "done";
    } catch (exc) {
      if (exc instanceof Error && exc.name === "AbortError") {
        run.status = "cancelled";
        await this.emit(run, { stage: "cancelled" });
      } else {
        run.status = "error";
        run.error = exc instanceof Error ? exc.message : String(exc);
        await this.emit(run, { stage: "error", message: run.error });
      }
    } finally {
      run.ended_at = nowIso();
      await this.emit(run, { stage: "run_ended", status: run.status });
      this.active.delete(`${run.layer}/${run.key}`);
      run._wake();
    }
  }

  private async emit(run: Run, payload: Dict): Promise<RunEvent> {
    const event: RunEvent = { seq: run._allocSeq(), ts: nowIso(), payload };
    run._pushEvent(event);
    run._wake();
    return event;
  }

  private evictIfNeeded(): void {
    while (this.order.length > MAX_HISTORY) {
      const old = this.order.shift()!;
      const run = this.runs.get(old);
      if (run && run.active) {
        this.order.unshift(old);
        return;
      }
      this.runs.delete(old);
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function removeIfExists(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* ignore */
  }
}

export class KeyError extends Error {
  constructor(public key: unknown) {
    super(`unknown run_id ${String(key)}`);
    this.name = "KeyError";
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

let _manager: RunManager | null = null;
export function get_run_manager(): RunManager {
  if (!_manager) _manager = new RunManager();
  return _manager;
}

export function reset_run_manager_for_tests(): void {
  _manager = null;
}
