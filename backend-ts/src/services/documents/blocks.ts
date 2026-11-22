/**
 * Validate portable BlockNote JSON and derive a read-only Markdown projection.
 *
 */

import { randomUUID } from "node:crypto";
import { NoteUIError, block_to_dsl, compile_noteui, dumpsPy, parse_inline_md } from "./noteui.js";

export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;

// Fenced-block info strings that become ``learning`` blocks (info -> props.kind).
// Keep in sync with ``web/features/notes/model/markdown.ts``.
export const FENCE_LEARNING_KINDS: Record<string, string> = {
  quiz: "quiz",
  flashcards: "flashcards",
  flashcard: "flashcards",
  timeline: "timeline",
  conceptmap: "concept_map",
  concept_map: "concept_map",
  geogebra: "geogebra",
  research: "research",
  task: "task",
};
export const DIAGRAM_FENCES = new Set(["mermaid", "flow", "seq"]);
// ```noteui fences hold a NoteUI Lang program (see noteui.ts) compiled to blocks.
export const NOTEUI_FENCES = new Set(["noteui", "nb", "note"]);
const _KIND_FENCES: Record<string, string> = {
  quiz: "quiz",
  flashcards: "flashcards",
  timeline: "timeline",
  concept_map: "conceptmap",
  geogebra: "geogebra",
  research: "research",
  task: "task",
};
const _FENCE_OPEN = /^\s*(`{3,}|~{3,})(\S*)\s*$/;

// Blocks with no inline content of their own (BlockNote ``content: "none"``).
export const LEAF_BLOCK_TYPES = new Set([
  "learning",
  "noteUpload",
  "clip",
  "math",
  "divider",
  "image",
  "video",
  "audio",
  "file",
  "noteColumn",
  "noteColumns",
  "tableOfContents",
  "webCard",
  "htmlEmbed",
  "taskView",
]);

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Python-semantics helpers (mirrors noteui.py)
// ---------------------------------------------------------------------------

type AnyDict = Record<string, any>;

function isPlainObj(v: any): v is AnyDict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** dict.get(key, default) — own-property lookup only. */
function pyGet(o: any, key: string, def: any): any {
  if (isPlainObj(o) && Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  return def;
}

function pyTruthy(v: any): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

/** Python str(value) (repr of elements inside containers). */
function pyRepr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  }
  return String(v);
}

function pyStr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return "{" + Object.entries(v).map(([k, x]) => pyRepr(k) + ": " + pyRepr(x)).join(", ") + "}";
  }
  return String(v);
}

/** Python int(): truncates floats, parses integer strings, else throw. */
function pyInt(v: any): number {
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("cannot convert float to integer");
    return Math.trunc(v);
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!/^[-+]?\d+$/.test(t)) throw new Error(`invalid literal for int() with base 10: '${v}'`);
    return parseInt(t, 10);
  }
  throw new Error("int() argument must be a string, a bytes-like object or a real number");
}

const SPLIT_LINES = /\r\n|[\n\r\x0b\x0c\x1c-\x1e\x85\u2028\u2029]/;
function splitLines(s: string): string[] {
  return s.split(SPLIT_LINES);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Coarse Markdown -> blocks
// ---------------------------------------------------------------------------

function textBlock(type_: string, text: string, props?: AnyDict | null): AnyDict {
  return {
    id: newId(),
    type: type_,
    props: props || {},
    content: parse_inline_md(text),
    children: [],
  };
}

function fenceLearningBlock(info: string, body: string, source: string): AnyDict {
  /** Build the ``learning`` block the browser makes from a fenced block. */
  const kind = Object.prototype.hasOwnProperty.call(FENCE_LEARNING_KINDS, info)
    ? FENCE_LEARNING_KINDS[info]
    : info === "mermaid"
      ? "mermaid"
      : "legacy_diagram";
  let data = "{}";
  try {
    const parsed = JSON.parse(body);
    if (isPlainObj(parsed)) data = dumpsPy(parsed, true);
  } catch {
    // pass
  }
  const isStructured = Object.values(FENCE_LEARNING_KINDS).includes(kind);
  return {
    id: newId(),
    type: "learning",
    props: {
      kind,
      // Structured fences keep their JSON body; diagrams keep the whole
      // fence because their Markdown renderer understands the delimiters.
      markdown: isStructured ? body : source,
      prompt: "",
      data,
      sourceUrl: "",
    },
    children: [],
  };
}

function htmlEmbedBlock(source: string): AnyDict {
  return { id: newId(), type: "htmlEmbed", props: { source }, children: [] };
}

function parseTableRow(line: string): string[] | null {
  const stripped = line.trim();
  if (!stripped.includes("|")) return null;
  const cells = stripped.replace(/^\|+|\|+$/g, "").split("|").map((c) => c.trim());
  return cells.length ? cells : null;
}

function isTableSep(line: string): boolean {
  const cells = parseTableRow(line);
  return !!cells && cells.every((c) => /^:?-{3,}:?$/.test(c.replace(/ /g, "")));
}

function blkCode(language: string, code: string): AnyDict {
  return {
    id: newId(),
    type: "codeBlock",
    props: { language },
    content: [{ type: "text", text: code, styles: {} }],
    children: [],
  };
}

/**
 * Markdown (plus ```noteui / learning fences) -> BlockNote blocks.
 *
 * Used when a page must be edited through ``nb_patch``: the model's Markdown
 * body becomes real blocks so rich content survives the round trip. It is a
 * pragmatic parser, not a full CommonMark implementation — the editor still
 * owns exotic conversions.
 */
export function coarse_markdown_to_blocks(content: string): AnyDict[] {
  const blocks: AnyDict[] = [];
  const paragraph: string[] = [];
  const lines = splitLines(content);

  const flush = () => {
    if (paragraph.length) {
      const text = paragraph.join("\n").trim();
      paragraph.length = 0;
      if (text) blocks.push(textBlock("paragraph", text));
    }
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = _FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[1];
      const info = fence[2];
      const close = new RegExp(
        "^\\s*" + escapeRegExp(marker[0]) + "{" + marker.length + ",}\\s*$"
      );
      let end = index + 1;
      while (end < lines.length && !close.test(lines[end])) end += 1;
      if (end < lines.length) {
        const body = lines.slice(index + 1, end).join("\n");
        const source = lines.slice(index, end + 1).join("\n");
        flush();
        if (NOTEUI_FENCES.has(info)) {
          try {
            blocks.push(...compile_noteui(body));
          } catch (e) {
            if (!(e instanceof NoteUIError)) throw e;
            blocks.push(
              textBlock(
                "paragraph",
                `\`\`\`${info}\n${body}\n\`\`\`\n\n(noteui compile failed: ${e.message})`
              )
            );
          }
        } else if (Object.prototype.hasOwnProperty.call(FENCE_LEARNING_KINDS, info) || DIAGRAM_FENCES.has(info)) {
          blocks.push(fenceLearningBlock(info, body, source));
        } else if (info === "html") {
          blocks.push(htmlEmbedBlock(body));
        } else {
          blocks.push(blkCode(info, body));
        }
        index = end + 1;
        continue;
      }
      // Unterminated fence: treat the rest as literal lines.
    }
    const stripped = line.trim();
    if (!stripped) {
      flush();
      index += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(stripped);
    if (heading) {
      flush();
      blocks.push(textBlock("heading", heading[2], { level: heading[1].length }));
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(stripped)) {
      flush();
      blocks.push({ id: newId(), type: "divider", props: {}, children: [] });
      index += 1;
      continue;
    }
    // Pipe table: header row followed by a |---| separator row.
    if (stripped.includes("|") && index + 1 < lines.length && isTableSep(lines[index + 1])) {
      flush();
      const header = parseTableRow(stripped) ?? [];
      const rows: any[][] = [header.map((c) => ({ type: "text", text: c, styles: {} }))];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const cells = parseTableRow(lines[index]) ?? [];
        rows.push(cells.map((c) => ({ type: "text", text: c, styles: {} })));
        index += 1;
      }
      blocks.push({
        id: newId(),
        type: "table",
        props: {},
        content: { rows: rows.map((r) => ({ cells: r })) },
        children: [],
      });
      continue;
    }
    // Blockquote: consecutive "> " lines.
    if (stripped.startsWith(">")) {
      flush();
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>+/, "").trim());
        index += 1;
      }
      blocks.push(textBlock("quote", quoteLines.join("\n")));
      continue;
    }
    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(stripped);
    const bullet = /^[-*+]\s+(.*)$/.exec(stripped);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(stripped);
    if (task || bullet || numbered) {
      flush();
      if (task) {
        blocks.push(
          textBlock("checkListItem", task[2], { checked: task[1].toLowerCase() === "x" })
        );
      } else if (bullet) {
        blocks.push(textBlock("bulletListItem", bullet[1]));
      } else {
        blocks.push(textBlock("numberedListItem", numbered![1]));
      }
      index += 1;
      continue;
    }
    // Display math on its own line(s): $$...$$
    if (stripped.startsWith("$$")) {
      if (stripped.endsWith("$$") && stripped.length > 4) {
        const formula = stripped.slice(2, -2).trim();
        flush();
        blocks.push({
          id: newId(), type: "mathBlock", props: {}, content: formula, children: [],
        });
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < lines.length && !lines[end].trim().endsWith("$$")) end += 1;
      if (end < lines.length) {
        const formula = lines.slice(index + 1, end).join("\n");
        flush();
        blocks.push({
          id: newId(), type: "mathBlock", props: {}, content: formula.trim(), children: [],
        });
        index = end + 1;
        continue;
      }
    }
    paragraph.push(stripped);
    index += 1;
  }
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// Safe links
// ---------------------------------------------------------------------------

// A URI scheme is a leading ``name:`` token. Only these may navigate away from
// the app; everything else (javascript:, data:, file:, …) is page-provided code
// or an unsupported target and must never reach a rendered ``href``.
const _ALLOWED_URI_SCHEMES = new Set(["http", "https", "mailto"]);
const _URI_SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const _CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Only links the editor can display without executing page-provided code.
 *
 * Absolute http(s)/mailto URLs, root-relative paths and fragments are safe.
 * Plain relative paths are safe too: they resolve against the app origin and
 * carry no scheme, so a notebook's ``[Lasers](Lasers)`` cross-reference does
 * not break saving. Executable schemes, protocol-relative ``//host`` URLs and
 * control characters (which browsers can fold into a scheme) are rejected.
 */
export function safe_link(value: any): boolean {
  if (typeof value !== "string") return false;
  // Browsers strip surrounding whitespace before resolving a URL, so inspect
  // the normalised form rather than the raw stored string.
  const v = value.trim();
  if (!v) return true;
  if (_CONTROL_CHARS.test(v) || v.startsWith("//")) return false;
  const scheme = _URI_SCHEME.exec(v);
  if (scheme) return _ALLOWED_URI_SCHEMES.has(scheme[1].toLowerCase());
  return true;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validate_blocks(blocks: AnyDict[]): AnyDict[] {
  if (Buffer.byteLength(dumpsPy(blocks), "utf8") > MAX_BLOCK_BYTES) {
    throw new Error("Page exceeds the 4 MB block limit");
  }
  const ids = new Set<string>();

  const supported = new Set([
    "paragraph", "heading", "bulletListItem", "numberedListItem", "checkListItem",
    "toggleListItem", "quote", "codeBlock", "table", "image", "video", "audio",
    "file", "divider", "math", "mathBlock", "clip", "learning", "noteUpload",
    "callout", "toggleHeading", "noteColumn", "noteColumns", "tableOfContents",
    "webCard", "htmlEmbed", "taskView",
  ]);

  function inline(items: any, depth = 0): void {
    if (depth > 16) throw new Error("Inline nesting exceeds 16 levels");
    if (typeof items === "string") return;
    if (!Array.isArray(items)) throw new Error("Invalid inline content");
    for (const item of items) {
      if (!isPlainObj(item)) throw new Error("Invalid inline content");
      const kind = item["type"];
      if (kind === "text") {
        if (typeof item["text"] !== "string" || !isPlainObj(pyGet(item, "styles", {}))) {
          throw new Error("Invalid styled text");
        }
      } else if (kind === "link") {
        if (!safe_link(item["href"])) throw new Error("Unsupported link URL");
        inline(pyGet(item, "content", []), depth + 1);
      } else if (kind === "math") {
        inline(pyGet(item, "content", []), depth + 1);
      } else if (kind === "pageLink" || kind === "inlineMath" || kind === "noteDate") {
        const props = pyGet(item, "props", {});
        if (
          !isPlainObj(props) ||
          Object.values(props).some((v) => typeof v !== "string")
        ) {
          throw new Error("Invalid inline properties");
        }
        if (kind === "pageLink" && !/^[0-9a-f]{8,32}$/.test(pyGet(props, "pageId", ""))) {
          throw new Error("Invalid linked page ID");
        }
      } else {
        throw new Error("Unsupported inline content");
      }
    }
  }

  function visit(items: any, depth = 0, parent?: string): void {
    if (!Array.isArray(items) || depth > 16) {
      throw new Error("Invalid block tree or nesting exceeds 16 levels");
    }
    for (const block of items) {
      if (!isPlainObj(block)) throw new Error("Each block must be an object");
      const bid = block["id"];
      if (typeof bid !== "string" || !/^[\w-]{1,128}$/.test(bid) || ids.has(bid)) {
        throw new Error("Blocks require unique, valid IDs");
      }
      ids.add(bid);
      if (ids.size > 10000) throw new Error("Page exceeds 10000 blocks");
      if (!supported.has(block["type"])) throw new Error("Unsupported block type");
      if (typeof block["type"] !== "string" || !isPlainObj(pyGet(block, "props", {}))) {
        throw new Error("Invalid block type or properties");
      }
      if (block["type"] === "noteColumn" && parent !== "noteColumns") {
        throw new Error("Column blocks must belong to a columns layout");
      }
      const props = pyGet(block, "props", {});
      if (Object.values(props).some((v) => !["string", "number", "boolean"].includes(typeof v))) {
        throw new Error("Block properties must be scalar values");
      }
      for (const name of ["url", "sourceUrl"]) {
        if (name in props || Object.prototype.hasOwnProperty.call(props, name)) {
          if (!safe_link(props[name])) throw new Error("Unsupported block URL");
        }
      }
      if (
        (block["type"] === "heading" || block["type"] === "toggleHeading") &&
        ![1, 2, 3, 4, 5, 6].includes(pyGet(props, "level", 1))
      ) {
        throw new Error("Heading level must be between 1 and 6");
      }
      if (block["type"] === "learning") {
        let data: any;
        try {
          data = JSON.parse(pyGet(props, "data", "{}") ?? "{}");
          if (!isPlainObj(data)) throw new Error("not object");
        } catch {
          throw new Error("Learning data must be a JSON object");
        }
        for (const name of [
          "questions", "cards", "events", "nodes", "edges",
          "workspace_items", "artifacts",
        ]) {
          if (
            Object.prototype.hasOwnProperty.call(data, name) &&
            (!Array.isArray(data[name]) || data[name].some((row: any) => !isPlainObj(row)))
          ) {
            throw new Error(`Learning ${name} must be a list of objects`);
          }
        }
      }
      if (LEAF_BLOCK_TYPES.has(block["type"])) {
        // Models often echo the kind as text content ("timeline"); a
        // block without inline content cannot hold it, and the editor
        // refuses the whole page if it is kept.
        delete block["content"];
      }
      const content = pyGet(block, "content", []);
      if (block["type"] === "table") {
        if (!isPlainObj(content) || !Array.isArray(pyGet(content, "rows", undefined))) {
          throw new Error("Invalid table");
        }
        for (const row of content["rows"]) {
          if (!isPlainObj(row) || !Array.isArray(pyGet(row, "cells", undefined))) {
            throw new Error("Invalid table row");
          }
          for (const cell of row["cells"]) {
            inline(isPlainObj(cell) ? pyGet(cell, "content", []) : cell);
          }
        }
      } else if (!LEAF_BLOCK_TYPES.has(block["type"])) {
        inline(content);
      }
      if (block["type"] === "noteColumns") {
        const columns = pyGet(block, "children", []);
        if (
          !Array.isArray(columns) ||
          columns.length < 2 ||
          columns.length > 5 ||
          columns.some((c) => isPlainObj(c) && c["type"] !== "noteColumn")
        ) {
          throw new Error("Columns require between 2 and 5 column blocks");
        }
      }
      visit(pyGet(block, "children", []), depth + 1, block["type"]);
    }
  }

  visit(blocks);
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline markdown projection
// ---------------------------------------------------------------------------

export function inline_markdown(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const result: string[] = [];
  for (const item of content) {
    if (!isPlainObj(item)) continue;
    let text =
      item["type"] === "text"
        ? pyStr(pyGet(item, "text", ""))
        : inline_markdown(pyGet(item, "content", undefined));
    if (item["type"] === "math" || item["type"] === "inlineMath") {
      let formula = pyGet(pyGet(item, "props", {}), "formula", null);
      if (formula === null || formula === undefined) {
        formula = inline_markdown(pyGet(item, "content", undefined));
      }
      text = "$" + pyStr(formula) + "$";
    }
    if (item["type"] === "pageLink") {
      const props = pyGet(item, "props", {});
      text = `[${pyGet(props, "title", "Page")}](/co-writer/${pyGet(props, "pageId", "")})`;
    }
    if (item["type"] === "noteDate") {
      text = pyStr(pyGet(pyGet(item, "props", {}), "date", ""));
    }
    const styles = pyGet(item, "styles", null) || {};
    for (const [key, marker] of [
      ["code", "`"],
      ["bold", "**"],
      ["italic", "*"],
      ["strike", "~~"],
    ] as const) {
      if (isPlainObj(styles) && pyTruthy(pyGet(styles, key, null))) {
        text = marker + text + marker;
      }
    }
    if (item["type"] === "link") {
      text = `[${text}](${pyGet(item, "href", "")})`;
    }
    result.push(text);
  }
  return result.join("");
}

// ---------------------------------------------------------------------------
// Blocks -> Markdown
// ---------------------------------------------------------------------------

// Block types Markdown cannot represent (or only lossily); they serialize to a
// ```noteui fence so nb_patch can compile them back losslessly.
const _DSL_ALWAYS = new Set([
  "callout", "toggleHeading", "toggleListItem", "noteColumns", "noteColumn",
  "tableOfContents", "webCard", "htmlEmbed", "taskView", "clip", "noteUpload",
]);
// These keep a Markdown form, but children would be lost — prefer DSL then.
const _DSL_WITH_CHILDREN = new Set([
  "heading", "quote", "bulletListItem", "numberedListItem", "checkListItem",
]);

/** Fence-serialized form for blocks plain Markdown cannot carry, else null. */
function specialMarkdown(block: AnyDict): string | null {
  const kind = block["type"];
  const props = pyGet(block, "props", {}) || {};
  const chRaw = pyGet(block, "children", null);
  const children: any[] = pyTruthy(chRaw) ? chRaw : [];
  if (_DSL_ALWAYS.has(kind) || (_DSL_WITH_CHILDREN.has(kind) && children.length)) {
    try {
      return "````noteui\n" + block_to_dsl(block) + "\n````";
    } catch (e) {
      if (e instanceof NoteUIError) return null;
      throw e;
    }
  }
  if (kind === "learning") {
    let data: any = {};
    try {
      data = JSON.parse(pyGet(props, "data", "{}") ?? "{}");
    } catch {
      data = {};
    }
    if (!isPlainObj(data)) data = {};
    const lkind = pyStr(pyGet(props, "kind", null) || "");
    const info = Object.prototype.hasOwnProperty.call(_KIND_FENCES, lkind)
      ? _KIND_FENCES[lkind]
      : undefined;
    if (info && (pyTruthy(data) || pyTruthy(pyGet(props, "markdown", null)))) {
      const body = pyTruthy(data)
        ? dumpsPy(data)
        : pyStr(pyGet(props, "markdown", null) || "");
      let maxRun = 3;
      for (const m of body.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0].length + 1);
      const fence = "`".repeat(Math.max(3, maxRun));
      return `${fence}${info}\n${body}\n${fence}`;
    }
    const markdown = pyStr(pyGet(props, "markdown", null) || "");
    if ((lkind === "mermaid" || lkind === "legacy_diagram") && markdown.trim().startsWith("```")) {
      return markdown;
    }
    try {
      return "````noteui\n" + block_to_dsl(block) + "\n````";
    } catch (e) {
      if (e instanceof NoteUIError) return null;
      throw e;
    }
  }
  return null;
}

export function blocks_to_markdown(blocks: AnyDict[], depth = 0): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const kind = block["type"];
    const props = pyGet(block, "props", {}) || {};
    const special = specialMarkdown(block);
    if (special !== null) {
      parts.push(
        special
          .split(SPLIT_LINES)
          .map((line) => "  ".repeat(depth) + line)
          .join("\n")
      );
      continue;
    }
    let text = inline_markdown(pyGet(block, "content", undefined));
    if (kind === "heading" || kind === "toggleHeading") {
      const level = Math.max(1, Math.min(6, pyInt(pyGet(props, "level", 1))));
      text = "#".repeat(level) + " " + text;
    } else if (
      kind === "bulletListItem" || kind === "numberedListItem" ||
      kind === "checkListItem" || kind === "toggleListItem"
    ) {
      const prefix: Record<string, string> = {
        bulletListItem: "- ",
        numberedListItem: "1. ",
        toggleListItem: "- ",
        checkListItem: pyTruthy(pyGet(props, "checked", null)) ? "- [x] " : "- [ ] ",
      };
      text = prefix[kind] + text;
    } else if (kind === "quote" || kind === "callout") {
      text = text.split(SPLIT_LINES).map((line) => "> " + line).join("\n");
    } else if (kind === "codeBlock") {
      let maxRun = 3;
      for (const m of text.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0].length + 1);
      const fence = "`".repeat(Math.max(3, maxRun));
      text = `${fence}${pyGet(props, "language", "")}\n${text}\n${fence}`;
    } else if (kind === "image" || kind === "video" || kind === "audio" || kind === "file") {
      const label = pyGet(props, "caption", null) || pyGet(props, "name", kind);
      text = `${kind === "image" ? "!" : ""}[${label}](${pyGet(props, "url", "")})`;
    } else if (kind === "table") {
      const content = pyGet(block, "content", null) || {};
      const rows = pyGet(content, "rows", []) || [];
      const lines = rows.map((row: any) => {
        const cells = pyGet(row, "cells", []) || [];
        return (
          "| " +
          cells
            .map((c: any) =>
              inline_markdown(isPlainObj(c) ? pyGet(c, "content", undefined) : c)
                .replaceAll("|", "\\|")
                .replaceAll("\n", "<br>")
            )
            .join(" | ") +
          " |"
        );
      });
      if (lines.length) {
        const firstCells = pyGet(rows[0], "cells", []) || [];
        lines.splice(1, 0, "| " + firstCells.map(() => "---").join(" | ") + " |");
      }
      text = lines.join("\n");
    } else if (kind === "webCard") {
      text = `[${pyGet(props, "title", null) || pyGet(props, "url", "")}](${pyGet(props, "url", "")})\n\n${pyGet(props, "description", "")}`;
    } else if (kind === "htmlEmbed") {
      const source = pyStr(pyGet(props, "source", ""));
      let maxRun = 3;
      for (const m of source.matchAll(/`+/g)) maxRun = Math.max(maxRun, m[0].length + 1);
      const fence = "`".repeat(Math.max(3, maxRun));
      text = `${fence}html\n${source}\n${fence}`;
    } else if (kind === "taskView") {
      text = "[Workspace tasks](/kanban)";
    } else if (kind === "tableOfContents") {
      text = "";
    } else if (kind === "divider") {
      text = "---";
    } else if (kind === "math" || kind === "mathBlock") {
      let formula = pyGet(props, "formula", null);
      if (formula === null || formula === undefined) {
        formula = inline_markdown(pyGet(block, "content", undefined));
      }
      text = "$$\n" + pyStr(formula) + "\n$$";
    } else if (kind === "learning" || kind === "clip") {
      text = pyStr(
        pyTruthy(pyGet(props, "markdown", null))
          ? pyGet(props, "markdown", null)
          : pyTruthy(pyGet(props, "prompt", null))
            ? pyGet(props, "prompt", null)
            : pyTruthy(pyGet(props, "title", null))
              ? pyGet(props, "title", null)
              : ""
      );
      if (kind === "learning") {
        // NB: Python does not guard this json.loads — invalid data raises.
        const data = JSON.parse(pyGet(props, "data", "{}") ?? "{}");
        if (pyGet(props, "kind", null) === "flashcards" && pyTruthy(pyGet(data, "cards", null))) {
          text = pyGet(data, "cards", [])
            .map((c: any) => `**${pyGet(c, "front", "")}**\n\n${pyGet(c, "back", "")}`)
            .join("\n\n");
        }
        if (pyGet(props, "kind", null) === "quiz" && pyTruthy(pyGet(data, "questions", null))) {
          const questions: string[] = [];
          for (const q of pyGet(data, "questions", [])) {
            const options = pyGet(q, "options", null) || {};
            const optionText = isPlainObj(options)
              ? Object.entries(options).map(([k, v]) => `- ${k}: ${v}`).join("\n")
              : "";
            questions.push(
              `${pyGet(q, "question", "")}\n\n${optionText}\n\nAnswer: ${pyGet(q, "correct_answer", "")}\n\n${pyGet(q, "explanation", "")}`
            );
          }
          text = questions.join("\n\n");
        }
        if (pyGet(props, "kind", null) === "timeline" && pyTruthy(pyGet(data, "events", null))) {
          text = pyGet(data, "events", [])
            .map((e: any) => `${pyGet(e, "date", "")} — ${pyGet(e, "title", "")}\n${pyGet(e, "description", "")}`)
            .join("\n\n");
        }
        const items = pyTruthy(pyGet(data, "workspace_items", null))
          ? pyGet(data, "workspace_items", [])
          : pyGet(data, "artifacts", []) || [];
        for (const item of items) {
          const url = pyGet(item, "url", "");
          if (safe_link(url) && pyTruthy(url)) {
            text += `\n\n[${pyGet(item, "filename", null) || pyGet(item, "title", null) || "Media"}](${item["url"]})`;
          }
        }
      }
      if (pyTruthy(pyGet(props, "sourceUrl", null))) {
        text += `\n\n[Source](${props["sourceUrl"]})`;
      }
    }
    if (text) {
      parts.push(
        text
          .split(SPLIT_LINES)
          .map((line) => "  ".repeat(depth) + line)
          .join("\n")
      );
    }
    const chRaw = pyGet(block, "children", null);
    if (pyTruthy(chRaw)) {
      parts.push(
        blocks_to_markdown(
          chRaw,
          kind === "noteColumns" || kind === "noteColumn" ? depth : depth + 1
        )
      );
    }
  }
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

export function* walk_blocks(blocks: any): Generator<AnyDict> {
  for (const block of blocks || []) {
    yield block;
    yield* walk_blocks(pyGet(block, "children", []));
  }
}

// ---------------------------------------------------------------------------
// Image query resolution (port of api/openui.py upstream calls, via fetch)
// ---------------------------------------------------------------------------

const _HEADERS = {
  "User-Agent": "open-intelligent-ui (https://github.com/thesysdev/open-intelligent-ui)",
};
const _SKIP_IMAGE_RE = /\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram/i;
const _SKIP_WIKI_RE = /\.svg|icon|logo|map|flag|seal/i;
const _IMAGE_WIDTH = 960;

function wikiWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w.length > 3);
}

async function wikiQuery(host: string, params: Record<string, string>): Promise<AnyDict[]> {
  const url =
    `https://${host}/w/api.php?action=query&format=json&formatversion=2&` +
    new URLSearchParams(params).toString();
  const resp = await fetch(url, { headers: _HEADERS, signal: AbortSignal.timeout(8000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data: any = await resp.json();
  if (data && data.error) throw new Error(`${host} error`);
  const pages = (((data ?? {}).query ?? {}).pages ?? []) as AnyDict[];
  return pages.sort((a, b) => (a["index"] ?? 0) - (b["index"] ?? 0));
}

async function searchImagesRaw(q: string): Promise<string[]> {
  const images: string[] = [];
  const add = (url: any) => {
    if (
      typeof url === "string" &&
      url.startsWith("https://") &&
      !_SKIP_IMAGE_RE.test(url) &&
      !images.includes(url)
    ) {
      images.push(url);
    }
  };
  const wanted = new Set(wikiWords(q));
  const articles = await wikiQuery("en.wikipedia.org", {
    generator: "search",
    gsrsearch: q,
    gsrlimit: "6",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: String(_IMAGE_WIDTH),
  });
  for (const page of articles) {
    const titleWords = wikiWords(pyStr(page["title"] ?? ""));
    if (titleWords.some((w) => wanted.has(w))) {
      add(pyGet(pyGet(page, "thumbnail", {}), "source", null));
    }
  }

  const terms = q.split(/\s+/).filter(Boolean);
  const tries = [...new Set([terms.join(" "), terms.slice(0, 3).join(" "), terms.slice(0, 2).join(" ")])];
  for (const term of tries) {
    if (images.length >= 3) break;
    const files = await wikiQuery("commons.wikimedia.org", {
      generator: "search",
      gsrsearch: `${term} filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "6",
      prop: "imageinfo",
      iiprop: "url|mime",
      iiurlwidth: String(_IMAGE_WIDTH),
    });
    for (const page of files) {
      const infoList = pyGet(page, "imageinfo", []);
      const info = Array.isArray(infoList) && infoList.length ? infoList[0] : null;
      if (info && pyStr(pyGet(info, "mime", "")).startsWith("image/")) {
        add(pyGet(info, "thumburl", null) ?? pyGet(info, "url", null));
      }
    }
  }
  return images.slice(0, 4);
}

async function wikiGet(url: string): Promise<AnyDict> {
  const resp = await fetch(url, { headers: _HEADERS, signal: AbortSignal.timeout(8000) });
  if (resp.status === 404) return {};
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as AnyDict;
}

function photoKey(url: string): string {
  const filename = decodeURIComponent(url.split("?")[0].split("/").pop() ?? "");
  return filename.replace(/^\d+px-/, "");
}

/** Python urllib.parse.quote(s, safe="") — encodeURIComponent plus !'()* escaped. */
function quotePy(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

async function wikiPhotos(title: string): Promise<AnyDict> {
  /** Lead + media-list photos and coordinates for an exact article title. */
  const encoded = quotePy(title.replace(/ /g, "_"));
  const [summary, media] = await Promise.all([
    wikiGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`),
    wikiGet(`https://en.wikipedia.org/api/rest_v1/page/media-list/${encoded}`),
  ]);
  const photos: string[] = [];
  const seenKeys = new Set<string>();
  const lead = pyGet(pyGet(summary, "thumbnail", {}), "source", null);
  if (lead) {
    photos.push(lead);
    seenKeys.add(photoKey(lead));
  }
  for (const item of pyGet(media, "items", []) || []) {
    const srcset = pyGet(item, "srcset", []) || [];
    if (pyGet(item, "type", null) !== "image" || !srcset.length) continue;
    let src = pyStr(pyGet(srcset[0], "src", ""));
    if (!src || _SKIP_WIKI_RE.test(src)) continue;
    const url = src.startsWith("//") ? "https:" + src : src;
    const k = photoKey(url);
    if (!seenKeys.has(k)) {
      photos.push(url);
      seenKeys.add(k);
    }
    if (photos.length >= 3) break;
  }
  const coords = pyGet(summary, "coordinates", {}) || {};
  const info: AnyDict = { photos };
  if (coords["lat"] !== null && coords["lat"] !== undefined) info["lat"] = coords["lat"];
  if (coords["lon"] !== null && coords["lon"] !== undefined) info["lng"] = coords["lon"];
  return info;
}

/**
 * Fill ``url`` on image blocks that carry a NoteUI ``query`` prop.
 *
 * ``SearchImage``/``WikiImage`` compile to image blocks with ``query`` (and
 * ``via``) instead of a URL; the patch path resolves them once so the stored
 * document keeps a stable link. Failures leave the block query-only — the
 * frontend preview resolves lazily at render time.
 */
export async function resolve_image_queries(blocks: AnyDict[]): Promise<void> {
  const targets = [...walk_blocks(blocks)].filter(
    (b) =>
      b["type"] === "image" &&
      isPlainObj(b["props"]) &&
      pyTruthy(b["props"]["query"]) &&
      !pyTruthy(b["props"]["url"])
  );
  if (!targets.length) return;

  const one = async (props: AnyDict) => {
    const query = pyStr(props["query"]).trim();
    let url: string | null = null;
    try {
      if (props["via"] === "wiki") {
        const info = await wikiPhotos(query);
        const photos = pyGet(info, "photos", []) || [];
        url = photos.length ? photos[0] : null;
      } else {
        const res = await searchImagesRaw(query);
        url = res.length ? res[0] : null;
      }
    } catch {
      url = null; // resolution is best-effort
    }
    if (url) props["url"] = url;
  };

  await Promise.all(targets.map((b) => one(b["props"])));
}
