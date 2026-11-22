// reindex/readiness routes' backing state: per-KB ``.progress.json`` snapshots,
// the ``.indexing-run.json`` / ``.indexing-cancel.json`` durable journals, and
// the in-process task registry that decides whether a "running" journal entry
// is still alive.
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { Settings } from "../../config.js";
import {
  getKbEntry,
  kbDir,
  rawDir,
  updateKbEntry,
  updateKbStatus,
} from "./store.js";
import { collectSupportedFiles, getSupportedExtensions } from "./file_types.js";
import { KnowledgeBaseStore } from "../../store/kb_store.js";
import { taskStreamManager, updateTaskStatus } from "./tasks.js";
import type { AnyRecord } from "./types.js";

function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload));
  renameSync(tmp, path);
}

function readJson(path: string): AnyRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as AnyRecord)
      : null;
  } catch {
    return null;
  }
}

// -- progress broadcaster (api/utils/progress_broadcaster.py) --------------------

type ProgressListener = (progress: AnyRecord) => void;
const progressListeners = new Map<string, Set<ProgressListener>>();

export function subscribeProgress(kbKey: string, fn: ProgressListener): () => void {
  let set = progressListeners.get(kbKey);
  if (!set) {
    set = new Set();
    progressListeners.set(kbKey, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (!set!.size) progressListeners.delete(kbKey);
  };
}

function broadcastProgress(kbKey: string, progress: AnyRecord): void {
  for (const fn of progressListeners.get(kbKey) ?? []) {
    try {
      fn(progress);
    } catch {
      /* listener gone */
    }
  }
}

// -- ProgressTracker (knowledge/progress_tracker.py) ------------------------------

export const PROGRESS_STAGES = {
  INITIALIZING: "initializing",
  PROCESSING_DOCUMENTS: "processing_documents",
  PROCESSING_FILE: "processing_file",
  COMPLETED: "completed",
  ERROR: "error",
} as const;

export class ProgressTracker {
  readonly kbName: string;
  readonly settings: Settings;
  readonly kbDirPath: string;
  readonly progressFile: string;
  taskId: string | null = null;

  constructor(settings: Settings, kbName: string) {
    this.settings = settings;
    this.kbName = kbName;
    this.kbDirPath = kbDir(settings, kbName);
    this.progressFile = join(this.kbDirPath, ".progress.json");
  }

  update(stage: string, fields: {
    message?: string;
    current?: number;
    total?: number;
    file_name?: string;
    error?: string | null;
    error_code?: string | null;
    retryable?: boolean | null;
    indexed_count?: number | null;
    index_changed?: boolean | null;
    index_action?: string | null;
    message_key?: string | null;
    message_params?: AnyRecord | null;
    task_id?: string | null;
  } = {}): AnyRecord {
    const current = fields.current ?? 0;
    const total = fields.total ?? 0;
    const progress: AnyRecord = {
      kb_name: this.kbName,
      task_id: fields.task_id ?? this.taskId,
      stage,
      message: fields.message ?? "",
      current,
      total,
      file_name: fields.file_name ?? "",
      progress_percent: total > 0 ? Math.floor((current / total) * 100) : 0,
      timestamp: new Date().toISOString(),
    };
    if (fields.indexed_count !== undefined && fields.indexed_count !== null) progress["indexed_count"] = fields.indexed_count;
    if (fields.index_changed !== undefined && fields.index_changed !== null) progress["index_changed"] = fields.index_changed;
    if (fields.index_action) progress["index_action"] = fields.index_action;
    if (fields.message_key) {
      progress["message_key"] = fields.message_key;
      progress["message_params"] = fields.message_params ?? {};
    }
    if (fields.error) {
      progress["error"] = fields.error;
      progress["stage"] = PROGRESS_STAGES.ERROR;
    }
    if (fields.error_code) progress["error_code"] = fields.error_code;
    if (fields.retryable !== undefined && fields.retryable !== null) progress["retryable"] = fields.retryable;

    this.saveProgress(progress);
    broadcastProgress(this.kbName, progress);
    return progress;
  }

  private saveProgress(progress: AnyRecord): void {
    // Persist into the KB registry entry (upstream kb_config.json) and the
    // per-KB .progress.json snapshot.
    const stage = String(progress["stage"] ?? "");
    let status = "initializing";
    if (stage === PROGRESS_STAGES.COMPLETED) status = "ready";
    else if (stage === PROGRESS_STAGES.ERROR) status = "error";
    else if ([PROGRESS_STAGES.INITIALIZING, PROGRESS_STAGES.PROCESSING_DOCUMENTS, PROGRESS_STAGES.PROCESSING_FILE].includes(stage as never)) {
      status = "processing";
    }
    try {
      updateKbStatus(this.settings, this.kbName, status, {
        stage: progress["stage"],
        message: progress["message"],
        percent: progress["progress_percent"],
        current: progress["current"],
        total: progress["total"],
        file_name: progress["file_name"],
        error: progress["error"],
        error_code: progress["error_code"],
        retryable: progress["retryable"],
        timestamp: progress["timestamp"],
        task_id: progress["task_id"],
        indexed_count: progress["indexed_count"],
        index_changed: progress["index_changed"],
        index_action: progress["index_action"],
        message_key: progress["message_key"],
        message_params: progress["message_params"],
      });
    } catch {
      /* progress persistence is best-effort */
    }
    try {
      atomicWriteJson(this.progressFile, progress);
    } catch {
      /* ignore */
    }
  }

  getProgress(): AnyRecord | null {
    if (existsSync(this.progressFile)) {
      const data = readJson(this.progressFile);
      if (data !== null) return data;
    }
    try {
      const entry = getKbEntry(this.settings, this.kbName);
      const progress = entry?.["progress"];
      if (progress !== null && typeof progress === "object" && !Array.isArray(progress)) {
        return progress as AnyRecord;
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  clear(): void {
    try {
      if (existsSync(this.progressFile)) unlinkSync(this.progressFile);
    } catch {
      /* ignore */
    }
  }
}

// -- indexing run journal (knowledge/indexing_run.py) ------------------------------

const TERMINAL_STATES = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const liveRunTaskIds = new Set<string>();

function markRunLive(taskId: string): void {
  liveRunTaskIds.add(taskId);
}

function markRunDone(taskId: string): void {
  liveRunTaskIds.delete(taskId);
}

function isRunLive(run: AnyRecord | null): boolean {
  if (!run) return false;
  const taskId = String(run["task_id"] ?? "");
  if (taskId && liveRunTaskIds.has(taskId)) return true;
  // Same-process pid check (upstream uses psutil create_time; pid reuse is rare
  // enough for this single-process backend).
  const pid = Number(run["pid"]);
  return Number.isFinite(pid) && pid === process.pid;
}

export function loadRun(kbDirPath: string): AnyRecord | null {
  const path = join(kbDirPath, ".indexing-run.json");
  const value = readJson(path);
  if (value === null) {
    if (existsSync(path)) throw new Error("Indexing journal is unreadable; original file preserved.");
    return null;
  }
  if (value["schema"] !== 1 || typeof value["documents"] !== "object" || value["documents"] === null) {
    throw new Error("Indexing journal is invalid; original file preserved.");
  }
  let cancelled: AnyRecord = {};
  try {
    cancelled = readJson(join(kbDirPath, ".indexing-cancel.json")) ?? {};
  } catch {
    throw new Error("Indexing cancellation state is unreadable; original file preserved.");
  }
  value["cancel_requested"] = cancelled["task_id"] === value["task_id"];
  return value;
}

export function visibleRun(kbDirPath: string): AnyRecord | null {
  const value = loadRun(kbDirPath);
  if (value === null || TERMINAL_STATES.has(String(value["state"]))) return value;
  if (isRunLive(value)) return value;
  const documents: AnyRecord = {};
  const docs = (value["documents"] ?? {}) as AnyRecord;
  for (const [key, docRaw] of Object.entries(docs)) {
    const doc = { ...(docRaw as AnyRecord) };
    if (["pending", "parsing", "embedding"].includes(String(doc["status"]))) {
      doc["status"] = "unknown";
    }
    documents[key] = doc;
  }
  return {
    ...value,
    state: "interrupted",
    documents,
    recovery:
      "Retry reuses validated parser outputs and resumable document checkpoints. Uncheckpointed chunking and embedding work restarts.",
  };
}

export function requestCancel(kbDirPath: string, taskId: string): boolean {
  const value = loadRun(kbDirPath);
  if (value === null) return false;
  if (String(value["task_id"] ?? "") !== taskId) return false;
  if (TERMINAL_STATES.has(String(value["state"]))) return false;
  atomicWriteJson(join(kbDirPath, ".indexing-cancel.json"), { task_id: taskId });
  return true;
}

export function beginRun(
  kbDirPath: string,
  opts: { taskId: string; sources?: string[]; provider?: string },
): AnyRecord {
  const run: AnyRecord = {
    schema: 1,
    task_id: opts.taskId,
    state: "running",
    pid: process.pid,
    process_started_at: Date.now(),
    provider: opts.provider ?? "",
    started_at: new Date().toISOString(),
    documents: {},
    sources: opts.sources ?? [],
  };
  atomicWriteJson(join(kbDirPath, ".indexing-run.json"), run);
  try {
    unlinkSync(join(kbDirPath, ".indexing-cancel.json"));
  } catch { /* absent */ }
  return run;
}

function finishRun(kbDirPath: string, state: string, extra: AnyRecord = {}): void {
  const value = loadRunQuiet(kbDirPath);
  if (value === null) return;
  const documents = (value["documents"] ?? {}) as AnyRecord;
  for (const doc of Object.values(documents)) {
    const d = doc as AnyRecord;
    if (["pending", "parsing", "embedding"].includes(String(d["status"]))) {
      d["status"] = state === "completed" ? "indexed" : "unknown";
    }
  }
  atomicWriteJson(join(kbDirPath, ".indexing-run.json"), {
    ...value,
    state,
    finished_at: new Date().toISOString(),
    documents,
    ...extra,
  });
}

function loadRunQuiet(kbDirPath: string): AnyRecord | null {
  try {
    return loadRun(kbDirPath);
  } catch {
    return readJson(join(kbDirPath, ".indexing-run.json"));
  }
}

// -- readiness / reindex helpers ---------------------------------------------------

export function indexingReadiness(settings: Settings, kbName: string): AnyRecord {
  const entry = getKbEntry(settings, kbName);
  const dir = kbDir(settings, kbName);
  const raw = rawDir(settings, kbName);
  const sources = collectSupportedFiles(raw, true);
  return {
    parser: "builtin",
    ready: true,
    reason: "",
    message: "The built-in document index is ready.",
    formats: [...getSupportedExtensions()].sort(),
    mode: null,
    device: null,
    embedding_model: String(entry?.["embedding_model"] ?? ""),
    embedding_configured: Boolean(entry?.["embedding_model"]),
    source_count: sources.length,
    note: "Readiness checks configuration and local prerequisites; runtime downloads, resource limits and provider responses can still fail.",
  };
}

export function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return "";
  }
}

// -- reindex background task (knowledge.py run_reindex_task analogue) -------------

/**
 * Rebuild a KB's document index from its raw/ files. Upstream dispatches to the
 * bound RAG provider pipeline; this deployment's index is the sqlite document
 * store (``KnowledgeBaseStore``), so the job walks raw/, extracts supported
 * files and re-adds them — the same indexing path uploads and syncs use.
 */
export async function runReindexTask(
  settings: Settings,
  kbName: string,
  taskId: string,
): Promise<void> {
  const tracker = new ProgressTracker(settings, kbName);
  tracker.taskId = taskId;
  const kbDirPath = kbDir(settings, kbName);
  const raw = rawDir(settings, kbName);
  markRunLive(taskId);
  try {
    const files = collectSupportedFiles(raw, true);
    if (!files.length) {
      throw new Error(`Re-index found no valid documents to index in '${kbName}'.`);
    }
    tracker.update(PROGRESS_STAGES.PROCESSING_DOCUMENTS, {
      message: `Indexing ${files.length} file(s)...`,
      current: 0,
      total: files.length,
      task_id: taskId,
    });
    taskStreamManager.emitLog(taskId, `Re-index of '${kbName}' started (${files.length} file(s))`);

    const kb = new KnowledgeBaseStore(settings);
    const root = resolve(raw);
    let indexed = 0;
    for (const path of files) {
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : path;
      tracker.update(PROGRESS_STAGES.PROCESSING_FILE, {
        message: `Indexing ${rel}`,
        current: indexed,
        total: files.length,
        file_name: rel,
        task_id: taskId,
      });
      taskStreamManager.emitLog(taskId, `Indexing ${rel}`);
      try {
        kb.add_document(kbName, rel, new Uint8Array(readFileSync(path)));
        indexed++;
      } catch (exc) {
        taskStreamManager.emitLog(
          taskId,
          `Failed to index ${rel}: ${exc instanceof Error ? exc.message : String(exc)}`,
        );
      }
    }
    if (!indexed) {
      throw new Error(`Re-index found no valid documents to index in '${kbName}'.`);
    }
    const entry = getKbEntry(settings, kbName);
    if (entry) {
      // Clear legacy mismatch flags now that a fresh index exists.
      updateKbEntry(settings, kbName, (e) => {
        if (e["needs_reindex"]) e["needs_reindex"] = false;
        delete e["embedding_mismatch"];
        e["last_indexed_at"] = new Date().toISOString();
        e["last_indexed_count"] = indexed;
        e["last_indexed_action"] = "reindex";
      });
    }
    tracker.update(PROGRESS_STAGES.COMPLETED, {
      message: `Re-index of '${kbName}' complete`,
      current: files.length,
      total: files.length,
      indexed_count: indexed,
      index_changed: true,
      index_action: "reindex",
      task_id: taskId,
    });
    finishRun(kbDirPath, "completed", { indexed_count: indexed });
    updateTaskStatus(taskId, "completed");
    taskStreamManager.emitComplete(taskId, `Re-index of '${kbName}' complete`);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    taskStreamManager.emitLog(taskId, `Re-index failed: ${msg}`);
    updateTaskStatus(taskId, "error", { error: msg });
    try {
      tracker.update(PROGRESS_STAGES.ERROR, {
        message: `Re-index failed: ${msg}`,
        error: msg,
        error_code: "knowledge_task_failed",
        retryable: true,
        task_id: taskId,
      });
    } catch { /* progress write is best-effort */ }
    finishRun(kbDirPath, "failed", { error: msg });
    taskStreamManager.emitFailed(taskId, msg, { error_code: "knowledge_task_failed", retryable: true });
  } finally {
    markRunDone(taskId);
  }
}

