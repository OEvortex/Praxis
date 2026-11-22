// Port of deeptutor/reading/store.py + search.py + service.py — the reading
// engine the immersive-reading capability's tools sit on.
//
// Two persistence layers live here:
//
// 1. **Mode state** — ``ReadingModeStore``. Upstream carried the open
//    material/workspace/viewport on ``context.metadata`` per turn; here it is
//    persisted in the shared SQLite kv table keyed by session id
//    (``reading_mode:<session_id>``), matching src/store/database.ts patterns.
//    The turn context var ``current_session_id`` (agent/turn_context.ts)
//    supplies the key inside tools.
//
// 2. **Material storage** — ``MaterialStore``. Reads the same on-disk layout
//    upstream writes (and the REST port in src/services/reading is expected to
//    keep writing): ``<root>/<content_id>/{manifest.json, outline.json,
//    unit_refs.json, units/%04d.txt, media.json, media/, annotations/<id>.json,
//    raw/, render/}`` plus the ``_catalog.sqlite3`` material→content index.
//    The catalog sqlite schema mirrors deeptutor/reading/catalog_store.py.
//
// Everything degrades gracefully: a missing catalog, missing material or
// unreadable file yields null/empty rather than throwing, so a turn on a
// backend without ingested materials still answers "no document open" style
// failures instead of crashing.

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { get_settings, type Settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";
import {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  MaterialNotFound,
  ReadingError,
  annotationFromDict,
  annotationToDict,
  manifestFromDict,
  manifestToDict,
  outlineEntryFromDict,
  outlineEntryToDict,
  unitReferenceFromDict,
  unitReferenceToDict,
  type Annotation,
  type AnnotationKind,
  type MaterialManifest,
  type OutlineEntry,
  type SearchHit,
  type UnitReference,
} from "../../services/reading/models.js";

// Re-exported for the capability modules that historically imported the
// engine error types from this module.
export { MaterialNotFound, ReadingError };

// ---------------------------------------------------------------------------
// Constants (mirrors store.py / service.py / search.py)
// ---------------------------------------------------------------------------

export const MANIFEST_NAME = "manifest.json";
export const OUTLINE_NAME = "outline.json";
export const UNIT_REFS_NAME = "unit_refs.json";
export const MEDIA_INDEX_NAME = "media.json";
export const UNITS_DIR = "units";
export const MEDIA_DIR = "media";
export const RAW_DIR = "raw";
export const RENDER_DIR = "render";
export const ANNOTATIONS_DIR = "annotations";

/** Hard ceiling on unit text one tool call may return (upstream MAX_READ_CHARS). */
export const MAX_READ_CHARS = 60_000;
export const MAX_LOCATORS_PER_READ = 24;
export const MAX_OUTLINE_ROWS = 120;
export const CATALOG_DB_NAME = "_catalog.sqlite3";

const MATERIAL_ID_RE = /^(?:[0-9a-f]{8,64}|rm_[0-9a-f]{12})$/;
const CONTENT_ID_RE = /^[0-9a-f]{8,64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clipChars(s: string, n: number): string {
  return [...s].slice(0, Math.max(0, n)).join("");
}

// ---------------------------------------------------------------------------
// Mode state — sqlite kv keyed by session id
// ---------------------------------------------------------------------------

export interface ReadingViewport {
  locator?: number;
  selection?: string;
  time_seconds?: number;
  [k: string]: unknown;
}

export interface ReadingModeRecord {
  /** True once the turn/page selected immersive-reading mode. */
  mode: boolean;
  material_id: string;
  workspace_id: string;
  viewport: ReadingViewport;
  updated_at: number;
}

const MODE_KEY_PREFIX = "reading_mode:";

export function modeKey(sessionId: string): string {
  return `${MODE_KEY_PREFIX}${sessionId}`;
}

export function emptyModeRecord(): ReadingModeRecord {
  return { mode: false, material_id: "", workspace_id: "", viewport: {}, updated_at: 0 };
}

export function recordFromDict(data: unknown): ReadingModeRecord {
  const base = emptyModeRecord();
  if (!isRecord(data)) return base;
  return {
    mode: Boolean(data["mode"]),
    material_id: String(data["material_id"] ?? "").trim(),
    workspace_id: String(data["workspace_id"] ?? "").trim(),
    viewport: isRecord(data["viewport"]) ? (data["viewport"] as ReadingViewport) : {},
    updated_at: Number(data["updated_at"]) || 0,
  };
}

/** Per-session reading mode state persisted in the shared kv table. */
export class ReadingModeStore {
  constructor(private readonly settings: Settings = get_settings()) {}

  get(sessionId: string): ReadingModeRecord {
    if (!sessionId) return emptyModeRecord();
    return recordFromDict(get_state<unknown>(this.settings, modeKey(sessionId)));
  }

  /** Merge a partial update into the session's record. */
  update(sessionId: string, patch: Partial<ReadingModeRecord>): ReadingModeRecord {
    const current = this.get(sessionId);
    const next: ReadingModeRecord = {
      ...current,
      ...patch,
      viewport: { ...current.viewport, ...(patch.viewport ?? {}) },
      updated_at: Date.now() / 1000,
    };
    if (!sessionId) return next;
    put_state(this.settings, modeKey(sessionId), next);
    return next;
  }

  /** Enter/leave reading mode for a session. */
  setMode(sessionId: string, on: boolean): ReadingModeRecord {
    return this.update(sessionId, { mode: on });
  }

  /** Bind the session to a material (and optionally a workspace tab). */
  bindMaterial(sessionId: string, materialId: string, workspaceId = ""): ReadingModeRecord {
    const record = this.update(sessionId, {
      material_id: String(materialId ?? "").trim(),
      ...(workspaceId ? { workspace_id: String(workspaceId).trim() } : {}),
    });
    return record;
  }

  /** Record what the reader viewport is showing (called by the REST layer). */
  setViewport(sessionId: string, viewport: ReadingViewport): ReadingModeRecord {
    const current = this.get(sessionId);
    return this.update(sessionId, {
      viewport: { ...current.viewport, ...viewport },
    });
  }

  clear(sessionId: string): void {
    if (!sessionId) return;
    // put_state with an empty record keeps the key but disables the mode;
    // delete via a fresh empty record is clearer than removing the key.
    put_state(this.settings, modeKey(sessionId), emptyModeRecord());
  }
}

export const readingModeStore = new ReadingModeStore();

// ---------------------------------------------------------------------------
// Search engine — port of reading/search.py (pure functions)
// ---------------------------------------------------------------------------

const WS_RUN = /\s+/g;
const SOFT_PUNCT = /[‘’“”–—\-_'"`，、;；:：.。!！?？()（）[\]【】]/g;
const TERM_SPLIT = /[^\p{L}\p{N}_]+/u;
const MIN_TERM_LEN = 2;
const CJK = /[㐀-䶿一-鿿豈-﫿぀-ヿ]/;

export const SNIPPET_RADIUS = 140;

export function normalise(text: string): string {
  return (text ?? "")
    .replace(SOFT_PUNCT, "")
    .replace(WS_RUN, " ")
    .trim()
    .toLowerCase();
}

export function termsOf(query: string): string[] {
  const raw = (query ?? "")
    .toLowerCase()
    .split(TERM_SPLIT)
    .filter((t) => t.length > 0);
  const expanded: string[] = [];
  for (const term of raw) {
    if ([...term].length >= 3 && CJK.test(term)) {
      const chars = [...term];
      for (let i = 0; i + 1 < chars.length; i++) {
        expanded.push(chars[i]! + chars[i + 1]!);
      }
    } else if ([...term].length >= MIN_TERM_LEN) {
      expanded.push(term);
    }
  }
  return [...new Set(expanded)];
}

export type MatchMode = "exact" | "normalised" | "terms";

export interface SearchResult {
  hits: SearchHit[];
  mode: MatchMode | null;
  truncated: boolean;
}

export function searchHitToPlain(hit: SearchHit): Record<string, unknown> {
  return {
    locator: hit.locator,
    snippet: hit.snippet,
    offset: hit.offset,
    match: hit.match,
  };
}

/** Search ``units`` (locator, text pairs) for ``query``, escalating layers. */
export function searchUnits(
  units: Iterable<[number, string]>,
  query: string,
  limit = 12,
): SearchResult {
  const needle = (query ?? "").trim();
  if (!needle) return { hits: [], mode: null, truncated: false };

  const materialised: [number, string][] = [];
  for (const [locator, text] of units) materialised.push([locator, text ?? ""]);
  const bounded = Math.max(1, Math.trunc(limit));

  for (const mode of ["exact", "normalised"] as const) {
    const hits = literalHits(materialised, needle, mode, bounded + 1);
    if (hits.length) {
      return { hits: hits.slice(0, bounded), mode, truncated: hits.length > bounded };
    }
  }

  const ranked = termHits(materialised, needle, bounded + 1);
  if (!ranked.length) return { hits: [], mode: null, truncated: false };
  return { hits: ranked.slice(0, bounded), mode: "terms", truncated: ranked.length > bounded };
}

function literalHits(
  units: [number, string][],
  needle: string,
  mode: "exact" | "normalised",
  limit: number,
): SearchHit[] {
  const hits: SearchHit[] = [];
  const target = mode === "exact" ? needle.toLowerCase() : normalise(needle);
  if (!target) return hits;
  for (const [locator, text] of units) {
    const haystack = mode === "exact" ? text.toLowerCase() : normalise(text);
    const position = haystack.indexOf(target);
    if (position < 0) continue;
    const anchor = mode === "exact" ? position : firstTermOffset(text, needle);
    hits.push({
      locator,
      snippet: snippet(text, anchor, needle.length),
      offset: Math.max(0, anchor),
      match: needle,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

function termHits(units: [number, string][], needle: string, limit: number): SearchHit[] {
  const queryTerms = termsOf(needle);
  if (!queryTerms.length) return [];
  const scored: { count: number; locator: number; hit: SearchHit }[] = [];
  for (const [locator, text] of units) {
    const lowered = text.toLowerCase();
    const present = queryTerms.filter((t) => lowered.includes(t));
    if (!present.length) continue;
    let anchor = lowered.length;
    for (const term of present) {
      const at = lowered.indexOf(term);
      if (at >= 0 && at < anchor) anchor = at;
    }
    if (anchor === lowered.length) anchor = 0;
    scored.push({
      count: present.length,
      locator,
      hit: {
        locator,
        snippet: snippet(text, anchor, (present[0] ?? "").length),
        offset: Math.max(0, anchor),
        match: present.join(" "),
      },
    });
  }
  scored.sort((a, b) => b.count - a.count || a.locator - b.locator);
  return scored.slice(0, limit).map((row) => row.hit);
}

function firstTermOffset(text: string, needle: string): number {
  const lowered = text.toLowerCase();
  for (const term of termsOf(needle)) {
    const found = lowered.indexOf(term);
    if (found >= 0) return found;
  }
  return 0;
}

function snippet(text: string, offset: number, matchLen: number): string {
  if (!text) return "";
  const start = Math.max(0, offset - SNIPPET_RADIUS);
  const end = Math.min(text.length, offset + Math.max(1, matchLen) + SNIPPET_RADIUS);
  const window = text.slice(start, end).replace(WS_RUN, " ").trim();
  return `${start > 0 ? "…" : ""}${window}${end < text.length ? "…" : ""}`;
}

/** Character offset of ``quote`` in ``text``, or -1 (upstream locate_quote). */
export function locateQuote(text: string, quote: string): number {
  if (!text || !quote) return -1;
  const direct = text.toLowerCase().indexOf(quote.toLowerCase());
  if (direct >= 0) return direct;
  return normalise(text).indexOf(normalise(quote));
}

// ---------------------------------------------------------------------------
// Service layer — port of reading/service.py
// ---------------------------------------------------------------------------

const RANGE_RE = /^\s*(\d+)\s*(?:[-–—:]\s*(\d+))?\s*$/;

export interface RenderedUnits {
  text: string;
  locators: number[];
  truncated: boolean;
  unit: string;
}

export function parseLocators(spec: unknown, unitCount: number): number[] {
  if (unitCount <= 0) throw new ReadingError("this material has no readable units");
  const raw: number[] = [];
  if (typeof spec === "number" && Number.isFinite(spec)) {
    raw.push(Math.trunc(spec));
  } else if (typeof spec === "string") {
    for (const chunk of spec.replace(/，/g, ",").split(",")) {
      if (!chunk.trim()) continue;
      const match = RANGE_RE.exec(chunk);
      if (!match) continue;
      let start = Number.parseInt(match[1]!, 10);
      let end = match[2] ? Number.parseInt(match[2], 10) : start;
      if (end < start) [start, end] = [end, start];
      const boundedEnd = Math.min(end, start + MAX_LOCATORS_PER_READ);
      for (let v = start; v <= boundedEnd; v++) raw.push(v);
    }
  } else if (Array.isArray(spec)) {
    for (const value of spec) {
      const n = Number(value);
      if (Number.isFinite(n)) raw.push(Math.trunc(n));
    }
  }
  const inRange = [...new Set(raw.filter((v) => v >= 1 && v <= unitCount))].sort((a, b) => a - b);
  if (!inRange.length) {
    throw new ReadingError(
      `no valid locator in ${JSON.stringify(spec)} — this material has 1..${unitCount}.`,
    );
  }
  return inRange.slice(0, MAX_LOCATORS_PER_READ);
}

export function renderUnits(
  store: MaterialStore,
  materialId: string,
  spec: unknown,
  maxChars = MAX_READ_CHARS,
): RenderedUnits {
  const manifest = store.manifest(materialId);
  const locators = parseLocators(spec, manifest.unit_count);
  const { rows, truncated } = store.readUnits(materialId, locators, maxChars);
  const label = manifest.unit.charAt(0).toUpperCase() + manifest.unit.slice(1);
  const blocks = rows.map(([locator, text]) => {
    const body = text.trim();
    return body
      ? `--- ${label} ${locator} ---\n${body}`
      : `--- ${label} ${locator} ---\n(empty)`;
  });
  let rendered = blocks.join("\n\n");
  if (truncated) {
    rendered += `\n\n[truncated — the requested range exceeds the ${maxChars}-character read limit. Read fewer ${manifest.unit}s at a time.]`;
  }
  return {
    text: rendered,
    locators: rows.map(([locator]) => locator),
    truncated,
    unit: manifest.unit,
  };
}

export function searchMaterial(
  store: MaterialStore,
  materialId: string,
  query: string,
  limit = 12,
): SearchResult {
  store.manifest(materialId);
  return searchUnits(store.iterUnits(materialId), query, limit);
}

export interface QuoteCheck {
  verified: boolean;
  locator: number;
  quote: string;
  found_locator: number | null;
}

export function verifyQuote(
  store: MaterialStore,
  materialId: string,
  locator: number,
  quote: string,
): QuoteCheck {
  const manifest = store.manifest(materialId);
  const text = (quote ?? "").trim();
  if (!text) return { verified: false, locator, quote: "", found_locator: null };
  if (locator >= 1 && locator <= manifest.unit_count) {
    if (locateQuote(store.unitText(materialId, locator), text) >= 0) {
      return { verified: true, locator, quote: text, found_locator: locator };
    }
  }
  const found = searchUnits(store.iterUnits(materialId), text, 1);
  const hit = found.hits[0];
  if (hit && (found.mode === "exact" || found.mode === "normalised")) {
    return { verified: true, locator, quote: text, found_locator: hit.locator };
  }
  return { verified: false, locator, quote: text, found_locator: null };
}

/** Locator → clock time for timed media; empty for documents. */
export function unitTimestamps(
  store: MaterialStore,
  manifest: MaterialManifest,
): Map<number, string> {
  const out = new Map<number, string>();
  if (manifest.render_mode !== "video" && manifest.render_mode !== "audio") return out;
  for (const ref of store.unitReferences(manifest.material_id)) {
    if (ref.title && ref.source_href.startsWith("#t=")) {
      out.set(ref.locator, ref.title);
    }
  }
  return out;
}

export function renderOutline(store: MaterialStore, materialId: string): string {
  const manifest = store.manifest(materialId);
  return formatOutline(manifest, store.outline(materialId));
}

export function formatOutline(manifest: MaterialManifest, entries: OutlineEntry[]): string {
  const label = manifest.unit;
  const header =
    `${manifest.filename} — ${manifest.unit_count} ${label}s` +
    (manifest.title ? `, titled “${manifest.title}”` : "");
  if (!entries.length) {
    return `${header}\n(no outline available; read ${label}s directly)`;
  }
  const { trimmed, omitted } = trimOutline(entries);
  const lines = [header, ""];
  for (const entry of trimmed) {
    const indent = "  ".repeat(Math.max(0, entry.level - 1));
    lines.push(`${indent}${label} ${entry.locator}: ${entry.title || "(untitled)"}`);
  }
  if (omitted) {
    lines.push(`… ${omitted} more rows omitted; ask for a range to see them.`);
  }
  return lines.join("\n");
}

function trimOutline(entries: OutlineEntry[]): { trimmed: OutlineEntry[]; omitted: number } {
  if (entries.length <= MAX_OUTLINE_ROWS) return { trimmed: [...entries], omitted: 0 };
  for (let maxLevel = 1; maxLevel <= 6; maxLevel++) {
    const kept = entries.filter((e) => e.level <= maxLevel);
    if (kept.length > MAX_OUTLINE_ROWS) {
      const shallower = entries.filter((e) => e.level < maxLevel);
      if (shallower.length) {
        const slice = shallower.slice(0, MAX_OUTLINE_ROWS);
        return { trimmed: slice, omitted: entries.length - slice.length };
      }
      break;
    }
  }
  return { trimmed: entries.slice(0, MAX_OUTLINE_ROWS), omitted: entries.length - MAX_OUTLINE_ROWS };
}

export function materialSummary(manifest: MaterialManifest): string {
  const sizeKb = Math.max(1, Math.floor(manifest.byte_size / 1024));
  return (
    `${manifest.filename} (${manifest.unit_count} ${manifest.unit}s, ` +
    `${manifest.char_count} chars, ${sizeKb} KB)`
  );
}

// ---------------------------------------------------------------------------
// MaterialStore — on-disk reading materials (upstream ReadingStore layout)
// ---------------------------------------------------------------------------

interface CatalogMaterialRow {
  material_id: string;
  content_id: string;
  [k: string]: unknown;
}

interface CatalogWorkspaceRow {
  workspace_id: string;
  title: string;
  description?: string;
  color?: string;
  active_material_id?: string | null;
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

export interface WorkspaceTabInfo {
  material_id: string;
  title: string;
  source_kind: string;
  status: string;
  tab_order: number;
  pinned: boolean;
  opened: boolean;
}

export interface WorkspaceInfo {
  workspace_id: string;
  title: string;
  description: string;
  color: string;
  active_material_id: string | null;
  tabs: WorkspaceTabInfo[];
}

function readJsonFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
  renameSync(tmp, path);
}

/** Resolve the reading root: PRAXIS_READING_DIR, else <data_dir>/reading. */
export function readingRoot(settings: Settings = get_settings()): string {
  const env = (process.env["PRAXIS_READING_DIR"] ?? "").trim();
  return env || join(settings.data_dir, "reading");
}

export class MaterialStore {
  readonly root: string;
  private readonly settings: Settings;
  private catalogCache: DatabaseSync | null | undefined;

  constructor(settings: Settings = get_settings(), root?: string) {
    this.settings = settings;
    this.root = root ?? readingRoot(settings);
  }

  // -- catalog (material_id -> content_id, workspace metadata) --------------

  private catalog(): DatabaseSync | null {
    if (this.catalogCache !== undefined) return this.catalogCache;
    const path = join(this.root, CATALOG_DB_NAME);
    if (!existsSync(path)) {
      this.catalogCache = null;
      return null;
    }
    try {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA busy_timeout=30000");
      this.catalogCache = db;
      return db;
    } catch {
      this.catalogCache = null;
      return null;
    }
  }

  private catalogMaterial(materialId: string): CatalogMaterialRow | null {
    const db = this.catalog();
    if (!db) return null;
    try {
      const row = db
        .prepare("SELECT * FROM reading_materials WHERE material_id = ?")
        .get(materialId) as CatalogMaterialRow | undefined;
      return row ?? null;
    } catch {
      return null;
    }
  }

  /** material_id → content directory name (upstream _content_id). */
  contentId(materialId: string): string {
    const id = String(materialId ?? "").trim().toLowerCase();
    if (!MATERIAL_ID_RE.test(id)) {
      throw new ReadingError(`invalid material id: ${materialId}`);
    }
    const row = this.catalogMaterial(id);
    const contentId = String(row?.["content_id"] ?? id).trim().toLowerCase();
    if (!CONTENT_ID_RE.test(contentId)) {
      throw new ReadingError(`invalid content id for material ${materialId}`);
    }
    return contentId;
  }

  private materialDir(materialId: string): string {
    return join(this.root, this.contentId(materialId));
  }

  private statePath(materialId: string, stateDir: string): string {
    const id = String(materialId ?? "").trim().toLowerCase();
    if (!MATERIAL_ID_RE.test(id)) {
      throw new ReadingError(`invalid material id: ${materialId}`);
    }
    return join(this.materialDir(id), stateDir, `${id}.json`);
  }

  // -- manifest / outline / units -------------------------------------------

  private loadManifest(materialId: string): MaterialManifest | null {
    const dir = this.materialDir(materialId);
    const data = readJsonFile(join(dir, MANIFEST_NAME));
    if (!isRecord(data)) return null;
    try {
      return manifestFromDict(data);
    } catch {
      return null;
    }
  }

  manifest(materialId: string): MaterialManifest {
    const manifest = this.loadManifest(materialId);
    if (!manifest) throw new MaterialNotFound(`material ${materialId} not found`);
    return manifest;
  }

  exists(materialId: string): boolean {
    try {
      return this.loadManifest(materialId) !== null;
    } catch {
      return false;
    }
  }

  unitFile(materialDir: string, locator: number): string {
    return join(materialDir, UNITS_DIR, `${String(locator).padStart(4, "0")}.txt`);
  }

  unitText(materialId: string, locator: number): string {
    const manifest = this.manifest(materialId);
    if (locator < 1 || locator > manifest.unit_count) {
      throw new ReadingError(
        `${manifest.unit} ${locator} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    try {
      return readFileSync(this.unitFile(this.materialDir(materialId), locator), "utf-8");
    } catch {
      return "";
    }
  }

  readUnits(
    materialId: string,
    locators: number[],
    maxChars = MAX_READ_CHARS,
  ): { rows: [number, string][]; truncated: boolean } {
    const manifest = this.manifest(materialId);
    const wanted = [...new Set(locators.filter((l) => l >= 1 && l <= manifest.unit_count))].sort(
      (a, b) => a - b,
    );
    const rows: [number, string][] = [];
    let budget = Math.max(0, Math.trunc(maxChars));
    let truncated = false;
    for (const locator of wanted) {
      const text = this.unitText(materialId, locator);
      if (text.length > budget) {
        if (budget > 0) rows.push([locator, text.slice(0, budget)]);
        truncated = true;
        break;
      }
      rows.push([locator, text]);
      budget -= text.length;
    }
    const requested = new Set(locators.filter((l) => l >= 1 && l <= manifest.unit_count));
    if (wanted.length < requested.size) truncated = true;
    return { rows, truncated };
  }

  *iterUnits(materialId: string): Generator<[number, string]> {
    const manifest = this.manifest(materialId);
    for (let locator = 1; locator <= manifest.unit_count; locator++) {
      yield [locator, this.unitText(materialId, locator)];
    }
  }

  outline(materialId: string): OutlineEntry[] {
    const manifest = this.manifest(materialId);
    const dir = this.materialDir(materialId);
    const rows = readJsonFile(join(dir, OUTLINE_NAME));
    if (Array.isArray(rows)) {
      const entries: OutlineEntry[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        try {
          entries.push(outlineEntryFromDict(row));
        } catch {
          /* skip malformed row */
        }
      }
      // TODO(port): EPUB outline anchor upgrade + PDF synthesised-outline
      // migration live in store.py; the TS ingestion path does not produce
      // those legacy shapes yet, so raw rows are returned as-is.
      if (entries.length) return entries;
    }
    // Upstream falls back to synthesise_outline(units) for non-PDF materials.
    // TODO(port): port synthesise_outline from extract.py when the binary
    // extractors land; until then an empty outline is honest.
    void manifest;
    return [];
  }

  unitReferences(materialId: string): UnitReference[] {
    const manifest = this.manifest(materialId);
    const dir = this.materialDir(materialId);
    const rows = readJsonFile(join(dir, UNIT_REFS_NAME));
    if (!Array.isArray(rows)) {
      return Array.from({ length: manifest.unit_count }, (_, i) => ({
        locator: i + 1,
        source_href: "",
        title: "",
      }));
    }
    const refs: UnitReference[] = [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      try {
        refs.push(unitReferenceFromDict(row));
      } catch {
        /* skip */
      }
    }
    return refs.filter((r) => r.locator >= 1 && r.locator <= manifest.unit_count);
  }

  // -- media ---------------------------------------------------------------

  mediaItems(materialId: string): Record<string, unknown>[] {
    this.manifest(materialId);
    const rows = readJsonFile(join(this.materialDir(materialId), MEDIA_INDEX_NAME));
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is Record<string, unknown> => isRecord(row) && Boolean(row["name"]),
    );
  }

  mediaItemsAt(materialId: string, locator: number): Record<string, unknown>[] {
    return this.mediaItems(materialId).filter((row) => row["locator"] === locator);
  }

  /** Resolve a media file by index-validated name (no traversal). */
  mediaPath(materialId: string, name: string): string | null {
    const clean = basename(String(name ?? "").replace(/\\/g, "/"));
    if (!clean) return null;
    if (!this.mediaItems(materialId).some((row) => row["name"] === clean)) return null;
    const path = join(this.materialDir(materialId), MEDIA_DIR, clean);
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  rawPath(materialId: string): string | null {
    const manifest = this.manifest(materialId);
    if (manifest.render_mode === "text") return null;
    const dir = this.materialDir(materialId);
    const rawDir = join(dir, RAW_DIR);
    try {
      for (const entry of readdirSync(rawDir)) {
        const p = join(rawDir, entry);
        if (statSync(p).isFile()) return p;
      }
    } catch {
      /* no raw dir */
    }
    return null;
  }

  renderPath(materialId: string): string | null {
    const manifest = this.manifest(materialId);
    if (manifest.render_mode === "text") return null;
    const materialDir = this.materialDir(materialId);
    const renderDir = join(materialDir, RENDER_DIR);
    try {
      for (const entry of readdirSync(renderDir)) {
        const p = join(renderDir, entry);
        if (statSync(p).isFile()) return p;
      }
    } catch {
      /* none */
    }
    return this.rawPath(materialId);
  }

  // -- annotations -----------------------------------------------------------

  annotations(materialId: string): Annotation[] {
    this.manifest(materialId);
    const path = this.statePath(materialId, ANNOTATIONS_DIR);
    const rows = readJsonFile(path);
    if (!Array.isArray(rows)) {
      // Legacy flat annotations.json inside the content dir.
      const legacy = readJsonFile(join(this.materialDir(materialId), "annotations.json"));
      if (!Array.isArray(legacy)) return [];
      return this.parseAnnotations(legacy);
    }
    return this.parseAnnotations(rows);
  }

  private parseAnnotations(rows: unknown[]): Annotation[] {
    const parsed: Annotation[] = [];
    for (const row of rows) {
      if (!isRecord(row) || !row["annotation_id"]) continue;
      try {
        parsed.push(annotationFromDict(row));
      } catch {
        /* skip malformed */
      }
    }
    return parsed.sort((a, b) => a.locator - b.locator || a.created_at - b.created_at);
  }

  private writeAnnotations(materialId: string, rows: Annotation[]): void {
    atomicWriteJson(
      this.statePath(materialId, ANNOTATIONS_DIR),
      rows.map(annotationToDict),
    );
  }

  /** Insert or update one annotation (upstream save_annotation, simplified:
   *  the tool path never carries selectors — quote verification happens in
   *  verify_quote before this is called). */
  saveAnnotation(materialId: string, annotation: Annotation): Annotation {
    const manifest = this.manifest(materialId);
    if (annotation.locator < 1 || annotation.locator > manifest.unit_count) {
      throw new ReadingError(
        `${manifest.unit} ${annotation.locator} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    const existing = this.annotations(materialId);
    const now = Date.now() / 1000;
    let stored: Annotation = { ...annotation };
    if (!stored.annotation_id) {
      stored = { ...stored, annotation_id: randomBytes(6).toString("hex") };
    }
    const index = existing.findIndex((row) => row.annotation_id === stored.annotation_id);
    if (index === -1) {
      stored = {
        ...stored,
        material_revision: manifest.revision,
        created_at: stored.created_at || now,
        updated_at: now,
      };
      existing.push(stored);
    } else {
      const prev = existing[index]!;
      stored = {
        ...stored,
        material_revision: prev.material_revision,
        created_at: prev.created_at || now,
        updated_at: now,
      };
      existing[index] = stored;
    }
    existing.sort((a, b) => a.locator - b.locator || a.created_at - b.created_at);
    this.writeAnnotations(materialId, existing);
    return stored;
  }

  // -- page render probe -----------------------------------------------------

  /**
   * Whether the locator qualifies for a full-page render. Upstream probes the
   * raw PDF with pymupdf (>= PAGE_RENDER_MIN_DRAWINGS vector primitives);
   * there is no PDF parser in the TS backend yet, so this conservatively
   * reports false. TODO(port): implement once a PDF lib lands.
   */
  pageHasRender(_materialId: string, _locator: number): boolean {
    return false;
  }

  // -- workspaces (catalog sqlite) -------------------------------------------

  /** Workspace record with its tabs, or null when absent/unreadable. */
  getWorkspace(workspaceId: string): WorkspaceInfo | null {
    const db = this.catalog();
    if (!db || !workspaceId) return null;
    try {
      const ws = db
        .prepare("SELECT * FROM reading_workspaces WHERE workspace_id = ?")
        .get(workspaceId) as CatalogWorkspaceRow | undefined;
      if (!ws) return null;
      const tabRows = db
        .prepare(
          `SELECT wm.material_id, wm.tab_order, wm.pinned, wm.opened, wm.added_at,
                  m.title, m.source_kind, m.status
           FROM reading_workspace_materials wm
           LEFT JOIN reading_materials m ON m.material_id = wm.material_id
           WHERE wm.workspace_id = ?
           ORDER BY wm.tab_order ASC`,
        )
        .all(workspaceId) as Record<string, unknown>[];
      const tabs: WorkspaceTabInfo[] = tabRows.map((row) => ({
        material_id: String(row["material_id"] ?? ""),
        title: String(row["title"] ?? ""),
        source_kind: String(row["source_kind"] ?? ""),
        status: String(row["status"] ?? ""),
        tab_order: Number(row["tab_order"]) || 0,
        pinned: Boolean(row["pinned"]),
        opened: row["opened"] === undefined ? true : Boolean(row["opened"]),
      }));
      return {
        workspace_id: String(ws["workspace_id"]),
        title: String(ws["title"] ?? ""),
        description: String(ws["description"] ?? ""),
        color: String(ws["color"] ?? ""),
        active_material_id:
          ws["active_material_id"] === null || ws["active_material_id"] === undefined
            ? null
            : String(ws["active_material_id"]),
        tabs,
      };
    } catch {
      return null;
    }
  }

  /** Rebind a workspace's active tab; returns the updated workspace or null. */
  setActiveMaterial(workspaceId: string, materialId: string): WorkspaceInfo | null {
    const path = join(this.root, CATALOG_DB_NAME);
    if (!existsSync(path)) return null;
    const db = new DatabaseSync(path);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const member = db
          .prepare(
            "SELECT 1 FROM reading_workspace_materials WHERE workspace_id = ? AND material_id = ?",
          )
          .get(workspaceId, materialId);
        if (!member) {
          db.exec("ROLLBACK");
          return null;
        }
        db.prepare(
          "UPDATE reading_workspaces SET active_material_id = ?, updated_at = ? WHERE workspace_id = ?",
        ).run(materialId, Date.now() / 1000, workspaceId);
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* already rolled back */
        }
        throw e;
      }
    } finally {
      db.close();
    }
    return this.getWorkspace(workspaceId);
  }
}

export const materialStore = new MaterialStore();

// Re-exported for tool authors so they import one module.
export {
  ANNOTATION_COLORS,
  DEFAULT_ANNOTATION_COLOR,
  manifestToDict,
  clipChars,
};
export type { AnnotationKind };
