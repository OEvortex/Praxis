// Minimal YAML subset for Obsidian frontmatter — port of the PyYAML
// contains: flat/nested maps, scalar lists, quoted and plain scalars,
// comments, inline `[a, b]` / `{k: v}` flow collections, `|`/`>` block
// scalars (with `-`/`+` chomping and indent indicators), and `&anchor` /
// `*alias` references.
//
// Deliberately NOT a general YAML parser: no multi-document streams, no
// merge keys (`<<`), no tags, no sets. Anything it cannot represent is
// preserved as its raw string; an unknown alias stays literal rather than
// failing the whole note (upstream's yaml.safe_load would reject the
// frontmatter entirely — keeping the text is strictly more useful here).

export class YamlError extends Error {}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// --- scalar coercion -------------------------------------------------------

function coerceScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === "" ) return "";
  if (s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
  if (s === "true" || s === "True" || s === "TRUE") return true;
  if (s === "false" || s === "False" || s === "FALSE") return false;
  if (/^[+-]?\d+$/.test(s)) {
    const n = Number.parseInt(s, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1).replace(/\\(["'\\nrt])/g, (_m, c: string) => {
      switch (c) {
        case "n": return "\n";
        case "t": return "\t";
        case "r": return "\r";
        default: return c;
      }
    });
  }
  // Strip a trailing comment only when preceded by whitespace and not inside
  // quotes — good enough for frontmatter.
  const hash = s.indexOf(" #");
  const clean = (hash >= 0 ? s.slice(0, hash) : s).trim();
  return clean;
}

function splitInlineList(inner: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p !== "");
}

type YamlAnchors = Map<string, unknown>;

function cloneValue(v: unknown): unknown {
  return v !== null && typeof v === "object"
    ? JSON.parse(JSON.stringify(v))
    : v;
}

function parseValue(raw: string, anchors: YamlAnchors): unknown {
  let s = raw.trim();
  // Leading anchors: `&name value` — the anchor binds the parsed value.
  const anchorNames: string[] = [];
  for (;;) {
    const am = /^&([^\s&]+)\s*(.*)$/.exec(s);
    if (!am) break;
    anchorNames.push(am[1]!);
    s = am[2]!.trim();
  }
  if (!s) return null;
  // Alias: `*name` resolves to the anchored value; unknown stays literal.
  const alias = /^\*([^\s,\]{}]+)\s*(?:#.*)?$/.exec(s);
  let value: unknown;
  if (alias) {
    const anchored = anchors.get(alias[1]!);
    value = anchored === undefined ? s : cloneValue(anchored);
  } else if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    value = inner ? splitInlineList(inner).map((p) => parseValue(p, anchors)) : [];
  } else if (s.startsWith("{") && s.endsWith("}")) {
    // Flow map: {a: 1, b: 2} — rare in frontmatter but cheap to support.
    const out: Record<string, unknown> = {};
    for (const part of splitInlineList(s.slice(1, -1))) {
      const idx = part.indexOf(":");
      if (idx <= 0) continue;
      out[part.slice(0, idx).trim()] = parseValue(part.slice(idx + 1), anchors);
    }
    value = out;
  } else {
    value = coerceScalar(s);
  }
  for (const name of anchorNames) anchors.set(name, cloneValue(value));
  return value;
}

interface Line {
  indent: number;
  raw: string;
  text: string;
}

// All physical lines are kept: blank lines and `#` comments are structural
// noise at block level, but they are *content* inside `|`/`>` scalars, so the
// block-scalar reader works on `raw` directly.
function logicalLines(text: string): Line[] {
  return text.split(/\r?\n/).map((raw) => {
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    return { indent, raw, text: raw.trim() };
  });
}

function isSkippable(line: Line): boolean {
  return line.text === "" || line.text.startsWith("#");
}

/** Index of the next line that is not blank and not a full-line comment. */
function nextContent(lines: Line[], i: number): number {
  while (i < lines.length && isSkippable(lines[i]!)) i++;
  return i;
}

// `|` literal / `>` folded, optional chomping (`-` strip, `+` keep) and
// indentation indicator (`|2`). A trailing comment is allowed.
const BLOCK_SCALAR_RE = /^([|>])([+-]?)(\d?)\s*(?:#.*)?$/;

/**
 * Consume a block scalar whose header line was just read. `parentIndent` is
 * the indent of the key/dash the scalar belongs to; content must be indented
 * deeper (or use the explicit indicator). Returns [value, nextIndex].
 */
function parseBlockScalar(
  lines: Line[],
  start: number,
  parentIndent: number,
  header: RegExpExecArray,
): [string, number] {
  const style = header[1]!;
  const chomp = header[2] ?? "";
  const indicator = header[3] ?? "";
  const explicitIndent = indicator ? parentIndent + parseInt(indicator, 10) : -1;

  // The first non-blank, non-comment line sets the content indentation
  // (unless an explicit indicator overrides it).
  let contentIndent = -1;
  for (let k = start; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.text === "" || l.text.startsWith("#")) continue;
    if (l.indent <= parentIndent) break;
    contentIndent = explicitIndent > 0 ? explicitIndent : l.indent;
    break;
  }
  if (contentIndent < 0) return ["", start];

  const contents: string[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.text === "") {
      // Blank lines are scalar content (paragraph breaks / kept newlines).
      contents.push("");
      i++;
      continue;
    }
    if (l.indent < contentIndent) break;
    contents.push(l.raw.slice(Math.min(contentIndent, l.raw.length)));
    i++;
  }

  let text: string;
  let trailingBlanks = 0;
  if (style === ">") {
    // Folded: line breaks inside a paragraph become spaces; each run of
    // blank lines becomes that many line feeds.
    text = "";
    trailingBlanks = 0;
    {
      const segments: { lines: string[]; blanksBefore: number }[] = [];
      let pending = 0;
      let seen = false;
      let open = false; // current segment still accepting folded lines
      for (const c of contents) {
        if (c === "") {
          pending++;
          open = false;
          continue;
        }
        if (!open) {
          segments.push({ lines: [c], blanksBefore: seen ? pending : 0 });
          seen = true;
          pending = 0;
          open = true;
        } else {
          segments[segments.length - 1]!.lines.push(c);
        }
      }
      trailingBlanks = pending;
      text = segments
        .map((seg, idx) =>
          (idx > 0 ? "\n".repeat(seg.blanksBefore) : "") + seg.lines.join(" "),
        )
        .join("");
    }
  } else {
    // Literal: content lines joined verbatim.
    text = contents.join("\n");
  }

  // Chomping.
  if (chomp === "-") {
    text = text.replace(/\n+$/, "");
  } else if (chomp === "+") {
    if (contents.length) {
      text = style === ">" ? text + "\n".repeat(trailingBlanks + 1) : text + "\n";
    }
  } else {
    // Clip: strip trailing breaks, keep exactly one.
    const stripped = text.replace(/\n+$/, "");
    text = stripped ? stripped + "\n" : "";
  }
  return [text, i];
}

/**
 * Parse one `key: <rest>` / `- <rest>` value: anchors, block scalars, nested
 * blocks and flow/plain values. Returns [value, nextIndex].
 */
function parseEntryValue(
  lines: Line[],
  i: number,
  parentIndent: number,
  rawRest: string,
  anchors: YamlAnchors,
): [unknown, number] {
  let rest = rawRest.trim();
  const anchorNames: string[] = [];
  for (;;) {
    const am = /^&([^\s&]+)\s*(.*)$/.exec(rest);
    if (!am) break;
    anchorNames.push(am[1]!);
    rest = am[2]!.trim();
  }

  let value: unknown;
  let ni = i;
  if (rest === "") {
    const ci = nextContent(lines, i);
    if (ci < lines.length && lines[ci]!.indent > parentIndent) {
      const [v, nj] = parseBlock(lines, ci, lines[ci]!.indent, anchors);
      value = v;
      ni = nj;
    } else {
      value = null;
    }
  } else {
    const bm = BLOCK_SCALAR_RE.exec(rest);
    if (bm) {
      const [v, nj] = parseBlockScalar(lines, i, parentIndent, bm);
      value = v;
      ni = nj;
    } else {
      value = parseValue(rest, anchors);
    }
  }
  for (const name of anchorNames) anchors.set(name, cloneValue(value));
  return [value, ni];
}

// Parse the block starting at lines[i] whose indent is `indent`.
// Returns [value, nextIndex].
function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
  anchors: YamlAnchors,
): [unknown, number] {
  const i0 = nextContent(lines, start);
  if (i0 >= lines.length || lines[i0]!.indent !== indent) {
    return [null, i0];
  }
  const first = lines[i0]!.text;

  if (first.startsWith("- ") || first === "-") {
    const seq: unknown[] = [];
    let i = i0;
    while (i < lines.length) {
      const ni = nextContent(lines, i);
      if (ni >= lines.length) break;
      const l = lines[ni]!;
      if (l.indent !== indent || !(l.text.startsWith("- ") || l.text === "-")) break;
      i = ni;
      let itemText = l.text === "-" ? "" : l.text.slice(2).trim();
      i++;

      // Anchors on the whole item: `- &name value`.
      const anchorNames: string[] = [];
      for (;;) {
        const am = /^&([^\s&]+)\s*(.*)$/.exec(itemText);
        if (!am) break;
        anchorNames.push(am[1]!);
        itemText = am[2]!.trim();
      }

      let value: unknown;
      if (itemText === "") {
        const ci = nextContent(lines, i);
        if (ci < lines.length && lines[ci]!.indent > indent) {
          const [v, nj] = parseBlock(lines, ci, lines[ci]!.indent, anchors);
          value = v;
          i = nj;
        } else {
          value = null;
        }
      } else if (BLOCK_SCALAR_RE.test(itemText)) {
        const [v, nj] = parseBlockScalar(lines, i, indent, BLOCK_SCALAR_RE.exec(itemText)!);
        value = v;
        i = nj;
      } else {
        const colon = itemText.indexOf(":");
        if (
          colon > 0 &&
          !itemText.startsWith('"') &&
          !itemText.startsWith("'") &&
          !itemText.startsWith("*")
        ) {
          // "- key: value" — a map entry inside a sequence; gather its
          // continuation keys (deeper indent) as extra entries.
          const map: Record<string, unknown> = {};
          const key = itemText.slice(0, colon).trim().replace(/^["']|["']$/g, "");
          const [v0, i1] = parseEntryValue(lines, i, indent, itemText.slice(colon + 1), anchors);
          map[key] = v0;
          i = i1;
          for (;;) {
            const ci = nextContent(lines, i);
            if (ci >= lines.length) break;
            const cl = lines[ci]!;
            if (cl.indent <= indent || cl.text === "-" || cl.text.startsWith("- ")) break;
            const km = /^([^:]+):\s*(.*)$/.exec(cl.text);
            if (!km) break;
            const k2 = km[1]!.trim().replace(/^["']|["']$/g, "");
            const [v2, i2] = parseEntryValue(lines, ci + 1, cl.indent, km[2] ?? "", anchors);
            map[k2] = v2;
            i = i2;
          }
          value = map;
        } else {
          value = parseValue(itemText, anchors);
        }
      }
      for (const name of anchorNames) anchors.set(name, cloneValue(value));
      seq.push(value);
    }
    return [seq, i];
  }

  // Map.
  const map: Record<string, unknown> = {};
  let i = i0;
  for (;;) {
    const ni = nextContent(lines, i);
    if (ni >= lines.length) break;
    const l = lines[ni]!;
    if (l.indent !== indent || l.text === "-" || l.text.startsWith("- ")) break;
    const m = /^([^:]+):\s*(.*)$/.exec(l.text);
    if (!m) {
      // Non key:value line at this level — skip rather than corrupt.
      i = ni + 1;
      continue;
    }
    const key = m[1]!.trim().replace(/^["']|["']$/g, "");
    const [v, nj] = parseEntryValue(lines, ni + 1, indent, m[2] ?? "", anchors);
    map[key] = v;
    i = nj;
  }
  return [map, i];
}

export function parseYamlSubset(text: string): Record<string, unknown> {
  const lines = logicalLines(text);
  const anchors: YamlAnchors = new Map();
  const first = nextContent(lines, 0);
  if (first >= lines.length) return {};
  const [value] = parseBlock(lines, first, lines[first]!.indent, anchors);
  return isRecord(value) ? value : {};
}

// --- dumping ---------------------------------------------------------------

function formatScalar(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // Quote when the plain form would re-parse as something else.
  if (
    s === "" ||
    /^[~]|^(null|true|false|yes|no|on|off)$/i.test(s) ||
    /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ||
    s.startsWith("[") ||
    s.startsWith("{") ||
    s.startsWith("#") ||
    s !== s.trim() ||
    /[:#\[\]{}&*!|>'"%@`]/.test(s)
  ) {
    return JSON.stringify(s);
  }
  return s;
}

function dumpBlock(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        const entries = Object.entries(item);
        if (!entries.length) {
          out.push(`${pad}- {}`);
          continue;
        }
        const [[k, v], ...rest] = entries;
        if (Array.isArray(v) || isRecord(v)) {
          out.push(`${pad}- ${k}:`);
          out.push(...dumpBlock(v, indent + 2));
        } else {
          out.push(`${pad}- ${k}: ${formatScalar(v)}`);
        }
        for (const [rk, rv] of rest) {
          if (Array.isArray(rv) || isRecord(rv)) {
            out.push(`${pad}  ${rk}:`);
            out.push(...dumpBlock(rv, indent + 2));
          } else {
            out.push(`${pad}  ${rk}: ${formatScalar(rv)}`);
          }
        }
      } else if (Array.isArray(item)) {
        out.push(`${pad}-`);
        out.push(...dumpBlock(item, indent + 1));
      } else {
        out.push(`${pad}- ${formatScalar(item)}`);
      }
    }
    return out;
  }
  if (isRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v) && v.every((x) => !isRecord(x) && !Array.isArray(x))) {
        if (!v.length) {
          out.push(`${pad}${k}: []`);
        } else {
          out.push(`${pad}${k}:`);
          for (const item of v) out.push(`${pad}  - ${formatScalar(item)}`);
        }
      } else if (Array.isArray(v) || isRecord(v)) {
        out.push(`${pad}${k}:`);
        out.push(...dumpBlock(v, indent + 1));
      } else {
        out.push(`${pad}${k}: ${formatScalar(v)}`);
      }
    }
    return out;
  }
  out.push(`${pad}${formatScalar(value)}`);
  return out;
}

export function dumpYamlSubset(data: Record<string, unknown>): string {
  return dumpBlock(data, 0).join("\n");
}
