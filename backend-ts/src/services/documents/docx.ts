// Port of backend/app/services/documents/docx.py — Markdown <-> DOCX
// conversion for Co-Writer interchange.
//
// python-docx is replaced by a minimal in-house OOXML implementation:
//   * a small ZIP reader/writer built on node:zlib (store + deflate),
//   * a small XML parser sufficient for wordprocessingML,
//   * a hand-rolled .docx writer emitting the same document structure
//     python-docx produces (styles.xml, numbering.xml, document.xml,
//     document.xml.rels).

import { deflateRawSync, inflateRawSync } from "node:zlib";

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0];
const DOCX_MAX_MEMBERS = 4096;
const DOCX_MAX_MEMBER_BYTES = 20 * 1024 * 1024;
const DOCX_MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
const DOCX_MAX_COMPRESSION_RATIO = 200.0;
const MAX_MARKDOWN_CHARS = 600_000;

const HYPERLINK_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
const CODE_FONTS = new Set([
  "consolas",
  "courier new",
  "courier",
  "menlo",
  "monaco",
  "cascadia mono",
]);
const CODE_FONT = "Consolas";
const XML_INVALID_TEXT_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]/g;

const HEADING_STYLES: Record<string, number> = {
  title: 1,
  "heading 1": 1,
  "heading 2": 2,
  "heading 3": 3,
  "heading 4": 4,
  "heading 5": 5,
  "heading 6": 6,
  subtitle: 2,
};
const QUOTE_STYLES = new Set(["quote", "intense quote", "blockquote"]);

const ORDERED_NUM_FMTS = new Set([
  "decimal",
  "decimalzero",
  "lowerletter",
  "upperletter",
  "lowerroman",
  "upperroman",
  "ordinal",
  "ordinaltext",
  "cardinaltext",
  "decimalenclosedcircle",
  "decimalenclosedparen",
]);

const MD_HEADING_RE = /^(#{1,6})\s+(.*)$/;
const MD_UL_RE = /^[-*+]\s+(.*)$/;
const MD_OL_RE = /^\d+[.)]\s+(.*)$/;
const MD_QUOTE_RE = /^>\s?(.*)$/;
const MD_HR_RE = /^(-{3,}|\*{3,}|_{3,})$/;
const MD_TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const MD_FENCE_RE = /^```/;

const UNPARSEABLE_ROW_CELL = "(unparseable row)";
const INLINE_RE =
  /\[(?<link_text>[^\]\n]*)\]\((?<link_href>[^)\s]*)\)|`(?<code>[^`\n]+)`|\*\*\*(?<bi>[^\n]+?)\*\*\*|\*\*(?<b1>[^\n]+?)\*\*|__(?<b2>[^\n]+?)__|~~(?<strike>[^\n]+?)~~|\*(?<i1>[^\n]+?)\*|(?<!\w)_(?!_)(?<i2>[^\n]+?)(?<!_)_(?!\w)/g;
const ESCAPABLE = new Set("\\`*_[]~|<>#+-.!()");
const ESCAPE_RE = /([\\`*_\[\]~|])/g;
// A "|" not preceded by an odd number of backslashes.
const UNESCAPED_PIPE_RE = /(?<!\\)(?:\\\\)*\|/g;
const MASK = "\x00";

export class DocxConversionError extends Error {}

// ===========================================================================
// Minimal ZIP container (store + deflate) and CRC32
// ===========================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Uint8Array;
  /** Store uncompressed (method 0) instead of deflating — EPUB mimetype. */
  stored?: boolean;
}

/** Build a .zip archive (deflate method 8, or stored when `stored`) from named entries. */
export function createZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >>> 8) & 0xff]);
  const u32 = (v: number) =>
    new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]);
  const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  };

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const method = entry.stored ? 0 : 8;
    const compressed = entry.stored
      ? entry.data
      : new Uint8Array(deflateRawSync(Buffer.from(entry.data)));
    const crc = crc32(entry.data);
    const localOffset = offset;

    const local = concat([
      u32(0x04034b50),
      u16(20), // version needed
      u16(0x0800), // UTF-8 flag
      u16(method),
      u16(0), // time
      u16(0), // date
      u32(crc),
      u32(compressed.length),
      u32(entry.data.length),
      u16(nameBytes.length),
      u16(0), // extra len
      nameBytes,
      compressed,
    ]);
    chunks.push(local);
    offset += local.length;

    central.push(
      concat([
        u32(0x02014b50),
        u16(20), // version made by
        u16(20), // version needed
        u16(0x0800),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(compressed.length),
        u32(entry.data.length),
        u16(nameBytes.length),
        u16(0), // extra
        u16(0), // comment
        u16(0), // disk
        u16(0), // internal attrs
        u32(0), // external attrs
        u32(localOffset),
        nameBytes,
      ])
    );
  }

  const centralDir = concat(central);
  const centralOffset = offset;
  const eocd = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(centralOffset),
    u16(0),
  ]);

  return concat([...chunks, centralDir, eocd]);
}

interface ZipInfo {
  name: string;
  method: number;
  compressedSize: number;
  fileSize: number;
  localHeaderOffset: number;
}

function _u16le(view: DataView, off: number): number {
  return view.getUint16(off, true);
}
function _u32le(view: DataView, off: number): number {
  return view.getUint32(off, true);
}

function _listZipMembers(data: Uint8Array): ZipInfo[] {
  // Locate End Of Central Directory by scanning the tail.
  const minEocd = Math.max(0, data.length - 22 - 0xffff);
  let eocdOff = -1;
  for (let i = data.length - 22; i >= minEocd; i--) {
    if (
      data[i] === 0x50 &&
      data[i + 1] === 0x4b &&
      data[i + 2] === 0x05 &&
      data[i + 3] === 0x06
    ) {
      eocdOff = i;
      break;
    }
  }
  if (eocdOff < 0) throw new Error("bad zip: no EOCD");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = _u16le(view, eocdOff + 10);
  const cdOffset = _u32le(view, eocdOff + 16);

  const members: ZipInfo[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (_u32le(view, p) !== 0x02014b50) throw new Error("bad zip: central directory");
    const method = _u16le(view, p + 10);
    const compressedSize = _u32le(view, p + 20);
    const fileSize = _u32le(view, p + 24);
    const nameLen = _u16le(view, p + 28);
    const extraLen = _u16le(view, p + 30);
    const commentLen = _u16le(view, p + 32);
    const localHeaderOffset = _u32le(view, p + 42);
    const name = new TextDecoder().decode(
      data.subarray(p + 46, p + 46 + nameLen)
    );
    // python: ``if not info.is_dir()`` — directory entries are skipped.
    if (!name.endsWith("/")) {
      members.push({ name, method, compressedSize, fileSize, localHeaderOffset });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

function _readZipMember(
  data: Uint8Array,
  info: ZipInfo
): Uint8Array | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const off = info.localHeaderOffset;
  if (_u32le(view, off) !== 0x04034b50) return null;
  const nameLen = _u16le(view, off + 26);
  const extraLen = _u16le(view, off + 28);
  const start = off + 30 + nameLen + extraLen;
  const raw = data.subarray(start, start + info.compressedSize);
  if (info.method === 0) return raw;
  if (info.method === 8) return new Uint8Array(inflateRawSync(Buffer.from(raw)));
  return null;
}

function _validateDocxArchive(data: Uint8Array, filename: string): void {
  let members: ZipInfo[];
  try {
    members = _listZipMembers(data);
  } catch {
    throw new DocxConversionError(
      `${filename} is not a valid Word document. ` +
        "Please open it in Word and save it as a new .docx file."
    );
  }
  if (members.length > DOCX_MAX_MEMBERS) {
    throw new DocxConversionError(
      `${filename} has too many archive members (${members.length}).`
    );
  }
  let total = 0;
  for (const info of members) {
    if (info.fileSize > DOCX_MAX_MEMBER_BYTES) {
      throw new DocxConversionError(
        `${filename}: archive member ${info.name} is too large.`
      );
    }
    total += info.fileSize;
    if (total > DOCX_MAX_TOTAL_UNCOMPRESSED) {
      throw new DocxConversionError(
        `${filename}: uncompressed contents are too large.`
      );
    }
    if (
      info.compressedSize > 0 &&
      info.fileSize / info.compressedSize > DOCX_MAX_COMPRESSION_RATIO
    ) {
      throw new DocxConversionError(
        `${filename}: archive member ${info.name} has a suspicious compression ratio.`
      );
    }
  }
}

// ===========================================================================
// Minimal XML parser (elements, attributes, text, comments, CDATA)
// ===========================================================================

export interface XNode {
  tag: string;
  attrs: Record<string, string>;
  children: Array<XNode | string>;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseXml(src: string): XNode {
  let i = 0;
  const n = src.length;

  function parseAttrs(s: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      attrs[m[1]] = decodeXmlEntities(m[2] ?? m[3] ?? "");
    }
    return attrs;
  }

  function parseElement(): XNode {
    // assumes src[i] === '<' and not a comment/decl/CDATA
    i++; // consume '<'
    let name = "";
    while (i < n && !/[\s/>]/.test(src[i])) name += src[i++];
    const node: XNode = { tag: name, attrs: {}, children: [] };
    // attributes until '>' or '/>'
    let attrText = "";
    while (i < n) {
      const ch = src[i];
      if (ch === ">") {
        i++;
        break;
      }
      if (ch === "/" && src[i + 1] === ">") {
        i += 2;
        node.attrs = parseAttrs(attrText);
        return node; // self-closing
      }
      attrText += ch;
      i++;
    }
    node.attrs = parseAttrs(attrText);
    // children until matching close tag
    let text = "";
    const flush = () => {
      if (text) {
        node.children.push(decodeXmlEntities(text));
        text = "";
      }
    };
    while (i < n) {
      if (src.startsWith("</", i)) {
        const end = src.indexOf(">", i);
        i = end < 0 ? n : end + 1;
        flush();
        return node;
      }
      if (src.startsWith("<!--", i)) {
        const end = src.indexOf("-->", i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (src.startsWith("<![CDATA[", i)) {
        const end = src.indexOf("]]>", i + 9);
        text += src.slice(i + 9, end < 0 ? n : end);
        i = end < 0 ? n : end + 3;
        continue;
      }
      if (src[i] === "<") {
        flush();
        node.children.push(parseElement());
        continue;
      }
      text += src[i++];
    }
    flush();
    return node;
  }

  // skip prolog / misc until root element
  while (i < n) {
    if (src[i] === "<") {
      if (src.startsWith("<!--", i) || src.startsWith("<?", i) || src.startsWith("<!", i)) {
        const close = src.indexOf(">", i);
        i = close < 0 ? n : close + 1;
        continue;
      }
      return parseElement();
    }
    i++;
  }
  throw new Error("no root element");
}

// --- XML tree helpers -------------------------------------------------------

function isEl(child: XNode | string): child is XNode {
  return typeof child !== "string";
}

/** Local name without namespace prefix ("w:p" -> "p"). */
function localName(tag: string): string {
  const idx = tag.indexOf(":");
  return idx < 0 ? tag : tag.slice(idx + 1);
}

function childElements(node: XNode, local: string): XNode[] {
  const out: XNode[] = [];
  for (const c of node.children) {
    if (isEl(c) && localName(c.tag) === local) out.push(c);
  }
  return out;
}

function firstChild(node: XNode, local: string): XNode | undefined {
  for (const c of node.children) {
    if (isEl(c) && localName(c.tag) === local) return c;
  }
  return undefined;
}

function findDescendant(node: XNode, local: string): XNode | undefined {
  for (const c of node.children) {
    if (!isEl(c)) continue;
    if (localName(c.tag) === local) return c;
    const found = findDescendant(c, local);
    if (found) return found;
  }
  return undefined;
}

function findDescendants(node: XNode, local: string, out: XNode[] = []): XNode[] {
  for (const c of node.children) {
    if (!isEl(c)) continue;
    if (localName(c.tag) === local) out.push(c);
    findDescendants(c, local, out);
  }
  return out;
}

// ===========================================================================
// DOCX -> Markdown
// ===========================================================================

export function docxToMarkdown(data: Uint8Array, filename = "document.docx"): string {
  if (!data || data.length === 0) {
    throw new DocxConversionError(`${filename} is empty.`);
  }
  if (
    data.length >= 4 &&
    data[0] === OLE_MAGIC[0] &&
    data[1] === OLE_MAGIC[1] &&
    data[2] === OLE_MAGIC[2] &&
    data[3] === OLE_MAGIC[3]
  ) {
    throw new DocxConversionError(
      "Legacy .doc files are not supported yet. " +
        "Please save the document as .docx and try again."
    );
  }
  if (
    data.length < 4 ||
    data[0] !== OOXML_MAGIC[0] ||
    data[1] !== OOXML_MAGIC[1] ||
    data[2] !== OOXML_MAGIC[2] ||
    data[3] !== OOXML_MAGIC[3]
  ) {
    throw new DocxConversionError(
      `${filename} is not a valid Word document. ` +
        "Please open it in Word and save it as a new .docx file."
    );
  }
  _validateDocxArchive(data, filename);

  // Unpack members we need.
  const members = _listZipMembers(data);
  const wanted = new Map<string, Uint8Array>();
  for (const info of members) {
    if (
      info.name === "word/document.xml" ||
      info.name === "word/numbering.xml" ||
      info.name === "word/styles.xml" ||
      info.name === "word/_rels/document.xml.rels"
    ) {
      const content = _readZipMember(data, info);
      if (content) wanted.set(info.name, content);
    }
  }
  const documentXml = wanted.get("word/document.xml");
  if (!documentXml) {
    throw new DocxConversionError(
      `${filename} could not be read. Please open it in Word and save it as a new .docx file.`
    );
  }

  const document = parseXml(new TextDecoder().decode(documentXml));
  const numberingRoot = wanted.has("word/numbering.xml")
    ? parseXml(new TextDecoder().decode(wanted.get("word/numbering.xml")!))
    : null;
  const numbering = numberingFormats(numberingRoot);
  const styleNames = styleNameMap(wanted.has("word/styles.xml")
    ? parseXml(new TextDecoder().decode(wanted.get("word/styles.xml")!))
    : null);
  const rels = relTargetMap(
    wanted.has("word/_rels/document.xml.rels")
      ? parseXml(new TextDecoder().decode(wanted.get("word/_rels/document.xml.rels")!))
      : null
  );

  const body = findDescendant(document, "body");
  if (!body) {
    throw new DocxConversionError(
      `${filename} could not be read. Please open it in Word and save it as a new .docx file.`
    );
  }

  const blocks: string[] = [];
  let tablesSeen = 0;
  for (const child of body.children) {
    if (!isEl(child)) continue;
    const ln = localName(child.tag);
    let tableOrdinal: number | null = null;
    if (ln === "tbl") {
      tableOrdinal = tablesSeen;
      tablesSeen += 1;
      blocks.push(tableToMarkdown(child, tableOrdinal));
    } else if (ln === "p") {
      blocks.push(paragraphToMarkdown(child, numbering, styleNames, rels));
    }
  }
  const markdown = joinBlocks(blocks);
  const cleaned = markdown.trim();
  if (!cleaned) {
    throw new DocxConversionError(`${filename} has no extractable text.`);
  }
  if (cleaned.length > MAX_MARKDOWN_CHARS) {
    throw new DocxConversionError(
      `${filename} exceeds the Co-Writer character limit ` +
        `(${MAX_MARKDOWN_CHARS.toLocaleString("en-US")} characters).`
    );
  }
  return cleaned;
}

/** Map (numId, ilvl) -> Word numbering format, when numbering.xml exists. */
function numberingFormats(
  numbering: XNode | null
): Map<string, string> {
  const formats = new Map<string, string>();
  if (!numbering) return formats;
  try {
    const abstractLevels = new Map<string, Map<string, string>>();
    for (const abs of findDescendants(numbering, "abstractNum")) {
      const abstractId = abs.attrs["w:abstractNumId"];
      if (abstractId === undefined) continue;
      const levels = new Map<string, string>();
      for (const lvl of childElements(abs, "lvl")) {
        const ilvl = lvl.attrs["w:ilvl"] ?? "0";
        const fmtNode = firstChild(lvl, "numFmt");
        if (fmtNode) {
          levels.set(ilvl, (fmtNode.attrs["w:val"] ?? "").toLowerCase());
        }
      }
      abstractLevels.set(abstractId, levels);
    }
    for (const num of findDescendants(numbering, "num")) {
      const numId = num.attrs["w:numId"];
      const ref = firstChild(num, "abstractNumId");
      if (numId === undefined || !ref) continue;
      const levels = abstractLevels.get(ref.attrs["w:val"] ?? "");
      if (!levels) continue;
      for (const [ilvl, fmt] of levels) {
        formats.set(`${numId}${ilvl}`, fmt);
      }
    }
  } catch {
    return new Map();
  }
  return formats;
}

/** styleId -> display name from word/styles.xml. */
function styleNameMap(styles: XNode | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!styles) return map;
  for (const style of findDescendants(styles, "style")) {
    const id = style.attrs["w:styleId"];
    if (id === undefined) continue;
    const nameNode = firstChild(style, "name");
    if (nameNode?.attrs["w:val"]) {
      map.set(id, nameNode.attrs["w:val"]);
    }
  }
  return map;
}

/** rId -> hyperlink target from word/_rels/document.xml.rels. */
function relTargetMap(rels: XNode | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!rels) return map;
  for (const rel of findDescendants(rels, "Relationship")) {
    const id = rel.attrs["Id"];
    const target = rel.attrs["Target"];
    if (id && target) map.set(id, target);
  }
  return map;
}

function paragraphPlainText(p: XNode): string {
  // Concatenation of all w:t descendants (what python-docx .text approximates).
  let out = "";
  const walk = (node: XNode) => {
    for (const c of node.children) {
      if (!isEl(c)) continue;
      const ln = localName(c.tag);
      if (ln === "t") {
        for (const t of c.children) if (typeof t === "string") out += t;
      } else if (ln === "tab") {
        out += "\t";
      } else if (ln === "br" || ln === "cr") {
        out += "\n";
      } else {
        walk(c);
      }
    }
  };
  walk(p);
  return out;
}

function styleNameOf(
  p: XNode,
  styleNames: Map<string, string>
): string {
  const pPr = firstChild(p, "pPr");
  const pStyle = pPr ? firstChild(pPr, "pStyle") : undefined;
  const styleId = pStyle?.attrs["w:val"];
  if (!styleId) return "";
  return styleNames.get(styleId) ?? styleId;
}

function normalizeStyleKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/** heading lookup tolerant of styleIds like "Heading1". */
function headingLevel(styleKey: string): number | undefined {
  const direct = HEADING_STYLES[styleKey];
  if (direct !== undefined) return direct;
  const squashed = styleKey.replace(/\s+/g, "");
  for (const [key, level] of Object.entries(HEADING_STYLES)) {
    if (key.replace(/\s+/g, "") === squashed) return level;
  }
  return undefined;
}

function numberingRef(p: XNode): [string | null, string | null] {
  const pPr = firstChild(p, "pPr");
  const numPr = pPr ? firstChild(pPr, "numPr") : undefined;
  if (!numPr) return [null, null];
  const numIdNode = firstChild(numPr, "numId");
  const ilvlNode = firstChild(numPr, "ilvl");
  const numId = numIdNode?.attrs["w:val"] ?? null;
  const ilvl = ilvlNode?.attrs["w:val"] ?? "0";
  return [numId, ilvl];
}

function listKind(
  p: XNode,
  lowerStyle: string,
  numbering: Map<string, string>
): [string | null, number] {
  // "(kind, indent_level)" where kind is "ul", "ol" or null.
  if (lowerStyle.includes("heading") || ["title", "subtitle"].includes(lowerStyle)) {
    return [null, 0];
  }
  const [numId, ilvl] = numberingRef(p);
  const level = ilvl && /^\d+$/.test(ilvl) ? Math.min(parseInt(ilvl, 10), 5) : 0;
  if (numId !== null) {
    const fmt = numbering.get(`${numId}${ilvl ?? "0"}`) ?? "";
    if (fmt === "bullet") return ["ul", level];
    if (ORDERED_NUM_FMTS.has(fmt)) return ["ol", level];
  }
  // Fall back to the style name when numbering.xml is absent/unreadable.
  if (lowerStyle.includes("number") || lowerStyle.includes("enum")) return ["ol", level];
  if (lowerStyle.includes("bullet")) return ["ul", level];
  if (numId !== null) return ["ul", level];
  return [null, 0];
}

function paragraphToMarkdown(
  p: XNode,
  numbering: Map<string, string>,
  styleNames: Map<string, string>,
  rels: Map<string, string>
): string {
  const plain = paragraphPlainText(p);
  if (!plain.trim()) return "";
  const styleName = normalizeStyleKey(styleNameOf(p, styleNames));
  const body = inlineContentToMarkdown(p, rels) || escapeMd(plain.trim());
  const heading = headingLevel(styleName);
  if (heading !== undefined) return `${"#".repeat(heading)} ${body}`;
  const [kind, level] = listKind(p, styleName, numbering);
  const indent = "  ".repeat(level);
  if (kind === "ol") return `${indent}1. ${body}`;
  if (kind === "ul") return `${indent}- ${body}`;
  if (QUOTE_STYLES.has(styleName)) return `> ${body}`;
  return body;
}

function runToMarkdown(r: XNode): string {
  const text = paragraphPlainText(r);
  if (!text) return "";
  const rPr = firstChild(r, "rPr");
  const rFonts = rPr ? firstChild(rPr, "rFonts") : undefined;
  const fontName = (
    rFonts?.attrs["w:ascii"] ??
    rFonts?.attrs["w:hAnsi"] ??
    ""
  ).toLowerCase();
  if (CODE_FONTS.has(fontName)) {
    return text.includes("`") ? escapeMd(text) : `\`${text}\``;
  }
  let out = escapeMd(text);
  const strike = rPr ? firstChild(rPr, "strike") ?? firstChild(rPr, "dstrike") : undefined;
  if (strike && onVal(strike)) out = `~~${out}~~`;
  const b = rPr ? firstChild(rPr, "b") : undefined;
  const i = rPr ? firstChild(rPr, "i") : undefined;
  const bold = !!b && onVal(b);
  const italic = !!i && onVal(i);
  if (bold && italic) return `***${out}***`;
  if (bold) return `**${out}**`;
  if (italic) return `*${out}*`;
  return out;
}

/** w:val semantics for on/off properties (absent val => on). */
function onVal(el: XNode): boolean {
  const v = el.attrs["w:val"];
  if (v === undefined) return true;
  return !/^(0|false|off|none)$/i.test(v);
}

function runsToMarkdown(runs: XNode[]): string {
  return runs.map(runToMarkdown).join("");
}

function inlineContentToMarkdown(
  p: XNode,
  rels: Map<string, string>
): string {
  // Render runs *and* hyperlinks; plain run iteration misses linked runs.
  const parts: string[] = [];
  for (const child of p.children) {
    if (!isEl(child)) continue;
    const ln = localName(child.tag);
    if (ln === "hyperlink") {
      const runs = findDescendants(child, "r");
      const text = runsToMarkdown(runs) || escapeMd(paragraphPlainText(child).trim());
      if (!text) continue;
      const rId = child.attrs["r:id"] ?? child.attrs["id"];
      const address = (rId ? rels.get(rId) : undefined)?.trim() ?? "";
      parts.push(address ? `[${text}](${address})` : text);
    } else if (ln === "r") {
      parts.push(runToMarkdown(child));
    }
  }
  return parts.join("");
}

function cellText(cell: XNode): string {
  // python-docx cell.text covers the cell's direct paragraphs.
  const paras = childElements(cell, "p");
  const text = paras
    .map((p) => paragraphPlainText(p).trim())
    .filter(Boolean)
    .join(" ");
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** w:tr children of this table, not descending into nested w:tbl. */
function tableRows(table: XNode): XNode[] {
  const rows: XNode[] = [];
  for (const child of table.children) {
    if (!isEl(child)) continue;
    const ln = localName(child.tag);
    if (ln === "tr") rows.push(child);
    // nested w:tbl subtrees are skipped (python-docx row.cells also treats
    // the outer table only).
  }
  return rows;
}

function tableToMarkdown(table: XNode, tableOrdinal: number | null): string {
  const rows: string[][] = [];
  const trs = tableRows(table);
  for (let rowIndex = 0; rowIndex < trs.length; rowIndex++) {
    let cells: string[];
    try {
      cells = childElements(trs[rowIndex], "tc").map(cellText);
    } catch (exc) {
      const where =
        tableOrdinal !== null
          ? `table #${tableOrdinal + 1} row #${rowIndex + 1}`
          : `row #${rowIndex + 1}`;
      console.warn(
        `DOCX ${where} could not be parsed; kept a placeholder row (${exc})`
      );
      rows.push([UNPARSEABLE_ROW_CELL]);
      continue;
    }
    if (cells.some((cell) => cell.trim())) rows.push(cells);
  }
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => row.concat(Array(width - row.length).fill("")));
  const header = normalized[0];
  const lines = [
    "| " + header.join(" | ") + " |",
    "| " + header.map(() => "---").join(" | ") + " |",
  ];
  for (const row of normalized.slice(1)) {
    lines.push("| " + row.join(" | ") + " |");
  }
  return lines.join("\n");
}

function joinBlocks(blocks: string[]): string {
  return groupCodeBlocks(blocks).join("\n\n");
}

function groupCodeBlocks(blocks: string[]): string[] {
  // Re-fence runs of monospaced paragraphs that were a code block.
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      out.push("```\n" + run.map((line) => line.slice(1, -1)).join("\n") + "\n```");
    }
    run = [];
  };
  for (const block of blocks) {
    if (!block.trim()) continue;
    if (isCodeLine(block)) {
      run.push(block);
      continue;
    }
    flush();
    out.push(block);
  }
  flush();
  return out;
}

function isCodeLine(block: string): boolean {
  return (
    block.length >= 2 &&
    block.startsWith("`") &&
    block.endsWith("`") &&
    !block.slice(1, -1).includes("`") &&
    !block.includes("\n")
  );
}

function escapeMd(text: string): string {
  return text.replace(ESCAPE_RE, "\\$1");
}

// ===========================================================================
// Markdown -> DOCX
// ===========================================================================

interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
}
interface DocxHyperlink {
  text: string;
  url: string;
  id: string; // rId assigned for the document rels part
}
type DocxInline = DocxRun | DocxHyperlink;
interface DocxParagraph {
  styleId?: string;
  runs: DocxInline[];
  hyperlinks: DocxHyperlink[]; // python-docx appends hyperlinks at paragraph end
}
interface DocxTable {
  rows: string[][];
}
type DocxBlock = { kind: "p"; p: DocxParagraph } | { kind: "tbl"; t: DocxTable };

export function markdownToDocx(content: string, _title = ""): Uint8Array {
  // ``title`` is unused: any heading already lives in the markdown body.
  const cleaned = (content ?? "").replace(XML_INVALID_TEXT_RE, "");
  const lines = cleaned.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const blocks: DocxBlock[] = [];
  const hyperlinks: { id: string; url: string }[] = [];
  let hyperlinkSeq = 0;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped) {
      index += 1;
      continue;
    }
    if (MD_FENCE_RE.test(stripped)) {
      index = appendCodeBlock(blocks, lines, index);
      continue;
    }
    if (
      stripped.startsWith("|") &&
      index + 1 < lines.length &&
      MD_TABLE_SEP_RE.test(lines[index + 1].trim())
    ) {
      index = appendMarkdownTable(blocks, lines, index);
      continue;
    }
    const heading = MD_HEADING_RE.exec(stripped);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const text = heading[2].trim();
      if (text) {
        blocks.push({
          kind: "p",
          p: styledParagraph(text, `Heading${level}`, hyperlinks, () => `rId${++hyperlinkSeq}`),
        });
      }
      index += 1;
      continue;
    }
    if (MD_HR_RE.test(stripped)) {
      index += 1;
      continue;
    }
    const quote = MD_QUOTE_RE.exec(stripped);
    if (quote) {
      blocks.push({
        kind: "p",
        p: styledParagraph(quote[1], "Quote", hyperlinks, () => `rId${++hyperlinkSeq}`),
      });
      index += 1;
      continue;
    }
    const indent = leadingIndent(line);
    const unordered = MD_UL_RE.exec(stripped);
    if (unordered) {
      blocks.push({
        kind: "p",
        p: styledParagraph(
          unordered[1],
          listStyleId("ListBullet", indent),
          hyperlinks,
          () => `rId${++hyperlinkSeq}`
        ),
      });
      index += 1;
      continue;
    }
    const ordered = MD_OL_RE.exec(stripped);
    if (ordered) {
      blocks.push({
        kind: "p",
        p: styledParagraph(
          ordered[1],
          listStyleId("ListNumber", indent),
          hyperlinks,
          () => `rId${++hyperlinkSeq}`
        ),
      });
      index += 1;
      continue;
    }
    const p: DocxParagraph = { runs: [], hyperlinks: [] };
    addInlineRuns(p, stripped, hyperlinks, () => `rId${++hyperlinkSeq}`);
    blocks.push({ kind: "p", p });
    index += 1;
  }

  return buildDocx(blocks, hyperlinks);
}

function styledParagraph(
  text: string,
  styleId: string,
  hyperlinks: { id: string; url: string }[],
  nextId: () => string
): DocxParagraph {
  const p: DocxParagraph = { styleId, runs: [], hyperlinks: [] };
  addInlineRuns(p, text, hyperlinks, nextId);
  return p;
}

function leadingIndent(line: string): number {
  const expanded = line.replace(/\t/g, "    ");
  const leading = expanded.length - expanded.replace(/^ +/, "").length;
  return Math.min(Math.floor(leading / 2), 2);
}

function listStyleId(base: "ListBullet" | "ListNumber", indent: number): string {
  // python-docx: "List Bullet"/"List Bullet 2"/"List Bullet 3" (indent<=2).
  const suffix = indent <= 0 ? "" : String(indent + 1);
  return base + suffix;
}

function appendCodeBlock(blocks: DocxBlock[], lines: string[], index: number): number {
  index += 1;
  const collected: string[] = [];
  while (index < lines.length) {
    if (MD_FENCE_RE.test(lines[index].trim())) {
      index += 1;
      break;
    }
    collected.push(lines[index]);
    index += 1;
  }
  for (const line of collected.length ? collected : [""]) {
    blocks.push({
      kind: "p",
      p: { runs: [{ text: line, code: true }], hyperlinks: [] },
    });
  }
  return index;
}

function appendMarkdownTable(blocks: DocxBlock[], lines: string[], index: number): number {
  const rows: string[][] = [splitTableRow(lines[index])];
  index += 2;
  while (index < lines.length && lines[index].trim().startsWith("|")) {
    rows.push(splitTableRow(lines[index]));
    index += 1;
  }
  const cols = Math.max(0, ...rows.map((row) => row.length));
  if (cols === 0) return index;
  blocks.push({ kind: "tbl", t: { rows } });
  return index;
}

function splitTableRow(line: string): string[] {
  // Split on unescaped "|" so "\|" stays inside a cell.
  const stripped = line.trim();
  const cells: string[] = [];
  let start = 0;
  UNESCAPED_PIPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = UNESCAPED_PIPE_RE.exec(stripped)) !== null) {
    const pos = m.index + m[0].length - 1;
    cells.push(stripped.slice(start, pos));
    start = pos + 1;
  }
  cells.push(stripped.slice(start));
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => unescapeMd(cell.trim()));
}

function unescapeMd(text: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      out.push(text[i + 1]);
      i += 2;
    } else {
      out.push(text[i]);
      i += 1;
    }
  }
  return out.join("");
}

interface MaskResult {
  masked: string;
  saved: string[];
}

function maskEscapes(text: string): MaskResult {
  // Replace "\X" escapes with a sentinel so markers cannot match them.
  const out: string[] = [];
  const saved: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && i + 1 < text.length && ESCAPABLE.has(text[i + 1])) {
      saved.push(text[i + 1]);
      out.push(MASK);
      i += 2;
    } else {
      out.push(text[i]);
      i += 1;
    }
  }
  return { masked: out.join(""), saved };
}

function unmask(fragment: string, saved: string[], cursor: { pos: number }): string {
  if (!fragment.includes(MASK)) return fragment;
  let out = "";
  for (const ch of fragment) {
    out += ch === MASK ? saved[cursor.pos++] : ch;
  }
  return out;
}

function addInlineRuns(
  p: DocxParagraph,
  text: string,
  hyperlinks: { id: string; url: string }[],
  nextId: () => string
): void {
  // A literal NUL collides with the escape sentinel MASK; NUL is not valid
  // XML text anyway, so strip invalid chars before masking.
  const cleaned = text.replace(XML_INVALID_TEXT_RE, "");
  const { masked, saved } = maskEscapes(cleaned);
  const cursor = { pos: 0 };
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(masked)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (start > last) {
      p.runs.push({ text: unmask(masked.slice(last, start), saved, cursor) });
    }
    const g = m.groups ?? {};
    if (g.link_text !== undefined) {
      const linkText = unmask(g.link_text, saved, cursor);
      const linkHref = unmask(g.link_href ?? "", saved, cursor);
      addHyperlink(p, hyperlinks, nextId, linkText, linkHref);
    } else if (g.code !== undefined) {
      p.runs.push({ text: unmask(g.code, saved, cursor), code: true });
    } else if (g.bi !== undefined) {
      p.runs.push({ text: unmask(g.bi, saved, cursor), bold: true, italic: true });
    } else if (g.b1 !== undefined || g.b2 !== undefined) {
      p.runs.push({
        text: unmask(g.b1 ?? g.b2 ?? "", saved, cursor),
        bold: true,
      });
    } else if (g.strike !== undefined) {
      p.runs.push({ text: unmask(g.strike, saved, cursor), strike: true });
    } else {
      p.runs.push({
        text: unmask(g.i1 ?? g.i2 ?? "", saved, cursor),
        italic: true,
      });
    }
    last = end;
  }
  if (last < masked.length) {
    p.runs.push({ text: unmask(masked.slice(last), saved, cursor) });
  }
}

function addHyperlink(
  p: DocxParagraph,
  hyperlinks: { id: string; url: string }[],
  nextId: () => string,
  text: string,
  url: string
): void {
  if (!text) return;
  if (!url) {
    p.runs.push({ text });
    return;
  }
  const id = nextId();
  const link: DocxHyperlink = { text, url, id };
  hyperlinks.push({ id, url });
  // python-docx appends the hyperlink element at the end of the paragraph.
  p.hyperlinks.push(link);
}

// ===========================================================================
// .docx package writer
// ===========================================================================

const W_NS =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const CT_NS =
  "http://schemas.openxmlformats.org/package/2006/content-types";

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function runXml(run: DocxRun | DocxHyperlink, isHyperlink = false): string {
  const rPrParts: string[] = [];
  if (isHyperlink) {
    rPrParts.push(`<w:rStyle w:val="Hyperlink"/>`);
  }
  if ("code" in run && run.code) {
    rPrParts.push(
      `<w:rFonts w:ascii="${CODE_FONT}" w:hAnsi="${CODE_FONT}"/>`
    );
  }
  if ("bold" in run && run.bold) rPrParts.push("<w:b/>");
  if ("italic" in run && run.italic) rPrParts.push("<w:i/>");
  if ("strike" in run && run.strike) rPrParts.push("<w:strike/>");
  const rPr = rPrParts.length ? `<w:rPr>${rPrParts.join("")}</w:rPr>` : "";
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
}

const HEADING_LEVELS = [
  // styleId -> [name, basedOn, outlineLvl, bold, sizeHalfPoints, before, after]
  ["Heading1", "heading 1", "Normal", 0, true, 32, 240, 60],
  ["Heading2", "heading 2", "Normal", 1, true, 28, 200, 40],
  ["Heading3", "heading 3", "Normal", 2, true, 24, 160, 20],
  ["Heading4", "heading 4", "Normal", 3, true, 22, 120, 20],
  ["Heading5", "heading 5", "Normal", 4, true, 20, 80, 10],
  ["Heading6", "heading 6", "Normal", 5, true, 20, 40, 10],
] as const;

function stylesXml(): string {
  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`);
  parts.push(
    `<w:styles xmlns:w="${W_NS}">` +
      `<w:docDefaults><w:rPrDefault><w:rPr>` +
      `<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>` +
      `<w:sz w:val="22"/><w:szCs w:val="22"/>` +
      `<w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/>` +
      `</w:rPr></w:rPrDefault>` +
      `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault>` +
      `</w:docDefaults>`
  );
  parts.push(
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal">` +
      `<w:name w:val="Normal"/><w:qFormat/>` +
      `</w:style>`
  );
  for (const [id, name, basedOn, lvl, bold, size, before, after] of HEADING_LEVELS) {
    parts.push(
      `<w:style w:type="paragraph" w:styleId="${id}">` +
        `<w:name w:val="${name}"/><w:basedOn w:val="${basedOn}"/><w:next w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${before}" w:after="${after}"/>` +
        `<w:outlineLvl w:val="${lvl}"/></w:pPr>` +
        `<w:rPr>${bold ? "<w:b/>" : ""}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>` +
        `</w:style>`
    );
  }
  // Quote style.
  parts.push(
    `<w:style w:type="paragraph" w:styleId="Quote">` +
      `<w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
      `<w:pPr><w:spacing w:before="160" w:after="160"/><w:ind w:left="720" w:right="720"/></w:pPr>` +
      `<w:rPr><w:i/></w:rPr>` +
      `</w:style>`
  );
  // List styles — numbering wired through numbering.xml (numId 1 bullet, 2 decimal).
  const listDefs: Array<[string, string, number, number]> = [
    // [styleId, name, ilvl, numId]
    ["ListBullet", "List Bullet", 0, 1],
    ["ListBullet2", "List Bullet 2", 1, 1],
    ["ListBullet3", "List Bullet 3", 2, 1],
    ["ListNumber", "List Number", 0, 2],
    ["ListNumber2", "List Number 2", 1, 2],
    ["ListNumber3", "List Number 3", 2, 2],
  ];
  for (const [id, name, ilvl, numId] of listDefs) {
    parts.push(
      `<w:style w:type="paragraph" w:styleId="${id}">` +
        `<w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
        `<w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>` +
        `<w:spacing w:after="0"/><w:ind w:left="${720 * (ilvl + 1)}" w:hanging="360"/></w:pPr>` +
        `</w:style>`
    );
  }
  parts.push(
    `<w:style w:type="character" w:styleId="Hyperlink">` +
      `<w:name w:val="Hyperlink"/><w:qFormat/>` +
      `<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr>` +
      `</w:style>`
  );
  parts.push(`</w:styles>`);
  return parts.join("");
}

function numberingXml(): string {
  const lvl = (
    ilvl: number,
    fmt: string,
    text: string,
    left: number
  ) =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/>` +
    `<w:lvlText w:val="${xmlEscape(text)}"/><w:lvlJc w:val="left"/>` +
    `<w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>` +
    `<w:rPr><w:rFonts w:hint="default"/></w:rPr></w:lvl>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:numbering xmlns:w="${W_NS}">` +
    `<w:abstractNum w:abstractNumId="0">` +
    lvl(0, "bullet", "•", 720) +
    lvl(1, "bullet", "◦", 1440) +
    lvl(2, "bullet", "▪", 2160) +
    `</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1">` +
    lvl(0, "decimal", "%1.", 720) +
    lvl(1, "decimal", "%1.%2.", 1440) +
    lvl(2, "decimal", "%1.%2.%3.", 2160) +
    `</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    `<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>` +
    `</w:numbering>`
  );
}

function contentTypesXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="${CT_NS}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `</Types>`
  );
}

function rootRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    `<Relationship Id="rId1" Type="${PKG_REL_NS}/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`
  );
}

function documentRelsXml(hyperlinks: { id: string; url: string }[]): string {
  const parts = [
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`,
    `<Relationships xmlns="${PKG_REL_NS}">`,
    `<Relationship Id="rIdStyles" Type="${PKG_REL_NS}/styles" Target="styles.xml"/>`,
    `<Relationship Id="rIdNumbering" Type="${PKG_REL_NS}/numbering" Target="numbering.xml"/>`,
  ];
  for (const link of hyperlinks) {
    parts.push(
      `<Relationship Id="${link.id}" Type="${HYPERLINK_REL}" Target="${xmlEscape(link.url)}" TargetMode="External"/>`
    );
  }
  parts.push(`</Relationships>`);
  return parts.join("");
}

function paragraphXml(p: DocxParagraph): string {
  const pPr = p.styleId ? `<w:pPr><w:pStyle w:val="${p.styleId}"/></w:pPr>` : "";
  const runs = p.runs.map((r) => runXml(r)).join("");
  const links = p.hyperlinks
    .map((h) => {
      // python-docx appends hyperlink elements at the end of the paragraph.
      return (
        `<w:hyperlink r:id="${h.id}" r:history="1">` +
        runXml({ text: h.text }, true) +
        `</w:hyperlink>`
      );
    })
    .join("");
  return `<w:p>${pPr}${runs}${links}</w:p>`;
}

function tableXml(rows: string[][]): string {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const border =
    `<w:tblBorders>` +
    ["top", "left", "bottom", "right", "insideH", "insideV"]
      .map(
        (side) =>
          `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`
      )
      .join("") +
    `</w:tblBorders>`;
  const grid =
    `<w:tblGrid>` +
    Array.from({ length: cols }, () => `<w:gridCol w:w="2400"/>`).join("") +
    `</w:tblGrid>`;
  const body = rows
    .map(
      (row) =>
        `<w:tr>` +
        Array.from({ length: cols }, (_, c) => {
          const text = c < row.length ? row[c] : "";
          return (
            `<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>` +
            `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>` +
            `</w:tc>`
          );
        }).join("") +
        `</w:tr>`
    )
    .join("");
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${border}</w:tblPr>` +
    grid +
    body +
    `</w:tbl>`
  );
}

function documentXml(blocks: DocxBlock[]): string {
  const body = blocks
    .map((b) => (b.kind === "p" ? paragraphXml(b.p) : tableXml(b.t.rows)))
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">` +
    `<w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" ` +
    `w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>` +
    `</w:body></w:document>`
  );
}

function buildDocx(
  blocks: DocxBlock[],
  hyperlinks: { id: string; url: string }[]
): Uint8Array {
  const enc = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypesXml()) },
    { name: "_rels/.rels", data: enc.encode(rootRelsXml()) },
    { name: "word/document.xml", data: enc.encode(documentXml(blocks)) },
    { name: "word/styles.xml", data: enc.encode(stylesXml()) },
    { name: "word/numbering.xml", data: enc.encode(numberingXml()) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(documentRelsXml(hyperlinks)) },
  ];
  return createZip(entries);
}
