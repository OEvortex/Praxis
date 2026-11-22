// Port of consolidator/modes/update.py — chunk-based incremental fact
// extraction (L2 from snapshot entities, L3 from L2 entries).
import { existsSync } from "node:fs";
import { l2_file, l3_file, SURFACES, type L3Slot, type Surface } from "../../paths.js";
import * as snap from "../../snapshot/index.js";
import { chunk_with_boundary } from "../chunker.js";
import { load_l2_meta, load_l3_meta, save_l2_meta, save_l3_meta } from "../meta.js";
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
  collect_l2_entries,
  refs_in_span_l2,
  refs_in_span_l3,
  render_l2_entries_for_concat,
  render_traces_for_concat,
  validate_fact_refs,
  type ExtractedFact,
} from "../references.js";
import { parse as parseDoc, serialize, type Document, type Entry } from "../../document.js";
import { apply as applyOps, type AddOp } from "../../ops.js";
import { load_memory_settings, type MemorySettings } from "../../settings.js";
import type { Dict } from "../../../../shared/types.js";

export interface UpdateResult {
  layer: string;
  key: string;
  chunks_processed: number;
  facts_added: number;
  refs_dropped: number;
  new_entry_ids: string[];
  no_new_input: boolean;
}

export interface UpdateOpts {
  language?: string;
  user_label?: string;
  budget?: number | null;
  llm_selection?: Dict | null;
  on_event?: OnEvent | null;
  ctx?: RunContext | null;
}

function cancelled(ctx?: RunContext | null): boolean {
  return ctx?.signal?.aborted === true;
}

export async function run_update(
  layer: string,
  key: string,
  opts: UpdateOpts = {},
): Promise<UpdateResult> {
  const settings = load_memory_settings();
  const ctx: RunContext = {
    settings: opts.ctx?.settings ?? (settings && (await import("../../../../config.js")).get_settings()),
    llm_selection: opts.llm_selection ?? opts.ctx?.llm_selection ?? null,
    run: opts.ctx?.run ?? null,
    signal: opts.ctx?.signal ?? null,
  };
  if (layer === "L2") {
    return runUpdateL2(key as Surface, {
      ...opts,
      budget: opts.budget ?? settings.update.l2_budget,
      ctx,
      settings,
    });
  }
  if (layer === "L3") {
    return runUpdateL3(key as L3Slot, {
      ...opts,
      budget: opts.budget ?? settings.update.l3_budget,
      ctx,
      settings,
    });
  }
  throw new Error(`unknown layer ${JSON.stringify(layer)}`);
}

// ── L2 ────────────────────────────────────────────────────────────────

async function runUpdateL2(
  surface: Surface,
  opts: UpdateOpts & { budget: number; settings: MemorySettings; ctx: RunContext },
): Promise<UpdateResult> {
  const { language = "en", user_label = "anonymous", on_event, ctx, settings, budget } = opts;
  const meta = load_l2_meta(surface);
  const allEntities = [...snap.read_snapshot(surface)].sort((a, b) =>
    (a.ts || "") + a.id < (b.ts || "") + b.id ? -1 : 1,
  );
  const l2Path = l2_file(surface);
  const seen = existsSync(l2Path) ? meta.seen_entity_refs : new Set<string>();
  const newEntities = allEntities.filter((e) => !seen.has(`${surface}:${e.id}`));
  const seenNow = new Set(allEntities.map((e) => `${surface}:${e.id}`));

  await emit(on_event, {
    stage: "trace_loaded",
    surface,
    total: allEntities.length,
    new: newEntities.length,
  });

  if (!newEntities.length) {
    save_l2_meta(surface, { seen_entity_refs: seenNow });
    if (settings.merge.auto_after_update) {
      const { run_merge } = await import("./merge.js");
      await run_merge("L2", surface, { language, user_label, on_event, ctx });
    }
    await emit(on_event, { stage: "done", no_new_input: true, facts_added: 0 });
    return {
      layer: "L2", key: surface, chunks_processed: 0, facts_added: 0,
      refs_dropped: 0, new_entry_ids: [], no_new_input: true,
    };
  }

  const text = render_traces_for_concat(newEntities, { surface });
  const chunks = chunk_with_boundary(text, {
    budget,
    overlap_ratio: settings.chunking.overlap_ratio,
    min_chunk_chars: settings.chunking.min_chunk_chars,
    max_chunk_chars: settings.chunking.max_chunk_chars,
    boundary: settings.chunking.boundary,
  });
  await emit(on_event, {
    stage: "chunked", chunks: chunks.length, budget, chars: text.length,
  });

  const prompt = load_prompt("update_l2", language);
  const [focus, sections] = surface_focus(language, surface);
  const doc = load_doc(l2Path, { default_title: `${surface} memory` });

  let factsAdded = 0;
  let refsDropped = 0;
  const newEntryIds: string[] = [];

  for (const chunk of chunks) {
    if (cancelled(ctx)) throw abortError();
    await emit(on_event, {
      stage: "progress", mode: "update", turn: chunk.index + 1,
      total: chunks.length, chunk_start: chunk.start, chunk_end: chunk.end,
    });
    const system = prompt.system
      .replaceAll("{user_label}", user_label)
      .replaceAll("{surface}", surface)
      .replaceAll("{sections}", sections.length ? sections.join(", ") : "(any)")
      .replaceAll("{focus}", focus)
      .replaceAll("{today}", today_iso());
    const allowed = refs_in_span_l2(newEntities, {
      surface, full_text: text, start: chunk.start, end: chunk.end,
    });
    const user = prompt.user
      .replaceAll("{surface}", surface)
      .replaceAll("{existing}", renderExistingL2(doc))
      .replaceAll("{chunk}", chunkWithRefHeader(chunk.text, allowed))
      .replaceAll("{chunk_index}", String(chunk.index + 1))
      .replaceAll("{chunk_total}", String(chunks.length))
      .replaceAll("{chunk_start}", String(chunk.start))
      .replaceAll("{chunk_end}", String(chunk.end));
    const raw = await call_llm(
      { system_prompt: system, user_prompt: user, on_event, turn: chunk.index + 1, chunk_index: chunk.index, label: "update" },
      ctx,
    );
    const facts = parseFacts(raw);

    const keptInChunk: ExtractedFact[] = [];
    for (const fact of facts) {
      const [keptRefs, rejectReason] = validate_fact_refs(fact, {
        allowed,
        enforce_required: settings.reference.enforce_required,
        drop_invalid: settings.reference.drop_invalid_refs,
      });
      if (rejectReason !== null) {
        refsDropped++;
        await emit(on_event, {
          stage: "refs_dropped", turn: chunk.index + 1,
          reason: rejectReason, text: fact.text.slice(0, 120),
        });
        continue;
      }
      keptInChunk.push({ text: fact.text, refs: keptRefs, section: fact.section });
    }

    const addedNow = appendFactsToDoc(doc, keptInChunk, sections);
    factsAdded += addedNow.length;
    newEntryIds.push(...addedNow);
    if (addedNow.length) {
      await write_doc_checkpoint(
        l2Path, doc,
        { layer: "L2", key: surface, on_event, turn: chunk.index + 1, label: "update", action: "append_facts" },
        ctx,
      );
    }
    await emit(on_event, {
      stage: "facts_extracted", turn: chunk.index + 1,
      kept: keptInChunk.length, added: addedNow.length,
    });
  }

  save_l2_meta(surface, { seen_entity_refs: seenNow });
  await emit(on_event, {
    stage: "done", facts_added: factsAdded, refs_dropped: refsDropped,
    chunks_processed: chunks.length, auto_dedup: settings.dedup.auto_after_update,
  });

  if (settings.dedup.auto_after_update && factsAdded > 0) {
    const { run_dedup } = await import("./dedup.js");
    await run_dedup("L2", surface, {
      language, user_label, iterations: settings.dedup.iterations,
      llm_selection: opts.llm_selection, on_event, ctx,
    });
  }
  if (settings.merge.auto_after_update) {
    const { run_merge } = await import("./merge.js");
    await run_merge("L2", surface, { language, user_label, on_event, ctx });
  }

  return {
    layer: "L2", key: surface, chunks_processed: chunks.length,
    facts_added: factsAdded, refs_dropped: refsDropped,
    new_entry_ids: newEntryIds, no_new_input: false,
  };
}

// ── L3 ────────────────────────────────────────────────────────────────

async function runUpdateL3(
  slot: L3Slot,
  opts: UpdateOpts & { budget: number; settings: MemorySettings; ctx: RunContext },
): Promise<UpdateResult> {
  const { language = "en", user_label = "anonymous", on_event, ctx, settings, budget } = opts;
  if (slot === "preferences") {
    throw new Error("preferences.md is not auto-consolidated");
  }
  const meta = load_l3_meta(slot);
  const l2Docs = loadAllL2Docs();
  const entriesBySurface: Record<string, Entry[]> = {};
  const seenNow = new Map<string, Set<string>>();
  for (const [surface, doc] of Object.entries(l2Docs)) {
    const all = doc.sections.flatMap(([, es]) => es);
    seenNow.set(surface, new Set(all.map((e) => e.id)));
    const prev = meta.seen_l2_entry_ids.get(surface) ?? new Set<string>();
    entriesBySurface[surface] = all
      .filter((e) => !prev.has(e.id))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const newCount = Object.values(entriesBySurface).reduce((n, v) => n + v.length, 0);
  const totalCount = Object.values(l2Docs).reduce(
    (n, d) => n + d.sections.reduce((m, [, es]) => m + es.length, 0), 0,
  );
  await emit(on_event, {
    stage: "trace_loaded", slot, total_l2_entries: totalCount, new_l2_entries: newCount,
  });

  if (newCount === 0) {
    save_l3_meta(slot, { seen_l2_entry_ids: seenNow });
    if (settings.merge.auto_after_update) {
      const { run_merge } = await import("./merge.js");
      await run_merge("L3", slot, { language, user_label, on_event, ctx });
    }
    await emit(on_event, { stage: "done", no_new_input: true, facts_added: 0 });
    return {
      layer: "L3", key: slot, chunks_processed: 0, facts_added: 0,
      refs_dropped: 0, new_entry_ids: [], no_new_input: true,
    };
  }

  const text = render_l2_entries_for_concat(entriesBySurface);
  const chunks = chunk_with_boundary(text, {
    budget,
    overlap_ratio: settings.chunking.overlap_ratio,
    min_chunk_chars: settings.chunking.min_chunk_chars,
    max_chunk_chars: settings.chunking.max_chunk_chars,
    boundary: settings.chunking.boundary,
  });
  await emit(on_event, {
    stage: "chunked", chunks: chunks.length, budget, chars: text.length,
  });

  const prompt = load_prompt("update_l3", language);
  const [focus, sections] = slot_focus(language, slot);
  const l3Path = l3_file(slot);
  const doc = load_doc(l3Path, { default_title: defaultL3Title(slot) });

  let factsAdded = 0;
  let refsDropped = 0;
  const newEntryIds: string[] = [];

  for (const chunk of chunks) {
    if (cancelled(ctx)) throw abortError();
    await emit(on_event, {
      stage: "progress", mode: "update", turn: chunk.index + 1,
      total: chunks.length, chunk_start: chunk.start, chunk_end: chunk.end,
    });
    const system = prompt.system
      .replaceAll("{user_label}", user_label)
      .replaceAll("{slot}", slot)
      .replaceAll("{sections}", sections.length ? sections.join(", ") : "(any)")
      .replaceAll("{focus}", focus)
      .replaceAll("{today}", today_iso());
    const allowed = refs_in_span_l3({
      entries_by_surface: entriesBySurface,
      full_text: text, start: chunk.start, end: chunk.end,
    });
    const user = prompt.user
      .replaceAll("{slot}", slot)
      .replaceAll("{existing}", renderExisting(doc))
      .replaceAll("{chunk}", chunkWithRefHeader(chunk.text, allowed))
      .replaceAll("{chunk_index}", String(chunk.index + 1))
      .replaceAll("{chunk_total}", String(chunks.length));
    const raw = await call_llm(
      { system_prompt: system, user_prompt: user, on_event, turn: chunk.index + 1, chunk_index: chunk.index, label: "update" },
      ctx,
    );
    const facts = parseFacts(raw);

    const keptInChunk: ExtractedFact[] = [];
    for (const fact of facts) {
      const [keptRefs, rejectReason] = validate_fact_refs(fact, {
        allowed,
        enforce_required: settings.reference.enforce_required,
        drop_invalid: settings.reference.drop_invalid_refs,
      });
      if (rejectReason !== null) {
        refsDropped++;
        await emit(on_event, {
          stage: "refs_dropped", turn: chunk.index + 1,
          reason: rejectReason, text: fact.text.slice(0, 120),
        });
        continue;
      }
      keptInChunk.push({ text: fact.text, refs: keptRefs, section: fact.section });
    }

    const addedNow = appendFactsToDoc(doc, keptInChunk, sections);
    factsAdded += addedNow.length;
    newEntryIds.push(...addedNow);
    if (addedNow.length) {
      await write_doc_checkpoint(
        l3Path, doc,
        { layer: "L3", key: slot, on_event, turn: chunk.index + 1, label: "update", action: "append_facts" },
        ctx,
      );
    }
    await emit(on_event, {
      stage: "facts_extracted", turn: chunk.index + 1,
      kept: keptInChunk.length, added: addedNow.length,
    });
  }

  save_l3_meta(slot, { seen_l2_entry_ids: seenNow });
  await emit(on_event, {
    stage: "done", facts_added: factsAdded, refs_dropped: refsDropped,
    chunks_processed: chunks.length, auto_dedup: settings.dedup.auto_after_update,
  });

  if (settings.dedup.auto_after_update && factsAdded > 0) {
    const { run_dedup } = await import("./dedup.js");
    await run_dedup("L3", slot, {
      language, user_label, iterations: settings.dedup.iterations,
      llm_selection: opts.llm_selection, on_event, ctx,
    });
  }
  if (settings.merge.auto_after_update) {
    const { run_merge } = await import("./merge.js");
    await run_merge("L3", slot, { language, user_label, on_event, ctx });
  }

  return {
    layer: "L3", key: slot, chunks_processed: chunks.length,
    facts_added: factsAdded, refs_dropped: refsDropped,
    new_entry_ids: newEntryIds, no_new_input: false,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function abortError(): Error {
  const e = new Error("cancelled");
  e.name = "AbortError";
  return e;
}

function parseFacts(raw: string): ExtractedFact[] {
  if (!raw) return [];
  const snippet = extractJsonObject(raw);
  if (snippet === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return [];
  }
  const items = data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Dict)["facts"]
    : null;
  if (!Array.isArray(items)) return [];
  const out: ExtractedFact[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const it = item as Dict;
    const text = String(it["text"] ?? "").trim();
    const section = String(it["section"] ?? "").trim();
    const refsRaw = it["refs"];
    const refs = (Array.isArray(refsRaw) ? refsRaw : [])
      .map((r) => String(r).trim())
      .filter(Boolean);
    if (!text) continue;
    out.push({ text, refs, section });
  }
  return out;
}

function extractJsonObject(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith("```")) {
    const nl = text.indexOf("\n");
    text = nl === -1 ? text : text.slice(nl + 1);
    if (text.trimEnd().endsWith("```")) text = text.trimEnd().slice(0, -3);
  }
  const start = text.indexOf("{");
  if (start === -1) return null;
  // raw_decode equivalent: find the first balanced {...}.
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function appendFactsToDoc(
  doc: Document,
  facts: ExtractedFact[],
  allowedSections: string[],
): string[] {
  const newIds: string[] = [];
  const fallback = allowedSections[0] ?? "Notes";
  for (const fact of facts) {
    let section = fact.section || fallback;
    if (allowedSections.length && !allowedSections.includes(section)) {
      section = fallback;
    }
    const op: AddOp = { op: "add", section, text: fact.text, refs: fact.refs };
    const report = applyOps(doc, [op]);
    if (report.accepted && report.results.length) {
      const id = report.results[0].entry_id;
      if (id) newIds.push(id);
    }
  }
  return newIds;
}

function renderExisting(doc: Document): string {
  const count = doc.sections.reduce((n, [, es]) => n + es.length, 0);
  if (!count) return "(empty — first run)";
  return serialize(doc).trim();
}

function renderExistingL2(doc: Document): string {
  return renderExisting(doc);
}

function chunkWithRefHeader(chunkText: string, allowed: Set<string>): string {
  if (!allowed.size) return chunkText;
  const refs = [...allowed].sort().map((r) => `- ${r}`).join("\n");
  return `# Chunk-local citeable refs\n${refs}\n\n${chunkText}`;
}

function loadAllL2Docs(): Record<string, Document> {
  const docs: Record<string, Document> = {};
  for (const surface of SURFACES) {
    const path = l2_file(surface);
    if (!existsSync(path)) continue;
    try {
      docs[surface] = parseDoc(
        (await0_read(path)),
      );
    } catch {
      continue;
    }
  }
  return docs;
}

import { readFileSync } from "node:fs";
function await0_read(path: string): string {
  return readFileSync(path, "utf-8");
}

function defaultL3Title(slot: L3Slot): string {
  return (
    {
      recent: "Recent summary",
      profile: "User profile",
      scope: "Knowledge scope",
      preferences: "Preferences",
    } as Record<string, string>
  )[slot];
}

// keep collect_l2_entries referenced for parity
void collect_l2_entries;
