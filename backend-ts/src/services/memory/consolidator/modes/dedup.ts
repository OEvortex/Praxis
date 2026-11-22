// Port of consolidator/modes/dedup.ts — iterative line-level dedup.
import { existsSync } from "node:fs";
import { l2_file, l3_file, type L3Slot, type Surface } from "../../paths.js";
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
  today_iso,
  write_doc_checkpoint,
  type OnEvent,
  type RunContext,
} from "../_runtime.js";
import { load_memory_settings } from "../../settings.js";
import { get_settings } from "../../../../config.js";
import type { Dict } from "../../../../shared/types.js";

export interface DedupResult {
  layer: string;
  key: string;
  iterations_run: number;
  edits_applied: number;
  converged_early: boolean;
}

export interface DedupOpts {
  language?: string;
  user_label?: string;
  iterations?: number | null;
  llm_selection?: Dict | null;
  on_event?: OnEvent | null;
  ctx?: RunContext | null;
}

export async function run_dedup(layer: string, key: string, opts: DedupOpts = {}): Promise<DedupResult> {
  const settings = load_memory_settings();
  const iters = opts.iterations ?? settings.dedup.iterations;
  const ctx: RunContext = {
    settings: opts.ctx?.settings ?? get_settings(),
    llm_selection: opts.llm_selection ?? opts.ctx?.llm_selection ?? null,
    run: opts.ctx?.run ?? null,
    signal: opts.ctx?.signal ?? null,
  };
  const { language = "en", user_label = "anonymous", on_event } = opts;
  const path = pathFor(layer, key);
  const empty = { layer, key, iterations_run: 0, edits_applied: 0, converged_early: true };
  if (!existsSync(path)) {
    await emit(on_event, { stage: "done", no_doc: true, edits_applied: 0 });
    return empty;
  }
  const doc = load_doc(path, { default_title: defaultTitle(layer, key) });
  const entryCount = doc.sections.reduce((n, [, es]) => n + es.length, 0);
  if (!entryCount) {
    await emit(on_event, { stage: "done", no_doc: true, edits_applied: 0 });
    return empty;
  }

  const prompt = load_prompt("dedup", language);
  let totalApplied = 0;
  let converged = false;
  let i = 0;
  for (i = 0; i < iters; i++) {
    if (ctx.signal?.aborted) {
      const e = new Error("cancelled"); e.name = "AbortError"; throw e;
    }
    const view = render_view(doc);
    await emit(on_event, {
      stage: "progress", mode: "dedup", turn: i + 1, total: iters, lines: view.lines.length,
    });
    const system = prompt.system
      .replaceAll("{user_label}", user_label)
      .replaceAll("{today}", today_iso());
    const user = prompt.user
      .replaceAll("{doc}", renderWithNumbers(view))
      .replaceAll("{iteration}", String(i + 1))
      .replaceAll("{iterations_total}", String(iters));
    const raw = await call_llm(
      { system_prompt: system, user_prompt: user, on_event, turn: i + 1, label: "dedup" },
      ctx,
    );
    const edits = parse_edits_payload(raw, { layer });
    if (!edits.length) {
      converged = true;
      await emit(on_event, { stage: "facts_extracted", turn: i + 1, edits: 0 });
      break;
    }
    const [newDoc, report] = apply_edits(doc, edits as Edit[]);
    doc.title = newDoc.title;
    doc.sections = newDoc.sections;
    totalApplied += report.applied.length;
    if (report.applied.length) {
      await write_doc_checkpoint(
        path, doc,
        { layer, key, on_event, turn: i + 1, label: "dedup", action: "apply_edits" },
        ctx,
      );
    }
    await emit(on_event, {
      stage: "op_applied", turn: i + 1,
      applied: report.applied.length, rejected: report.rejected.length,
    });
    if (!report.applied.length && !report.rejected.length) {
      converged = true;
      break;
    }
  }

  await emit(on_event, {
    stage: "done", edits_applied: totalApplied,
    iterations_run: Math.min(iters, i + 1), converged_early: converged,
  });

  if (load_memory_settings().merge.auto_after_dedup) {
    const { run_merge } = await import("./merge.js");
    await run_merge(layer, key, { language, user_label, on_event, ctx });
  }
  return {
    layer, key,
    iterations_run: Math.min(iters, i + 1),
    edits_applied: totalApplied,
    converged_early: converged,
  };
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

function renderWithNumbers(view: LineView): string {
  const width = Math.max(2, String(view.lines.length).length);
  return view.lines
    .map((line) => {
      let text = line.text;
      if (line.entry_id != null) {
        const entry = view.entry_by_id.get(line.entry_id);
        if (entry) {
          text += ` | refs=${JSON.stringify(entry.refs)}`;
        }
      }
      return `${String(line.number).padStart(width)}: ${text}`;
    })
    .join("\n");
}
