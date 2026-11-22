// ref pool
// validation + raw-trace annotation for update/audit modes.
import type { Document, Entry } from "../document.js";
import { is_entry_id, is_valid_ref } from "../ids.js";
import type { Entity } from "../snapshot/entity.js";
import type { Dict } from "../../../shared/types.js";

export interface ExtractedFact {
  text: string;
  refs: string[];
  section?: string;
}

const ENTITY_HEADER_FMT = "=== {marker} ===";
const L3_SURFACE_HEADER_RE = /^### surface: ([a-z][a-z0-9_-]*)/gm;

function entityMarker(surface: string, entityId: string): string {
  return `@entity ${surface}:${entityId}`;
}

function formatMeta(ent: Entity): string {
  if (!ent.metadata) return "";
  const bits: string[] = [];
  for (const [k, v] of Object.entries(ent.metadata)) {
    if (v === null || v === undefined || v === "" ||
        (Array.isArray(v) && !v.length) ||
        (typeof v === "object" && !Array.isArray(v) && !Object.keys(v as object).length)) {
      continue;
    }
    bits.push(`${k}=${String(v)}`);
  }
  return bits.join(" ");
}

// ── Update-mode helpers ───────────────────────────────────────────────

export function refs_in_chunk_l2(
  entities: Iterable<Entity>,
  opts: { surface: string; chunk_text: string },
): Set<string> {
  const allowed = new Set<string>();
  for (const ent of entities) {
    const marker = entityMarker(opts.surface, ent.id);
    if (opts.chunk_text.includes(marker)) allowed.add(`${opts.surface}:${ent.id}`);
  }
  return allowed;
}

export function refs_in_span_l2(
  entities: Iterable<Entity>,
  opts: { surface: string; full_text: string; start: number; end: number },
): Set<string> {
  const markers: Array<[number, string]> = [];
  for (const ent of entities) {
    const marker = entityMarker(opts.surface, ent.id);
    const pos = opts.full_text.indexOf(marker);
    if (pos !== -1) markers.push([pos, `${opts.surface}:${ent.id}`]);
  }
  return refsOverlappingSpan(markers, opts.full_text.length, opts.start, opts.end);
}

export function refs_in_chunk_l3(
  chunkText: string,
  _entriesBySurface?: Record<string, Entry[]>,
): Set<string> {
  const out = new Set<string>();
  L3_SURFACE_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = L3_SURFACE_HEADER_RE.exec(chunkText)) !== null) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

export function refs_in_span_l3(opts: {
  entries_by_surface?: Record<string, Entry[]>;
  full_text: string;
  start: number;
  end: number;
}): Set<string> {
  const headers: Array<{ start: number; end: number; name: string }> = [];
  const re = /^### surface: ([a-z][a-z0-9_-]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(opts.full_text)) !== null) {
    headers.push({ start: m.index, end: m.index + m[0].length, name: m[1] });
  }
  if (!headers.length) return new Set();
  const allowed = new Set<string>();
  headers.forEach((h, idx) => {
    const blockStart = h.start;
    const blockEnd = idx + 1 < headers.length ? headers[idx + 1].start : opts.full_text.length;
    if (blockStart < opts.end && blockEnd > opts.start) allowed.add(h.name);
  });
  return allowed;
}

export function validate_fact_refs(
  fact: ExtractedFact,
  opts: {
    allowed: Set<string>;
    enforce_required: boolean;
    drop_invalid: boolean;
  },
): [string[], string | null] {
  const { allowed, enforce_required, drop_invalid } = opts;
  if (!fact.refs.length) {
    if (enforce_required) return [[], "missing refs"];
    return [[], null];
  }

  if (drop_invalid) {
    const kept = fact.refs
      .map((ref) => normalizeAllowedRef(ref, allowed))
      .filter((r): r is string => r !== null);
    if (!kept.length && enforce_required) return [[], "no surviving refs in chunk pool"];
    return [dedupe(kept), null];
  }

  for (const ref of fact.refs) {
    const normalized = normalizeAllowedRef(ref, allowed);
    if (normalized === null && !is_valid_ref(ref)) {
      return [[], `malformed ref ${JSON.stringify(ref)}`];
    }
    if (normalized === null) {
      return [[], `out-of-pool ref ${JSON.stringify(ref)}`];
    }
  }
  return [dedupe(fact.refs.map((r) => normalizeAllowedRef(r, allowed) ?? r)), null];
}

// ── Rendering ─────────────────────────────────────────────────────────

export function render_traces_for_concat(
  entities: Entity[],
  opts: { surface: string },
): string {
  const blocks: string[] = [];
  for (const ent of entities) {
    const header = ENTITY_HEADER_FMT.replace("{marker}", entityMarker(opts.surface, ent.id));
    const metaStr = formatMeta(ent);
    const body = (ent.content || "").trim();
    const parts = [
      header,
      `ref: ${opts.surface}:${ent.id}`,
      `label: ${ent.label}`,
      `ts: ${ent.ts || "?"}`,
      metaStr ? `meta: ${metaStr}` : null,
      "",
      body,
    ];
    blocks.push(parts.filter((x): x is string => x !== null).join("\n"));
  }
  return blocks.join("\n\n");
}

export function render_l2_entries_for_concat(
  entriesBySurface: Record<string, Entry[]>,
): string {
  const blocks: string[] = [];
  for (const [surface, entries] of Object.entries(entriesBySurface)) {
    if (!entries.length) continue;
    const lines = [`### surface: ${surface}`];
    for (const entry of entries) {
      const tag = entry.section ? `[${entry.section}] ` : "";
      lines.push(`- ${tag}${entry.text}`);
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

// ── Audit-mode helpers ────────────────────────────────────────────────

export function annotate_l2_line_with_evidence(
  lineNumber: number,
  entry: Entry,
  opts: { surface: string; entity_lookup: Map<string, Entity> },
): string {
  const lines: string[] = [
    `line ${lineNumber}: ${entry.text} [^${entry.id}]`,
    `  section: ${entry.section}`,
  ];
  if (!entry.refs.length) {
    lines.push("  sources: (none)");
    return lines.join("\n");
  }
  lines.push(`  sources (${entry.refs.length}):`);
  for (const ref of entry.refs) {
    const idx = ref.indexOf(":");
    if (idx === -1) {
      lines.push(`    └ ${ref}: (malformed)`);
      continue;
    }
    const entId = ref.slice(idx + 1);
    const ent = opts.entity_lookup.get(entId);
    if (!ent) {
      lines.push(`    └ ${ref}: (entity not found in current workspace)`);
      continue;
    }
    const body = (ent.content || "").replace(/\s+$/, "");
    lines.push(`    └ ${ref} (ts=${ent.ts || "?"}, label=${JSON.stringify(ent.label)}):`);
    for (const srcLine of body.split("\n")) lines.push(`        ${srcLine}`);
  }
  return lines.join("\n");
}

export function annotate_l3_line_with_evidence(
  lineNumber: number,
  entry: Entry,
  opts: { l2_entry_lookup: Map<string, Entry> },
): string {
  const lines: string[] = [
    `line ${lineNumber}: ${entry.text} [^${entry.id}]`,
    `  section: ${entry.section}`,
  ];
  if (!entry.refs.length) {
    lines.push("  sources: (none)");
    return lines.join("\n");
  }
  lines.push(`  sources (${entry.refs.length}):`);
  for (const ref of entry.refs) {
    if (!is_entry_id(ref)) {
      lines.push(`    └ ${ref}: (malformed L2 id)`);
      continue;
    }
    const src = opts.l2_entry_lookup.get(ref);
    if (!src) {
      lines.push(`    └ ${ref}: (L2 entry not found)`);
      continue;
    }
    lines.push(`    └ ${ref} (section=${JSON.stringify(src.section)}):`);
    lines.push(`        ${src.text}`);
    if (src.refs.length) {
      lines.push(`        upstream refs: ${src.refs.join(", ")}`);
    }
  }
  return lines.join("\n");
}

// ── Internals ─────────────────────────────────────────────────────────

function normalizeAllowedRef(ref: string, allowed: Set<string>): string | null {
  const candidate = stripRefWrappers(String(ref).trim());
  if (allowed.has(candidate) && is_valid_ref(candidate)) return candidate;
  const sorted = [...allowed].sort((a, b) => b.length - a.length);
  for (const allowedRef of sorted) {
    if (!is_valid_ref(allowedRef)) continue;
    if (hasRefSuffix(candidate, allowedRef)) return allowedRef;
  }
  return null;
}

function stripRefWrappers(ref: string): string {
  return ref.trim().replace(/^[`[\](){}<>]+|[`[\](){}<>]+$/g, "").replace(/^\^/, "").trim();
}

function hasRefSuffix(candidate: string, allowedRef: string): boolean {
  if (candidate === allowedRef) return true;
  if (!candidate.endsWith(allowedRef)) return false;
  const prefix = candidate.slice(0, candidate.length - allowedRef.length);
  if (!prefix) return true;
  return ":：?#/| \t\n^".includes(prefix[prefix.length - 1]);
}

function dedupe(refs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ref of refs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

function refsOverlappingSpan(
  markers: Array<[number, string]>,
  textLen: number,
  start: number,
  end: number,
): Set<string> {
  const allowed = new Set<string>();
  const ordered = [...markers].sort((a, b) => a[0] - b[0]);
  ordered.forEach(([blockStart, ref], idx) => {
    const blockEnd = idx + 1 < ordered.length ? ordered[idx + 1][0] : textLen;
    if (blockStart < end && blockEnd > start) allowed.add(ref);
  });
  return allowed;
}

export function collect_l2_entries(docs: Record<string, Document>): Record<string, Entry[]> {
  const out: Record<string, Entry[]> = {};
  for (const [surface, doc] of Object.entries(docs)) {
    out[surface] = allEntriesOf(doc);
  }
  return out;
}

function allEntriesOf(doc: Document): Entry[] {
  return doc.sections.flatMap(([, entries]) => entries);
}
