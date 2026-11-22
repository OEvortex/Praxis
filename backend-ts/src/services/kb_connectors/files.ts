// Raw KB file operations: filesystem raw/ dir merged with sqlite kb_docs.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Settings } from "../../config.js";
import * as database from "../../store/database.js";
import { docxToMarkdown } from "../documents/docx.js";
import {
  KbConnectorError,
  ensureDir,
  getKbEntry,
  kbDir,
  rawDir,
  safeJoin,
} from "./store.js";
import { isConnectedKb, supportsLocalRawFiles } from "./types.js";
import { decodeBytes, getExtension } from "./file_types.js";
import { inflateRawSync } from "node:zlib";

export const MAX_FILE_SIZE = 200 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS_PER_DOC = 200_000;

// -- entry resolution ------------------------------------------------------------

function requireEntry(settings: Settings, kbName: string): Record<string, any> {
  const entry = getKbEntry(settings, kbName);
  if (entry === null) {
    throw new KbConnectorError(`Knowledge base '${kbName}' not found`);
  }
  return entry;
}

export function assertWritableKb(settings: Settings, kbName: string): Record<string, any> {
  const entry = requireEntry(settings, kbName);
  if (isConnectedKb(entry)) {
    throw new KbConnectorError(
      `Knowledge base '${kbName}' is connected to an external resource and is read-only.`,
    );
  }
  return entry;
}

export function resolveRawDir(settings: Settings, kbName: string, allowUnsupported = false): string | null {
  const entry = requireEntry(settings, kbName);
  if (!supportsLocalRawFiles(entry)) {
    if (allowUnsupported) return null;
    throw new KbConnectorError(
      `Knowledge base '${kbName}' is connected to an external resource and has no local files.`,
    );
  }
  return rawDir(settings, kbName);
}

function resolveWithin(root: string, filename: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, filename);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    throw new KbConnectorError("Access denied");
  }
  return target;
}

// -- listing -----------------------------------------------------------------------

interface RawListing {
  files: Record<string, unknown>[];
}

function mimeFor(name: string): string | null {
  const ext = getExtension(name);
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".epub": "application/epub+zip",
  };
  return map[ext] ?? null;
}

function sqliteDocs(settings: Settings, kbName: string): Record<string, unknown>[] {
  const connection = database.connect(settings);
  try {
    const rows = connection
      .prepare("SELECT name, size FROM kb_docs WHERE kb = ?")
      .all(kbName) as { name: string; size: number }[];
    return rows.map((r) => ({ name: r.name, size: Number(r.size ?? 0) }));
  } catch {
    return [];
  } finally {
    connection.close();
  }
}

function walkDir(root: string): { dirs: string[]; files: { abs: string; rel: string; size: number; mtime: number }[] } {
  const dirs: string[] = [];
  const files: { abs: string; rel: string; size: number; mtime: number }[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const rel = relative(root, p).split(sep).join("/");
        dirs.push(rel);
        walk(p);
      } else if (e.isFile()) {
        try {
          const st = statSync(p);
          files.push({
            abs: p,
            rel: relative(root, p).split(sep).join("/"),
            size: st.size,
            mtime: st.mtimeMs / 1000,
          });
        } catch {
          /* skip */
        }
      }
    }
  };
  walk(root);
  return { dirs, files };
}

/** GET /{kb}/files — raw/ tree merged with sqlite-stored docs. */
export function listKbRawFiles(settings: Settings, kbName: string): RawListing {
  const raw = resolveRawDir(settings, kbName, true);
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  if (raw !== null && existsSync(raw) && statSync(raw).isDirectory()) {
    const { dirs, files } = walkDir(raw);
    for (const d of dirs) {
      out.push({ name: d, type: "folder" });
      seen.add(d + "/");
    }
    for (const f of files) {
      out.push({
        name: f.rel,
        type: "file",
        size: f.size,
        modified: f.mtime,
        mime_type: mimeFor(f.rel),
      });
      seen.add(f.rel);
    }
  }

  // Merge sqlite docs not present on the filesystem (legacy/simple uploads).
  for (const doc of sqliteDocs(settings, kbName)) {
    const name = String(doc["name"]);
    if (seen.has(name)) continue;
    out.push({
      name,
      type: "file",
      size: doc["size"],
      modified: null,
      mime_type: mimeFor(name),
    });
  }

  out.sort((a, b) =>
    String(a["name"]).toLowerCase().localeCompare(String(b["name"]).toLowerCase()),
  );
  return { files: out };
}

// -- folder / move ----------------------------------------------------------------

function sanitizeRelSubdir(relPath: unknown): string {
  let s = String(relPath ?? "").trim();
  // strip leading/trailing slashes and any ".." segments
  s = s.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const parts = s.split("/").filter((p) => p && p !== "." && p !== "..");
  return parts.join("/");
}

export function createKbFolder(settings: Settings, kbName: string, relPath: string): { status: string; path: string } {
  assertWritableKb(settings, kbName);
  const root = rawDir(settings, kbName);
  const subdir = sanitizeRelSubdir(relPath);
  if (!subdir) throw new KbConnectorError("Folder name is required");
  const target = safeJoin(root, subdir);
  if (target === null) throw new KbConnectorError("Access denied");
  ensureDir(target);
  return { status: "ok", path: subdir };
}

export function moveKbFile(
  settings: Settings,
  kbName: string,
  source: string,
  destFolder: string,
): { status: string; path: string } {
  assertWritableKb(settings, kbName);
  const root = resolve(rawDir(settings, kbName));
  const sourceRel = sanitizeRelSubdir(source);
  if (!sourceRel) throw new KbConnectorError("Source path is required");
  const src = safeJoin(root, sourceRel);
  if (src === null) throw new KbConnectorError("Access denied");
  if (!existsSync(src)) throw new KbConnectorError("Source not found");

  const destFolderRel = sanitizeRelSubdir(destFolder);
  const destDir = destFolderRel ? safeJoin(root, destFolderRel) : root;
  if (destDir === null) throw new KbConnectorError("Access denied");
  const dest = join(destDir, basename(src));

  if (resolve(dest) === resolve(src)) {
    return { status: "ok", path: sourceRel };
  }
  const srcResolved = resolve(src);
  const destDirResolved = resolve(destDir);
  if (
    statSync(src).isDirectory() &&
    (destDirResolved === srcResolved || destDirResolved.startsWith(srcResolved + sep))
  ) {
    throw new KbConnectorError("Cannot move a folder into itself");
  }
  if (existsSync(dest)) {
    throw new KbConnectorError(`'${basename(src)}' already exists in the target folder`);
  }
  ensureDir(destDir);
  renameSync(src, dest);
  // Keep sqlite doc rows in sync for flat names.
  syncMovedDoc(settings, kbName, sourceRel, relative(root, dest).split(sep).join("/"));
  return { status: "ok", path: relative(root, dest).split(sep).join("/") };
}

function syncMovedDoc(settings: Settings, kbName: string, oldRel: string, newRel: string): void {
  // kb_docs rows keyed by flat name only; update when the basename matches.
  const connection = database.connect(settings);
  try {
    const rows = connection
      .prepare("SELECT name, data, size FROM kb_docs WHERE kb = ?")
      .all(kbName) as { name: string; data: unknown; size: number }[];
    for (const row of rows) {
      if (row.name === oldRel || row.name === basename(oldRel)) {
        connection
          .prepare("UPDATE kb_docs SET name = ? WHERE kb = ? AND name = ?")
          .run(newRel, kbName, row.name);
      }
    }
  } finally {
    connection.close();
  }
}

// -- resolve single file --------------------------------------------------------------

export interface ResolvedRawFile {
  kind: "fs" | "sqlite";
  path: string | null;
  name: string;
  data: Uint8Array | null;
  mime: string | null;
}

/** Resolve a raw file by KB-relative path; falls back to sqlite kb_docs. */
export function resolveRawFile(settings: Settings, kbName: string, filename: string): ResolvedRawFile {
  const entry = requireEntry(settings, kbName);
  if (!supportsLocalRawFiles(entry)) {
    throw new KbConnectorError(
      `Knowledge base '${kbName}' is connected to an external resource and has no local files.`,
    );
  }
  const root = rawDir(settings, kbName);
  const target = safeJoin(root, filename);
  if (target === null) throw new KbConnectorError("Access denied");
  try {
    if (existsSync(target) && statSync(target).isFile()) {
      return {
        kind: "fs",
        path: target,
        name: basename(target),
        data: null,
        mime: mimeFor(target),
      };
    }
  } catch {
    /* fall through */
  }
  // sqlite fallback (flat doc names only)
  const flat = filename.split("/").pop() ?? filename;
  const connection = database.connect(settings);
  try {
    const row = connection
      .prepare("SELECT name, data FROM kb_docs WHERE kb = ? AND name IN (?, ?)")
      .get(kbName, filename, flat) as { name: string; data: unknown } | undefined;
    if (row !== undefined) {
      const data =
        row.data instanceof Uint8Array
          ? row.data
          : Buffer.from(String(row.data ?? ""), "utf-8");
      return { kind: "sqlite", path: null, name: row.name, data, mime: mimeFor(row.name) };
    }
  } finally {
    connection.close();
  }
  throw new KbConnectorError("File not found");
}

// -- delete ------------------------------------------------------------------------------

export function deleteKbFile(
  settings: Settings,
  kbName: string,
  filename: string,
): { status: string; path: string; was_indexed: boolean } {
  const entry = assertWritableKb(settings, kbName);
  void entry;
  const resolved = resolveRawFile(settings, kbName, filename);
  const rel = resolved.kind === "fs" && resolved.path
    ? relative(rawDir(settings, kbName), resolved.path).split(sep).join("/")
    : resolved.name;

  let wasIndexed = false;
  const connection = database.connect(settings);
  try {
    const chunkRow = connection
      .prepare("SELECT 1 FROM kb_chunks WHERE kb = ? AND doc = ? LIMIT 1")
      .get(kbName, resolved.name);
    wasIndexed = chunkRow !== undefined;
    connection.prepare("DELETE FROM kb_docs WHERE kb = ? AND name = ?").run(kbName, resolved.name);
    connection.prepare("DELETE FROM kb_chunks WHERE kb = ? AND doc = ?").run(kbName, resolved.name);
  } finally {
    connection.close();
  }

  if (resolved.kind === "fs" && resolved.path) {
    rmSync(resolved.path, { force: true });
    // remove empty parent dirs up to raw/
    const root = resolve(rawDir(settings, kbName));
    let dir = resolve(resolved.path, "..");
    while (dir.startsWith(root + sep) || dir === root) {
      try {
        if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
        else break;
      } catch {
        break;
      }
      if (dir === root) break;
      dir = resolve(dir, "..");
    }
  }
  return { status: "ok", path: rel, was_indexed: wasIndexed };
}

// -- preview text ------------------------------------------------------------------------

// Minimal PDF text extractor: inflate streams, pull literal/hex strings shown by
// Tj/TJ operators, decode PDFDoc/WinAnsi-ish. Best-effort for previews.
// Exported for the question-mimic pipeline (question.py upload mode), which
// uses it as the no-MinerU fallback text source for uploaded exam PDFs.
export function pdfExtractText(data: Uint8Array, maxChars: number): string {
  const src = new TextDecoder("latin1").decode(data);
  const out: string[] = [];
  const streamRe = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  let streams = 0;
  while ((m = streamRe.exec(src)) !== null && streams < 256) {
    const start = m.index + m[0].length;
    const end = src.indexOf("endstream", start);
    if (end < 0) break;
    streams++;
    const raw = data.subarray(start, end);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(inflateRawSync(Buffer.from(raw)));
    } catch {
      continue;
    }
    if (bytes.length > 8 * 1024 * 1024) continue;
    const s = new TextDecoder("latin1").decode(bytes);
    // literal strings
    const litRe = /\((?:\\.|[^\\()])*\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = litRe.exec(s)) !== null) {
      const inner = lm[0].slice(1, -1);
      out.push(pdfDecodeLiteral(inner));
    }
    // hex strings
    const hexRe = /<([0-9a-fA-F\s]+)>/g;
    while ((lm = hexRe.exec(s)) !== null) {
      const hex = lm[1].replace(/\s+/g, "");
      if (hex.length % 2) continue;
      let t = "";
      for (let i = 0; i + 1 < hex.length; i += 2) {
        const code = parseInt(hex.slice(i, i + 2), 16);
        t += code >= 32 && code < 127 ? String.fromCharCode(code) : " ";
      }
      out.push(t);
    }
  }
  return out
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function pdfDecodeLiteral(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x5c && i + 1 < s.length) {
      const e = s[++i];
      if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (/[0-7]/.test(e)) {
        let oct = e;
        while (oct.length < 3 && i + 1 < s.length && /[0-7]/.test(s[i + 1])) {
          oct += s[++i];
        }
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
      } else out += e;
    } else {
      out += c >= 32 && c < 127 ? s[i] : " ";
    }
  }
  return out;
}

export class DocumentExtractionError extends Error {}

/** extract_text_from_path subset: text-like decode, docx, pdf, epub→unsupported. */
export function extractPreviewText(path: string, name: string): string {
  const data = readFileSync(path);
  if (data.length > MAX_FILE_SIZE) {
    throw new DocumentExtractionError(`File exceeds maximum size of ${MAX_FILE_SIZE} bytes`);
  }
  const ext = getExtension(name);
  let text: string;
  if (ext === ".docx") {
    try {
      text = docxToMarkdown(data, name);
    } catch (exc) {
      throw new DocumentExtractionError(`Could not extract text: ${exc}`);
    }
  } else if (ext === ".pdf") {
    text = pdfExtractText(data, MAX_EXTRACTED_CHARS_PER_DOC);
  } else if ([".xlsx", ".pptx", ".epub"].includes(ext)) {
    throw new DocumentExtractionError(`${name}: unsupported preview format`);
  } else {
    text = decodeBytes(data).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  if (!text.trim()) {
    throw new DocumentExtractionError(`${name}: no extractable text`);
  }
  return text.slice(0, MAX_EXTRACTED_CHARS_PER_DOC);
}

/** Preview for a resolved file (fs or sqlite blob). */
export function previewResolvedFile(resolved: ResolvedRawFile): string {
  if (resolved.kind === "sqlite") {
    if (!resolved.data) throw new DocumentExtractionError("File not found");
    const ext = getExtension(resolved.name);
    if (ext === ".docx") {
      return docxToMarkdown(resolved.data, resolved.name).slice(0, MAX_EXTRACTED_CHARS_PER_DOC);
    }
    if (ext === ".pdf") {
      return pdfExtractText(resolved.data, MAX_EXTRACTED_CHARS_PER_DOC);
    }
    return decodeBytes(resolved.data)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .slice(0, MAX_EXTRACTED_CHARS_PER_DOC);
  }
  return extractPreviewText(resolved.path!, resolved.name);
}
