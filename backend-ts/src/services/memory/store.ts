// Port of deeptutor/services/memory/store.py — MemoryStore facade.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { l2_file, l3_file, memory_root, backup_root, SURFACES, L3_SLOTS, type L3Slot, type Surface } from "./paths.js";
import * as paths from "./paths.js";
import * as trace from "./trace.js";
import { parse as parseDoc, serialize, newDocument, remove_entry, all_entries, type Document } from "./document.js";
import { apply as opsApply, type ApplyReport, type Op } from "./ops.js";
import { consolidate_l2, consolidate_l3 } from "./consolidator/modes/shims.js";
import { parse_ops_response } from "./consolidator/parse.js";
import type { TraceEvent } from "./trace.js";
import type { Dict } from "../../shared/types.js";

export type Layer = "L2" | "L3";

const V1_FILES = ["PROFILE.md", "SOUL.md", "SUMMARY.md"];
const NO_MEMORY =
  "(No memory available — interact with DeepTutor and update from the Memory page to build one.)";

export interface DocOverview {
  layer: Layer;
  key: string;
  exists: boolean;
  updated_at: string | null;
  entry_count: number;
  backlog: number;
}

function normalizePrefText(text: string): string {
  return (text || "").split(/\s+/).filter(Boolean).join(" ").toLowerCase();
}

function findDuplicatePreference(doc: Document, section: string, text: string) {
  const target = normalizePrefText(text);
  if (!target) return null;
  for (const entry of all_entries(doc)) {
    if (entry.section === section && normalizePrefText(entry.text) === target) {
      return entry;
    }
  }
  return null;
}

export class MemoryStore {
  async emit(event: TraceEvent): Promise<void> {
    await trace.append(event);
  }

  read_doc(layer: Layer, key: string): Document {
    const path = this._path(layer, key);
    if (!existsSync(path)) return newDocument(defaultTitle(layer, key));
    try {
      return parseDoc(readFileSync(path, "utf-8"));
    } catch {
      return newDocument(defaultTitle(layer, key));
    }
  }

  read_raw(layer: Layer, key: string): string {
    const path = this._path(layer, key);
    if (!existsSync(path)) return "";
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return "";
    }
  }

  read_l3_concat(): string {
    const parts: string[] = [];
    for (const slot of paths.L3_SLOTS) {
      const body = this.read_raw("L3", slot).trim();
      if (body) parts.push(body);
    }
    if (!parts.length) return NO_MEMORY;
    return parts.join("\n\n---\n\n") + "\n";
  }

  async overwrite_doc(layer: Layer, key: string, md: string): Promise<void> {
    const path = this._path(layer, key);
    atomicWrite(path, md);
  }

  async delete_entry(layer: Layer, key: string, entryId: string): Promise<boolean> {
    const path = this._path(layer, key);
    if (!existsSync(path)) return false;
    const doc = parseDoc(readFileSync(path, "utf-8"));
    if (!remove_entry(doc, entryId)) return false;
    atomicWrite(path, serialize(doc));
    return true;
  }

  async update_l2(
    surface: Surface,
    opts: { language?: string; user_label?: string; on_event?: unknown; apply_ops?: boolean; llm_selection?: Dict | null } = {},
  ) {
    return consolidate_l2(surface, {
      language: opts.language,
      user_label: opts.user_label,
      on_event: opts.on_event as never,
      apply_ops: opts.apply_ops,
      llm_selection: opts.llm_selection,
    });
  }

  async update_l3(
    slot: L3Slot,
    opts: { language?: string; user_label?: string; on_event?: unknown; apply_ops?: boolean; llm_selection?: Dict | null } = {},
  ) {
    if (slot === "preferences") throw new Error("preferences.md is not auto-consolidated");
    return consolidate_l3(slot, {
      language: opts.language,
      user_label: opts.user_label,
      on_event: opts.on_event as never,
      apply_ops: opts.apply_ops,
      llm_selection: opts.llm_selection,
    });
  }

  async apply_ops_payload(layer: Layer, key: string, opsPayload: unknown[]): Promise<ApplyReport> {
    const path = this._path(layer, key);
    const ops = parse_ops_response(JSON.stringify({ ops: opsPayload }));
    const doc = existsSync(path)
      ? parseDoc(readFileSync(path, "utf-8"))
      : newDocument(defaultTitle(layer, key));
    const report = opsApply(doc, ops);
    if (report.accepted && ops.length) {
      mkdirSync(dirname(path), { recursive: true });
      atomicWrite(path, serialize(doc));
    }
    return report;
  }

  async write_preference(opts: {
    op: "add" | "edit";
    text: string;
    target_id?: string | null;
    reason?: string | null;
    trace_id: string;
  }): Promise<ApplyReport> {
    const path = l3_file("preferences");
    const doc = existsSync(path)
      ? parseDoc(readFileSync(path, "utf-8"))
      : newDocument(defaultTitle("L3", "preferences"));
    const section = "Preferences";
    let report: ApplyReport;
    if (opts.op === "add") {
      const duplicate = findDuplicatePreference(doc, section, opts.text);
      if (duplicate) {
        return {
          accepted: true,
          results: [
            {
              op: { op: "add", section, text: opts.text, refs: [opts.trace_id] },
              status: "applied",
              entry_id: duplicate.id,
              detail: "duplicate",
            },
          ],
        };
      }
      report = opsApply(doc, [
        { op: "add", section, text: opts.text, refs: [opts.trace_id] },
      ]);
    } else {
      if (!opts.target_id) {
        return { accepted: false, results: [], reason: "edit requires target_id" };
      }
      report = opsApply(doc, [
        {
          op: "edit",
          target_id: opts.target_id,
          new_text: opts.text,
          new_refs: [opts.trace_id],
        },
      ]);
    }
    if (report.accepted) atomicWrite(path, serialize(doc));
    return report;
  }

  overview(): DocOverview[] {
    const rows: DocOverview[] = [];
    for (const surface of SURFACES) rows.push(this.overviewFor("L2", surface));
    for (const slot of L3_SLOTS) rows.push(this.overviewFor("L3", slot));
    return rows;
  }

  private overviewFor(layer: Layer, key: string): DocOverview {
    const path = this._path(layer, key);
    if (!existsSync(path)) {
      const backlog = layer === "L2" ? trace.count_since(key as Surface) : 0;
      return { layer, key, exists: false, updated_at: null, entry_count: 0, backlog };
    }
    const stat = statSync(path);
    const updatedAt = new Date(stat.mtimeMs).toISOString();
    let entryCount = 0;
    try {
      entryCount = all_entries(parseDoc(readFileSync(path, "utf-8"))).length;
    } catch {
      entryCount = 0;
    }
    let backlog = 0;
    if (layer === "L2") {
      try {
        backlog = trace.count_since(key as Surface, new Date(stat.mtimeMs));
      } catch {
        backlog = 0;
      }
    }
    return { layer, key, exists: true, updated_at: updatedAt, entry_count: entryCount, backlog };
  }

  private _path(layer: Layer, key: string): string {
    if (layer === "L2") {
      if (!(SURFACES as readonly string[]).includes(key)) {
        throw new Error(`unknown surface ${JSON.stringify(key)}`);
      }
      return l2_file(key as Surface);
    }
    if (!(L3_SLOTS as readonly string[]).includes(key)) {
      throw new Error(`unknown L3 slot ${JSON.stringify(key)}`);
    }
    return l3_file(key as L3Slot);
  }
}

function atomicWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

function defaultTitle(layer: Layer, key: string): string {
  if (layer === "L2") return `${key} memory`;
  return (
    {
      recent: "Recent summary",
      profile: "User profile",
      scope: "Knowledge scope",
      preferences: "Preferences",
    } as Record<string, string>
  )[key] ?? key;
}

// ── v1 → v2 startup migration ──────────────────────────────────────────

export function migrate_v1_if_needed(): string | null {
  const root = memory_root();
  if (!existsSync(root)) return null;
  const v1Present = V1_FILES.filter((name) => existsSync(join(root, name)));
  if (!v1Present.length) return null;

  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "T") + "Z";
  const stamp = ts.replace(/\..*/, "");
  const backupDir = join(backup_root(), stamp);
  mkdirSync(backupDir, { recursive: true });
  for (const item of readdirSync(root)) {
    if (["trace", "L2", "L3", "backup"].includes(item)) continue;
    try {
      renameSync(join(root, item), join(backupDir, item));
    } catch {
      // best effort
    }
  }
  return backupDir;
}

export function migrate_partner_surface_if_needed(): boolean {
  const root = memory_root();
  if (!existsSync(root)) return false;
  let moved = false;
  const { renameSync: rn, writeFileSync: wf, unlinkSync: ul } = { renameSync, writeFileSync, unlinkSync: (p: string) => { try { require("node:fs").unlinkSync(p); } catch { /* noop */ } } };
  void rn; void wf; void ul;
  // tutorbot → partner rename (idempotent, mirrors upstream).
  const l2 = paths.l2_dir();
  const oldMd = join(l2, "tutorbot.md");
  const newMd = join(l2, "partner.md");
  if (existsSync(oldMd) && !existsSync(newMd)) {
    let text = readFileSync(oldMd, "utf-8");
    text = text.replaceAll("tutorbot:", "partner:");
    text = text.replace(/\btutorbot\b/g, "partner");
    text = text.replace(/\bTutorbot\b/g, "Partner");
    writeFileSync(newMd, text, "utf-8");
    try { (await_import_unlink(oldMd)); } catch { /* noop */ }
    moved = true;
  }
  const oldMeta = join(l2, "tutorbot.meta.json");
  const newMeta = join(l2, "partner.meta.json");
  if (existsSync(oldMeta) && !existsSync(newMeta)) {
    writeFileSync(newMeta, readFileSync(oldMeta, "utf-8").replaceAll("tutorbot:", "partner:"), "utf-8");
    try { unlink(oldMd); } catch { /* noop */ }
    try { unlink(oldMeta); } catch { /* noop */ }
    moved = true;
  }
  for (const sub of ["snapshot", "trace"]) {
    const oldDir = join(root, sub, "tutorbot");
    const newDir = join(root, sub, "partner");
    if (existsSync(oldDir) && !existsSync(newDir)) {
      try { renameSync(oldDir, newDir); moved = true; } catch { /* noop */ }
    }
  }
  const l3 = paths.l3_dir();
  try {
    for (const metaPath of readdirSync(l3).filter((n) => n.endsWith(".meta.json"))) {
      const p = join(l3, metaPath);
      try {
        const data = JSON.parse(readFileSync(p, "utf-8")) as Dict;
        const seen = data["seen_l2_entry_ids"];
        if (seen && typeof seen === "object" && !Array.isArray(seen)) {
          const s = seen as Dict;
          if ("tutorbot" in s && !("partner" in s)) {
            s["partner"] = s["tutorbot"];
            delete s["tutorbot"];
            writeFileSync(p, JSON.stringify(data, null, 2), "utf-8");
            moved = true;
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* l3 dir missing */ }
  return moved;
}

import { unlinkSync as _unlink } from "node:fs";
function unlink(p: string): void { try { _unlink(p); } catch { /* noop */ } }
function await_import_unlink(p: string): void { unlink(p); }

// ── Singleton ─────────────────────────────────────────────────────────

let _singleton: MemoryStore | null = null;
export function get_memory_store(): MemoryStore {
  if (!_singleton) _singleton = new MemoryStore();
  return _singleton;
}

export const getMemoryStore = get_memory_store;
export { defaultTitle as _default_title };
