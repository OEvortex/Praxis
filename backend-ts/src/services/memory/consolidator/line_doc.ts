// Port of deeptutor/services/memory/consolidator/line_doc.py — line-numbered
// view of a memory doc + line-level edit ops (audit/dedup).
import { is_entry_id, new_entry_id } from "../ids.js";
import {
  all_entries,
  find_entry,
  newDocument,
  remove_entry,
  section_entries,
  type Document,
  type Entry,
} from "../document.js";
import type { Dict } from "../../../shared/types.js";

export type LineKind = "title" | "blank" | "section" | "bullet";

export interface Line {
  number: number; // 1-based, matches what the LLM sees
  kind: LineKind;
  text: string;
  entry_id?: string | null;
  section?: string | null;
}

export interface LineView {
  lines: Line[];
  entry_by_id: Map<string, Entry>;
  entries_in_order: Entry[];
  render(withNumbers?: boolean): string;
  line(number: number): Line | null;
}

// ── Edit ops ──────────────────────────────────────────────────────────

export interface ReplaceLineOp {
  op: "replace";
  line: number;
  new_text: string;
  refs: string[];
  reason?: string;
}
export interface DeleteLinesOp {
  op: "delete";
  line_start: number;
  line_end: number; // inclusive
  reason?: string;
}
export interface InsertAfterOp {
  op: "insert";
  after_line: number;
  text: string;
  refs: string[];
  section?: string | null;
  reason?: string;
}
export type Edit = ReplaceLineOp | DeleteLinesOp | InsertAfterOp;

export interface EditResult {
  op: Edit;
  status: "applied" | "rejected";
  detail?: string;
}
export interface EditReport {
  applied: EditResult[];
  rejected: EditResult[];
}

// ── Render ────────────────────────────────────────────────────────────

export function render_view(doc: Document): LineView {
  const lines: Line[] = [];
  const entriesInOrder: Entry[] = [];
  const entryById = new Map<string, Entry>();

  if (doc.title) {
    lines.push({ number: lines.length + 1, kind: "title", text: `# ${doc.title}` });
    lines.push({ number: lines.length + 1, kind: "blank", text: "" });
  }

  for (const [sectionName, entries] of doc.sections) {
    if (!entries.length) continue;
    lines.push({
      number: lines.length + 1,
      kind: "section",
      text: `## ${sectionName}`,
    });
    for (const entry of entries) {
      lines.push({
        number: lines.length + 1,
        kind: "bullet",
        text: `- ${entry.text} [^${entry.id}]`,
        entry_id: entry.id,
        section: sectionName,
      });
      entriesInOrder.push(entry);
      entryById.set(entry.id, entry);
    }
    lines.push({ number: lines.length + 1, kind: "blank", text: "" });
  }

  while (lines.length && lines[lines.length - 1].kind === "blank") lines.pop();

  const view: LineView = {
    lines,
    entry_by_id: entryById,
    entries_in_order: entriesInOrder,
    render(withNumbers = true) {
      if (withNumbers) {
        const width = Math.max(2, String(lines.length).length);
        return lines
          .map((l) => `${String(l.number).padStart(width)}: ${l.text}`)
          .join("\n");
      }
      return lines.map((l) => l.text).join("\n");
    },
    line(number: number) {
      return number >= 1 && number <= lines.length ? lines[number - 1] : null;
    },
  };
  return view;
}

// ── Apply edits ───────────────────────────────────────────────────────

class Reject extends Error {}

function entryInDoc(doc: Document, entryId: string): Entry | null {
  if (!is_entry_id(entryId)) return null;
  return find_entry(doc, entryId);
}

function sectionEntries(doc: Document, name: string): Entry[] {
  return section_entries(doc, name);
}

function dropEmptySections(doc: Document): void {
  doc.sections = doc.sections.filter(([, entries]) => entries.length > 0);
}

function applyOne(edit: Edit, doc: Document, view: LineView): string {
  if (edit.op === "replace") return applyReplace(edit, doc, view);
  if (edit.op === "delete") return applyDelete(edit, doc, view);
  if (edit.op === "insert") return applyInsert(edit, doc, view);
  throw new Reject(`unknown edit type ${(edit as Edit).op}`);
}

function applyReplace(edit: ReplaceLineOp, doc: Document, view: LineView): string {
  const line = view.line(edit.line);
  if (!line) throw new Reject(`line ${edit.line} out of range`);
  if (line.kind !== "bullet" || !line.entry_id) {
    throw new Reject(`line ${edit.line} is not an editable entry`);
  }
  if (!edit.new_text.trim()) throw new Reject("new_text empty");
  if (!edit.refs.length) throw new Reject("replace requires non-empty refs");
  const entry = entryInDoc(doc, line.entry_id);
  if (!entry) throw new Reject(`entry ${line.entry_id} not found in current doc`);
  entry.text = edit.new_text.trim();
  entry.refs = [...edit.refs];
  return `replace ${entry.id}`;
}

function applyDelete(edit: DeleteLinesOp, doc: Document, view: LineView): string {
  if (edit.line_end < edit.line_start) {
    throw new Reject(`line_end ${edit.line_end} < line_start ${edit.line_start}`);
  }
  const idsToDrop = new Set<string>();
  for (let n = edit.line_start; n <= edit.line_end; n++) {
    const line = view.line(n);
    if (!line || line.kind !== "bullet" || !line.entry_id) continue;
    idsToDrop.add(line.entry_id);
  }
  if (!idsToDrop.size) throw new Reject("range covers no entries");
  for (const [, entries] of doc.sections) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (idsToDrop.has(entries[i].id)) entries.splice(i, 1);
    }
  }
  return `deleted ${idsToDrop.size} entries`;
}

function applyInsert(edit: InsertAfterOp, doc: Document, view: LineView): string {
  if (!edit.text.trim()) throw new Reject("insert text empty");
  if (!edit.refs.length) throw new Reject("insert requires non-empty refs");

  let section = edit.section ?? null;
  if (section === null) {
    if (edit.after_line < 1 || edit.after_line > view.lines.length) {
      throw new Reject(
        "after_line out of range; for top-of-doc insert provide `section` explicitly",
      );
    }
    const anchor = view.line(edit.after_line);
    section = anchor?.section ?? null;
    if (section === null && anchor && anchor.kind === "section") {
      section = anchor.text.replace(/^#\s+/, "").trim();
    }
    if (section === null) {
      throw new Reject("no section context for insert; supply `section`");
    }
  }

  const entry: Entry = {
    id: new_entry_id(),
    section,
    text: edit.text.trim(),
    refs: [...edit.refs],
  };
  const target = sectionEntries(doc, section);
  const anchor =
    edit.after_line >= 1 && edit.after_line <= view.lines.length
      ? view.line(edit.after_line)
      : null;
  if (
    anchor &&
    anchor.kind === "bullet" &&
    anchor.section === section &&
    anchor.entry_id
  ) {
    const idx = target.findIndex((e) => e.id === anchor.entry_id);
    if (idx >= 0) target.splice(idx + 1, 0, entry);
    else target.push(entry);
  } else {
    target.push(entry);
  }
  return `inserted ${entry.id} into ${JSON.stringify(section)}`;
}

function sortKey(e: Edit): [number, number] {
  if (e.op === "replace") return [e.line, 0];
  if (e.op === "delete") return [e.line_end, 1];
  return [e.after_line, 2];
}

export function apply_edits(
  doc: Document,
  edits: Edit[],
  opts: { view?: LineView | null } = {},
): [Document, EditReport] {
  const view = opts.view ?? render_view(doc);
  const editList = [...edits].sort((a, b) => {
    const [ka, kb] = [sortKey(a), sortKey(b)];
    return kb[0] - ka[0] || kb[1] - ka[1];
  });
  const report: EditReport = { applied: [], rejected: [] };

  // Fresh copy: section lists are new, Entry objects are shared (replace
  // mutates them in place, same as upstream).
  const newDoc: Document = {
    title: doc.title,
    sections: doc.sections.map(([n, es]) => [n, [...es]] as [string, Entry[]]),
  };

  for (const edit of editList) {
    try {
      const detail = applyOne(edit, newDoc, view);
      report.applied.push({ op: edit, status: "applied", detail });
    } catch (exc) {
      if (exc instanceof Reject) {
        report.rejected.push({ op: edit, status: "rejected", detail: exc.message });
      } else {
        throw exc;
      }
    }
  }

  dropEmptySections(newDoc);
  return [newDoc, report];
}

// ── Parse edits payload ───────────────────────────────────────────────

const REF_WRAPPER_CHARS = "`[](){}<>^ \t\n\r";
const ENTRY_ID_REF_RE = /^m_[0-9A-HJKMNP-TV-Z]{26}$/;

function cleanRefs(rawRefs: unknown, layer?: string | null): string[] {
  if (!Array.isArray(rawRefs)) return [];
  const out: string[] = [];
  for (const r of rawRefs) {
    if (!r) continue;
    const s = String(r).replace(new RegExp(`^[${REF_WRAPPER_CHARS}]+|[${REF_WRAPPER_CHARS}]+$`, "g"), "").trim();
    if (!s) continue;
    if (layer === "L2" && ENTRY_ID_REF_RE.test(s)) continue;
    out.push(s);
  }
  return out;
}

const FENCE_RE = /^```[a-zA-Z]*\s*|\s*```$/g;

function extractJson(raw: string): string | null {
  const text = raw.trim().replace(FENCE_RE, "");
  const objStart = text.indexOf("{");
  const arrStart = text.indexOf("[");
  if (objStart === -1 && arrStart === -1) return null;
  const start = objStart === -1 ? arrStart : arrStart === -1 ? objStart : Math.min(objStart, arrStart);
  // Find the matching close bracket via a small scanner (raw_decode equivalent).
  const open = text[start];
  const close = open === "{" ? "}" : "]";
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
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function toInt(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function parse_edits_payload(raw: string, opts: { layer?: string | null } = {}): Edit[] {
  const layer = opts.layer ?? null;
  const snippet = extractJson(raw);
  if (snippet === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(snippet);
  } catch {
    return [];
  }
  const items = Array.isArray(data)
    ? data
    : data !== null && typeof data === "object" && Array.isArray((data as Dict)["edits"])
      ? ((data as Dict)["edits"] as unknown[])
      : null;
  if (!items) return [];

  const edits: Edit[] = [];
  for (const rawOp of items) {
    if (rawOp === null || typeof rawOp !== "object") continue;
    const op = rawOp as Dict;
    const kind = op["op"];
    try {
      if (kind === "replace") {
        edits.push({
          op: "replace",
          line: toInt(op["line"]),
          new_text: String(op["new_text"] ?? "").trim(),
          refs: cleanRefs(op["refs"], layer),
          reason: String(op["reason"] ?? "").trim(),
        });
      } else if (kind === "delete") {
        edits.push({
          op: "delete",
          line_start: toInt(op["line_start"] ?? op["line"]),
          line_end: toInt(op["line_end"] ?? op["line"]),
          reason: String(op["reason"] ?? "").trim(),
        });
      } else if (kind === "insert") {
        const section = op["section"];
        edits.push({
          op: "insert",
          after_line: toInt(op["after_line"]),
          text: String(op["text"] ?? "").trim(),
          refs: cleanRefs(op["refs"], layer),
          section: section ? String(section).trim() : null,
          reason: String(op["reason"] ?? "").trim(),
        });
      }
    } catch {
      continue;
    }
  }
  return edits;
}

export { all_entries, find_entry, newDocument };
export type { Document, Entry };
