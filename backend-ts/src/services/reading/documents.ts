// Port of deeptutor/utils/document_extractor.py (the OOXML/EPUB parts) for
// reading-material extraction: EPUB spine units + navigation outline,
// PPTX slide text, XLSX sheet text, and the EPUB archive normaliser
// (normalize_epub_archive). All parsing is dependency-free: shared/zip.ts for
// the container and services/documents/docx.ts for the minimal XML parser.
//
// Upstream resolves optional parser libraries (python-pptx/openpyxl) first and
// falls back to raw OOXML; this backend only has the OOXML path, which is the
// same fallback upstream uses for archives without usable metadata.

import { posix } from "node:path";
import { readZip } from "../../shared/zip.js";
import { createZip, parseXml, type XNode } from "../documents/docx.js";
import { ReadingError } from "./models.js";

// --- archive guards (mirror document_extractor._validate_epub_archive) --------

const MAX_MEMBERS = 4096;
const MAX_MEMBER_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200.0;

const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04"

const EPUB_CONTAINER_SUFFIX = "META-INF/container.xml";
const EPUB_CONTENT_EXTENSIONS = new Set([".xhtml", ".html", ".htm"]);
const EPUB_BLOCK_TAGS = new Set([
  "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote",
  "td", "th", "tr", "table", "section", "article", "header", "footer",
  "aside", "figure", "figcaption", "dd", "dt", "dl", "hr",
]);
const EPUB_SKIP_TAGS = new Set(["head", "script", "style"]);

const SLIDE_MEMBER_RE = /^ppt\/slides\/slide\d+\.xml$/;
const SHEET_MEMBER_RE = /^xl\/worksheets\/sheet\d+\.xml$/;
const HEADER_MEMBER_RE = /^word\/(header|footer|footnotes|endnotes|comments)\d*\.xml$/;

// --- small shared helpers -----------------------------------------------------

function isEl(child: XNode | string): child is XNode {
  return typeof child !== "string";
}

/** Local name without namespace prefix ("a:t" -> "t", "opf:item" -> "item"). */
function localName(tag: string): string {
  const idx = tag.indexOf(":");
  return idx < 0 ? tag : tag.slice(idx + 1);
}

/** All descendant elements (not including `node` itself), document order. */
function* descendants(node: XNode): Generator<XNode> {
  for (const child of node.children) {
    if (!isEl(child)) continue;
    yield child;
    yield* descendants(child);
  }
}

function findDescendants(node: XNode, local: string, out: XNode[] = []): XNode[] {
  for (const child of descendants(node)) {
    if (localName(child.tag) === local) out.push(child);
  }
  return out;
}

/** First descendant (document order) whose local name is in `names`. */
function findFirst(node: XNode, names: Set<string>): XNode | undefined {
  for (const child of descendants(node)) {
    if (names.has(localName(child.tag))) return child;
  }
  return undefined;
}

/** itertext(): every string descendant concatenated. */
function allText(node: XNode): string {
  let out = "";
  for (const child of node.children) {
    out += typeof child === "string" ? child : allText(child);
  }
  return out;
}

function childElements(node: XNode, local: string): XNode[] {
  const out: XNode[] = [];
  for (const child of node.children) {
    if (isEl(child) && localName(child.tag) === local) out.push(child);
  }
  return out;
}

function firstChild(node: XNode, local: string): XNode | undefined {
  return childElements(node, local)[0];
}

/** Text of the first direct child element with this local name. */
function childText(node: XNode, local: string): string {
  const child = firstChild(node, local);
  return child ? allText(child) : "";
}

function safeDecodeURI(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** posixpath.normpath(posixpath.join(baseDir, href)) with leading "/" stripped. */
function resolveMember(baseDir: string, href: string): string {
  const joined = href.startsWith("/")
    ? posix.normalize(href)
    : posix.normalize(posix.join(baseDir, href));
  return joined.startsWith("/") ? joined.slice(1) : joined;
}

function parseMemberXml(data: Buffer | undefined): XNode | null {
  if (data === undefined) return null;
  try {
    return parseXml(new TextDecoder("utf-8", { fatal: false }).decode(data));
  } catch {
    return null;
  }
}

// --- OOXML entry map -----------------------------------------------------------

/** Read + validate an Office/EPUB zip into a name → bytes map. */
function ooxmlEntries(data: Buffer, filename: string): Map<string, Buffer> {
  if (
    data.length < 4 ||
    data[0] !== OOXML_MAGIC[0] ||
    data[1] !== OOXML_MAGIC[1] ||
    data[2] !== OOXML_MAGIC[2] ||
    data[3] !== OOXML_MAGIC[3]
  ) {
    throw new ReadingError(
      `${filename}: does not look like a valid ZIP-based document (bad header)`,
    );
  }
  let entries;
  try {
    entries = readZip(data, MAX_MEMBERS);
  } catch (exc) {
    throw new ReadingError(
      `${filename}: failed to open ZIP package (${(exc as Error).message})`,
    );
  }
  const files = entries.filter((e) => !e.isDirectory);
  let total = 0;
  for (const entry of files) {
    if (entry.size > MAX_MEMBER_BYTES) {
      throw new ReadingError(`${filename}: archive member ${entry.name} is too large`);
    }
    total += entry.size;
    if (total > MAX_TOTAL_UNCOMPRESSED) {
      throw new ReadingError(`${filename}: uncompressed contents are too large`);
    }
    if (
      entry.compressedSize > 0 &&
      entry.size / entry.compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new ReadingError(
        `${filename}: archive member ${entry.name} has a suspicious compression ratio`,
      );
    }
  }
  const map = new Map<string, Buffer>();
  for (const entry of files) map.set(entry.name, entry.data);
  return map;
}

/** Relationship Id → resolved archive path ("…/_rels/x.xml.rels" → base dir). */
function officeRels(map: Map<string, Buffer>, relsMember: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = parseMemberXml(map.get(relsMember));
  if (!root) return out;
  // "ppt/_rels/presentation.xml.rels" → owner dir "ppt".
  const base = posix.dirname(posix.dirname(relsMember));
  for (const node of descendants(root)) {
    if (localName(node.tag) !== "Relationship") continue;
    if ((node.attrs["TargetMode"] ?? "").toLowerCase() === "external") continue;
    const rid = node.attrs["Id"] ?? "";
    const target = node.attrs["Target"] ?? "";
    if (rid && target) out.set(rid, resolveMember(base, target));
  }
  return out;
}

// ===========================================================================
// OOXML shared text collector (document_extractor._collect_ooxml_text)
// ===========================================================================

function collectOoxmlText(node: XNode): string {
  let out = "";
  const walk = (n: XNode): void => {
    const ln = localName(n.tag);
    if (ln === "t") {
      out += allText(n);
      return;
    }
    if (ln === "tab") {
      out += "\t";
    } else if (ln === "br" || ln === "cr") {
      out += "\n";
    }
    for (const child of n.children) {
      if (isEl(child)) walk(child);
    }
  };
  walk(node);
  return out;
}

/** Paragraph texts under `root` (every "p" descendant), or the root's text. */
function paragraphTexts(root: XNode): string[] {
  const paragraphs: string[] = [];
  for (const node of descendants(root)) {
    if (localName(node.tag) !== "p") continue;
    const text = collectOoxmlText(node).trim();
    if (text) paragraphs.push(text);
  }
  if (paragraphs.length) return paragraphs;
  const text = collectOoxmlText(root).trim();
  return text ? [text] : [];
}

// ===========================================================================
// PPTX
// ===========================================================================

function naturalSlideKey(name: string): number {
  const m = /(\d+)/.exec(posix.basename(name));
  return m ? parseInt(m[1]!, 10) : 0;
}

/** Slide parts in presentation order, with a metadata-free fallback. */
function pptxSlideMembers(map: Map<string, Buffer>): string[] {
  const names = new Set(map.keys());
  const presRoot = parseMemberXml(map.get("ppt/presentation.xml"));
  if (presRoot) {
    const slideIds = findDescendants(presRoot, "sldId");
    if (slideIds.length) {
      const targets = officeRels(map, "ppt/_rels/presentation.xml.rels");
      const ordered = slideIds
        .map((node) => targets.get(node.attrs["r:id"] ?? "") ?? "")
        .filter((target) => target !== "" && names.has(target));
      if (ordered.length) return ordered;
    }
  }
  return [...names]
    .filter((name) => SLIDE_MEMBER_RE.test(name))
    .sort((a, b) => naturalSlideKey(a) - naturalSlideKey(b));
}

/** Slide text with "--- Slide N ---" separators (upstream _extract_pptx_ooxml). */
export function extractPptxText(data: Buffer, filename: string): string {
  const map = ooxmlEntries(data, filename);
  const slides: string[] = [];
  pptxSlideMembers(map).forEach((member, index) => {
    const root = parseMemberXml(map.get(member));
    if (!root) return;
    const paragraphs = paragraphTexts(root);
    if (paragraphs.length) {
      slides.push(`--- Slide ${index + 1} ---\n${paragraphs.join("\n")}`);
    }
  });
  return slides.join("\n\n");
}

// ===========================================================================
// XLSX
// ===========================================================================

function xlsxSharedStrings(map: Map<string, Buffer>): string[] {
  const root = parseMemberXml(map.get("xl/sharedStrings.xml"));
  if (!root) return [];
  const strings: string[] = [];
  for (const child of root.children) {
    if (isEl(child) && localName(child.tag) === "si") {
      strings.push(collectOoxmlText(child));
    }
  }
  return strings;
}

/** worksheet member → display name, in workbook order (null when unavailable). */
function xlsxSheetNames(map: Map<string, Buffer>): Map<string, string> | null {
  const root = parseMemberXml(map.get("xl/workbook.xml"));
  const rels = parseMemberXml(map.get("xl/_rels/workbook.xml.rels"));
  if (!root || !rels) return null;
  const targets = new Map<string, string>();
  for (const node of descendants(rels)) {
    if (localName(node.tag) !== "Relationship") continue;
    if ((node.attrs["TargetMode"] ?? "").toLowerCase() === "external") continue;
    const id = node.attrs["Id"] ?? "";
    const target = node.attrs["Target"] ?? "";
    if (id && target) targets.set(id, resolveMember("xl", target));
  }
  const out = new Map<string, string>();
  for (const node of descendants(root)) {
    if (localName(node.tag) !== "sheet") continue;
    const rid = node.attrs["r:id"] ?? "";
    const member = targets.get(rid) ?? "";
    if (!member || !map.has(member)) continue;
    out.set(member, node.attrs["name"] ?? `sheet${out.size + 1}`);
  }
  return out.size ? out : null;
}

function xlsxCellText(cell: XNode, sharedStrings: string[]): string {
  const cellType = cell.attrs["t"] ?? "";
  if (cellType === "inlineStr") return collectOoxmlText(cell);
  const value = childText(cell, "v");
  if (cellType === "s") {
    try {
      return sharedStrings[parseInt(value, 10)] ?? value;
    } catch {
      return value;
    }
  }
  return value;
}

function columnIndex(ref: string): number {
  const m = /^([A-Za-z]{1,3})[1-9]\d*$/.exec(ref);
  if (!m) return 0;
  let column = 0;
  for (const letter of m[1]!.toUpperCase()) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return column <= 16384 ? column : 0;
}

/** Sheet text with "--- Sheet: name ---" sections (upstream _extract_xlsx_ooxml). */
export function extractXlsxText(data: Buffer, filename: string): string {
  const map = ooxmlEntries(data, filename);
  const sharedStrings = xlsxSharedStrings(map);
  let sheetNames = xlsxSheetNames(map);
  if (!sheetNames) {
    const members = [...map.keys()]
      .filter((name) => SHEET_MEMBER_RE.test(name))
      .sort((a, b) => naturalSheetKey(a) - naturalSheetKey(b));
    sheetNames = new Map(members.map((m, i) => [m, `sheet${i + 1}`]));
  }
  const sheets: string[] = [];
  for (const [member, sheetName] of sheetNames) {
    const root = parseMemberXml(map.get(member));
    if (!root) continue;
    const rows: string[] = [];
    for (const row of descendants(root)) {
      if (localName(row.tag) !== "row") continue;
      const cells: string[] = [];
      for (const cell of childElements(row, "c")) {
        const column = columnIndex(cell.attrs["r"] ?? "");
        const text = xlsxCellText(cell, sharedStrings);
        if (column >= 1) {
          while (cells.length < column - 1) cells.push("");
          cells[column - 1] = text;
        } else {
          cells.push(text);
        }
      }
      const rowText = cells.join("\t");
      if (rowText.trim()) rows.push(rowText);
    }
    if (rows.length) sheets.push(`--- Sheet: ${sheetName} ---\n${rows.join("\n")}`);
  }
  return sheets.join("\n\n");
}

function naturalSheetKey(name: string): number {
  return naturalSlideKey(name);
}

// ===========================================================================
// EPUB
// ===========================================================================

export interface EpubSpineUnit {
  href: string;
  text: string;
  title: string;
}

export interface EpubOutlineItem {
  locator: number;
  title: string;
  level: number;
  source_href: string;
  source_anchor: string;
}

function epubIsResidue(name: string): boolean {
  return name.split("/").some((part) => part === "__MACOSX" || part.startsWith("."));
}

function epubExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}

interface EpubPackage {
  names: string[];
  nameSet: Set<string>;
  opfDir: string;
  manifest: Map<string, { href: string; mediaType: string; properties: string }>;
  spineIds: string[];
  navMember: string;
  ncxMember: string;
}

/** container.xml → rootfile → OPF → manifest/spine/nav/ncx. */
function epubOpenPackage(map: Map<string, Buffer>): EpubPackage {
  const names = [...map.keys()].filter((name) => !epubIsResidue(name));
  const nameSet = new Set(names);
  const empty: EpubPackage = {
    names, nameSet, opfDir: "", manifest: new Map(), spineIds: [],
    navMember: "", ncxMember: "",
  };
  const container = names.find((name) => name.endsWith(EPUB_CONTAINER_SUFFIX));
  if (!container) return empty;
  const prefix = container.slice(0, container.length - EPUB_CONTAINER_SUFFIX.length);
  const containerRoot = parseMemberXml(map.get(container));
  if (!containerRoot) return empty;
  let rootfile = "";
  for (const node of descendants(containerRoot)) {
    if (localName(node.tag) === "rootfile") {
      rootfile = node.attrs["full-path"] ?? "";
      break;
    }
  }
  const opfPath = rootfile ? `${prefix}${rootfile}` : "";
  if (!opfPath || !nameSet.has(opfPath)) return empty;

  const opfRoot = parseMemberXml(map.get(opfPath));
  if (!opfRoot) return empty;
  const opfDir = posix.dirname(opfPath);
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  const spineIds: string[] = [];
  let spineToc = "";
  let navMember = "";
  for (const node of descendants(opfRoot)) {
    const ln = localName(node.tag);
    if (ln === "item") {
      const id = node.attrs["id"] ?? "";
      const href = node.attrs["href"] ?? "";
      if (id && href) {
        const member = resolveMember(opfDir, safeDecodeURI(href.split("#", 1)[0]!));
        manifest.set(id, {
          href: member,
          mediaType: node.attrs["media-type"] ?? "",
          properties: node.attrs["properties"] ?? "",
        });
        if ((node.attrs["properties"] ?? "").split(/\s+/).includes("nav") && !navMember) {
          navMember = member;
        }
      }
    } else if (ln === "itemref") {
      const idref = node.attrs["idref"] ?? "";
      if (idref) spineIds.push(idref);
    } else if (ln === "spine") {
      spineToc = node.attrs["toc"] ?? "";
    }
  }
  let ncxMember = "";
  if (spineToc) {
    const item = manifest.get(spineToc);
    if (item && (item.mediaType === "application/x-dtbncx+xml" || item.href.toLowerCase().endsWith(".ncx"))) {
      ncxMember = item.href;
    }
  }
  return { names, nameSet, opfDir, manifest, spineIds, navMember, ncxMember };
}

/** XHTML members in spine order, falling back to archive order. */
function epubContentMembers(pkg: EpubPackage): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const idref of pkg.spineIds) {
    const item = pkg.manifest.get(idref);
    if (!item) continue;
    const member = item.href;
    if (pkg.nameSet.has(member) && !seen.has(member)) {
      ordered.push(member);
      seen.add(member);
    }
  }
  if (ordered.length) return ordered;
  return pkg.names.filter((name) => EPUB_CONTENT_EXTENSIONS.has(epubExt(name)));
}

function normalizeEpubText(parts: string[]): string {
  const raw = parts.join("");
  return raw
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line)
    .join("\n");
}

const EPUB_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEpubEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const code = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return EPUB_ENTITIES[ent] ?? whole;
  });
}

/** Tolerant text extraction for chapters parseXml cannot handle. */
function epubLooseText(raw: string): string {
  let s = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table|section|article|blockquote|figure|figcaption|dd|dt|dl)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeEpubText([decodeEpubEntities(s)]);
}

function renderXhtml(node: XNode, parts: string[]): void {
  const tag = localName(node.tag);
  if (EPUB_SKIP_TAGS.has(tag)) return;
  for (const child of node.children) {
    if (typeof child === "string") parts.push(child);
    else renderXhtml(child, parts);
  }
  if (tag === "br") parts.push("\n");
  else if (EPUB_BLOCK_TAGS.has(tag)) parts.push("\n\n");
}

function epubChapterText(map: Map<string, Buffer>, member: string): { text: string; root: XNode | null } {
  const data = map.get(member);
  if (data === undefined) return { text: "", root: null };
  const root = parseMemberXml(data);
  if (root) {
    const parts: string[] = [];
    renderXhtml(root, parts);
    return { text: normalizeEpubText(parts), root };
  }
  return {
    text: epubLooseText(new TextDecoder("utf-8", { fatal: false }).decode(data)),
    root: null,
  };
}

function epubElementText(node: XNode): string {
  return allText(node).replace(/\s+/g, " ").trim();
}

const EPUB_HEADING_TAGS = new Set(["h1", "h2", "title"]);

function epubChapterHeading(root: XNode | null): string {
  if (!root) return "";
  const node = findFirst(root, EPUB_HEADING_TAGS);
  return node ? epubElementText(node) : "";
}

// --- EPUB navigation (EPUB3 nav + EPUB2 NCX) ------------------------------------

interface ResolvedTarget {
  locator: number;
  member: string;
  anchor: string;
}

function epubPackageNavigation(
  map: Map<string, Buffer>,
  pkg: EpubPackage,
  spineMembers: string[],
): EpubOutlineItem[] {
  const locatorByMember = new Map(spineMembers.map((m, i) => [m, i + 1]));

  const resolveTarget = (href: string, baseMember: string): ResolvedTarget => {
    const hash = href.indexOf("#");
    const rawPath = hash < 0 ? href : href.slice(0, hash);
    const rawAnchor = hash < 0 ? "" : href.slice(hash + 1);
    const member = resolveMember(posix.dirname(baseMember), safeDecodeURI(rawPath));
    return {
      locator: locatorByMember.get(member) ?? 0,
      member,
      anchor: safeDecodeURI(rawAnchor),
    };
  };

  const rows: EpubOutlineItem[] = [];

  // EPUB3 nav document.
  if (pkg.navMember && map.has(pkg.navMember)) {
    const navRoot = parseMemberXml(map.get(pkg.navMember));
    if (navRoot) {
      const navs = findDescendants(navRoot, "nav");
      const tocNav =
        navs.find((node) => {
          const type =
            node.attrs["epub:type"] ??
            Object.entries(node.attrs).find(
              ([key]) => key.endsWith(":type") || key.endsWith("}type"),
            )?.[1] ??
            "";
          return type.split(/\s+/).includes("toc");
        }) ?? navs[0];

      const walkNav = (node: XNode, level: number): void => {
        for (const child of node.children) {
          if (!isEl(child)) continue;
          const ln = localName(child.tag);
          if (ln === "li") {
            const link = childElements(child, "a")[0] ?? childElements(child, "span")[0];
            const href = link?.attrs["href"] ?? "";
            const title = link ? epubElementText(link) : "";
            if (href && title) {
              const target = resolveTarget(href, pkg.navMember);
              if (target.locator) {
                rows.push({
                  locator: target.locator,
                  title,
                  level: Math.max(1, level),
                  source_href: target.member,
                  source_anchor: target.anchor,
                });
              }
            }
            for (const item of child.children) {
              if (isEl(item) && localName(item.tag) === "ol") walkNav(item, level + 1);
            }
          } else if (ln === "ol") {
            walkNav(child, level);
          }
        }
      };
      if (tocNav) walkNav(tocNav, 1);
    }
  }

  // EPUB2 NCX fallback.
  if (!rows.length && pkg.ncxMember && map.has(pkg.ncxMember)) {
    const ncxRoot = parseMemberXml(map.get(pkg.ncxMember));
    const navMap = ncxRoot ? findFirst(ncxRoot, new Set(["navMap"])) : undefined;
    if (ncxRoot && navMap) {
      const walkNcx = (node: XNode, level: number): void => {
        for (const point of node.children) {
          if (!isEl(point) || localName(point.tag) !== "navPoint") continue;
          const label = findFirst(point, new Set(["navLabel"]));
          const content = firstChild(point, "content");
          const title = label ? epubElementText(label) : "";
          const href = content?.attrs["src"] ?? "";
          if (href && title) {
            const target = resolveTarget(href, pkg.ncxMember);
            if (target.locator) {
              rows.push({
                locator: target.locator,
                title,
                level: Math.max(1, level),
                source_href: target.member,
                source_anchor: target.anchor,
              });
            }
          }
          walkNcx(point, level + 1);
        }
      };
      walkNcx(navMap, 1);
    }
  }
  return rows;
}

/** Spine units + nested outline (upstream extract_epub_spine). */
export function extractEpubSpine(
  data: Buffer,
  filename: string,
): { units: EpubSpineUnit[]; outline: EpubOutlineItem[] } {
  const map = ooxmlEntries(data, filename);
  const pkg = epubOpenPackage(map);
  const members = epubContentMembers(pkg);
  const units: EpubSpineUnit[] = members.map((member) => {
    const { text, root } = epubChapterText(map, member);
    return { href: member, text, title: epubChapterHeading(root) };
  });
  const outline = epubPackageNavigation(map, pkg, members);
  return { units, outline };
}

// ===========================================================================
// EPUB archive normaliser (upstream normalize_epub_archive)
// ===========================================================================

/**
 * Repack EPUBs whose OCF chain sits below a wrapper directory or that carry
 * ``__MACOSX`` residue, so strict browser EPUB readers can open them. Returns
 * the original bytes untouched for conforming archives.
 */
export function normalizeEpubArchive(data: Buffer, filename: string): Buffer {
  let entries;
  try {
    entries = readZip(data, MAX_MEMBERS * 4);
  } catch (exc) {
    throw new ReadingError(
      `${filename}: failed to open EPUB archive (${(exc as Error).message})`,
    );
  }
  const infos = entries.filter((e) => !e.isDirectory);
  const useful = infos.filter((e) => !epubIsResidue(e.name));
  const hasResidue = useful.length !== infos.length;
  const container = useful.find((e) => e.name.endsWith(EPUB_CONTAINER_SUFFIX));
  let prefix = container ? container.name.slice(0, container.name.length - EPUB_CONTAINER_SUFFIX.length) : "";
  if (prefix && !useful.every((e) => e.name.startsWith(prefix))) {
    // A package document buried among unrelated root files is not a wrapped
    // book; leave it for the extractor's fallback path.
    prefix = "";
  }
  if (!prefix && !hasResidue) return data;

  const mimetypeName = `${prefix}mimetype`;
  const mimetype = useful.find((e) => e.name === mimetypeName);
  const out: { name: string; data: Uint8Array; stored?: boolean }[] = [
    {
      name: "mimetype",
      data: mimetype ? mimetype.data : new TextEncoder().encode("application/epub+zip"),
      stored: true,
    },
  ];
  for (const info of useful) {
    const name = prefix ? info.name.slice(prefix.length) : info.name;
    if (!name || name === "mimetype") continue;
    out.push({ name, data: info.data });
  }
  return Buffer.from(createZip(out));
}
