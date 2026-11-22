// Port of deeptutor/reading/extract.py — cut a source file into addressable
// units (the locator space). PDF/EPUB/DOCX/PPTX/XLSX are extracted by the
// ports in ./documents.ts (OOXML via shared/zip + the docx XML parser), the
// dependency-free PDF stream parser in store/kb_store.ts, and poppler's
// `pdftotext` when available for faithful per-page units.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { extractPdfText } from "../../store/kb_store.js";
import { docxToMarkdown } from "../documents/docx.js";
import {
  extractEpubSpine,
  extractPptxText,
  extractXlsxText,
} from "./documents.js";
import {
  ReadingError,
  type OutlineEntry,
  type RenderMode,
  type UnitKind,
  type UnitReference,
  outlineEntryToDict,
} from "./models.js";

// Target size of a synthesised "section" (~one dense printed page).
export const SECTION_TARGET_CHARS = 2800;
// Never emit a section longer than this even with no paragraph break.
export const SECTION_HARD_CHARS = 4200;

export const RAW_VIEW_EXTENSIONS = new Set([".pdf"]);
export const MARKDOWN_SUFFIXES = new Set([".md", ".markdown"]);

// Text-like suffixes the TS backend can cut into sections directly. Anything
// not listed here is rejected rather than silently mis-extracted.
const TEXT_SUFFIXES = new Set([
  ".txt", ".text", ".md", ".markdown", ".rst", ".org",
  ".csv", ".tsv", ".json", ".jsonl", ".xml", ".yaml", ".yml", ".toml",
  ".html", ".htm", ".log", ".srt", ".vtt",
]);
const CODE_SUFFIXES = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt", ".scala",
  ".sh", ".bash", ".zsh", ".fish", ".sql", ".r", ".m", ".lua", ".pl", ".pm",
]);

const MD_HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const MD_FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const SLIDE_SEPARATOR = /^--- Slide \d+ ---$/m;

export interface MediaItem {
  name: string;
  mime_type: string;
  data: Buffer;
  locator: number;
}

export interface Extraction {
  units: string[];
  unit: UnitKind;
  extractor: string;
  has_raw_view: boolean;
  title: string;
  outline: OutlineEntry[];
  render_mode: RenderMode;
  unit_refs: UnitReference[];
  media: MediaItem[];
  char_count: number;
}

// ---------------------------------------------------------------------------
// Flat text → sections
// ---------------------------------------------------------------------------

export function splitIntoSections(text: string): string[] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalised) return [];

  const sections: string[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = () => {
    if (buffer.length) {
      const joined = buffer.join("\n\n").trim();
      if (joined) sections.push(joined);
      buffer = [];
      size = 0;
    }
  };

  for (const paragraph of normalised.split("\n\n")) {
    const block = paragraph.trim();
    if (!block) continue;
    for (const piece of hardSplit(block, SECTION_HARD_CHARS)) {
      buffer.push(piece);
      size += piece.length;
      if (size >= SECTION_TARGET_CHARS) flush();
    }
  }
  flush();
  return sections;
}

export function splitMarkdownByHeadings(
  text: string,
): [string[], OutlineEntry[]] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!normalised) return [[], []];

  const boundaries: Array<{ start: number; level: number; title: string }> = [];
  // The run that opened the current fenced block; only a bare run of the same
  // character at least as long closes it (CommonMark-ish).
  let fenceMarker = "";
  let offset = 0;
  for (const line of normalised.split(/(?<=\n)/)) {
    const bare = line.replace(/\n$/, "");
    const fence = MD_FENCE.exec(bare);
    if (fence) {
      const marker = fence[1]!;
      const info = fence[2] ?? "";
      if (!fenceMarker) {
        // A backtick fence's info string cannot contain a backtick.
        if (!(marker[0] === "`" && info.includes("`"))) {
          fenceMarker = marker;
          offset += line.length;
          continue;
        }
      } else if (
        marker[0] === fenceMarker[0] &&
        marker.length >= fenceMarker.length &&
        !info.trim()
      ) {
        fenceMarker = "";
        offset += line.length;
        continue;
      }
    }
    if (!fenceMarker) {
      const heading = MD_HEADING.exec(bare);
      if (heading) {
        const title = cleanHeadingTitle(heading[2]!);
        if (title) {
          boundaries.push({ start: offset, level: heading[1]!.length, title });
        }
      }
    }
    offset += line.length;
  }

  if (boundaries.length < 2) {
    return [splitIntoSections(normalised), []];
  }

  const units: string[] = [];
  const outline: OutlineEntry[] = [];
  for (let index = 0; index < boundaries.length; index++) {
    const { start, level, title } = boundaries[index]!;
    const end = index + 1 < boundaries.length ? boundaries[index + 1]!.start : normalised.length;
    const sectionStart = index === 0 ? 0 : start;
    for (const piece of splitIntoSections(normalised.slice(sectionStart, end))) {
      units.push(piece);
      outline.push({ locator: units.length, title, level, synthesised: false, source_href: "", source_anchor: "" });
    }
  }
  return [units, outline];
}

function cleanHeadingTitle(title: string): string {
  const clean = title.replace(/\[([^]]*)\]\([^)]*\)/g, "$1");
  return clean.replace(/[*`_~]/g, "").trim();
}

function hardSplit(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const pieces: string[] = [];
  let remaining = block;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    let cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = limit;
    pieces.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Outline synthesis
// ---------------------------------------------------------------------------

export function synthesiseOutline(units: string[]): OutlineEntry[] {
  return units.map((unit, i) => ({
    locator: i + 1,
    title: firstLineLabel(unit),
    level: 1,
    synthesised: true,
    source_href: "",
    source_anchor: "",
  }));
}

export function firstLineLabel(unit: string, limit = 90): string {
  for (const rawLine of unit.split("\n")) {
    let line = rawLine.trim();
    if (line.length < 2) continue;
    const heading = MD_HEADING.exec(line);
    if (heading) line = heading[2]!.trim();
    if (!line) continue;
    return line.length <= limit ? line : line.slice(0, limit - 1).trimEnd() + "…";
  }
  return "";
}

// ---------------------------------------------------------------------------
// Format dispatch
// ---------------------------------------------------------------------------

export function extractMaterial(source: string, data?: Buffer): Extraction {
  const name = basename(source);
  const suffix = extname(name).toLowerCase();

  let extraction: Extraction;
  if (suffix === ".pdf") {
    extraction = extractPdf(source, data, name);
  } else if (suffix === ".epub") {
    extraction = extractEpub(source, data, name);
  } else if (suffix === ".docx") {
    extraction = extractDocx(source, data, name);
  } else if (suffix === ".pptx") {
    extraction = extractSlides(source, data, name);
  } else if (suffix === ".xlsx") {
    extraction = extractSpreadsheet(source, data, name);
  } else if (MARKDOWN_SUFFIXES.has(suffix)) {
    const [units, outline] = splitMarkdownByHeadings(readText(source, data, name));
    extraction = {
      units, unit: "section", extractor: "text", has_raw_view: false,
      title: "", outline, render_mode: "text", unit_refs: [], media: [],
      char_count: units.reduce((n, u) => n + u.length, 0),
    };
  } else if (TEXT_SUFFIXES.has(suffix) || CODE_SUFFIXES.has(suffix) || !suffix) {
    extraction = sectionsFromText(readText(source, data, name), "text");
  } else {
    throw new ReadingError(
      `${name}: unsupported reading format "${suffix || name}". ` +
        `Supported: PDF, EPUB, DOCX, PPTX, XLSX, text, Markdown, and source code.`,
    );
  }

  if (!extraction.units.some((u) => u.trim())) {
    throw new ReadingError(
      `${name}: no readable text could be extracted. ` +
        `A scanned document needs OCR before it can be read here.`,
    );
  }
  return extraction;
}

// ---------------------------------------------------------------------------
// Binary formats (ports of the upstream per-format extractors)
// ---------------------------------------------------------------------------

function readBytes(source: string, data: Buffer | undefined, name: string): Buffer {
  try {
    const bytes = data ?? readFileSync(source);
    if (!bytes.length) throw new ReadingError(`${name} is empty`);
    return bytes;
  } catch (exc) {
    if (exc instanceof ReadingError) throw exc;
    throw new ReadingError(`${name}: could not be read (${(exc as Error).message})`);
  }
}

// Poppler's pdftotext reads the PDF on stdin and emits one \f-terminated block
// per page — the same "one unit per physical page" contract PyMuPDF gives
// upstream. Absent or failing → fall back to the dependency-free stream
// parser in store/kb_store.ts (whole-document text → sections).
const PDF_TEXT_ARGS = ["-enc", "UTF-8", "-", "-"];

function pdfPagesViaPdftotext(data: Buffer): string[] | null {
  let res;
  try {
    res = spawnSync("pdftotext", PDF_TEXT_ARGS, {
      input: data,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    });
  } catch {
    return null;
  }
  if (res.error || res.status !== 0 || !res.stdout || res.stdout.length === 0) {
    return null;
  }
  const pages = res.stdout.toString("utf8").split("\f");
  // pdftotext terminates every page (including the last) with \f.
  if (pages.length > 1 && !pages[pages.length - 1]!.trim()) pages.pop();
  return pages.length ? pages : null;
}

function extractPdf(source: string, data: Buffer | undefined, name: string): Extraction {
  const bytes = readBytes(source, data, name);
  const pages = pdfPagesViaPdftotext(bytes);
  if (pages) {
    return {
      units: pages,
      unit: "page",
      extractor: "pdftotext",
      has_raw_view: true,
      title: "",
      outline: [],
      render_mode: "pdf",
      unit_refs: [],
      media: [],
      char_count: pages.reduce((n, u) => n + u.length, 0),
    };
  }
  // Fallback: the stream-parser in kb_store.ts yields one joined text, so the
  // locator space degrades to sections (render_mode "text", no page pairing).
  return sectionsFromText(extractPdfText(bytes), "pdf-stream");
}

function extractEpub(source: string, data: Buffer | undefined, name: string): Extraction {
  const bytes = readBytes(source, data, name);
  let spine;
  try {
    spine = extractEpubSpine(bytes, name);
  } catch (exc) {
    if (exc instanceof ReadingError) throw exc;
    throw new ReadingError(`${name}: failed to read EPUB (${(exc as Error).message})`);
  }
  const outline: OutlineEntry[] = spine.outline.map((row) => ({
    locator: row.locator,
    title: row.title,
    level: row.level,
    synthesised: false,
    source_href: row.source_href,
    source_anchor: row.source_anchor,
  }));
  if (!outline.length) {
    spine.units.forEach((unit, i) => {
      outline.push({
        locator: i + 1,
        title: unit.title || basename(unit.href).replace(/\.[^.]+$/, ""),
        level: 1,
        synthesised: !unit.title,
        source_href: unit.href,
        source_anchor: "",
      });
    });
  }
  const units = spine.units.map((unit) => unit.text);
  return {
    units,
    unit: "chapter",
    extractor: "epub-spine",
    has_raw_view: false,
    title: "",
    outline,
    render_mode: "epub",
    unit_refs: spine.units.map((unit, i) => ({
      locator: i + 1,
      source_href: unit.href,
      title: unit.title,
    })),
    media: [],
    char_count: units.reduce((n, u) => n + u.length, 0),
  };
}

function extractDocx(source: string, data: Buffer | undefined, name: string): Extraction {
  const bytes = readBytes(source, data, name);
  let markdown: string;
  try {
    markdown = docxToMarkdown(bytes, name);
  } catch (exc) {
    throw new ReadingError(`${name}: ${(exc as Error).message}`);
  }
  return sectionsFromText(markdown, "docx");
}

function extractSlides(source: string, data: Buffer | undefined, name: string): Extraction {
  const bytes = readBytes(source, data, name);
  let text: string;
  try {
    text = extractPptxText(bytes, name);
  } catch (exc) {
    if (exc instanceof ReadingError) throw exc;
    throw new ReadingError(`${name}: failed to read PPTX (${(exc as Error).message})`);
  }
  const parts = text.split(SLIDE_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) {
    // No slide separators (degenerate deck) — keep the text as flat sections.
    return sectionsFromText(text, "pptx-text");
  }
  return {
    units: parts,
    unit: "slide",
    extractor: "pptx",
    has_raw_view: false,
    title: "",
    outline: [],
    render_mode: "text",
    unit_refs: [],
    media: [],
    char_count: parts.reduce((n, u) => n + u.length, 0),
  };
}

function extractSpreadsheet(source: string, data: Buffer | undefined, name: string): Extraction {
  const bytes = readBytes(source, data, name);
  let text: string;
  try {
    text = extractXlsxText(bytes, name);
  } catch (exc) {
    if (exc instanceof ReadingError) throw exc;
    throw new ReadingError(`${name}: failed to read XLSX (${(exc as Error).message})`);
  }
  return sectionsFromText(text, "xlsx");
}

function readText(source: string, data: Buffer | undefined, name: string): string {
  let bytes: Buffer;
  try {
    bytes = data ?? readFileSync(source);
  } catch (exc) {
    throw new ReadingError(`${name}: could not be read (${(exc as Error).message})`);
  }
  if (!bytes.length) throw new ReadingError(`${name} is empty`);
  const suffix = extname(name).toLowerCase();
  let text = bytes.toString("utf8");
  if (suffix === ".html" || suffix === ".htm") {
    // Crude tag strip — enough for a first port; a real HTML→markdown
    // extractor is a TODO.
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, "\n")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'");
  }
  return text;
}

function sectionsFromText(text: string, extractor: string): Extraction {
  const units = splitIntoSections(text);
  return {
    units,
    unit: "section",
    extractor,
    has_raw_view: false,
    title: "",
    outline: [],
    render_mode: "text",
    unit_refs: [],
    media: [],
    char_count: units.reduce((n, u) => n + u.length, 0),
  };
}

export { outlineEntryToDict };
