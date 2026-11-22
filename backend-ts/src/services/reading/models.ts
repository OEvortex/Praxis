// Port of deeptutor/reading/models.py — data model for immersive reading.
//
// The central abstraction is the **locator**: a 1-indexed address into a
// material that means "page" for a PDF, "chapter" for an EPUB, "slide" for a
// deck and "segment" for timed media. Rectangles on an annotation are stored
// normalised (0..1 of the unit's width/height, origin top-left).

export type UnitKind = "page" | "chapter" | "slide" | "section" | "segment";
export type RenderMode = "text" | "pdf" | "epub" | "video" | "audio";
export type ContentFormat = "plain_text" | "web_markdown";
export type AnnotationKind = "highlight" | "underline" | "note" | "citation";
export type TextSelectorType = "TextQuoteSelector" | "TextPositionSelector";
export type AnnotationResolution = "resolved" | "unresolved" | "ambiguous";

export const MAX_TEXT_SELECTOR_CHARS = 2000;

// Palette offered by the reader toolbar. Kept server-side so an annotation
// arriving from an older client (or a tool call) can be validated.
export const ANNOTATION_COLORS: Record<string, [number, number, number]> = {
  yellow: [0.99, 0.87, 0.35],
  green: [0.55, 0.86, 0.58],
  blue: [0.48, 0.75, 0.98],
  pink: [0.98, 0.63, 0.78],
  purple: [0.78, 0.68, 0.98],
};

export const DEFAULT_ANNOTATION_COLOR = "yellow";

export class ReadingError extends Error {}
export class MaterialNotFound extends ReadingError {}
export class ReadingUpgradeConflict extends ReadingError {}

// ---------------------------------------------------------------------------
// Rect
// ---------------------------------------------------------------------------

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function rectClamped(r: Rect): Rect {
  const clip = (v: number) => Math.min(1, Math.max(0, Number(v)));
  const [x0, x1] = [clip(r.x0), clip(r.x1)].sort((a, b) => a - b);
  const [y0, y1] = [clip(r.y0), clip(r.y1)].sort((a, b) => a - b);
  return { x0, y0, x1, y1 };
}

export function rectIsDegenerate(r: Rect): boolean {
  return r.x1 - r.x0 <= 0 || r.y1 - r.y0 <= 0;
}

export function rectToList(r: Rect): [number, number, number, number] {
  const c = rectClamped(r);
  return [c.x0, c.y0, c.x1, c.y1];
}

export function rectFromAny(value: unknown): Rect | null {
  if (Array.isArray(value) && value.length === 4) {
    const nums = value.map((v) => Number(v));
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return rectClamped({ x0: nums[0]!, y0: nums[1]!, x1: nums[2]!, y1: nums[3]! });
  }
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    const nums = [v.x0, v.y0, v.x1, v.y1].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    return rectClamped({
      x0: nums[0]!,
      y0: nums[1]!,
      x1: nums[2]!,
      y1: nums[3]!,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Outline / unit references / search hits
// ---------------------------------------------------------------------------

export interface OutlineEntry {
  locator: number;
  title: string;
  level: number;
  synthesised: boolean;
  source_href: string;
  source_anchor: string;
}

export function outlineEntryToDict(e: OutlineEntry): Record<string, unknown> {
  return {
    locator: e.locator,
    title: e.title,
    level: e.level,
    synthesised: e.synthesised,
    source_href: e.source_href,
    source_anchor: e.source_anchor,
  };
}

export function outlineEntryFromDict(data: Record<string, unknown>): OutlineEntry {
  return {
    locator: Math.max(1, Number(data.locator) || 1),
    title: String(data.title ?? ""),
    level: Math.max(1, Number(data.level) || 1),
    synthesised: Boolean(data.synthesised),
    source_href: String(data.source_href ?? ""),
    source_anchor: String(data.source_anchor ?? ""),
  };
}

export interface UnitReference {
  locator: number;
  source_href: string;
  title: string;
}

export function unitReferenceToDict(r: UnitReference): Record<string, unknown> {
  return { locator: r.locator, source_href: r.source_href, title: r.title };
}

export function unitReferenceFromDict(data: Record<string, unknown>): UnitReference {
  return {
    locator: Math.max(1, Number(data.locator) || 1),
    source_href: String(data.source_href ?? ""),
    title: String(data.title ?? ""),
  };
}

export interface SearchHit {
  locator: number;
  snippet: string;
  offset: number;
  match: string;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export interface MaterialManifest {
  material_id: string;
  filename: string;
  unit: UnitKind;
  unit_count: number;
  mime: string;
  title: string;
  source_hash: string;
  extractor: string;
  byte_size: number;
  char_count: number;
  created_at: number;
  has_raw_view: boolean;
  render_mode: RenderMode;
  media_count: number;
  content_format: ContentFormat;
  source_type: string;
  source_url: string;
  revision: number;
}

const UNIT_KINDS = new Set(["page", "chapter", "slide", "section", "segment"]);
const RENDER_MODES = new Set(["text", "pdf", "epub", "video", "audio"]);
const CONTENT_FORMATS = new Set(["plain_text", "web_markdown"]);

export function manifestToDict(m: MaterialManifest): Record<string, unknown> {
  return {
    material_id: m.material_id,
    filename: m.filename,
    unit: m.unit,
    unit_count: m.unit_count,
    mime: m.mime,
    title: m.title,
    source_hash: m.source_hash,
    extractor: m.extractor,
    byte_size: m.byte_size,
    char_count: m.char_count,
    created_at: m.created_at,
    has_raw_view: m.has_raw_view,
    render_mode: m.render_mode,
    media_count: m.media_count,
    content_format: m.content_format,
    source_type: m.source_type,
    source_url: m.source_url,
    revision: m.revision,
  };
}

export function manifestFromDict(data: Record<string, unknown>): MaterialManifest {
  const unit = String(data.unit ?? "page");
  let renderMode = String(data.render_mode ?? "");
  if (!RENDER_MODES.has(renderMode)) {
    renderMode = data.has_raw_view ? "pdf" : "text";
  }
  let contentFormat = String(data.content_format ?? "");
  if (!CONTENT_FORMATS.has(contentFormat)) contentFormat = "plain_text";
  return {
    material_id: String(data.material_id ?? ""),
    filename: String(data.filename ?? ""),
    unit: (UNIT_KINDS.has(unit) ? unit : "page") as UnitKind,
    unit_count: Number(data.unit_count) || 0,
    mime: String(data.mime ?? ""),
    title: String(data.title ?? ""),
    source_hash: String(data.source_hash ?? ""),
    extractor: String(data.extractor ?? ""),
    byte_size: Number(data.byte_size) || 0,
    char_count: Number(data.char_count) || 0,
    created_at: Number(data.created_at) || 0,
    has_raw_view: Boolean(data.has_raw_view),
    render_mode: renderMode as RenderMode,
    media_count: Number(data.media_count) || 0,
    content_format: contentFormat as ContentFormat,
    source_type: String(data.source_type ?? "upload"),
    source_url: String(data.source_url ?? ""),
    revision: Math.max(1, Number(data.revision) || 1),
  };
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export interface TextQuoteSelector {
  type: "TextQuoteSelector";
  exact: string;
  prefix: string;
  suffix: string;
}

export interface TextPositionSelector {
  type: "TextPositionSelector";
  start: number;
  end: number;
}

export type TextSelector = TextQuoteSelector | TextPositionSelector;

export function textSelectorToDict(s: TextSelector): Record<string, unknown> {
  if (s.type === "TextQuoteSelector") {
    const row: Record<string, unknown> = { type: s.type, exact: s.exact };
    if (s.prefix) row.prefix = s.prefix;
    if (s.suffix) row.suffix = s.suffix;
    return row;
  }
  return { type: s.type, start: s.start, end: s.end };
}

export function parseTextSelectors(value: unknown): TextSelector[] {
  if (!Array.isArray(value)) return [];
  const parsed: TextSelector[] = [];
  for (const raw of value.slice(0, 2)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const type = String(row.type ?? "");
    if (type === "TextQuoteSelector") {
      const exact = String(row.exact ?? "").slice(0, 2000);
      if (exact) {
        parsed.push({
          type: "TextQuoteSelector",
          exact,
          // W3C prefix is the text immediately before ``exact``; when legacy
          // data exceeds the bound, its tail still touches the selection.
          prefix: String(row.prefix ?? "").slice(-128),
          suffix: String(row.suffix ?? "").slice(0, 128),
        });
      }
    } else if (type === "TextPositionSelector") {
      let start = 0;
      let end = 0;
      try {
        start = Math.max(0, Number(row.start) || 0);
        end = Math.max(start, Number(row.end) || 0);
      } catch {
        continue;
      }
      if (end > start) {
        parsed.push({ type: "TextPositionSelector", start, end });
      }
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Annotation / bookmark / position
// ---------------------------------------------------------------------------

const ANNOTATION_KINDS = new Set(["highlight", "underline", "note", "citation"]);
const RESOLUTIONS = new Set(["resolved", "unresolved", "ambiguous"]);

export interface Annotation {
  annotation_id: string;
  locator: number;
  material_revision: number;
  kind: AnnotationKind;
  color: string;
  quote: string;
  note: string;
  rects: Rect[];
  source_anchor: string;
  selectors: TextSelector[];
  resolution: AnnotationResolution;
  author: string;
  created_at: number;
  updated_at: number;
}

export function annotationToDict(a: Annotation): Record<string, unknown> {
  return {
    annotation_id: a.annotation_id,
    locator: a.locator,
    material_revision: a.material_revision,
    kind: a.kind,
    color: a.color,
    quote: a.quote,
    note: a.note,
    rects: a.rects.map(rectToList),
    source_anchor: a.source_anchor,
    selectors: a.selectors.map(textSelectorToDict),
    resolution: a.resolution,
    author: a.author,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

export function annotationFromDict(data: Record<string, unknown>): Annotation {
  const kind = String(data.kind ?? "highlight");
  const color = String(data.color ?? DEFAULT_ANNOTATION_COLOR);
  const rects = (Array.isArray(data.rects) ? data.rects : [])
    .map(rectFromAny)
    .filter((r): r is Rect => r !== null && !rectIsDegenerate(r));
  const resolution = String(data.resolution ?? "resolved");
  return {
    annotation_id: String(data.annotation_id ?? ""),
    locator: Math.max(1, Number(data.locator) || 1),
    material_revision: Math.max(1, Number(data.material_revision) || 1),
    kind: (ANNOTATION_KINDS.has(kind) ? kind : "highlight") as AnnotationKind,
    color: color in ANNOTATION_COLORS ? color : DEFAULT_ANNOTATION_COLOR,
    quote: String(data.quote ?? ""),
    note: String(data.note ?? ""),
    rects,
    source_anchor: String(data.source_anchor ?? ""),
    selectors: parseTextSelectors(data.selectors),
    resolution: (RESOLUTIONS.has(resolution) ? resolution : "resolved") as AnnotationResolution,
    author: String(data.author ?? "user"),
    created_at: Number(data.created_at) || 0,
    updated_at: Number(data.updated_at) || 0,
  };
}

export interface ReadingBookmark {
  bookmark_id: string;
  locator: number;
  label: string;
  source_anchor: string;
  created_at: number;
}

export function bookmarkToDict(b: ReadingBookmark): Record<string, unknown> {
  return {
    bookmark_id: b.bookmark_id,
    locator: b.locator,
    label: b.label,
    source_anchor: b.source_anchor,
    created_at: b.created_at,
  };
}

export function bookmarkFromDict(data: Record<string, unknown>): ReadingBookmark {
  return {
    bookmark_id: String(data.bookmark_id ?? ""),
    locator: Math.max(1, Number(data.locator) || 1),
    label: String(data.label ?? ""),
    source_anchor: String(data.source_anchor ?? ""),
    created_at: Number(data.created_at) || 0,
  };
}

export interface ReadingPosition {
  locator: number;
  source_anchor: string;
  percentage: number;
  updated_at: number;
}

export function positionToDict(p: ReadingPosition): Record<string, unknown> {
  return {
    locator: p.locator,
    source_anchor: p.source_anchor,
    percentage: p.percentage,
    updated_at: p.updated_at,
  };
}

export function positionFromDict(data: Record<string, unknown> | null | undefined): ReadingPosition {
  if (!data || typeof data !== "object") {
    return { locator: 1, source_anchor: "", percentage: 0, updated_at: 0 };
  }
  return {
    locator: Math.max(1, Number(data.locator) || 1),
    source_anchor: String(data.source_anchor ?? ""),
    percentage: Math.min(1, Math.max(0, Number(data.percentage) || 0)),
    updated_at: Number(data.updated_at) || 0,
  };
}
