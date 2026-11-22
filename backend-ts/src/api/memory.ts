// Port of deeptutor/api/routers/memory.py — Memory v3 API (workbench backend).
// Mount at /api/memory (orchestrator wires it; do not edit main.ts).
//
// Routes duplicated by the legacy stub handlers in api/handlers.ts are still
// registered here for completeness — Hono matches in mount order, so whichever
// router is mounted first wins. See REPORT for the collision list.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import {
  L3_SLOTS,
  SURFACES,
  backup_root,
  l2_file,
  l3_file,
  trace_dir,
  trace_file,
  type L3Slot,
  type Surface,
} from "../services/memory/paths.js";
import { get_memory_store } from "../services/memory/store.js";
import * as paths from "../services/memory/paths.js";
import { parse as parseDoc, newDocument, type Document } from "../services/memory/document.js";
import { render_view } from "../services/memory/consolidator/line_doc.js";
import {
  get_run_manager,
  RunBusyError,
  type Run,
  type RunMode,
} from "../services/memory/consolidator/runs.js";
import {
  run_audit,
  run_dedup,
  run_merge,
  run_update,
} from "../services/memory/consolidator/modes/index.js";
import type { OnEvent, RunContext } from "../services/memory/consolidator/_runtime.js";
import {
  memory_settings_dict,
  save_memory_settings,
} from "../services/memory/settings.js";
import * as trace from "../services/memory/trace.js";
import * as snap from "../services/memory/snapshot/index.js";
import type { Dict } from "../shared/types.js";

const ENTRY_ID_RE = /^m_[0-9A-HJKMNP-TV-Z]{26}$/;

type Layer = "L2" | "L3";

export const memoryRouter = new Hono();

// ── Helpers ────────────────────────────────────────────────────────────

function validateDocKey(layer: Layer, key: string): void {
  if (layer === "L2" && !(SURFACES as readonly string[]).includes(key)) {
    throw new HTTPException(404, { message: `unknown surface ${JSON.stringify(key)}` });
  }
  if (layer === "L3" && !(L3_SLOTS as readonly string[]).includes(key)) {
    throw new HTTPException(404, { message: `unknown L3 slot ${JSON.stringify(key)}` });
  }
}

function validateLayer(layer: string): Layer {
  if (layer !== "L2" && layer !== "L3") {
    throw new HTTPException(400, { message: "layer must be L2 or L3" });
  }
  return layer;
}

function validateSurface(surface: string): Surface {
  if (!(SURFACES as readonly string[]).includes(surface)) {
    throw new HTTPException(404, { message: `unknown surface ${JSON.stringify(surface)}` });
  }
  return surface as Surface;
}

function defaultTitle(layer: string, key: string): string {
  if (layer === "L2") return `${key} memory`;
  return (
    {
      recent: "Recent summary",
      profile: "User profile",
      scope: "Knowledge scope",
      preferences: "Preferences",
    } as Record<string, string>
  )[key] ?? `${key} memory`;
}

function docPath(layer: Layer, key: string): string {
  return layer === "L2" ? l2_file(key as Surface) : l3_file(key as L3Slot);
}

// ── Overview / list ────────────────────────────────────────────────────

memoryRouter.get("/overview", (c) => {
  const store = get_memory_store();
  const rows = store.overview().map((r) => ({ ...r }));
  const backups: string[] = [];
  const backupDir = backup_root();
  if (existsSync(backupDir)) {
    for (const name of readdirSync(backupDir).sort()) {
      try {
        if (statSync(join(backupDir, name)).isDirectory()) backups.push(name);
      } catch { /* skip */ }
    }
  }
  return c.json({ docs: rows, backups });
});

memoryRouter.get("/resolve_entry/:entry_id", (c) => {
  const entryId = c.req.param("entry_id");
  if (!ENTRY_ID_RE.test(entryId)) {
    throw new HTTPException(400, { message: "not a valid entry id" });
  }
  for (const surface of SURFACES) {
    const path = l2_file(surface);
    if (!existsSync(path)) continue;
    let doc: Document;
    try {
      doc = parseDoc(readFileSync(path, "utf-8"));
    } catch {
      continue;
    }
    for (const entry of doc.sections.flatMap(([, es]) => es)) {
      if (entry.id === entryId) {
        return c.json({ layer: "L2", key: surface, entry_id: entryId });
      }
    }
  }
  throw new HTTPException(404, { message: "entry not found in any L2 doc" });
});

memoryRouter.get("/backup", (c) => {
  const backupDir = backup_root();
  if (!existsSync(backupDir)) return c.json({ backups: [] });
  const out: Dict[] = [];
  for (const name of readdirSync(backupDir).sort()) {
    const p = join(backupDir, name);
    try {
      if (!statSync(p).isDirectory()) continue;
      out.push({ name, files: readdirSync(p).sort() });
    } catch { /* skip */ }
  }
  return c.json({ backups: out });
});

// ── Doc read / write / delete ──────────────────────────────────────────

memoryRouter.get("/doc/:layer/:key", (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  return c.json({
    layer,
    key,
    content: get_memory_store().read_raw(layer, key),
  });
});

memoryRouter.put("/doc/:layer/:key", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  const payload = (await c.req.json()) as Dict;
  await get_memory_store().overwrite_doc(layer, key, String(payload["content"] ?? ""));
  return c.json({ layer, key, saved: true });
});

memoryRouter.delete("/doc/:layer/:key/entry/:entry_id", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  const entryId = c.req.param("entry_id");
  validateDocKey(layer, key);
  const ok = await get_memory_store().delete_entry(layer, key, entryId);
  if (!ok) throw new HTTPException(404, { message: "entry not found" });
  return c.json({ layer, key, deleted: entryId });
});

memoryRouter.post("/doc/:layer/:key/reset", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);

  const manager = get_run_manager();
  if (manager.active_for(layer, key) !== null) {
    throw new HTTPException(409, {
      message: "cancel the active run before resetting this doc",
    });
  }

  const docFile = docPath(layer, key);
  const metaPath =
    layer === "L2"
      ? join(paths.l2_dir(), `${key}.meta.json`)
      : join(paths.l3_dir(), `${key}.meta.json`);

  let removedDoc = false;
  let removedMeta = false;
  try {
    if (existsSync(docFile)) {
      unlinkSync(docFile);
      removedDoc = true;
    }
    if (existsSync(metaPath)) {
      unlinkSync(metaPath);
      removedMeta = true;
    }
  } catch (exc) {
    throw new HTTPException(500, {
      message: `reset failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    });
  }
  return c.json({
    layer, key, reset: true, removed_doc: removedDoc, removed_meta: removedMeta,
  });
});

// ── Runs ───────────────────────────────────────────────────────────────

interface RunStartBody {
  layer?: string;
  key?: string;
  mode?: string;
  language?: string;
  budget?: number | null;
  iterations?: number | null;
  llm_selection?: { profile_id?: string; model_id?: string } | null;
}

function runnerFor(req: Required<Pick<RunStartBody, "layer" | "key" | "mode">> & RunStartBody) {
  const layer = req.layer;
  const key = req.key;
  const mode = req.mode as RunMode;
  const language = req.language ?? "en";
  const budget = req.budget ?? null;
  const iterations = req.iterations ?? null;
  const llmSelection = req.llm_selection
    ? { profile_id: req.llm_selection.profile_id, model_id: req.llm_selection.model_id }
    : null;

  return async (onEvent: OnEvent, run: Run): Promise<void> => {
    const ctx: RunContext = {
      settings: (await import("../config.js")).get_settings(),
      llm_selection: llmSelection as Dict | null,
      run,
      signal: run.cancelFlag.signal,
    };
    const base = {
      language,
      user_label: run.user_label,
      on_event: onEvent,
      ctx,
      llm_selection: llmSelection as Dict | null,
    };
    if (mode === "update") {
      await run_update(layer, key, { ...base, budget });
    } else if (mode === "audit") {
      await run_audit(layer, key, { ...base, budget });
    } else if (mode === "dedup") {
      await run_dedup(layer, key, { ...base, iterations });
    } else if (mode === "merge") {
      await run_merge(layer, key, base);
    } else {
      throw new Error(`unknown mode ${JSON.stringify(mode)}`);
    }
  };
}

memoryRouter.post("/runs/start", async (c) => {
  const req = (await c.req.json()) as RunStartBody;
  const layer = validateLayer(String(req.layer ?? ""));
  const key = String(req.key ?? "");
  validateDocKey(layer, key);
  const mode = String(req.mode ?? "");
  if (!["update", "audit", "dedup", "merge"].includes(mode)) {
    throw new HTTPException(400, { message: `unknown mode ${JSON.stringify(mode)}` });
  }
  if (layer === "L3" && key === "preferences" && mode !== "dedup" && mode !== "merge") {
    throw new HTTPException(405, {
      message: "preferences is written by the write_memory tool, not consolidated",
    });
  }

  const manager = get_run_manager();
  const selection = req.llm_selection
    ? { profile_id: req.llm_selection.profile_id, model_id: req.llm_selection.model_id }
    : null;
  try {
    const run = await manager.start({
      layer,
      key,
      mode: mode as RunMode,
      runner: runnerFor({
        layer, key, mode,
        language: req.language ?? "en",
        budget: req.budget ?? null,
        iterations: req.iterations ?? null,
        llm_selection: selection as never,
      }),
      params: {
        budget: req.budget ?? null,
        iterations: req.iterations ?? null,
        language: req.language ?? "en",
        llm_selection: selection,
      },
      language: req.language ?? "en",
    });
    return c.json(run.to_dict());
  } catch (exc) {
    if (exc instanceof RunBusyError) {
      throw new HTTPException(409, { message: exc.message });
    }
    throw exc;
  }
});

memoryRouter.get("/runs/:run_id", (c) => {
  const run = get_run_manager().get(c.req.param("run_id"));
  if (!run) throw new HTTPException(404, { message: "unknown run_id" });
  return c.json(run.to_dict());
});

memoryRouter.post("/runs/:run_id/cancel", async (c) => {
  const ok = await get_run_manager().cancel(c.req.param("run_id"));
  if (!ok) throw new HTTPException(409, { message: "not active" });
  return c.json({ run_id: c.req.param("run_id"), cancelled: true });
});

memoryRouter.post("/runs/:run_id/undo", async (c) => {
  const manager = get_run_manager();
  const runId = c.req.param("run_id");
  let event;
  try {
    event = await manager.undo_last(runId);
  } catch (exc) {
    if (exc instanceof Error && exc.name === "KeyError") {
      throw new HTTPException(404, { message: "unknown run_id" });
    }
    if (exc instanceof RunBusyError) {
      throw new HTTPException(409, { message: exc.message });
    }
    throw exc;
  }
  if (event === null) {
    throw new HTTPException(409, { message: "nothing to undo" });
  }
  const run = manager.get(runId);
  return c.json({
    run_id: runId,
    undone: true,
    undo_count: run ? run.undo_stack.length : 0,
    event: { seq: event.seq, ts: event.ts, ...event.payload },
  });
});

memoryRouter.get("/runs", (c) => {
  const layerParam = c.req.query("layer");
  const keyParam = c.req.query("key");
  let layer: Layer | null = null;
  if (layerParam !== undefined) {
    layer = validateLayer(layerParam);
    if (keyParam !== undefined) validateDocKey(layer, keyParam);
  }
  const runs = get_run_manager().list_for({ layer, key: keyParam ?? null });
  return c.json({ runs: runs.map((r) => r.to_dict()) });
});

memoryRouter.get("/runs/:run_id/events", async (c) => {
  const runId = c.req.param("run_id");
  const since = Math.max(0, Number(c.req.query("since") ?? "0") || 0);
  const manager = get_run_manager();
  const run = manager.get(runId);
  if (!run) throw new HTTPException(404, { message: "unknown run_id" });

  return streamSSE(c, async (stream) => {
    let cursor = since;
    const signal = c.req.raw.signal;
    const sseData = (ev: { seq: number; ts: string; payload: Dict }) =>
      `data: ${JSON.stringify({ seq: ev.seq, ts: ev.ts, ...ev.payload })}\n\n`;
    try {
      while (true) {
        if (signal.aborted) return;
        const events = await manager.wait_for_events(run, cursor);
        for (const ev of events) {
          await stream.write(sseData(ev));
          cursor = Math.max(cursor, ev.seq + 1);
        }
        if (!run.active) {
          const final = run.events.filter((e) => e.seq >= cursor);
          for (const ev of final) await stream.write(sseData(ev));
          return;
        }
        // wait_for_events resolves on the next emit; loop re-checks.
      }
    } catch {
      return;
    }
  });
});

// ── Legacy per-mode endpoints (SSE inline stream) ──────────────────────

function legacyRunStream(req: RunStartBody) {
  const layer = String(req.layer ?? "");
  const key = String(req.key ?? "");
  const mode = String(req.mode ?? "");
  return async function* (): AsyncGenerator<string> {
    const manager = get_run_manager();
    try {
      const run = await manager.start({
        layer,
        key,
        mode: mode as RunMode,
        runner: runnerFor(req as never),
        params: {
          budget: req.budget ?? null,
          iterations: req.iterations ?? null,
          language: req.language ?? "en",
          llm_selection: req.llm_selection ?? null,
        },
        language: req.language ?? "en",
      });
      let cursor = 0;
      while (true) {
        const events = await manager.wait_for_events(run, cursor);
        for (const ev of events) {
          yield `data: ${JSON.stringify({ ...ev.payload, seq: ev.seq })}\n\n`;
          cursor = ev.seq + 1;
        }
        if (!run.active) break;
      }
    } catch (exc) {
      if (exc instanceof RunBusyError) {
        yield `data: ${JSON.stringify({ stage: "error", message: exc.message })}\n\n`;
      } else {
        yield `data: ${JSON.stringify({ stage: "error", message: String(exc) })}\n\n`;
      }
    }
  };
}

function sseResponse(gen: () => AsyncGenerator<string>) {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        try {
          for await (const chunk of gen()) {
            controller.enqueue(enc.encode(chunk));
          }
        } catch { /* ignore */ }
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } },
  );
}

memoryRouter.post("/doc/:layer/:key/update", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  const payload = (await c.req.json().catch(() => ({}))) as Dict;
  return sseResponse(legacyRunStream({
    layer, key, mode: "update",
    language: String(payload["language"] ?? "en") || "en",
    budget: (payload["budget"] as number | null) ?? null,
    llm_selection: payload["llm_selection"] as never,
  }));
});

memoryRouter.post("/doc/:layer/:key/audit", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  const payload = (await c.req.json().catch(() => ({}))) as Dict;
  return sseResponse(legacyRunStream({
    layer, key, mode: "audit",
    language: String(payload["language"] ?? "en") || "en",
    budget: (payload["budget"] as number | null) ?? null,
    llm_selection: payload["llm_selection"] as never,
  }));
});

memoryRouter.post("/doc/:layer/:key/dedup", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  const payload = (await c.req.json().catch(() => ({}))) as Dict;
  return sseResponse(legacyRunStream({
    layer, key, mode: "dedup",
    language: String(payload["language"] ?? "en") || "en",
    iterations: (payload["iterations"] as number | null) ?? null,
    llm_selection: payload["llm_selection"] as never,
  }));
});

memoryRouter.get("/doc/:layer/:key/lines", (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  const path = docPath(layer, key);
  const doc = existsSync(path)
    ? (() => { try { return parseDoc(readFileSync(path, "utf-8")); } catch { return newDocument(defaultTitle(layer, key)); } })()
    : newDocument(defaultTitle(layer, key));
  const view = render_view(doc);
  return c.json({
    layer,
    key,
    lines: view.lines.map((line) => ({
      number: line.number,
      kind: line.kind,
      text: line.text,
      entry_id: line.entry_id ?? null,
      section: line.section ?? null,
    })),
  });
});

// ── Settings ───────────────────────────────────────────────────────────

memoryRouter.get("/settings", (c) => c.json(memory_settings_dict()));

memoryRouter.put("/settings", async (c) => {
  const payload = (await c.req.json().catch(() => ({}))) as Dict;
  save_memory_settings(payload);
  return c.json(memory_settings_dict());
});

// ── Apply ops ──────────────────────────────────────────────────────────

memoryRouter.post("/doc/:layer/:key/apply", async (c) => {
  const layer = validateLayer(c.req.param("layer"));
  const key = c.req.param("key");
  validateDocKey(layer, key);
  if (layer === "L3" && key === "preferences") {
    throw new HTTPException(405, {
      message: "preferences is written by the write_memory tool, not consolidated",
    });
  }
  const payload = (await c.req.json()) as Dict;
  const ops = Array.isArray(payload["ops"]) ? (payload["ops"] as unknown[]) : [];
  if (!ops.length) {
    return c.json({ accepted: true, reason: "no ops to apply", results: [] });
  }
  const report = await get_memory_store().apply_ops_payload(layer, key, ops);
  return c.json({
    accepted: report.accepted,
    reason: report.reason ?? "",
    results: report.results.map((r) => ({
      status: r.status,
      entry_id: r.entry_id ?? null,
      detail: r.detail ?? "",
    })),
  });
});

// ── Trace browser ──────────────────────────────────────────────────────

memoryRouter.get("/trace/:surface", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const limit = Number(c.req.query("limit") ?? "200") || 200;
  const offset = Number(c.req.query("offset") ?? "0") || 0;
  const bound = Math.max(1, Math.min(limit, 1000));
  const events: Dict[] = [];
  let i = 0;
  for (const event of trace.iter_since(surf)) {
    if (i < offset) { i++; continue; }
    if (events.length >= bound) break;
    events.push({ ...event, payload: event.payload });
    i++;
  }
  return c.json({ surface: surf, events, offset, limit });
});

memoryRouter.delete("/trace/:surface", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const dir = trace_dir(surf);
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      try {
        unlinkSync(join(dir, name));
        removed++;
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  return c.json({ surface: surf, removed_files: removed });
});

memoryRouter.delete("/trace/:surface/day/:day", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const day = c.req.param("day");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) {
    throw new HTTPException(400, { message: "day must be YYYY-MM-DD" });
  }
  const path = trace_file(surf, new Date(`${day}T00:00:00Z`));
  if (!existsSync(path)) {
    throw new HTTPException(404, { message: "no trace for that day" });
  }
  try {
    unlinkSync(path);
  } catch (exc) {
    throw new HTTPException(500, {
      message: exc instanceof Error ? exc.message : String(exc),
    });
  }
  return c.json({ surface: surf, day, deleted: true });
});

// ── Snapshot (L1 workspace mirror) ─────────────────────────────────────

memoryRouter.get("/snapshot/:surface", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const entities = snap.read_snapshot(surf);
  const pending = snap.pending_changes(surf, entities);
  const state = snap.current_state(surf);
  return c.json({
    surface: surf,
    entities: entities.map((e) => ({ ...e, metadata: { ...e.metadata } })),
    last_refresh: state["last_refresh"] ?? null,
    pending_changes: pending.map((ch) => ({ ...ch })),
  });
});

memoryRouter.post("/snapshot/:surface/refresh", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const changes = snap.refresh_snapshot(surf);
  const state = snap.current_state(surf);
  return c.json({
    surface: surf,
    changes: changes.map((ch) => ({ ...ch })),
    last_refresh: state["last_refresh"] ?? null,
  });
});

memoryRouter.get("/snapshot/:surface/changes", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  const limit = Number(c.req.query("limit") ?? "200") || 200;
  const offset = Number(c.req.query("offset") ?? "0") || 0;
  const entries = snap.read_changes(surf, { limit, offset } as never);
  return c.json({
    surface: surf,
    changes: entries.map((ch) => ({ ...ch })),
    limit,
    offset,
  });
});

memoryRouter.delete("/snapshot/:surface/changes", (c) => {
  const surf = validateSurface(c.req.param("surface"));
  snap.clear_changes(surf);
  return c.json({ surface: surf, cleared: true });
});
