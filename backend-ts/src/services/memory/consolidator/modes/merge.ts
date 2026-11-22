// Port of consolidator/modes/merge.py — no-LLM footnote consolidation +
// L3 legacy m_<ULID> ref migration to bare surface names.
import { existsSync, readFileSync } from "node:fs";
import { l2_file, l3_file, SURFACES, type L3Slot, type Surface } from "../../paths.js";
import { emit, load_doc, write_doc_checkpoint, type OnEvent, type RunContext } from "../_runtime.js";
import { is_entry_id } from "../../ids.js";
import { parse as parseDoc, serialize, type Document } from "../../document.js";
import type { Dict } from "../../../../shared/types.js";

export interface MergeResult {
  layer: string;
  key: string;
  footnote_rows_before: number;
  footnote_rows_after: number;
  rewrote: boolean;
  legacy_l3_refs_migrated?: number;
}

const FOOTNOTE_DEF_RE = /^\[\^[^\]]+\]:\s*/gm;

export interface MergeOpts {
  language?: string;
  user_label?: string;
  on_event?: OnEvent | null;
  ctx?: RunContext | null;
}

export async function run_merge(layer: string, key: string, opts: MergeOpts = {}): Promise<MergeResult> {
  const { on_event, ctx } = opts;
  const path = pathFor(layer, key);
  if (!existsSync(path)) {
    await emit(on_event, { stage: "done", no_doc: true, rewrote: false });
    return {
      layer, key, footnote_rows_before: 0, footnote_rows_after: 0, rewrote: false,
    };
  }

  const rawBefore = readFileSync(path, "utf-8");
  const rowsBefore = (rawBefore.match(FOOTNOTE_DEF_RE) ?? []).length;
  const doc = load_doc(path, { default_title: defaultTitle(layer, key) });

  let legacyMigrated = 0;
  if (layer === "L3") legacyMigrated = migrateL3LegacyRefs(doc);

  const uniqueRefs = new Set<string>();
  for (const entry of doc.sections.flatMap(([, es]) => es)) {
    for (const ref of entry.refs) uniqueRefs.add(ref);
  }
  const rowsAfter = uniqueRefs.size;

  await emit(on_event, {
    stage: "progress", mode: "merge",
    footnote_rows_before: rowsBefore,
    footnote_rows_after: rowsAfter,
    legacy_l3_refs_migrated: legacyMigrated,
  });

  const expected = serialize(doc);
  const rewrote = rawBefore !== expected;
  if (rewrote) {
    await write_doc_checkpoint(
      path, doc,
      { layer, key, on_event, turn: 1, label: "merge", action: "merge_footnotes" },
      ctx,
    );
  }

  await emit(on_event, {
    stage: "done",
    footnote_rows_before: rowsBefore,
    footnote_rows_after: rowsAfter,
    rewrote,
    legacy_l3_refs_migrated: legacyMigrated,
  });
  return {
    layer, key,
    footnote_rows_before: rowsBefore,
    footnote_rows_after: rowsAfter,
    rewrote,
    legacy_l3_refs_migrated: legacyMigrated,
  };
}

function migrateL3LegacyRefs(doc: Document): number {
  const l2Owner = new Map<string, string>();
  for (const surface of SURFACES) {
    const path = l2_file(surface);
    if (!existsSync(path)) continue;
    try {
      const l2Doc = parseDoc(readFileSync(path, "utf-8"));
      for (const entry of l2Doc.sections.flatMap(([, es]) => es)) {
        if (!l2Owner.has(entry.id)) l2Owner.set(entry.id, surface);
      }
    } catch {
      continue;
    }
  }

  let migrated = 0;
  for (const entry of doc.sections.flatMap(([, es]) => es)) {
    if (!entry.refs.length) continue;
    const newRefs: string[] = [];
    const seen = new Set<string>();
    for (const ref of entry.refs) {
      if (is_entry_id(ref)) {
        migrated++;
        const resolved = l2Owner.get(ref);
        if (resolved === undefined || seen.has(resolved)) continue;
        seen.add(resolved);
        newRefs.push(resolved);
      } else {
        if (seen.has(ref)) continue;
        seen.add(ref);
        newRefs.push(ref);
      }
    }
    entry.refs = newRefs;
  }
  return migrated;
}

function pathFor(layer: string, key: string): string {
  if (layer === "L2") return l2_file(key as Surface);
  if (layer === "L3") return l3_file(key as L3Slot);
  throw new Error(`unknown layer ${JSON.stringify(layer)}`);
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

void (0 as unknown as Dict);
