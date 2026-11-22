// Port of consolidator/modes/_shims.ts — legacy consolidate_l2/l3 wrappers
// around run_update (kept for MemoryStore.update_l2/update_l3).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { l2_file, l3_file, type L3Slot, type Surface } from "../../paths.js";
import { parse as parseDoc, serialize, type Document } from "../../document.js";
import type { ApplyReport, Op } from "../../ops.js";
import { run_update, type UpdateResult } from "./update.js";
import type { OnEvent, RunContext } from "../_runtime.js";
import type { Dict } from "../../../../shared/types.js";

export interface ConsolidateResult {
  report: ApplyReport;
  backlog_count: number;
  proposed_ops: Op[];
}

export interface ShimOpts {
  language?: string;
  user_label?: string;
  on_event?: OnEvent | null;
  apply_ops?: boolean;
  ctx?: RunContext | null;
  llm_selection?: Dict | null;
}

export async function consolidate_l2(surface: Surface, opts: ShimOpts = {}): Promise<ConsolidateResult> {
  const result = await run_update("L2", surface, {
    language: opts.language,
    user_label: opts.user_label,
    on_event: opts.on_event,
    ctx: opts.ctx,
    llm_selection: opts.llm_selection,
  });
  if (opts.apply_ops === false) {
    rollbackNewEntries("L2", surface, result.new_entry_ids);
  }
  return toConsolidateResult(result);
}

export async function consolidate_l3(slot: L3Slot, opts: ShimOpts = {}): Promise<ConsolidateResult> {
  if (slot === "preferences") {
    throw new Error("preferences.md is not auto-consolidated");
  }
  const result = await run_update("L3", slot, {
    language: opts.language,
    user_label: opts.user_label,
    on_event: opts.on_event,
    ctx: opts.ctx,
    llm_selection: opts.llm_selection,
  });
  if (opts.apply_ops === false) {
    rollbackNewEntries("L3", slot, result.new_entry_ids);
  }
  return toConsolidateResult(result);
}

function toConsolidateResult(result: UpdateResult): ConsolidateResult {
  const reason = result.no_new_input
    ? "no new input"
    : `applied via chunk-update (${result.facts_added} added)`;
  return {
    report: { accepted: true, reason, results: [] },
    backlog_count: result.chunks_processed,
    proposed_ops: [],
  };
}

function rollbackNewEntries(layer: string, key: string, ids: string[]): void {
  if (!ids.length) return;
  const path = layer === "L2" ? l2_file(key as Surface) : l3_file(key as L3Slot);
  if (!existsSync(path)) return;
  const doc = parseDoc(readFileSync(path, "utf-8"));
  const drop = new Set(ids);
  doc.sections = doc.sections
    .map(([name, entries]) => [name, entries.filter((e) => !drop.has(e.id))] as [string, typeof entries])
    .filter(([, entries]) => entries.length > 0);
  writeFileSync(path, serialize(doc), "utf-8");
}
