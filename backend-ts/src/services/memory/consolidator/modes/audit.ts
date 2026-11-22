// Port of consolidator/modes/audit.py — line-level edits vs raw evidence.
import { existsSync, readFileSync } from "node:fs";
import { l2_file, l3_file, SURFACES, type L3Slot, type Surface } from "../../paths.js";
import * as snap from "../../snapshot/index.js";
import { chunk_with_boundary } from "../chunker.js";
import {
  apply_edits,
  parse_edits_payload,
  render_view,
  type Edit,
  type LineView,
} from "../line_doc.js";
import {
  call_llm,
  emit,
  load_doc,
  load_prompt,
  slot_focus,
  surface_focus,
  today_iso,
  write_doc_checkpoint,
  type OnEvent,
  type RunContext,
} from "../_runtime.js";
import {
  annotate_l2_line_with_evidence,
  annotate_l3_line_with_evidence,
} from "../references.js";
import { parse as parseDoc, type Document, type Entry } from "../../document.js";
import type { Entity } from "../../snapshot/entity.js";
import { load_memory_settings, type MemorySettings } from "../../settings.js";
import { get_settings } from "../../../../config.js";
import type { Dict } from "../../../../shared/types.js";

export interface AuditResult {
  layer: string;
  key: string;
  chunks_processed: number;
  edits_applied?: number;
  edits_rejected?: number;
  no_doc?: boolean;
}

export interface AuditOpts {
  language?: string;
  user_label?: string;
  budget?: number | null;
  llm_selection?: Dict | null;
  on_event?: OnEvent | null;
  ctx?: RunContext | null;
}

export async function run_audit(layer: string, key: string, opts: AuditOpts = {}): Promise<AuditResult> {
  const settings = load_memory_settings();
  const ctx: RunContext = {
    settings: opts.ctx?.settings ?? get_settings(),
    llm_selection: opts.llm_selection ?? opts.ctx?.llm_selection ?? null,
    run: opts.ctx?.run ?? null,
    signal: opts.ctx?.signal ?? null,
  };
  if (layer === "L2") {
    return runAuditL2(key as Surface, {
      ...opts, budget: opts.budget ?? settings.audit.l2_budget, ctx, settings,
    });
  }
  if (layer === "L3") {
    return runAuditL3(key as L3Slot, {
      ...opts, budget: opts.budget ?? settings.audit.l3_budget, ctx, settings,
    });
  }
  throw new Error(`unknown layer ${JSON.stringify(layer)}`);
}

async function runAuditL2(
  surface: Surface,
  opts: AuditOpts & { budget: number; settings: MemorySettings; ctx: RunContext },
): Promise<AuditResult> {
  const { language = "en", user_label = "anonymous", on_event, ctx, settings, budget } = opts;
  const l2Path = l2_file(surface);
  if (!existsSync(l2Path)) {
    await emit(on_event, { stage: "done", no_doc: true });
    return { layer: "L2", key: surface, chunks_processed: 0, no_doc: true };
  }
  const doc = load_doc(l2Path, { default_title: `${surface} memory` });
  const auditView = render_view(doc);
  const entityLookup = new Map<string, Entity>(
    snap.read_snapshot(surface).map((e) => [e.id, e]),
  );
  const prompt = load_prompt("audit_l2", language);
  const [focus] = surface_focus(language, surface);

  const [annotatedText] = buildAnnotatedL2(doc, surface, entityLookup);
  const chunks = chunk_with_boundary(annotatedText, {
    budget,
    overlap_ratio: settings.chunking.overlap_ratio,
    min_chunk_chars: settings.chunking.min_chunk_chars,
    max_chunk_chars: settings.chunking.max_chunk_chars,
    boundary: settings.chunking.boundary,
  });
  await emit(on_event, {
    stage: "chunked", chunks: chunks.length, budget, chars: annotatedText.length,
  });

  let editsApplied = 0;
  let editsRejected = 0;
  for (const chunk of chunks) {
    if (ctx.signal?.aborted) throw abortErr();
    await emit(on_event, {
      stage: "progress", mode: "audit", turn: chunk.index + 1, total: chunks.length,
    });
    const system = prompt.system
      .replaceAll("{user_label}", user_label)
      .replaceAll("{surface}", surface)
      .replaceAll("{focus}", focus)
      .replaceAll("{today}", today_iso());
    const user = prompt.user
      .replaceAll("{surface}", surface)
      .replaceAll("{chunk}", chunk.text);
    const raw = await call_llm(
      { system_prompt: system, user_prompt: user, on_event, turn: chunk.index + 1, chunk_index: chunk.index, label: "audit" },
      ctx,
    );
    const edits = parse_edits_payload(raw, { layer: "L2" });
    if (!edits.length) {
      await emit(on_event, { stage: "facts_extracted", turn: chunk.index + 1, edits: 0 });
      continue;
    }
    const [newDoc, report] = apply_edits(doc, edits as Edit[], { view: auditView });
    // apply_edits returns a fresh doc; swap contents into `doc` so later
    // chunks keep mutating the same object upstream-style.
    doc.title = newDoc.title;
    doc.sections = newDoc.sections;
    editsApplied += report.applied.length;
    editsRejected += report.rejected.length;
    if (report.applied.length) {
      await write_doc_checkpoint(
        l2Path, doc,
        { layer: "L2", key: surface, on_event, turn: chunk.index + 1, label: "audit", action: "apply_edits" },
        ctx,
      );
    }
    for (const res of report.applied) {
      await emit(on_event, {
        stage: "op_applied", turn: chunk.index + 1,
        op: res.op.op, detail: res.detail ?? "",
      });
    }
    for (const res of report.rejected) {
      await emit(on_event, {
        stage: "op_rejected", turn: chunk.index + 1,
        op: res.op.op, detail: res.detail ?? "",
      });
    }
  }

  await emit(on_event, {
    stage: "done", edits_applied: editsApplied, edits_rejected: editsRejected,
    chunks_processed: chunks.length,
  });

  if (load_memory_settings().merge.auto_after_audit) {
    const { run_merge } = await import("./merge.js");
    await run_merge("L2", surface, { language, user_label, on_event, ctx });
  }
  return {
    layer: "L2", key: surface, chunks_processed: chunks.length,
    edits_applied: editsApplied, edits_rejected: editsRejected,
  };
}

async function runAuditL3(
  slot: L3Slot,
  opts: AuditOpts & { budget: number; settings: MemorySettings; ctx: RunContext },
): Promise<AuditResult> {
  const { language = "en", user_label = "anonymous", on_event, ctx, settings, budget } = opts;
  if (slot === "preferences") {
    throw new Error("preferences.md is not audited automatically");
  }
  const l3Path = l3_file(slot);
  if (!existsSync(l3Path)) {
    await emit(on_event, { stage: "done", no_doc: true });
    return { layer: "L3", key: slot, chunks_processed: 0, no_doc: true };
  }
  const doc = load_doc(l3Path, { default_title: `${slot} memory` });
  const auditView = render_view(doc);
  const l2Lookup = buildL2EntryLookup();
  const prompt = load_prompt("audit_l3", language);
  const [focus] = slot_focus(language, slot);

  const [annotatedText] = buildAnnotatedL3(doc, l2Lookup);
  const chunks = chunk_with_boundary(annotatedText, {
    budget,
    overlap_ratio: settings.chunking.overlap_ratio,
    min_chunk_chars: settings.chunking.min_chunk_chars,
    max_chunk_chars: settings.chunking.max_chunk_chars,
    boundary: settings.chunking.boundary,
  });
  await emit(on_event, {
    stage: "chunked", chunks: chunks.length, budget, chars: annotatedText.length,
  });

  let editsApplied = 0;
  let editsRejected = 0;
  for (const chunk of chunks) {
    if (ctx.signal?.aborted) throw abortErr();
    await emit(on_event, {
      stage: "progress", mode: "audit", turn: chunk.index + 1, total: chunks.length,
    });
    const system = prompt.system
      .replaceAll("{user_label}", user_label)
      .replaceAll("{slot}", slot)
      .replaceAll("{focus}", focus)
      .replaceAll("{today}", today_iso());
    const user = prompt.user
      .replaceAll("{slot}", slot)
      .replaceAll("{chunk}", chunk.text);
    const raw = await call_llm(
      { system_prompt: system, user_prompt: user, on_event, turn: chunk.index + 1, chunk_index: chunk.index, label: "audit" },
      ctx,
    );
    const edits = parse_edits_payload(raw, { layer: "L3" });
    if (!edits.length) {
      await emit(on_event, { stage: "facts_extracted", turn: chunk.index + 1, edits: 0 });
      continue;
    }
    const [newDoc, report] = apply_edits(doc, edits as Edit[], { view: auditView });
    doc.title = newDoc.title;
    doc.sections = newDoc.sections;
    editsApplied += report.applied.length;
    editsRejected += report.rejected.length;
    if (report.applied.length) {
      await write_doc_checkpoint(
        l3Path, doc,
        { layer: "L3", key: slot, on_event, turn: chunk.index + 1, label: "audit", action: "apply_edits" },
        ctx,
      );
    }
    for (const res of report.applied) {
      await emit(on_event, {
        stage: "op_applied", turn: chunk.index + 1,
        op: res.op.op, detail: res.detail ?? "",
      });
    }
    for (const res of report.rejected) {
      await emit(on_event, {
        stage: "op_rejected", turn: chunk.index + 1,
        op: res.op.op, detail: res.detail ?? "",
      });
    }
  }

  await emit(on_event, {
    stage: "done", edits_applied: editsApplied, edits_rejected: editsRejected,
    chunks_processed: chunks.length,
  });

  if (load_memory_settings().merge.auto_after_audit) {
    const { run_merge } = await import("./merge.js");
    await run_merge("L3", slot, { language, user_label, on_event, ctx });
  }
  return {
    layer: "L3", key: slot, chunks_processed: chunks.length,
    edits_applied: editsApplied, edits_rejected: editsRejected,
  };
}

// ── Annotation builders ───────────────────────────────────────────────

function renderLineIndex(view: LineView): string {
  const width = Math.max(2, String(view.lines.length).length);
  const body = view.lines
    .map((l) => `${String(l.number).padStart(width)}: ${l.text}`)
    .join("\n");
  return `# Line-numbered view (LLM-facing):\n${body}`;
}

function buildAnnotatedL2(
  doc: Document,
  surface: string,
  entityLookup: Map<string, Entity>,
): [string, Array<[number, number]>] {
  const view = render_view(doc);
  const pieces: string[] = [renderLineIndex(view)];
  const ranges: Array<[number, number]> = [];
  let cursor = pieces[0].length;
  for (const line of view.lines) {
    if (line.kind !== "bullet" || !line.entry_id) continue;
    const entry = view.entry_by_id.get(line.entry_id);
    if (!entry) continue;
    const block = annotate_l2_line_with_evidence(line.number, entry, {
      surface, entity_lookup: entityLookup,
    });
    const prefix = "\n\n";
    const start = cursor + prefix.length;
    pieces.push(prefix + block);
    cursor = start + block.length;
    ranges.push([start, cursor]);
  }
  return [pieces.join(""), ranges];
}

function buildAnnotatedL3(
  doc: Document,
  l2Lookup: Map<string, Entry>,
): [string, Array<[number, number]>] {
  const view = render_view(doc);
  const pieces: string[] = [renderLineIndex(view)];
  const ranges: Array<[number, number]> = [];
  let cursor = pieces[0].length;
  for (const line of view.lines) {
    if (line.kind !== "bullet" || !line.entry_id) continue;
    const entry = view.entry_by_id.get(line.entry_id);
    if (!entry) continue;
    const block = annotate_l3_line_with_evidence(line.number, entry, {
      l2_entry_lookup: l2Lookup,
    });
    const prefix = "\n\n";
    const start = cursor + prefix.length;
    pieces.push(prefix + block);
    cursor = start + block.length;
    ranges.push([start, cursor]);
  }
  return [pieces.join(""), ranges];
}

function buildL2EntryLookup(): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const surface of SURFACES) {
    const path = l2_file(surface);
    if (!existsSync(path)) continue;
    try {
      const doc = parseDoc(readFileSync(path, "utf-8"));
      for (const entry of doc.sections.flatMap(([, es]) => es)) {
        out.set(entry.id, entry);
      }
    } catch {
      continue;
    }
  }
  return out;
}

function abortErr(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}
