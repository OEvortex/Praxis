// on-disk store for reading materials
// and their annotations.
//
// Layout, one directory per extracted content (identical to upstream so a
// migrated data directory keeps working):
//
//   <root>/<content_id>/
//       manifest.json        # MaterialManifest
//       outline.json         # OutlineEntry rows
//       unit_refs.json       # UnitReference rows
//       units/0001.txt       # one file per locator
//       raw/<filename>       # the original bytes, for the faithful viewer
//       render/<filename>    # browser-ready archive (EPUB repair)
//       media/ + media.json  # embedded images + captions
//       assets/              # generated rasters (web snapshots, covers)
//       revisions/           # immutable prior snapshots
//       annotations/<material_id>.json
//       positions/<material_id>.json
//       bookmarks/<material_id>.json
//
// Node is single-threaded and every write here is synchronous, so the
// upstream per-material re-entrant locks collapse to plain calls; JSON files
// are still written atomically (temp file + rename) like upstream.

import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, posix } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  annotationFromDict,
  annotationToDict,
  bookmarkFromDict,
  bookmarkToDict,
  manifestFromDict,
  manifestToDict,
  outlineEntryFromDict,
  outlineEntryToDict,
  positionFromDict,
  positionToDict,
  unitReferenceFromDict,
  unitReferenceToDict,
  type Annotation,
  type MaterialManifest,
  type OutlineEntry,
  type ReadingBookmark,
  type ReadingPosition,
  type TextPositionSelector,
  type TextQuoteSelector,
  type TextSelector,
  type UnitReference,
  MaterialNotFound,
  ReadingError,
  ReadingUpgradeConflict,
  MAX_TEXT_SELECTOR_CHARS,
} from "./models.js";
import { synthesiseOutline, extractMaterial } from "./extract.js";
import { normalizeEpubArchive } from "./documents.js";

export const MANIFEST_NAME = "manifest.json";
export const OUTLINE_NAME = "outline.json";
export const UNIT_REFS_NAME = "unit_refs.json";
export const ANNOTATIONS_DIR = "annotations";
export const POSITIONS_DIR = "positions";
export const BOOKMARKS_DIR = "bookmarks";
export const UNIT_REFS_NAME_ALT = UNIT_REFS_NAME;
export const UNITS_DIR = "units";
export const RAW_DIR = "raw";
export const RENDER_DIR = "render";
export const MEDIA_DIR = "media";
export const MEDIA_INDEX_NAME = "media.json";
export const ASSETS_DIR = "assets";
export const REVISIONS_DIR = "revisions";

export const MAX_BOOKMARKS = 200;
export const MAX_READ_CHARS = 60_000;

const CONTENT_ID_RE = /^[0-9a-f]{8,64}$/;
const MATERIAL_ID_RE = /^(?:[0-9a-f]{8,64}|rm_[0-9a-f]{12}|mat_[0-9a-f]+|rw_[0-9a-f]+)$/;
const ID_LENGTH = 16;

export function contentHash(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex").slice(0, ID_LENGTH);
}

// ---------------------------------------------------------------------------
// Quote-selector grounding helpers (port of store.py module functions)
// ---------------------------------------------------------------------------

function normaliseSelectorText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

interface QuoteSpan {
  start: number;
  end: number;
}

function findQuoteSpan(text: string, selector: TextQuoteSelector): QuoteSpan | null {
  const words = selector.exact.split(/\S+/).filter(Boolean);
  // Python: re.findall(r"\S+", exact) then join with \s+
  const parts = selector.exact.match(/\S+/g) ?? [];
  if (!parts.length) return null;
  const pattern = new RegExp(parts.map(escapeRe).join("\\s+"));
  const match = pattern.exec(text);
  if (!match) return null;
  const span = { start: match.index, end: match.index + match[0].length };
  if (quoteContextMatches(text, span, selector)) return span;
  // Python tries every match and returns the first context match.
  let m: RegExpExecArray | null;
  const global = new RegExp(pattern.source, "g");
  while ((m = global.exec(text)) !== null) {
    const candidate = { start: m.index, end: m.index + m[0].length };
    if (quoteContextMatches(text, candidate, selector)) return candidate;
  }
  return null;
}

function quoteContextMatches(
  text: string,
  span: QuoteSpan,
  selector: TextQuoteSelector,
): boolean {
  const wantedPrefix = normaliseSelectorText(selector.prefix);
  const wantedSuffix = normaliseSelectorText(selector.suffix);
  const preceding = normaliseSelectorText(text.slice(0, span.start));
  const following = normaliseSelectorText(text.slice(span.end));
  return (!wantedPrefix || preceding.endsWith(wantedPrefix)) &&
    (!wantedSuffix || following.startsWith(wantedSuffix));
}

function findAllQuoteSpans(text: string, selector: TextQuoteSelector): QuoteSpan[] {
  const parts = selector.exact.match(/\S+/g) ?? [];
  if (!parts.length) return [];
  const pattern = new RegExp(parts.map(escapeRe).join("\\s+"), "g");
  const all: QuoteSpan[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    all.push({ start: m.index, end: m.index + m[0].length });
  }
  const contextual = all.filter((span) => quoteContextMatches(text, span, selector));
  return contextual.length ? contextual : all;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Conservative Markdown → rendered-text projection for quote grounding.
// TODO: port deeptutor.services.session.selection_grounding.rendered_markdown_text
// faithfully (KaTeX-aware). This approximation strips inline markup so quotes
// taken from the rendered view still resolve.
export function renderedMarkdownText(unitText: string): string {
  return unitText
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]+\$/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// ReadingStore
// ---------------------------------------------------------------------------

export class ReadingStore {
  readonly root: string;

  constructor(root?: string | null) {
    this.root = root ?? "";
  }

  private dir(materialId: string): string {
    return join(this.root, this.contentId(materialId));
  }

  private validateId(materialId: string): string {
    const candidate = String(materialId ?? "").trim().toLowerCase();
    // Upstream accepts content hashes and minted ids; the catalog also mints
    // `mat_<hex>` ids, so accept that shape too.
    if (!/^(?:[0-9a-f]{8,64}|rm_[0-9a-f]{12}|mat_[0-9a-f]+)$/.test(candidate)) {
      throw new ReadingError(`invalid material id: ${JSON.stringify(materialId)}`);
    }
    return candidate;
  }

  private catalogRow(materialId: string): Record<string, unknown> | undefined {
    const dbPath = join(this.root, "_catalog.sqlite3");
    if (!existsSync(dbPath)) return undefined;
    try {
      const conn = new DatabaseSync(dbPath);
      try {
        return conn
          .prepare("SELECT * FROM reading_materials WHERE material_id = ?")
          .get(materialId) as Record<string, unknown> | undefined;
      } finally {
        conn.close();
      }
    } catch {
      return undefined;
    }
  }

  private contentId(materialId: string): string {
    const resolvedId = this.validateId(materialId);
    const row = this.catalogRow(resolvedId);
    const contentId = String(row?.content_id ?? resolvedId).trim().toLowerCase();
    if (!CONTENT_ID_RE.test(contentId)) {
      throw new ReadingError(`invalid content id for material ${JSON.stringify(materialId)}`);
    }
    return contentId;
  }

  private statePath(materialId: string, stateDir: string): string {
    const resolvedId = this.validateId(materialId);
    return join(this.dir(resolvedId), stateDir, `${resolvedId}.json`);
  }

  private legacyStatePath(materialId: string, filename: string): string | null {
    const resolvedId = this.validateId(materialId);
    const contentId = this.contentId(resolvedId);
    return resolvedId === contentId ? join(this.root, contentId, filename) : null;
  }

  private unitFile(materialDir: string, locator: number): string {
    return join(materialDir, UNITS_DIR, `${String(locator).padStart(4, "0")}.txt`);
  }

  // -- ingest -------------------------------------------------------------

  ingest(source: string, opts: { filename?: string; data?: Buffer } = {}): MaterialManifest {
    const name = opts.filename ?? basename(source);
    const data = opts.data ?? readFileSync(source);
    if (!data.length) throw new ReadingError(`${name} is empty`);

    const isEpub = name.toLowerCase().endsWith(".epub");
    // Finder-style wrapped EPUBs and __MACOSX residue are repacked so strict
    // browser EPUB readers can open the stored raw file (upstream
    // normalize_epub_archive); conforming archives pass through unchanged.
    const sourceData = isEpub ? normalizeEpubArchive(data, name) : data;

    const materialId = contentHash(sourceData);
    const displayName = name.trim() || basename(source);

    const existing = this.loadManifest(materialId);
    if (existing && this.isComplete(materialId, existing)) {
      if (!((name.toLowerCase().endsWith(".epub") && existing.render_mode !== "epub") ||
            (isEpub && !data.equals(sourceData)))) {
        return existing;
      }
      if (this.annotations(materialId).length) {
        throw new ReadingUpgradeConflict(
          "This EPUB was imported by the legacy text reader and has annotations. " +
            "Export those annotations before replacing it with the source-faithful version.",
        );
      }
    }

    const extraction = extractMaterial(source, isEpub ? sourceData : undefined);

    const materialDir = this.dir(materialId);
    const stageDir = join(this.root, `.${materialId}.${randomUUID().slice(0, 8)}.staging`);
    const unitsDir = join(stageDir, UNITS_DIR);
    mkdirSync(unitsDir, { recursive: true });

    extraction.units.forEach((unit, i) => {
      writeFileSync(this.unitFile(stageDir, i + 1), unit, "utf8");
    });

    const mediaRows: Array<Record<string, unknown>> = [];
    if (extraction.media.length) {
      const mediaDir = join(stageDir, MEDIA_DIR);
      mkdirSync(mediaDir, { recursive: true });
      for (const item of extraction.media) {
        writeFileSync(join(mediaDir, item.name), item.data);
        mediaRows.push({
          name: item.name,
          locator: item.locator,
          mime: item.mime_type,
          bytes: item.data.length,
        });
      }
      atomicWriteText(join(stageDir, MEDIA_INDEX_NAME), JSON.stringify(mediaRows));
    }

    if (extraction.render_mode !== "text") {
      const rawDir = join(stageDir, RAW_DIR);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(join(rawDir, safeFilename(displayName, basename(source))), sourceData);
    }

    // PDF page first-lines are not a table of contents — keep only the
    // document's own outline, or none.
    const outline =
      extraction.outline.length || extraction.render_mode === "pdf"
        ? extraction.outline
        : synthesiseOutline(extraction.units);
    atomicWriteText(
      join(stageDir, OUTLINE_NAME),
      JSON.stringify(outline.map(outlineEntryToDict)),
    );
    atomicWriteText(
      join(stageDir, UNIT_REFS_NAME),
      JSON.stringify(extraction.unit_refs.map(unitReferenceToDict)),
    );

    const manifest: MaterialManifest = {
      material_id: materialId,
      filename: displayName,
      unit: extraction.unit,
      unit_count: extraction.units.length,
      mime: guessMime(displayName),
      title: extraction.title || basename(displayName).replace(/\.[^.]+$/, ""),
      source_hash: materialId,
      extractor: extraction.extractor,
      byte_size: sourceData.length,
      char_count: extraction.char_count,
      created_at: Date.now() / 1000,
      has_raw_view: extraction.render_mode === "pdf",
      render_mode: extraction.render_mode,
      media_count: mediaRows.length,
      content_format: extname(name).toLowerCase() === ".md" ||
        extname(name).toLowerCase() === ".markdown"
        ? "web_markdown"
        : "plain_text",
      source_type: "upload",
      source_url: "",
      revision: 1,
    };
    // Manifest last: its presence is the "usable" signal.
    atomicWriteText(
      join(stageDir, MANIFEST_NAME),
      JSON.stringify(manifestToDict(manifest), null, 2),
    );

    // Carry user-owned state forward across a re-ingest.
    const stateNames = ["annotations.json", "position.json"];
    const stateDirs = [ANNOTATIONS_DIR, POSITIONS_DIR, BOOKMARKS_DIR];
    for (const stateName of stateNames) {
      const src = join(materialDir, stateName);
      if (existsSync(src)) copyFileSync(src, join(stageDir, stateName));
    }
    for (const stateDir of stateDirs) {
      const srcDir = join(materialDir, stateDir);
      if (existsSync(srcDir)) {
        copyDirSync(srcDir, join(stageDir, stateDir));
      }
    }

    // Install atomically: stage → backup swap, restore on failure.
    const backupDir = join(this.root, `.${materialId}.${randomUUID().slice(0, 8)}.backup`);
    try {
      if (existsSync(materialDir)) renameSync(materialDir, backupDir);
      try {
        renameSync(stageDir, materialDir);
      } catch (exc) {
        if (existsSync(backupDir) && !existsSync(materialDir)) {
          renameSync(backupDir, materialDir);
        }
        throw exc;
      }
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
    return this.manifest(materialId);
  }

  // -- ingest_units ---------------------------------------------------------

  ingestUnits(
    materialId: string,
    opts: {
      filename: string;
      units: string[];
      unit?: string;
      title?: string;
      mime?: string;
      extractor?: string;
      render_mode?: string;
      raw_data?: Buffer | null;
      outline?: OutlineEntry[] | null;
      unit_refs?: UnitReference[];
      content_format?: "plain_text" | "web_markdown";
      source_type?: string;
      source_url?: string;
      assets?: Record<string, Buffer>;
      carry_source?: boolean;
    },
  ): MaterialManifest {
    materialId = this.validateId(materialId);
    const contentId = this.contentId(materialId);
    const cleanUnits = opts.units.map((u) => String(u).trim()).filter(Boolean);
    if (!cleanUnits.length) {
      throw new ReadingError(`${opts.filename}: no readable content was extracted`);
    }
    const unit = opts.unit ?? "section";
    if (!["page", "chapter", "slide", "section", "segment"].includes(unit)) {
      throw new ReadingError(`unsupported reading unit: ${unit}`);
    }
    const renderMode = opts.render_mode ?? "text";
    if (!["text", "pdf", "epub", "video", "audio"].includes(renderMode)) {
      throw new ReadingError(`unsupported render mode: ${renderMode}`);
    }
    const contentFormat = opts.content_format ?? "plain_text";
    const remoteVideo = renderMode === "video" &&
      String(opts.extractor ?? "").startsWith("youtube-") ||
      String(opts.extractor ?? "").startsWith("bilibili-");
    const carried = Boolean(opts.carry_source) && this.hasRaw(materialId);
    if (renderMode !== "text" && !opts.raw_data && !remoteVideo && !carried) {
      throw new ReadingError(`${renderMode} materials require playable source bytes`);
    }

    const displayName = (opts.filename || "material").trim() || "material";
    const existing = this.loadManifest(contentId);
    const materialDir = this.dir(materialId);
    const stageDir = join(this.root, `.${materialId}.${randomUUID().slice(0, 8)}.staging`);
    mkdirSync(join(stageDir, UNITS_DIR), { recursive: true });
    cleanUnits.forEach((text, i) => {
      writeFileSync(this.unitFile(stageDir, i + 1), text, "utf8");
    });

    if (opts.assets) {
      const assetsDir = join(stageDir, ASSETS_DIR);
      mkdirSync(assetsDir, { recursive: true });
      for (const [name, data] of Object.entries(opts.assets)) {
        writeFileSync(join(assetsDir, safeFilename(String(name), "asset")), data);
      }
    } else if (opts.carry_source) {
      copyDirIfExists(join(materialDir, ASSETS_DIR), join(stageDir, ASSETS_DIR));
    }

    if (opts.raw_data != null) {
      const rawDir = join(stageDir, RAW_DIR);
      mkdirSync(rawDir, { recursive: true });
      writeFileSync(
        join(rawDir, safeFilename(displayName, "material")),
        opts.raw_data,
      );
    } else if (opts.carry_source) {
      copyDirIfExists(join(materialDir, RAW_DIR), join(stageDir, RAW_DIR));
    }

    const outline = opts.outline ?? synthesiseOutline(cleanUnits);
    atomicWriteText(join(stageDir, OUTLINE_NAME), JSON.stringify(outline.map(outlineEntryToDict)));
    atomicWriteText(
      join(stageDir, UNIT_REFS_NAME),
      JSON.stringify((opts.unit_refs ?? []).map(unitReferenceToDict)),
    );

    const manifest: MaterialManifest = {
      material_id: contentId,
      filename: displayName,
      unit: unit as MaterialManifest["unit"],
      unit_count: cleanUnits.length,
      mime: opts.mime ?? "text/markdown",
      title: (opts.title || basename(displayName).replace(/\.[^.]+$/, "")).trim(),
      source_hash: contentId,
      extractor: opts.extractor ?? "pre-extracted",
      byte_size:
        opts.raw_data != null
          ? opts.raw_data.length
          : opts.carry_source && existing
            ? existing.byte_size
            : 0,
      char_count: cleanUnits.reduce((n, v) => n + v.length, 0),
      created_at: existing?.created_at ?? Date.now() / 1000,
      has_raw_view: renderMode === "pdf",
      render_mode: renderMode as MaterialManifest["render_mode"],
      media_count: 0,
      content_format: contentFormat,
      source_type: opts.source_type ?? "upload",
      source_url: opts.source_url ?? "",
      revision: existing ? existing.revision + 1 : 1,
    };
    atomicWriteText(join(stageDir, MANIFEST_NAME), JSON.stringify(manifestToDict(manifest), null, 2));

    // Preserve prior revisions.
    if (existing && existsSync(materialDir)) {
      const previousRevisions = join(materialDir, REVISIONS_DIR);
      if (existsSync(previousRevisions)) {
        copyDirSync(previousRevisions, join(stageDir, REVISIONS_DIR));
      }
      const revisionDir = join(stageDir, REVISIONS_DIR, String(existing.revision).padStart(6, "0"));
      mkdirSync(revisionDir, { recursive: true });
      for (const filename of [MANIFEST_NAME, OUTLINE_NAME, UNIT_REFS_NAME]) {
        const source = join(materialDir, filename);
        if (existsSync(source)) copyFileSync(source, join(revisionDir, filename));
      }
      for (const dirname of [UNITS_DIR, ASSETS_DIR]) {
        const sourceDir = join(materialDir, dirname);
        if (existsSync(sourceDir)) copyDirSync(sourceDir, join(revisionDir, dirname));
      }
      const annotationsState = join(materialDir, ANNOTATIONS_DIR);
      if (existsSync(annotationsState)) {
        copyDirSync(annotationsState, join(revisionDir, ANNOTATIONS_DIR));
      }
    }
    for (const stateName of ["annotations.json", "position.json"]) {
      const src = join(materialDir, stateName);
      if (existsSync(src)) copyFileSync(src, join(stageDir, stateName));
    }
    for (const stateDir of [ANNOTATIONS_DIR, POSITIONS_DIR, BOOKMARKS_DIR]) {
      const srcDir = join(materialDir, stateDir);
      if (existsSync(srcDir)) copyDirSync(srcDir, join(stageDir, stateDir));
    }
    if (existing) this.reanchorAnnotations(stageDir, manifest.revision);

    const backupDir = join(this.root, `.${materialId}.${randomUUID().slice(0, 8)}.backup`);
    try {
      if (existsSync(materialDir)) renameSync(materialDir, backupDir);
      try {
        renameSync(stageDir, materialDir);
      } catch (exc) {
        if (existsSync(backupDir) && !existsSync(materialDir)) {
          renameSync(backupDir, materialDir);
        }
        throw exc;
      }
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
      rmSync(backupDir, { recursive: true, force: true });
    }
    return this.manifest(materialId);
  }

  // -- revisions ------------------------------------------------------------

  revisions(materialId: string): MaterialManifest[] {
    this.manifest(materialId);
    const root = join(this.dir(materialId), REVISIONS_DIR);
    if (!existsSync(root)) return [];
    const rows: MaterialManifest[] = [];
    for (const child of readdirSync(root).sort()) {
      if (!/^\d{6}$/.test(child)) continue;
      const data = readJson(join(root, child, MANIFEST_NAME));
      if (data && typeof data === "object" && !Array.isArray(data)) {
        rows.push(manifestFromDict(data as Record<string, unknown>));
      }
    }
    return rows;
  }

  revisionUnitText(materialId: string, revision: number, locator: number): string {
    this.manifest(materialId);
    if (revision < 1 || locator < 1) {
      throw new ReadingError("revision and locator must be positive");
    }
    const revisionDir = join(this.dir(materialId), REVISIONS_DIR, String(revision).padStart(6, "0"));
    const data = readJson(join(revisionDir, MANIFEST_NAME));
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new MaterialNotFound(`revision ${revision} not found`);
    }
    const manifest = manifestFromDict(data as Record<string, unknown>);
    if (locator > manifest.unit_count) {
      throw new ReadingError(
        `${manifest.unit} ${locator} is out of range for revision ${revision}.`,
      );
    }
    const path = this.unitFile(revisionDir, locator);
    if (!existsSync(path)) {
      throw new MaterialNotFound(`revision ${revision} unit ${locator} not found`);
    }
    return readFileSync(path, "utf8");
  }

  // -- read -----------------------------------------------------------------

  private isComplete(materialId: string, manifest: MaterialManifest): boolean {
    const materialDir = this.dir(materialId);
    if (manifest.unit_count <= 0) return false;
    if (!existsSync(this.unitFile(materialDir, manifest.unit_count))) return false;
    if (manifest.render_mode !== "text" && !this.findRaw(materialDir)) return false;
    return true;
  }

  private loadManifest(materialId: string): MaterialManifest | null {
    const resolvedId = this.validateId(materialId);
    const data = readJson(join(this.dir(resolvedId), MANIFEST_NAME));
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const manifest = manifestFromDict(data as Record<string, unknown>);
    if (!manifest.material_id) return null;
    const row = this.catalogRow(resolvedId);
    if (!row) return { ...manifest, material_id: resolvedId };
    const renderMode = String(row.render_mode ?? manifest.render_mode);
    return {
      ...manifest,
      material_id: resolvedId,
      filename: String(row.filename ?? manifest.filename),
      title: String(row.title ?? manifest.title),
      mime: String(row.mime ?? manifest.mime),
      render_mode: renderMode as MaterialManifest["render_mode"],
      has_raw_view: renderMode === "pdf",
      created_at: Number(row.created_at) || manifest.created_at,
    };
  }

  manifest(materialId: string): MaterialManifest {
    const manifest = this.loadManifest(materialId);
    if (!manifest) throw new MaterialNotFound(`material ${JSON.stringify(materialId)} not found`);
    return manifest;
  }

  exists(materialId: string): boolean {
    try {
      return this.loadManifest(materialId) !== null;
    } catch {
      return false;
    }
  }

  listMaterials(): MaterialManifest[] {
    if (!existsSync(this.root)) return [];
    const found: MaterialManifest[] = [];
    for (const child of readdirSync(this.root)) {
      if (!CONTENT_ID_RE.test(child) && !existsSync(join(this.root, child, MANIFEST_NAME))) {
        // Only content-hash directories count; staged dirs start with ".".
        continue;
      }
      if (!existsSync(join(this.root, child, MANIFEST_NAME))) continue;
      const manifest = this.loadManifest(child);
      if (manifest) found.push(manifest);
    }
    return found.sort((a, b) => b.created_at - a.created_at);
  }

  unitText(materialId: string, locator: number): string {
    const manifest = this.manifest(materialId);
    if (!(locator >= 1 && locator <= manifest.unit_count)) {
      throw new ReadingError(
        `${manifest.unit} ${locator} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    const path = this.unitFile(this.dir(materialId), locator);
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  }

  readUnits(
    materialId: string,
    locators: number[],
    opts: { max_chars?: number } = {},
  ): { rows: Array<[number, string]>; truncated: boolean } {
    const manifest = this.manifest(materialId);
    const wanted = [...new Set(locators.map(Number).filter((l) => l >= 1 && l <= manifest.unit_count))].sort((a, b) => a - b);
    const rows: Array<[number, string]> = [];
    let budget = Math.max(0, opts.max_chars ?? MAX_READ_CHARS);
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
    const requested = new Set(locators.map(Number));
    if (wanted.length < [...requested].filter((l) => l >= 1 && l <= manifest.unit_count).length) {
      truncated = true;
    }
    return { rows, truncated };
  }

  outline(materialId: string): OutlineEntry[] {
    const manifest = this.manifest(materialId);
    const rows = readJson(join(this.dir(materialId), OUTLINE_NAME));
    if (Array.isArray(rows)) {
      const entries = rows
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r))
        .map((r) => {
          try {
            return outlineEntryFromDict(r);
          } catch {
            return null;
          }
        })
        .filter((e): e is OutlineEntry => e !== null);
      if (manifest.render_mode === "pdf") {
        // PDFs keep native bookmarks or no outline; synthesised per-page rows
        // are migrated away at read time.
        return entries.every((e) => e.synthesised) ? [] : entries;
      }
      if (entries.length) return entries;
    }
    if (manifest.render_mode === "pdf") return [];
    const units = Array.from({ length: manifest.unit_count }, (_, i) =>
      this.unitText(materialId, i + 1),
    );
    return synthesiseOutline(units);
  }

  *iterUnits(materialId: string): Generator<[number, string]> {
    const manifest = this.manifest(materialId);
    for (let locator = 1; locator <= manifest.unit_count; locator++) {
      yield [locator, this.unitText(materialId, locator)];
    }
  }

  rawPath(materialId: string): string | null {
    const manifest = this.manifest(materialId);
    if (manifest.render_mode === "text") return null;
    return this.findRaw(this.dir(materialId));
  }

  renderPath(materialId: string): string | null {
    const manifest = this.manifest(materialId);
    if (manifest.render_mode === "text") return null;
    const materialDir = this.dir(materialId);
    return this.findFileInDir(join(materialDir, RENDER_DIR)) ?? this.findRaw(materialDir);
  }

  mediaItems(materialId: string): Array<Record<string, unknown>> {
    const rows = readJson(join(this.dir(materialId), MEDIA_INDEX_NAME));
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object" && !Array.isArray(r) && Boolean((r as Record<string, unknown>).name),
    );
  }

  mediaItemsAt(materialId: string, locator: number): Array<Record<string, unknown>> {
    return this.mediaItems(materialId).filter((r) => r.locator === locator);
  }

  mediaPath(materialId: string, name: string): string | null {
    const clean = posix.basename(String(name ?? "").replace(/\\/g, "/"));
    if (!clean) return null;
    if (!this.mediaItems(materialId).some((r) => r.name === clean)) return null;
    const path = join(this.dir(materialId), MEDIA_DIR, clean);
    return existsSync(path) ? path : null;
  }

  updateMediaCaptions(materialId: string, captions: Record<string, string>): number {
    const wanted = new Map<string, string>();
    for (const [name, value] of Object.entries(captions)) {
      const text = String(value ?? "").trim();
      if (text) wanted.set(String(name), text);
    }
    if (!wanted.size) return 0;
    const indexPath = join(this.dir(materialId), MEDIA_INDEX_NAME);
    const rows = readJson(indexPath);
    if (!Array.isArray(rows)) return 0;
    let changed = 0;
    for (const row of rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const rec = row as Record<string, unknown>;
      const name = String(rec.name ?? "");
      const caption = wanted.get(name);
      if (caption && String(rec.caption ?? "") !== caption) {
        rec.caption = caption;
        changed += 1;
      }
    }
    if (changed) atomicWriteText(indexPath, JSON.stringify(rows));
    return changed;
  }

  unitReferences(materialId: string): UnitReference[] {
    const manifest = this.manifest(materialId);
    const rows = readJson(join(this.dir(materialId), UNIT_REFS_NAME));
    if (!Array.isArray(rows)) {
      return Array.from({ length: manifest.unit_count }, (_, i) => ({
        locator: i + 1,
        source_href: "",
        title: "",
      }));
    }
    const refs = rows
      .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r))
      .map((r) => unitReferenceFromDict(r));
    return refs.filter((r) => r.locator >= 1 && r.locator <= manifest.unit_count);
  }

  position(materialId: string): ReadingPosition {
    this.manifest(materialId);
    const statePath = this.statePath(materialId, POSITIONS_DIR);
    let row = readJson(statePath);
    if (row === undefined && !existsSync(statePath)) {
      const legacy = this.legacyStatePath(materialId, "position.json");
      row = legacy ? readJson(legacy) : undefined;
    }
    return positionFromDict(row as Record<string, unknown> | null);
  }

  hasPosition(materialId: string): boolean {
    this.manifest(materialId);
    return existsSync(this.statePath(materialId, POSITIONS_DIR));
  }

  savePosition(materialId: string, position: ReadingPosition): ReadingPosition {
    const manifest = this.manifest(materialId);
    if (!(position.locator >= 1 && position.locator <= manifest.unit_count)) {
      throw new ReadingError(
        `${manifest.unit} ${position.locator} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    if (position.source_anchor.length > 4096) {
      throw new ReadingError("source anchor is too long");
    }
    if (!(position.percentage >= 0 && position.percentage <= 1)) {
      throw new ReadingError("position percentage must be between 0 and 1");
    }
    const stored: ReadingPosition = { ...position, updated_at: Date.now() / 1000 };
    atomicWriteText(
      this.statePath(materialId, POSITIONS_DIR),
      JSON.stringify(positionToDict(stored), null, 2),
    );
    return stored;
  }

  assetPath(materialId: string, assetName: string): string | null {
    this.manifest(materialId);
    const name = String(assetName ?? "").trim().toLowerCase();
    if (!/^(?:[0-9a-f]{20}|cover)\.(?:png|jpg|gif|webp)$/.test(name)) return null;
    const path = join(this.dir(materialId), ASSETS_DIR, name);
    return existsSync(path) ? path : null;
  }

  delete(materialId: string): boolean {
    const materialDir = this.dir(materialId);
    if (!existsSync(materialDir)) return false;
    rmSync(materialDir, { recursive: true, force: true });
    return true;
  }

  deleteMaterialState(materialId: string, opts: { content_id?: string | null } = {}): void {
    const resolvedId = this.validateId(materialId);
    const resolvedContent = String(opts.content_id ?? "").trim().toLowerCase() || this.contentId(resolvedId);
    if (!CONTENT_ID_RE.test(resolvedContent)) {
      throw new ReadingError(`invalid content id for material ${JSON.stringify(materialId)}`);
    }
    const contentDir = join(this.root, resolvedContent);
    for (const stateDir of [ANNOTATIONS_DIR, POSITIONS_DIR]) {
      rmSync(join(contentDir, stateDir, `${resolvedId}.json`), { force: true });
    }
  }

  // -- annotations ------------------------------------------------------------

  annotations(materialId: string): Annotation[] {
    this.manifest(materialId);
    const statePath = this.statePath(materialId, ANNOTATIONS_DIR);
    let rows = readJson(statePath);
    if (rows === undefined && !existsSync(statePath)) {
      const legacy = this.legacyStatePath(materialId, "annotations.json");
      rows = legacy ? readJson(legacy) : undefined;
    }
    if (!Array.isArray(rows)) return [];
    const parsed = rows
      .filter((r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object" && !Array.isArray(r) && Boolean((r as Record<string, unknown>).annotation_id),
      )
      .map((r) => annotationFromDict(r));
    return parsed.sort((a, b) => a.locator - b.locator || a.created_at - b.created_at);
  }

  saveAnnotation(materialId: string, annotation: Annotation): Annotation {
    const manifest = this.manifest(materialId);
    if (!(annotation.locator >= 1 && annotation.locator <= manifest.unit_count)) {
      throw new ReadingError(
        `${manifest.unit} ${annotation.locator} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    if (annotation.source_anchor.length > 4096) {
      throw new ReadingError("source anchor is too long");
    }
    const quoteSelectors = annotation.selectors.filter(
      (s): s is TextQuoteSelector => s.type === "TextQuoteSelector",
    );
    const positionSelectors = annotation.selectors.filter(
      (s): s is TextPositionSelector => s.type === "TextPositionSelector",
    );
    if (quoteSelectors.length > 1 || positionSelectors.length > 1) {
      throw new ReadingError("annotations may contain at most one selector of each type");
    }
    const quoteSelector = quoteSelectors[0];
    const positionSelector = positionSelectors[0];
    const unitText = annotation.selectors.length ? this.unitText(materialId, annotation.locator) : "";
    const renderedPositions = manifest.content_format === "web_markdown";
    const quoteText = renderedPositions ? renderedMarkdownText(unitText) : unitText;
    let positionText = "";
    if (positionSelector) {
      if (!renderedPositions && positionSelector.end > unitText.length) {
        throw new ReadingError("TextPositionSelector extends past this reading unit");
      }
      if (positionSelector.end - positionSelector.start > MAX_TEXT_SELECTOR_CHARS) {
        throw new ReadingError("TextPositionSelector span is too long");
      }
      if (!renderedPositions) {
        positionText = unitText.slice(positionSelector.start, positionSelector.end);
      }
    }
    let stored = { ...annotation };
    if (quoteSelector) {
      const normalisedExact = normaliseSelectorText(quoteSelector.exact);
      if (!normalisedExact) {
        throw new ReadingError("TextQuoteSelector exact text is empty");
      }
      if (stored.quote && normaliseSelectorText(stored.quote) !== normalisedExact) {
        throw new ReadingError("annotation quote does not match its TextQuoteSelector");
      }
      let canonicalExact: string;
      let span: { start: number; end: number } | null = null;
      if (positionSelector && !renderedPositions) {
        if (normaliseSelectorText(positionText) !== normalisedExact) {
          throw new ReadingError("text quote and position selectors describe different text");
        }
        if (
          !quoteContextMatches(
            unitText,
            { start: positionSelector.start, end: positionSelector.end },
            quoteSelector,
          )
        ) {
          throw new ReadingError("TextQuoteSelector context does not match this reading unit");
        }
        canonicalExact = positionText;
        span = { start: positionSelector.start, end: positionSelector.end };
      } else {
        span = findQuoteSpan(quoteText, quoteSelector);
        if (!span) {
          throw new ReadingError("TextQuoteSelector does not occur in this reading unit");
        }
        canonicalExact = quoteText.slice(span.start, span.end);
      }
      const canonicalQuote: TextQuoteSelector = { ...quoteSelector, exact: canonicalExact };
      stored = {
        ...stored,
        quote: canonicalExact,
        selectors: stored.selectors.map((s) =>
          s === quoteSelector ? canonicalQuote : s.type === "TextPositionSelector" && positionSelector && !renderedPositions
            ? { type: "TextPositionSelector", start: span!.start, end: span!.end } as TextSelector
            : s,
        ),
      };
    } else if (positionSelector && renderedPositions) {
      const span = findQuoteSpan(quoteText, {
        type: "TextQuoteSelector",
        exact: stored.quote,
        prefix: "",
        suffix: "",
      });
      if (!span) {
        throw new ReadingError("Markdown positions require a quote from this reading unit");
      }
      stored = { ...stored, quote: quoteText.slice(span.start, span.end) };
    } else if (positionSelector) {
      if (
        stored.quote &&
        normaliseSelectorText(stored.quote) !== normaliseSelectorText(positionText)
      ) {
        throw new ReadingError("annotation quote does not match its TextPositionSelector");
      }
      stored = { ...stored, quote: positionText };
    }

    const existing = this.annotations(materialId);
    let out = stored;
    if (!out.annotation_id) out = { ...out, annotation_id: randomUUID().replace(/-/g, "").slice(0, 12) };
    const now = Date.now() / 1000;
    const index = existing.findIndex((row) => row.annotation_id === out.annotation_id);
    if (index === -1) {
      out = {
        ...out,
        material_revision: manifest.revision,
        created_at: out.created_at || now,
        updated_at: now,
      };
      existing.push(out);
    } else {
      out = {
        ...out,
        material_revision: existing[index]!.material_revision,
        created_at: existing[index]!.created_at || now,
        updated_at: now,
      };
      existing[index] = out;
    }
    this.writeAnnotations(materialId, existing);
    return out;
  }

  deleteAnnotation(materialId: string, annotationId: string): boolean {
    this.manifest(materialId);
    const target = String(annotationId ?? "").trim();
    if (!target) return false;
    const existing = this.annotations(materialId);
    const remaining = existing.filter((row) => row.annotation_id !== target);
    if (remaining.length === existing.length) return false;
    this.writeAnnotations(materialId, remaining);
    return true;
  }

  private writeAnnotations(materialId: string, rows: Annotation[]): void {
    atomicWriteText(
      this.statePath(materialId, ANNOTATIONS_DIR),
      JSON.stringify(rows.map(annotationToDict), null, 2),
    );
  }

  // -- bookmarks ---------------------------------------------------------------

  bookmarks(materialId: string): ReadingBookmark[] {
    this.manifest(materialId);
    const rows = readJson(this.statePath(materialId, BOOKMARKS_DIR));
    if (!Array.isArray(rows)) return [];
    const parsed = rows
      .filter((r): r is Record<string, unknown> =>
        Boolean(r) && typeof r === "object" && !Array.isArray(r) && Boolean((r as Record<string, unknown>).bookmark_id),
      )
      .map((r) => bookmarkFromDict(r));
    return parsed.sort((a, b) => a.locator - b.locator || a.created_at - b.created_at);
  }

  addBookmark(
    materialId: string,
    locator: number,
    label = "",
    sourceAnchor = "",
  ): ReadingBookmark {
    const manifest = this.manifest(materialId);
    const target = Math.trunc(Number(locator));
    if (!(target >= 1 && target <= manifest.unit_count)) {
      throw new ReadingError(
        `${manifest.unit} ${target} is out of range — this material has ${manifest.unit_count}.`,
      );
    }
    const trimmed = String(label ?? "").trim().slice(0, 200);
    const anchor = String(sourceAnchor ?? "").slice(0, 4096);
    const existing = this.bookmarks(materialId);
    for (const row of existing) {
      if (row.locator === target) return row;
    }
    if (existing.length >= MAX_BOOKMARKS) {
      throw new ReadingError(
        `this material already has ${MAX_BOOKMARKS} bookmarks — remove one before adding another.`,
      );
    }
    const created: ReadingBookmark = {
      bookmark_id: `bm_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      locator: target,
      label: trimmed,
      source_anchor: anchor,
      created_at: Date.now() / 1000,
    };
    this.writeBookmarks(materialId, [...existing, created]);
    return created;
  }

  deleteBookmark(materialId: string, bookmarkId: string): boolean {
    this.manifest(materialId);
    const target = String(bookmarkId ?? "").trim();
    if (!target) return false;
    const existing = this.bookmarks(materialId);
    const remaining = existing.filter((row) => row.bookmark_id !== target);
    if (remaining.length === existing.length) return false;
    this.writeBookmarks(materialId, remaining);
    return true;
  }

  private writeBookmarks(materialId: string, rows: ReadingBookmark[]): void {
    atomicWriteText(
      this.statePath(materialId, BOOKMARKS_DIR),
      JSON.stringify(rows.map(bookmarkToDict), null, 2),
    );
  }

  // -- annotation re-anchoring on revision upgrade ------------------------------

  private reanchorAnnotations(stageDir: string, newRevision: number): void {
    const annotationsDir = join(stageDir, ANNOTATIONS_DIR);
    if (!existsSync(annotationsDir)) return;
    const unitTexts = new Map<number, string>();
    const unitsDir = join(stageDir, UNITS_DIR);
    if (existsSync(unitsDir)) {
      for (const file of readdirSync(unitsDir)) {
        if (!file.endsWith(".txt")) continue;
        const locator = Number(file.replace(/\.txt$/, ""));
        unitTexts.set(locator, readFileSync(join(unitsDir, file), "utf8"));
      }
    }
    for (const annotationsPath of readdirSync(annotationsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => join(annotationsDir, f))) {
      const rowsData = readJson(annotationsPath);
      if (!Array.isArray(rowsData) || !rowsData.length) continue;
      const rows = rowsData
        .filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object" && !Array.isArray(r) && Boolean((r as Record<string, unknown>).annotation_id))
        .map((r) => annotationFromDict(r));
      if (!rows.length) continue;
      let changed = false;
      const migrated: Annotation[] = [];
      for (const row of rows) {
        const quoteSelectors = row.selectors.filter(
          (s): s is TextQuoteSelector => s.type === "TextQuoteSelector",
        );
        if (!quoteSelectors.length) {
          migrated.push({ ...row, resolution: "unresolved" });
          changed = true;
          continue;
        }
        const quoteSelector = quoteSelectors[0]!;
        const matches: Array<{ locator: number; span: QuoteSpan }> = [];
        for (const [locator, text] of [...unitTexts.entries()].sort((a, b) => a[0] - b[0])) {
          for (const span of findAllQuoteSpans(text, quoteSelector)) {
            matches.push({ locator, span });
          }
        }
        if (matches.length === 1) {
          const { locator, span } = matches[0]!;
          const unitTextValue = unitTexts.get(locator)!;
          const canonicalExact = unitTextValue.slice(span.start, span.end);
          const newQuote: TextQuoteSelector = { ...quoteSelector, exact: canonicalExact };
          const newSelectors: TextSelector[] = row.selectors.map((s) => {
            if (s === quoteSelector) return newQuote;
            if (s.type === "TextPositionSelector") {
              return { type: "TextPositionSelector", start: span.start, end: span.end };
            }
            return s;
          });
          migrated.push({
            ...row,
            locator,
            quote: canonicalExact,
            selectors: newSelectors,
            material_revision: newRevision,
            resolution: "resolved",
          });
          changed = true;
        } else if (matches.length > 1) {
          migrated.push({ ...row, resolution: "ambiguous" });
          changed = true;
        } else {
          migrated.push({ ...row, resolution: "unresolved" });
          changed = true;
        }
      }
      if (changed) {
        atomicWriteText(
          annotationsPath,
          JSON.stringify(migrated.map(annotationToDict), null, 2),
        );
      }
    }
  }

  // -- path helpers --------------------------------------------------------------

  private findRaw(materialDir: string): string | null {
    return this.findFileInDir(join(materialDir, RAW_DIR));
  }

  private findFileInDir(directory: string): string | null {
    if (!existsSync(directory)) return null;
    for (const candidate of readdirSync(directory).sort()) {
      const path = join(directory, candidate);
      try {
        if (statSync(path).isFile()) return path;
      } catch {
        continue;
      }
    }
    return null;
  }

  private hasRaw(materialId: string): boolean {
    try {
      return this.findRaw(this.dir(this.contentId(materialId))) !== null;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    if ((exc as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

function atomicWriteText(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

function copyDirSync(src: string, dest: string): void {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    try {
      const st = statSync(s);
      if (st.isDirectory()) copyDirSync(s, d);
      else if (!existsSync(d)) copyFileSync(s, d);
    } catch {
      // skip unreadable entries, same tolerance as upstream copytree
    }
  }
}

function copyDirIfExists(src: string, dest: string): void {
  copyDirSync(src, dest);
}

const MAX_FILENAME_CHARS = 180;

function safeFilename(name: string, fallback: string): string {
  let base = basename(String(name ?? "")).trim();
  base = base.replace(/[\x00-\x1f]/g, "");
  base = base.replace(/[\\/]/g, "_");
  base = base.replace(/^\.+/, "").trim();
  if (!base) base = basename(fallback) || "material";
  if (base.length <= MAX_FILENAME_CHARS) return base;
  let suffix = extname(base);
  if (suffix.length > 16) suffix = "";
  const stem = base.slice(0, base.length - suffix.length).slice(0, MAX_FILENAME_CHARS - suffix.length);
  return stem.replace(/[. ]+$/, "") + suffix;
}

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessMime(filename: string): string {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? "application/octet-stream";
}

export { safeFilename as _safeFilenameForTests };
