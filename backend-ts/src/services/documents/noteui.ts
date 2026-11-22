/**
 * NoteUI Lang — an openui-style DSL that compiles to BlockNote blocks.
 *
 * Co-writer page bodies are Markdown; anything Markdown cannot express
 * (columns, callouts with tones, embedded cards, computed text) goes in a
 * ```` ```noteui ```` fence as a small program.
 *
 * Syntax mirrors OpenUI Lang: ``name = expr`` bindings, ``$name`` references,
 * ``Component(positional, args)`` calls whose last argument may be an array of
 * child components, ``@Function(args)`` compile-time functions, arrays ``[...]``,
 * objects ``{key: value}``, strings (``"..."``, ``'...'``, `` `raw` ``), numbers,
 * ``true``/``false``/``null``, ``+ - * / %``, comparisons, ``&&``/``||``/``!``,
 * ternary ``cond ? a : b``, member access ``obj.field`` / ``list.field`` plucking,
 * and indexing ``a[i]``.
 */

import { randomUUID } from "node:crypto";
import { safe_link, inline_markdown } from "./blocks.js";

export class NoteUIError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteUIError";
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

type AnyDict = Record<string, any>;

function isPlainObj(v: any): v is AnyDict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** dict.get(key, default) — own-property lookup only (no prototype keys). */
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

function pyNumOrNull(v: any): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

function pyNumReq(v: any): number {
  const n = pyNumOrNull(v);
  if (n === null) throw new TypeError("unsupported operand type(s)");
  return n;
}

function pyFloat(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const t = v.trim();
    if (t === "") throw new Error(`could not convert string to float: '${v}'`);
    const low = t.toLowerCase();
    if (low === "inf" || low === "+inf" || low === "infinity" || low === "+infinity") return Infinity;
    if (low === "-inf" || low === "-infinity") return -Infinity;
    if (low === "nan") return NaN;
    const n = Number(t);
    if (Number.isNaN(n)) throw new Error(`could not convert string to float: '${v}'`);
    return n;
  }
  throw new Error("float() argument must be a string or a number");
}

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

function pyRepr(v: any): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    return "'" + v.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
  }
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v)
        .map(([k, x]) => pyRepr(k) + ": " + pyRepr(x))
        .join(", ") +
      "}"
    );
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
    return (
      "{" +
      Object.entries(v)
        .map(([k, x]) => pyRepr(k) + ": " + pyRepr(x))
        .join(", ") +
      "}"
    );
  }
  return String(v);
}

/** noteui.py ``_str``: None->"", bool->"true"/"false", else str(value). */
function dslStr(v: any): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return pyStr(v);
}

function pyEq(a: any, b: any): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === b) return true;
  if (a === null || b === null) return false;
  const an = pyNumOrNull(a);
  const bn = pyNumOrNull(b);
  if (an !== null && bn !== null) return an === bn;
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  }
  if (isPlainObj(a) && isPlainObj(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return (
      ka.length === kb.length &&
      ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && pyEq(a[k], b[k]))
    );
  }
  return false;
}

function pyCompare(op: string, l: any, r: any): boolean {
  const ln = pyNumOrNull(l);
  const rn = pyNumOrNull(r);
  let c: number;
  if (ln !== null && rn !== null) {
    c = ln < rn ? -1 : ln > rn ? 1 : 0;
  } else if (typeof l === "string" && typeof r === "string") {
    c = l < r ? -1 : l > r ? 1 : 0;
  } else {
    throw new TypeError(`'${op}' not supported between instances`);
  }
  switch (op) {
    case "<":
      return c < 0;
    case ">":
      return c > 0;
    case "<=":
      return c <= 0;
    case ">=":
      return c >= 0;
    default:
      return false;
  }
}

function pyMod(a: number, b: number): number {
  const r = a % b;
  if (r !== 0 && (r < 0) !== (b < 0)) return r + b;
  return r;
}

function pyAdd(l: any, r: any): any {
  if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
  if (isPlainObj(l) && isPlainObj(r)) return { ...l, ...r };
  const ln = pyNumOrNull(l);
  const rn = pyNumOrNull(r);
  if (ln !== null && rn !== null) return ln + rn;
  throw new TypeError("unsupported operand type(s) for +");
}

function pyMul(l: any, r: any): any {
  const ln = pyNumOrNull(l);
  const rn = pyNumOrNull(r);
  if (ln !== null && rn !== null) return ln * rn;
  // "ab" * 3 / [1] * 2
  const seq = typeof l === "string" || Array.isArray(l) ? l : typeof r === "string" || Array.isArray(r) ? r : null;
  const n = seq === l ? rn : ln;
  if (seq !== null && n !== null && Number.isInteger(n)) {
    if (n <= 0) return typeof seq === "string" ? "" : [];
    if (typeof seq === "string") return seq.repeat(n);
    const out: any[] = [];
    for (let i = 0; i < n; i++) out.push(...seq);
    return out;
  }
  throw new TypeError("unsupported operand type(s) for *");
}

function newId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// ---------------------------------------------------------------------------
// Inline Markdown (shared by the DSL and the coarse Markdown converter)
// ---------------------------------------------------------------------------

const _MARKERS = ["**", "__", "~~", "*", "_", "`", "[", "$"];

function isAlnumCh(c: string): boolean {
  return /[\p{L}\p{N}]/u.test(c);
}

function parseSpans(text: string, styles: Record<string, boolean>): any[] {
  const out: any[] = [];
  const buf: string[] = [];
  let i = 0;
  const n = text.length;

  const flush = () => {
    if (buf.length) {
      out.push({ type: "text", text: buf.join(""), styles: { ...styles } });
      buf.length = 0;
    }
  };

  while (i < n) {
    const ch = text[i];
    let matched = false;
    for (const marker of _MARKERS) {
      if (!text.startsWith(marker, i)) continue;
      // A backslash-escaped marker stays literal.
      if (i > 0 && text[i - 1] === "\\") {
        buf.push(text.slice(i, i + marker.length));
        i += marker.length;
        matched = true;
        break;
      }
      if (marker === "**" || marker === "__") {
        const close = text.indexOf(marker, i + 2);
        if (close < 0) {
          buf.push(marker);
          i += 2;
          matched = true;
          break;
        }
        flush();
        out.push(
          ...parseSpans(text.slice(i + 2, close), { ...styles, bold: true })
        );
        i = close + 2;
        matched = true;
        break;
      }
      if (marker === "~~") {
        const close = text.indexOf("~~", i + 2);
        if (close < 0) {
          buf.push("~~");
          i += 2;
          matched = true;
          break;
        }
        flush();
        out.push(
          ...parseSpans(text.slice(i + 2, close), { ...styles, strike: true })
        );
        i = close + 2;
        matched = true;
        break;
      }
      if (marker === "*" || marker === "_") {
        // Avoid treating snake_case underscores as emphasis.
        if (
          marker === "_" &&
          ((i > 0 && (isAlnumCh(text[i - 1]) || text[i - 1] === "_")) ||
            (i + 1 < n && (isAlnumCh(text[i + 1]) || text[i + 1] === "_")))
        ) {
          continue;
        }
        const close = text.indexOf(marker, i + 1);
        if (close < 0) {
          buf.push(marker);
          i += 1;
          matched = true;
          break;
        }
        flush();
        out.push(
          ...parseSpans(text.slice(i + 1, close), { ...styles, italic: true })
        );
        i = close + 1;
        matched = true;
        break;
      }
      if (marker === "`") {
        const close = text.indexOf("`", i + 1);
        if (close < 0) {
          buf.push("`");
          i += 1;
          matched = true;
          break;
        }
        flush();
        out.push({
          type: "text",
          text: text.slice(i + 1, close),
          styles: { ...styles, code: true },
        });
        i = close + 1;
        matched = true;
        break;
      }
      if (marker === "[") {
        const mid = text.indexOf("](", i + 1);
        if (mid > 0) {
          const end = text.indexOf(")", mid + 2);
          if (end > 0) {
            const href = text.slice(mid + 2, end);
            const label = text.slice(i + 1, mid);
            if (safe_link(href)) {
              flush();
              out.push({ type: "link", href, content: parseSpans(label, {}) });
              i = end + 1;
              matched = true;
              break;
            }
          }
        }
        buf.push("[");
        i += 1;
        matched = true;
        break;
      }
      if (marker === "$") {
        // Display $$...$$ first, then inline $...$ (no space padding).
        if (text.startsWith("$$", i)) {
          const close = text.indexOf("$$", i + 2);
          if (close > i + 2) {
            const formula = text.slice(i + 2, close).trim();
            if (formula) {
              flush();
              out.push({ type: "math", content: formula });
              i = close + 2;
              matched = true;
              break;
            }
          }
          buf.push("$$");
          i += 2;
          matched = true;
          break;
        }
        const close = text.indexOf("$", i + 1);
        if (close > i + 1) {
          const formula = text.slice(i + 1, close);
          if (
            formula.trim() &&
            !formula.startsWith(" ") &&
            !formula.endsWith(" ")
          ) {
            flush();
            out.push({ type: "math", content: formula.trim() });
            i = close + 1;
            matched = true;
            break;
          }
        }
        buf.push("$");
        i += 1;
        matched = true;
        break;
      }
    }
    if (!matched) {
      buf.push(ch);
      i += 1;
    }
  }
  flush();
  return out;
}

/** Markdown-lite inline content: **bold** *italic* `code` ~~strike~~ [t](u) $math$. */
export function parse_inline_md(text: string): any[] {
  if (!text) return [];
  return parseSpans(text, {});
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const _PUNCT = new Set([
  "(", ")", "[", "]", "{", "}", ",", ":", ".", "?",
  "+", "-", "*", "/", "%", "=", "!", "<", ">", "&", "|",
]);
const _TWO_CHAR = new Set(["==", "!=", "<=", ">=", "&&", "||"]);

type Token = [kind: string, val: any, line: number];
type Node = any[];

function isDigitCh(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isAlphaCh(c: string): boolean {
  return /[\p{L}\p{Nl}]/u.test(c);
}
function isWordCh(c: string): boolean {
  return /[\p{L}\p{N}_]/u.test(c);
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = source.length;
  let line = 1;
  while (i < n) {
    const ch = source[i];
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === "/" && source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? n : end;
      continue;
    }
    if (isDigitCh(ch) || (ch === "." && i + 1 < n && isDigitCh(source[i + 1]))) {
      let j = i;
      while (j < n && (isDigitCh(source[j]) || source[j] === ".")) j += 1;
      const raw = source.slice(i, j);
      let val: number;
      if (raw.includes(".")) {
        val = Number(raw);
        if (Number.isNaN(val)) throw new NoteUIError(`Bad number '${raw}' (line ${line})`);
      } else {
        val = parseInt(raw, 10);
        if (Number.isNaN(val)) throw new NoteUIError(`Bad number '${raw}' (line ${line})`);
      }
      tokens.push(["num", val, line]);
      i = j;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      const buf: string[] = [];
      const ESC: Record<string, string> = {
        n: "\n", t: "\t", r: "\r", '"': '"', "'": "'", "\\": "\\", "`": "`", $: "$",
      };
      while (j < n && source[j] !== quote) {
        if (source[j] === "\\" && j + 1 < n) {
          const nxt = source[j + 1];
          buf.push(
            Object.prototype.hasOwnProperty.call(ESC, nxt) ? ESC[nxt] : nxt
          );
          j += 2;
          continue;
        }
        if (source[j] === "\n") line += 1;
        buf.push(source[j]);
        j += 1;
      }
      if (j >= n) throw new NoteUIError(`Unterminated string (line ${line})`);
      tokens.push(["str", buf.join(""), line]);
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      const j = source.indexOf("`", i + 1);
      if (j < 0) throw new NoteUIError(`Unterminated raw string (line ${line})`);
      tokens.push(["str", source.slice(i + 1, j), line]);
      const seg = source.slice(i, j);
      line += (seg.match(/\n/g) || []).length;
      i = j + 1;
      continue;
    }
    if (ch === "@") {
      let j = i + 1;
      while (j < n && isWordCh(source[j])) j += 1;
      if (j === i + 1)
        throw new NoteUIError(`'@' must be followed by a function name (line ${line})`);
      tokens.push(["fn", source.slice(i + 1, j), line]);
      i = j;
      continue;
    }
    if (ch === "$") {
      let j = i + 1;
      while (j < n && isWordCh(source[j])) j += 1;
      if (j === i + 1)
        throw new NoteUIError(`'$' must be followed by a variable name (line ${line})`);
      tokens.push(["var", source.slice(i + 1, j), line]);
      i = j;
      continue;
    }
    if (isAlphaCh(ch) || ch === "_") {
      let j = i;
      while (j < n && isWordCh(source[j])) j += 1;
      const word = source.slice(i, j);
      if (word === "true" || word === "false" || word === "null") {
        tokens.push(["lit", word === "true" ? true : word === "false" ? false : null, line]);
      } else {
        tokens.push(["ident", word, line]);
      }
      i = j;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (_TWO_CHAR.has(two)) {
      tokens.push(["op", two, line]);
      i += 2;
      continue;
    }
    if (_PUNCT.has(ch)) {
      if (ch === "=") {
        tokens.push(["op", "=", line]);
      } else if (ch === "&") {
        throw new NoteUIError(`Use '&&' for and (line ${line})`);
      } else if (ch === "|") {
        throw new NoteUIError(`Use '||' for or (line ${line})`);
      } else {
        tokens.push(["punct", ch, line]);
      }
      i += 1;
      continue;
    }
    throw new NoteUIError(`Unexpected character '${ch}' (line ${line})`);
  }
  tokens.push(["eof", null, line]);
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  tokens: Token[];
  pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }
  peek(): Token {
    return this.tokens[this.pos];
  }
  next(): Token {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }
  expect(value: string): Token {
    const tok = this.next();
    if (tok[1] !== value) {
      throw new NoteUIError(`Expected '${value}', got '${tok[1]}' (line ${tok[2]})`);
    }
    return tok;
  }
  at(value: string): boolean {
    const [kind, val] = this.peek();
    return val === value && (kind === "punct" || kind === "op");
  }
  parse_program(): Node[] {
    const stmts: Node[] = [];
    while (this.peek()[0] !== "eof") stmts.push(this.parse_stmt());
    return stmts;
  }
  parse_stmt(): Node {
    // name = expr  |  $name = expr  |  expr
    const [pk] = this.peek();
    const nxt = this.tokens[this.pos + 1];
    if (
      (pk === "ident" || pk === "var") &&
      nxt &&
      nxt[1] === "=" &&
      nxt[0] === "op"
    ) {
      const name = this.next()[1];
      this.next(); // '='
      return ["bind", name, this.parse_expr()];
    }
    return ["expr", this.parse_expr()];
  }
  parse_expr(): Node {
    return this.parse_ternary();
  }
  parse_ternary(): Node {
    const cond = this.parse_or();
    if (this.at("?")) {
      this.next();
      const yes = this.parse_expr();
      this.expect(":");
      const no = this.parse_expr();
      return ["tern", cond, yes, no];
    }
    return cond;
  }
  parse_or(): Node {
    let left = this.parse_and();
    while (this.at("||")) {
      this.next();
      left = ["bin", "||", left, this.parse_and()];
    }
    return left;
  }
  parse_and(): Node {
    let left = this.parse_cmp();
    while (this.at("&&")) {
      this.next();
      left = ["bin", "&&", left, this.parse_cmp()];
    }
    return left;
  }
  parse_cmp(): Node {
    let left = this.parse_add();
    while (
      this.peek()[0] === "op" &&
      ["==", "!=", "<", ">", "<=", ">="].includes(this.peek()[1])
    ) {
      const op = this.next()[1];
      left = ["bin", op, left, this.parse_add()];
    }
    return left;
  }
  parse_add(): Node {
    let left = this.parse_mul();
    while (this.at("+") || this.at("-")) {
      const op = this.next()[1];
      left = ["bin", op, left, this.parse_mul()];
    }
    return left;
  }
  parse_mul(): Node {
    let left = this.parse_unary();
    while (
      ["*", "/", "%"].includes(this.peek()[1]) &&
      (this.peek()[0] === "op" || this.peek()[0] === "punct")
    ) {
      const op = this.next()[1];
      left = ["bin", op, left, this.parse_unary()];
    }
    return left;
  }
  parse_unary(): Node {
    if (this.at("!")) {
      this.next();
      return ["un", "!", this.parse_unary()];
    }
    if (this.at("-")) {
      this.next();
      return ["un", "-", this.parse_unary()];
    }
    return this.parse_postfix();
  }
  parse_postfix(): Node {
    let node = this.parse_primary();
    while (true) {
      if (this.at(".")) {
        this.next();
        const [kind, name, line] = this.next();
        if (kind !== "ident") {
          throw new NoteUIError(`Expected a field name after '.' (line ${line})`);
        }
        node = ["member", node, name];
        continue;
      }
      if (this.at("[")) {
        this.next();
        const index = this.parse_expr();
        this.expect("]");
        node = ["index", node, index];
        continue;
      }
      break;
    }
    return node;
  }
  parse_primary(): Node {
    const [kind, val, line] = this.next();
    if (kind === "num") return ["lit", val];
    if (kind === "str") return ["lit", val];
    if (kind === "lit") return ["lit", val];
    if (kind === "var") return ["var", val];
    if (kind === "fn") {
      this.expect("(");
      const args = this.parse_args();
      this.expect(")");
      return ["fn", val, args];
    }
    if (kind === "ident") {
      if (val === "true" || val === "false" || val === "null") {
        return ["lit", val === "true" ? true : val === "false" ? false : null];
      }
      if (this.at("(")) {
        this.next();
        const args = this.parse_args();
        this.expect(")");
        return ["call", val, args];
      }
      // Bare identifier: bound variable reference.
      return ["var", val];
    }
    if (kind === "punct" && val === "(") {
      const node = this.parse_expr();
      this.expect(")");
      return node;
    }
    if (kind === "punct" && val === "[") {
      const items: Node[] = [];
      while (!this.at("]")) {
        items.push(this.parse_expr());
        if (this.at(",")) {
          this.next();
          continue;
        }
        break;
      }
      this.expect("]");
      return ["arr", items];
    }
    if (kind === "punct" && val === "{") {
      const pairs: [string, Node][] = [];
      while (!this.at("}")) {
        const [kkind, kval, kline] = this.next();
        if (kkind !== "ident" && kkind !== "str") {
          throw new NoteUIError(`Object keys must be names or strings (line ${kline})`);
        }
        this.expect(":");
        pairs.push([kval, this.parse_expr()]);
        if (this.at(",")) {
          this.next();
          continue;
        }
        break;
      }
      this.expect("}");
      return ["obj", pairs];
    }
    throw new NoteUIError(`Unexpected token '${val}' (line ${line})`);
  }
  parse_args(): Node[] {
    const args: Node[] = [];
    while (!this.at(")")) {
      args.push(this.parse_expr());
      if (this.at(",")) {
        this.next();
        continue;
      }
      break;
    }
    return args;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function blk(type_: string, props?: AnyDict | null, content?: any, children?: any[] | null): AnyDict {
  const block: AnyDict = {
    id: newId(),
    type: type_,
    props: props || {},
    children: children || [],
  };
  if (content !== null && content !== undefined) block["content"] = content;
  return block;
}

function isBlocks(value: any): boolean {
  return (
    Array.isArray(value) &&
    value.every((item) => isPlainObj(item) && typeof item["type"] === "string")
  );
}

function asBlocks(value: any, what = "value"): AnyDict[] {
  if (isBlocks(value)) return [...value];
  if (Array.isArray(value)) {
    const flat: AnyDict[] = [];
    for (const item of value) flat.push(...asBlocks(item, what));
    return flat;
  }
  throw new NoteUIError(`${what} must be a component or list of components`);
}

function joinText(args: any[]): string {
  const parts: string[] = [];
  for (const arg of args) {
    if (isBlocks(arg) || (Array.isArray(arg) && arg.length && isBlocks(arg[0]))) {
      throw new NoteUIError(
        "Text content cannot contain components; pass them as children instead"
      );
    }
    if (typeof arg === "boolean") {
      parts.push(arg ? "true" : "false");
    } else if (arg === null || arg === undefined) {
      continue;
    } else {
      parts.push(pyStr(arg));
    }
  }
  return parts.join("");
}

function contentOf(text: string): any[] {
  return parse_inline_md(text);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

type ComponentFn = (args: any[], children: AnyDict[] | null) => AnyDict[];

const _CHILDREN_OK = new Set([
  "heading", "toggleHeading", "quote", "callout",
  "bulletListItem", "numberedListItem", "checkListItem", "toggleListItem",
  "noteColumn",
]);

const _CALLOUT_TONES = new Set(["tip", "info", "warning"]);

function splitChildren(args: any[]): [any[], AnyDict[] | null] {
  const last = args.length ? args[args.length - 1] : undefined;
  if (
    args.length &&
    (isBlocks(last) ||
      (Array.isArray(last) && last.length && isBlocks(last[0])))
  ) {
    return [args.slice(0, -1), asBlocks(last, "children")];
  }
  return [args, null];
}

function requireNoChildren(children: AnyDict[] | null, name: string): void {
  if (children && children.length) {
    throw new NoteUIError(`${name} does not take child components`);
  }
}

function cPage(args: any[], _children: AnyDict[] | null): AnyDict[] {
  const blocks = args.length ? asBlocks(args[0], "Page") : [];
  return blocks;
}

function cHeading(args: any[], children: AnyDict[] | null, toggle = false): AnyDict[] {
  let [rest, tail] = splitChildren(args);
  const ch = (children && children.length ? children : tail) ?? [];
  let level = rest.length ? pyInt(rest[0]) : toggle ? 2 : 1;
  level = Math.max(1, Math.min(6, level));
  const text = joinText(rest.slice(1));
  const kind = toggle ? "toggleHeading" : "heading";
  const props: AnyDict = { level };
  if (toggle) props["collapsed"] = false;
  return [blk(kind, props, contentOf(text), ch.length ? ch : [])];
}

function cText(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Text");
  return [blk("paragraph", null, contentOf(joinText(args)))];
}

function cQuote(args: any[], children: AnyDict[] | null): AnyDict[] {
  let [rest, tail] = splitChildren(args);
  const ch = (children && children.length ? children : tail) ?? [];
  return [blk("quote", null, contentOf(joinText(rest)), ch.length ? ch : [])];
}

function cCallout(args: any[], children: AnyDict[] | null): AnyDict[] {
  let [rest, tail] = splitChildren(args);
  const ch = (children && children.length ? children : tail) ?? [];
  let tone = "tip";
  if (rest.length && typeof rest[0] === "string" && _CALLOUT_TONES.has(rest[0].toLowerCase())) {
    tone = rest[0].toLowerCase();
    rest = rest.slice(1);
  }
  return [blk("callout", { tone }, contentOf(joinText(rest)), ch.length ? ch : [])];
}

function cItem(kind: string): ComponentFn {
  return (args: any[], children: AnyDict[] | null) => {
    let [rest, tail] = splitChildren(args);
    const ch = (children && children.length ? children : tail) ?? [];
    const props: AnyDict = {};
    const items = [...rest];
    if (kind === "checkListItem" && items.length && typeof items[items.length - 1] === "boolean") {
      props["checked"] = items.pop();
    }
    return [blk(kind, props, contentOf(joinText(items)), ch.length ? ch : [])];
  };
}

function cCode(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "CodeBlock");
  const language = args.length ? pyStr(args[0]) : "";
  const code = joinText(args.slice(1));
  return [blk("codeBlock", { language }, contentOf(code))];
}

function cDivider(_args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Divider");
  return [blk("divider")];
}

function cMath(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Math");
  return [blk("mathBlock", null, joinText(args))];
}

function cMedia(kind: string): ComponentFn {
  return (args: any[], children: AnyDict[] | null) => {
    requireNoChildren(children, kind);
    const url = args.length ? pyStr(args[0]) : "";
    const props: AnyDict = { url };
    if (kind === "file") {
      props["name"] = args.length > 1 ? pyStr(args[1]) : "";
    } else if (args.length > 1) {
      props["caption"] = pyStr(args[1]);
    }
    return [blk(kind, props)];
  };
}

function cSearchImage(via: string): ComponentFn {
  return (args: any[], children: AnyDict[] | null) => {
    requireNoChildren(children, via === "search" ? "SearchImage" : "WikiImage");
    const query = args.length ? pyStr(args[0]) : "";
    if (!query.trim()) {
      throw new NoteUIError("SearchImage/WikiImage need a non-empty query");
    }
    const props: AnyDict = { query, via };
    if (args.length > 1) props["caption"] = pyStr(args[1]);
    return [blk("image", props)];
  };
}

function cTable(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Table");
  const rows = args.length ? args[0] : [];
  if (!Array.isArray(rows)) {
    throw new NoteUIError("Table expects an array of rows, each an array of cells");
  }
  const outRows: AnyDict[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) {
      throw new NoteUIError("Each table row must be an array of cells");
    }
    // Re-parse plain strings through the inline parser for **bold** etc.
    const cells = row.map((cell: any) =>
      Array.isArray(cell) ? cell : contentOf(pyStr(cell))
    );
    outRows.push({ cells });
  }
  return [blk("table", null, { rows: outRows })];
}

function cColumns(args: any[], _children: AnyDict[] | null): AnyDict[] {
  const cols = args.length ? asBlocks(args[0], "Columns") : [];
  if (
    cols.length < 2 ||
    cols.length > 5 ||
    cols.some((c) => c["type"] !== "noteColumn")
  ) {
    throw new NoteUIError("Columns needs 2 to 5 Column(...) children");
  }
  return [blk("noteColumns", null, null, cols)];
}

function cColumn(args: any[], _children: AnyDict[] | null): AnyDict[] {
  const blocks = args.length ? asBlocks(args[0], "Column") : [];
  return [blk("noteColumn", null, null, blocks)];
}

function cLeaf(kind: string, propsFrom: (args: any[]) => AnyDict): ComponentFn {
  return (args: any[], children: AnyDict[] | null) => {
    requireNoChildren(children, kind);
    return [blk(kind, propsFrom(args))];
  };
}

function learningBlock(kind: string, data: any = null, markdown = ""): AnyDict {
  const props: AnyDict = { kind, prompt: "", markdown, data: "{}", sourceUrl: "" };
  if (isPlainObj(data)) {
    const body = dumpsPy(data);
    props["data"] = body;
    if (!markdown) props["markdown"] = body;
  } else if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (isPlainObj(parsed)) {
        props["data"] = dumpsPy(parsed, true);
        if (!markdown) props["markdown"] = data;
      }
    } catch {
      if (!markdown) props["markdown"] = data;
    }
  }
  return blk("learning", props);
}

function cLearning(kind: string): ComponentFn {
  return (args: any[], children: AnyDict[] | null) => {
    requireNoChildren(children, kind);
    const data = args.length ? args[0] : null;
    const markdown = args.length > 1 ? pyStr(args[1]) : "";
    return [learningBlock(kind, data, markdown)];
  };
}

function cMermaid(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Mermaid");
  const code = joinText(args);
  const fence = "```mermaid\n" + code + "\n```";
  return [learningBlock("mermaid", null, fence)];
}

function cClip(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Clip");
  const props: AnyDict = {
    title: args.length ? pyStr(args[0]) : "",
    markdown: args.length > 1 ? pyStr(args[1]) : "",
    sourceUrl: args.length > 2 ? pyStr(args[2]) : "",
    sourceId: "",
    favoriteType: "",
    summary: "",
    metadata: "{}",
    expanded: false,
  };
  return [blk("clip", props)];
}

function cBlock(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Block");
  const raw = args.length ? args[0] : null;
  if (!isPlainObj(raw) || typeof raw["type"] !== "string") {
    throw new NoteUIError("Block(...) expects an object with a 'type' field");
  }
  const block = ensureIds(JSON.parse(JSON.stringify(raw)));
  return [block];
}

function ensureIds(node: any): any {
  if (Array.isArray(node)) return node.map(ensureIds);
  if (isPlainObj(node)) {
    const out: AnyDict = {};
    for (const [k, v] of Object.entries(node)) out[k] = ensureIds(v);
    if (
      typeof out["type"] === "string" &&
      (!Object.prototype.hasOwnProperty.call(out, "id") || typeof out["id"] !== "string")
    ) {
      out["id"] = newId();
    }
    return out;
  }
  return node;
}

function cLearningAny(args: any[], children: AnyDict[] | null): AnyDict[] {
  requireNoChildren(children, "Learning");
  const kind = args.length ? pyStr(args[0]) : "";
  const data = args.length > 1 ? args[1] : null;
  const markdown = args.length > 2 ? pyStr(args[2]) : "";
  return [learningBlock(kind, data, markdown)];
}

const _COMPONENTS: Record<string, ComponentFn> = {
  Page: cPage,
  Heading: (a, c) => cHeading(a, c, false),
  ToggleHeading: (a, c) => cHeading(a, c, true),
  Text: cText,
  Paragraph: cText,
  Quote: cQuote,
  Callout: cCallout,
  Bullet: cItem("bulletListItem"),
  Numbered: cItem("numberedListItem"),
  CheckItem: cItem("checkListItem"),
  ToggleItem: cItem("toggleListItem"),
  CodeBlock: cCode,
  Divider: cDivider,
  Math: cMath,
  Image: cMedia("image"),
  SearchImage: cSearchImage("search"),
  WikiImage: cSearchImage("wiki"),
  Video: cMedia("video"),
  Audio: cMedia("audio"),
  File: cMedia("file"),
  Table: cTable,
  Columns: cColumns,
  Column: cColumn,
  TableOfContents: cLeaf("tableOfContents", () => ({})),
  WebCard: cLeaf("webCard", (a) => ({
    url: a.length ? pyStr(a[0]) : "",
    title: a.length > 1 ? pyStr(a[1]) : "",
    description: a.length > 2 ? pyStr(a[2]) : "",
  })),
  HtmlEmbed: cLeaf("htmlEmbed", (a) => ({ source: joinText(a) })),
  TaskView: cLeaf("taskView", (a) => ({ view: a.length ? pyStr(a[0]) : "table" })),
  Clip: cClip,
  Block: cBlock,
  Mermaid: cMermaid,
  Quiz: cLearning("quiz"),
  Flashcards: cLearning("flashcards"),
  Timeline: cLearning("timeline"),
  ConceptMap: cLearning("concept_map"),
  GeoGebra: cLearning("geogebra"),
  Research: cLearning("research"),
  Task: cLearning("task"),
  Learning: cLearningAny,
};

// ---------------------------------------------------------------------------
// @functions (compile-time, openui-style)
// ---------------------------------------------------------------------------

function pluck(rows: any, field: string): any[] {
  if (!Array.isArray(rows)) return [];
  if (!field) return rows;
  return rows.filter((r) => isPlainObj(r) && Object.prototype.hasOwnProperty.call(r, field)).map((r) => r[field]);
}

function numList(value: any, field = ""): number[] {
  const items = field ? pluck(value, field) : Array.isArray(value) ? value : [];
  const out: number[] = [];
  for (const item of items) {
    try {
      out.push(pyFloat(item));
    } catch {
      continue;
    }
  }
  return out;
}

function agg(name: string, values: any, field = ""): number {
  const nums = numList(values, field);
  if (!nums.length) return 0;
  const sum = nums.reduce((x, y) => x + y, 0);
  if (name === "sum") return sum;
  if (name === "avg") return sum / nums.length;
  if (name === "min") return Math.min(...nums);
  if (name === "max") return Math.max(...nums);
  return nums.length;
}

// --- dates (UTC-midnight Date stands in for datetime.date) -----------------

function dateUtc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

function parseDate(value: any): Date | null {
  if (value instanceof Date) {
    return dateUtc(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }
  const s = pyStr(value).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = dateUtc(y, mo, da);
  if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) return null;
  return d;
}

function todayDate(): Date {
  const n = new Date();
  return dateUtc(n.getFullYear(), n.getMonth() + 1, n.getDate());
}

function dateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS_FULL = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DAYS_SHORT = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

/** Minimal strftime for the tokens used by FormatDate. */
function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%(-?)([YmdHMBbaA])/g, (_m, minus: string, tok: string) => {
    switch (tok) {
      case "Y": return String(d.getUTCFullYear()).padStart(4, "0");
      case "m": return pad2(d.getUTCMonth() + 1);
      case "d": return minus ? String(d.getUTCDate()) : pad2(d.getUTCDate());
      case "H": return pad2(d.getUTCHours());
      case "M": return pad2(d.getUTCMinutes());
      case "B": return MONTHS_FULL[d.getUTCMonth()];
      case "b": return MONTHS_SHORT[d.getUTCMonth()];
      case "A": {
        const wd = (d.getUTCDay() + 6) % 7;
        return DAYS_FULL[wd];
      }
      case "a": {
        const wd = (d.getUTCDay() + 6) % 7;
        return DAYS_SHORT[wd];
      }
      default: return _m;
    }
  });
}

// --- number formatting ------------------------------------------------------

function fixedPlain(v: number, d: number): string {
  return v.toFixed(Math.min(d, 100));
}

/** f"{v:,.{d}f}" — thousands grouping, fixed decimals. */
function fixedGrouped(v: number, d: number): string {
  const s = fixedPlain(v, d);
  if (s.includes("e") || s.includes("E")) return s;
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf(".");
  const intPart = dot < 0 ? body : body.slice(0, dot);
  const fracPart = dot < 0 ? "" : body.slice(dot);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (neg ? "-" : "") + grouped + fracPart;
}

function pyG(v: number): string {
  if (v === 0) return "0";
  if (!Number.isFinite(v)) return String(v);
  const p = 6;
  const exp = Math.floor(Math.log10(Math.abs(v)));
  if (exp < -4 || exp >= p) {
    let s = v.toExponential(p - 1);
    s = s.replace(/(\.\d*?)0+e/, "$1e").replace(/\.e/, "e");
    s = s.replace(/e([+-])(\d)$/, "e$10$2");
    return s;
  }
  const d = Math.max(0, p - 1 - exp);
  let s = fixedPlain(v, d);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (s === "-0") s = "0";
  return s;
}

function fmtNumber(v: number, decimals: number | null): string {
  if (decimals === null) {
    let s = fixedGrouped(v, 2);
    s = s.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
    if (s === "-0" || s === "") s = "0";
    return s;
  }
  return fixedGrouped(v, decimals);
}

function fnFormat(args: any[]): any {
  const value = args.length ? args[0] : "";
  const kind = args.length > 1 ? pyStr(args[1]) : "number";
  const decimals = args.length > 2 ? args[2] : null;
  const currency = args.length > 3 ? pyStr(args[3]) : "USD";
  let n: number;
  try {
    n = pyFloat(value);
  } catch {
    return pyStr(value);
  }
  if (kind === "currency") {
    const sym: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };
    const s = Object.prototype.hasOwnProperty.call(sym, currency.toUpperCase())
      ? sym[currency.toUpperCase()]
      : currency + " ";
    const d = decimals === null ? 2 : pyInt(decimals);
    return s + fixedGrouped(n, d);
  }
  if (kind === "percent") {
    const d = decimals === null ? 0 : pyInt(decimals);
    return fixedPlain(n, d) + "%";
  }
  if (kind === "compact") {
    for (const [div, suf] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
      if (Math.abs(n) >= div) return fixedPlain(n / div, 1) + suf;
    }
    return pyG(n);
  }
  return fmtNumber(n, decimals === null ? null : pyInt(decimals));
}

function fnDuration(args: any[]): any {
  const seconds = Math.max(0, pyInt(pyFloat(args.length ? args[0] : 0)));
  const style = args.length > 1 ? pyStr(args[1]) : "short";
  const h = Math.floor(seconds / 3600);
  const rem = seconds % 3600;
  const m = Math.floor(rem / 60);
  const s = rem % 60;
  if (style === "clock") {
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
  }
  const parts: string[] = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(h ? `${pad2(m)}m` : `${m}m`);
  if (s || !parts.length) parts.push(h || m ? `${pad2(s)}s` : `${s}s`);
  return parts.join(" ");
}

function fnFormatDate(args: any[]): any {
  const value = args.length ? args[0] : "";
  const style = args.length > 1 ? pyStr(args[1]) : "date";
  const d = parseDate(value) ?? todayDate();
  const fmts: Record<string, string> = {
    date: "%b %-d, %Y",
    short: "%b %-d",
    long: "%A, %B %-d, %Y",
    weekday: "%A",
    month: "%B %Y",
    time: "%H:%M",
    datetime: "%b %-d, %Y %H:%M",
    iso: "%Y-%m-%d",
  };
  return strftime(Object.prototype.hasOwnProperty.call(fmts, style) ? fmts[style] : "%b %-d, %Y", d);
}

function addMonths(d: Date, months: number): Date {
  const month = d.getUTCMonth() + months; // 0-based
  const year = d.getUTCFullYear() + Math.floor(month / 12);
  const mo = ((month % 12) + 12) % 12 + 1; // 1-based
  const y = year;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  const day = Math.min(d.getUTCDate(), dim);
  return dateUtc(y, mo, day);
}

function monthsBetween(a: Date | null, b: Date | null): number {
  if (!a || !b) return 0;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return months;
}

function startOf(d: Date, unit: string): Date {
  if (unit === "week") {
    const wd = (d.getUTCDay() + 6) % 7; // Monday=0
    const out = new Date(d.getTime());
    out.setUTCDate(out.getUTCDate() - wd);
    return out;
  }
  if (unit === "year") return dateUtc(d.getUTCFullYear(), 1, 1);
  return dateUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function fnGroupBy(args: any[]): any {
  const rows = args[0];
  const key = args.length > 1 ? pyStr(args[1]) : "";
  const field = args.length > 2 ? pyStr(args[2]) : "";
  const ag = args.length > 3 ? pyStr(args[3]) : "sum";
  const groups = new Map<any, any[]>();
  const order: any[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObj(row)) continue;
    const k = row[key];
    if (!groups.has(k)) {
      groups.set(k, []);
      order.push(k);
    }
    groups.get(k)!.push(row);
  }
  const out: any[] = [];
  for (const k of order) {
    const members = groups.get(k)!;
    const value = field ? agg(ag, members, field) : ag === "count" ? members.length : agg(ag, members, "");
    out.push({ key: k, value });
  }
  return out;
}

function cmpKeys(x: any, y: any): number {
  const xn = pyNumOrNull(x);
  const yn = pyNumOrNull(y);
  if (xn !== null && yn !== null) return xn < yn ? -1 : xn > yn ? 1 : 0;
  if (typeof x === "string" && typeof y === "string") return x < y ? -1 : x > y ? 1 : 0;
  throw new TypeError("unorderable types");
}

function fnFilter(args: any[]): any {
  const rows = args[0];
  const field = args.length > 1 ? pyStr(args[1]) : "";
  const op = args.length > 2 ? pyStr(args[2]) : "==";
  const want = args.length > 3 ? args[3] : null;
  if (!Array.isArray(rows)) return [];
  const out: any[] = [];
  for (const row of rows) {
    if (!isPlainObj(row)) continue;
    const val = pyGet(row, field, null);
    const isNum = pyNumOrNull(val) !== null;
    const okMap: Record<string, boolean> = {
      "==": pyEq(val, want),
      "!=": !pyEq(val, want),
      ">": isNum ? pyCompare(">", val, want) : false,
      "<": isNum ? pyCompare("<", val, want) : false,
      ">=": isNum ? pyCompare(">=", val, want) : false,
      "<=": isNum ? pyCompare("<=", val, want) : false,
      "contains": (() => {
        if (typeof val === "string") {
          if (typeof want !== "string")
            throw new TypeError("'in <string>' requires string as left operand");
          return val.includes(want);
        }
        if (Array.isArray(val)) return val.some((x) => pyEq(x, want));
        return false;
      })(),
    };
    const ok = Object.prototype.hasOwnProperty.call(okMap, op) ? okMap[op] : false;
    if (ok) out.push(row);
  }
  return out;
}

function fnBucket(args: any[]): any {
  const rows = args.length ? args[0] : [];
  const dateField = args.length > 1 ? pyStr(args[1]) : "";
  const unit = args.length > 2 ? pyStr(args[2]) : "day";
  const field = args.length > 3 ? pyStr(args[3]) : "";
  const ag = args.length > 4 ? pyStr(args[4]) : "sum";
  const buckets = new Map<string, any[]>();
  const order: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isPlainObj(row)) continue;
    const d = parseDate(pyGet(row, dateField, null));
    if (!d) continue;
    let key: string;
    if (unit === "week") {
      key = dateIso(startOf(d, "week"));
    } else if (unit === "month") {
      key = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
    } else {
      key = dateIso(d);
    }
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(row);
  }
  return [...order]
    .sort()
    .map((k) => ({
      key: k,
      value: field ? agg(ag, buckets.get(k)!, field) : buckets.get(k)!.length,
    }));
}

function fnCumulative(args: any[]): any {
  const rows = args.length ? args[0] : [];
  const field = args.length > 1 ? pyStr(args[1]) : "";
  if (Array.isArray(rows) && rows.length && !isPlainObj(rows[0])) {
    let total = 0;
    const out: number[] = [];
    for (const v of rows) {
      try {
        total += pyFloat(v);
      } catch {
        // pass
      }
      out.push(total);
    }
    return out;
  }
  let total = 0;
  const out: any[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isPlainObj(row)) {
      const copy = { ...row };
      try {
        const raw = pyGet(row, field, 0);
        total += pyFloat(pyTruthy(raw) ? raw : 0);
      } catch {
        // pass
      }
      copy[field] = total;
      out.push(copy);
    }
  }
  return out;
}

function fnMovingAvg(args: any[]): any {
  const rows = args.length ? args[0] : [];
  const field = args.length > 1 ? pyStr(args[1]) : "";
  const window = args.length > 2 ? Math.max(1, pyInt(args[2])) : 3;
  const values = numList(rows, field);
  const avgs: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const windowVals = values.slice(Math.max(0, i - window + 1), i + 1);
    avgs.push(windowVals.reduce((x, y) => x + y, 0) / windowVals.length);
  }
  if (Array.isArray(rows) && rows.length && isPlainObj(rows[0])) {
    const out: any[] = [];
    const n = Math.min(rows.length, avgs.length);
    for (let i = 0; i < n; i++) {
      const row = { ...rows[i] };
      row[field] = avgs[i];
      out.push(row);
    }
    return out;
  }
  return avgs;
}

function fnStats(args: any[]): any {
  const nums = numList(args.length ? args[0] : []);
  if (!nums.length) return { count: 0, min: 0, max: 0, avg: 0, sum: 0 };
  const sum = nums.reduce((x, y) => x + y, 0);
  return {
    count: nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
    avg: sum / nums.length,
    sum,
  };
}

function pyRound(v: number, n = 0): number {
  const f = 10 ** n;
  const x = v * f;
  const fl = Math.floor(x);
  const diff = x - fl;
  let r: number;
  if (diff > 0.5) r = fl + 1;
  else if (diff < 0.5) r = fl;
  else r = fl % 2 === 0 ? fl : fl + 1;
  return r / f;
}

/** Args array that raises IndexError-like RangeError on out-of-bounds access. */
function guardArgs(args: any[]): any[] {
  return new Proxy(args, {
    get(t, p, r) {
      if (typeof p === "string" && /^-?\d+$/.test(p)) {
        const idx0 = Number(p);
        const idx = idx0 < 0 ? t.length + idx0 : idx0;
        if (idx < 0 || idx >= t.length) throw new RangeError("list index out of range");
        return t[idx];
      }
      return Reflect.get(t, p, r);
    },
  });
}

const _FUNCTIONS: Record<string, (a: any[]) => any> = {
  // Lists
  Count: (a) => a.length,
  First: (a) => (Array.isArray(a[0]) && a[0].length ? a[0][0] : null),
  Last: (a) => (Array.isArray(a[0]) && a[0].length ? a[0][a[0].length - 1] : null),
  Sum: (a) => agg("sum", a[0], a.length > 1 ? pyStr(a[1]) : ""),
  Avg: (a) => agg("avg", a[0], a.length > 1 ? pyStr(a[1]) : ""),
  Min: (a) => agg("min", a[0], a.length > 1 ? pyStr(a[1]) : ""),
  Max: (a) => agg("max", a[0], a.length > 1 ? pyStr(a[1]) : ""),
  Includes: (a) => {
    if (!(a.length > 1 && (Array.isArray(a[0]) || typeof a[0] === "string"))) return false;
    if (Array.isArray(a[0])) return a[0].some((x) => pyEq(x, a[1]));
    if (typeof a[1] !== "string") throw new TypeError("'in <string>' requires string as left operand");
    return a[0].includes(a[1]);
  },
  Find: (a) => {
    if (!(a.length > 2 && Array.isArray(a[0]))) return null;
    const field = pyStr(a[1]);
    return a[0].find((r: any) => isPlainObj(r) && pyEq(pyGet(r, field, null), a[2])) ?? null;
  },
  IndexOf: (a) => {
    if (!Array.isArray(a[0])) return -1;
    const needle = a[1];
    return a[0].findIndex((x) => pyEq(x, needle));
  },
  Take: (a) => {
    if (!(Array.isArray(a[0]) && a.length > 1)) return [];
    const n = pyInt(a[1]);
    return n >= 0 ? a[0].slice(0, n) : a[0].slice(n);
  },
  Slice: (a) => {
    if (!(Array.isArray(a[0]) && a.length > 1)) return [];
    const i = pyInt(a[1]);
    const j = a.length > 2 ? pyInt(a[2]) : undefined;
    return a[0].slice(i, j);
  },
  Unique: (a) => {
    if (!Array.isArray(a[0])) return [];
    if (a[0].some((x) => Array.isArray(x) || isPlainObj(x))) {
      throw new TypeError("unhashable type: 'list' or 'dict'");
    }
    const out: any[] = [];
    for (const x of a[0]) if (!out.some((y) => pyEq(y, x))) out.push(x);
    return out;
  },
  Reverse: (a) => (Array.isArray(a[0]) ? [...a[0]].reverse() : []),
  Range: (a) => {
    const start = pyInt(a[0]);
    const stop = pyInt(a[1]);
    const step = a.length > 2 && pyTruthy(a[2]) ? pyInt(a[2]) : 1;
    if (step === 0) throw new RangeError("range() arg 3 must not be zero");
    const out: number[] = [];
    if (step > 0) for (let i = start; i < stop; i += step) out.push(i);
    else for (let i = start; i > stop; i += step) out.push(i);
    return out;
  },
  Flatten: (a) =>
    Array.isArray(a[0])
      ? a[0].flatMap((sub) => (Array.isArray(sub) ? sub : [sub]))
      : [],
  Concat: (a) =>
    Array.isArray(a[0]) && Array.isArray(a[1]) ? [...a[0], ...a[1]] : [],
  Append: (a) => (Array.isArray(a[0]) ? [...a[0], a[1]] : [a[1]]),
  Prepend: (a) => (Array.isArray(a[0]) ? [a[1], ...a[0]] : [a[1]]),
  RemoveAt: (a) => {
    if (!(Array.isArray(a[0]) && a.length > 1)) return [];
    const i = pyInt(a[1]);
    return [...a[0].slice(0, i), ...a[0].slice(i + 1)];
  },
  Chunk: (a) => {
    if (!(Array.isArray(a[0]) && a.length > 1)) return [];
    const size = Math.max(1, pyInt(a[1]));
    const out: any[] = [];
    for (let i = 0; i < a[0].length; i += size) out.push(a[0].slice(i, i + size));
    return out;
  },
  Pick: (a) =>
    Array.isArray(a[0]) && a[0].length
      ? a[0][Math.floor(Math.random() * a[0].length)]
      : null,
  Shuffle: (a) => {
    if (!Array.isArray(a[0])) return [];
    const arr = [...a[0]];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  },
  // Numbers
  Pow: (a) => (a.length > 1 ? Math.pow(pyNumReq(a[0]), pyNumReq(a[1])) : 0),
  Sqrt: (a) => {
    if (!a.length) return null;
    const v = pyNumReq(a[0]);
    return v >= 0 ? Math.pow(v, 0.5) : null;
  },
  Random: (a) => {
    if (a.length > 2 && pyTruthy(a[2])) {
      const lo = pyInt(a[0]);
      const hi = pyInt(a[1]);
      return Math.floor(Math.random() * (hi - lo + 1)) + lo;
    }
    const lo = pyNumReq(a.length ? a[0] : 0);
    const hi = pyNumReq(a.length > 1 ? a[1] : 1);
    return lo + (hi - lo) * Math.random();
  },
  Clamp: (a) => {
    if (a.length > 2) return Math.min(Math.max(pyNumReq(a[0]), pyNumReq(a[1])), pyNumReq(a[2]));
    return a.length ? a[0] : 0;
  },
  Percent: (a) =>
    a.length > 1 && pyTruthy(a[1]) ? (pyNumReq(a[0]) / pyNumReq(a[1])) * 100 : 0,
  Lerp: (a) => {
    if (a.length > 2) return pyNumReq(a[0]) + (pyNumReq(a[1]) - pyNumReq(a[0])) * pyNumReq(a[2]);
    return a.length ? a[0] : 0;
  },
  Round: (a) => pyRound(pyNumReq(a[0]), a.length > 1 ? pyInt(a[1]) : 0),
  Abs: (a) => (a.length ? Math.abs(pyNumReq(a[0])) : 0),
  Floor: (a) => (a.length ? Math.floor(pyNumReq(a[0])) : 0),
  Ceil: (a) => (a.length ? Math.ceil(pyNumReq(a[0])) : 0),
  // Text
  Format: fnFormat,
  Join: (a) => {
    let items: any[];
    if (a.length > 1 && pyTruthy(a[1])) {
      items = pluck(a[0], pyStr(a[1]));
    } else {
      items = Array.isArray(a[0]) ? a[0] : [a[0]];
    }
    const sep = a.length > 2 ? pyStr(a[2]) : ", ";
    return items
      .filter((x) => x !== null && x !== undefined)
      .map((x) => pyStr(x))
      .join(sep);
  },
  Plural: (a) => {
    const n = pyNumReq(a[0]);
    const word = pyStr(a[1]);
    const plural = a.length > 2 && pyTruthy(a[2]) ? pyStr(a[2]) : word + "s";
    return `${pyStr(a[0])} ${Math.abs(n) === 1 ? word : plural}`;
  },
  Pad: (a) => pyStr(a[0]).padStart(pyInt(a[1]), a.length > 2 ? pyStr(a[2]) : "0"),
  Upper: (a) => pyStr(a[0]).toUpperCase(),
  Lower: (a) => pyStr(a[0]).toLowerCase(),
  Trim: (a) => pyStr(a[0]).trim(),
  Capitalize: (a) =>
    pyStr(a[0])
      .toLowerCase()
      .replace(/(^|[^\p{L}])(\p{L})/gu, (_m, p1: string, p2: string) => p1 + p2.toUpperCase()),
  Split: (a) => {
    const sep = a.length > 1 ? pyStr(a[1]) : ",";
    if (sep === "") throw new Error("empty separator");
    return pyStr(a[0])
      .split(sep)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
  },
  Replace: (a) => pyStr(a[0]).split(pyStr(a[1])).join(a.length > 2 ? pyStr(a[2]) : ""),
  Duration: fnDuration,
  Default: (a) => {
    if (!a.length) return null;
    const v = a[0];
    const empty = v === null || v === undefined || v === "" || (typeof v === "number" && Number.isNaN(v));
    if (empty) {
      if (a.length < 2) throw new RangeError("list index out of range");
      return a[1];
    }
    return v;
  },
  // Dates
  Now: () => {
    const d = new Date();
    return (
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    );
  },
  Today: () => dateIso(todayDate()),
  FormatDate: fnFormatDate,
  AddDays: (a) => {
    if (a.length <= 1) return "";
    const d = new Date((parseDate(a[0]) ?? todayDate()).getTime());
    d.setUTCDate(d.getUTCDate() + pyInt(a[1]));
    return dateIso(d);
  },
  AddMonths: (a) => {
    if (a.length <= 1) return "";
    return dateIso(addMonths(parseDate(a[0]) ?? todayDate(), pyInt(a[1])));
  },
  DaysBetween: (a) => {
    if (a.length <= 1) return 0;
    const f = parseDate(a[0]);
    const b = parseDate(a[1]);
    if (!b || !f) return 0;
    return Math.round((b.getTime() - f.getTime()) / 86400000);
  },
  MonthsBetween: (a) => (a.length > 1 ? monthsBetween(parseDate(a[0]), parseDate(a[1])) : 0),
  StartOf: (a) => dateIso(startOf(parseDate(a[0]) ?? todayDate(), a.length > 1 ? pyStr(a[1]) : "month")),
  // Rows / data
  GroupBy: fnGroupBy,
  Top: (a) => {
    if (!(a.length > 2 && Array.isArray(a[0]))) return [];
    const field = pyStr(a[1]);
    const desc = !(a.length > 3 && a[3] === "asc");
    const rows = a[0].filter(isPlainObj).map((r: any, i: number) => ({ r, k: pyGet(r, field, 0), i }));
    rows.sort((x, y) => {
      const c = cmpKeys(x.k, y.k);
      return desc ? -c : c;
    });
    return rows.slice(0, pyInt(a[2])).map((x) => x.r);
  },
  Filter: fnFilter,
  Between: (a) => {
    if (!(a.length > 3 && Array.isArray(a[0]))) return [];
    const field = a.length > 1 ? pyStr(a[1]) : "";
    return a[0].filter(
      (r: any) =>
        isPlainObj(r) &&
        (a[2] === null || a[2] === undefined || pyCompare(">=", pyGet(r, field, 0), a[2])) &&
        (a[3] === null || a[3] === undefined || pyCompare("<=", pyGet(r, field, 0), a[3]))
    );
  },
  Bucket: fnBucket,
  Cumulative: fnCumulative,
  MovingAvg: fnMovingAvg,
  Change: (a) =>
    a.length > 1 && pyTruthy(a[1])
      ? ((pyNumReq(a[0]) - pyNumReq(a[1])) / pyNumReq(a[1])) * 100
      : null,
  Stats: fnStats,
};

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function evalNode(node: Node, env: Map<string, any>): any {
  const kind = node[0];
  if (kind === "lit") return node[1];
  if (kind === "var") {
    const name = node[1];
    if (!env.has(name)) throw new NoteUIError(`Undefined variable $${name}`);
    return env.get(name);
  }
  if (kind === "arr") {
    const items = node[1].map((item: Node) => evalNode(item, env));
    // An array of component results is a children list, not data.
    if (items.length && items.every(isBlocks)) {
      const flat: AnyDict[] = [];
      for (const item of items) flat.push(...item);
      return flat;
    }
    return items;
  }
  if (kind === "obj") {
    const out: AnyDict = {};
    for (const [key, val] of node[1] as [string, Node][]) out[key] = evalNode(val, env);
    return out;
  }
  if (kind === "fn") {
    const name = node[1];
    const argNodes = node[2] as Node[];
    if (name === "Each") {
      if (
        argNodes.length !== 3 ||
        argNodes[1][0] !== "lit" ||
        typeof argNodes[1][1] !== "string"
      ) {
        throw new NoteUIError('@Each(list, "var", template) needs a list, a variable name and a template');
      }
      const source = evalNode(argNodes[0], env);
      const varName = argNodes[1][1];
      if (!Array.isArray(source)) return [];
      const results: any[] = [];
      for (const item of source) {
        const scoped = new Map(env);
        scoped.set(varName, item);
        results.push(evalNode(argNodes[2], scoped));
      }
      if (results.length && results.every(isBlocks)) {
        const flat: AnyDict[] = [];
        for (const r of results) flat.push(...r);
        return flat;
      }
      return results;
    }
    const fn = _FUNCTIONS[name];
    if (fn === undefined) throw new NoteUIError(`Unknown function @${name}`);
    const args = argNodes.map((a) => evalNode(a, env));
    try {
      return fn(guardArgs(args));
    } catch (e) {
      if (e instanceof NoteUIError) throw e;
      throw new NoteUIError(`@${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (kind === "call") {
    const name = node[1];
    const argNodes = node[2] as Node[];
    const builder = _COMPONENTS[name];
    if (builder === undefined) throw new NoteUIError(`Unknown component ${name}()`);
    const args = argNodes.map((a) => evalNode(a, env));
    // Builders split a trailing children array off the evaluated args.
    return builder(guardArgs(args), null);
  }
  if (kind === "bin") {
    const op = node[1];
    if (op === "&&") return pyTruthy(evalNode(node[2], env)) && pyTruthy(evalNode(node[3], env));
    if (op === "||") return pyTruthy(evalNode(node[2], env)) || pyTruthy(evalNode(node[3], env));
    const left = evalNode(node[2], env);
    const right = evalNode(node[3], env);
    if (op === "+") {
      if (typeof left === "string" || typeof right === "string") {
        return dslStr(left) + dslStr(right);
      }
      return pyAdd(left, right);
    }
    if (op === "-") return pyNumReq(left) - pyNumReq(right);
    if (op === "*") return pyMul(left, right);
    if (op === "/") return pyTruthy(right) ? pyNumReq(left) / pyNumReq(right) : null;
    if (op === "%") return pyTruthy(right) ? pyMod(pyNumReq(left), pyNumReq(right)) : null;
    if (op === "==") return pyEq(left, right);
    if (op === "!=") return !pyEq(left, right);
    if (op === "<") return pyCompare("<", left, right);
    if (op === ">") return pyCompare(">", left, right);
    if (op === "<=") return pyCompare("<=", left, right);
    if (op === ">=") return pyCompare(">=", left, right);
  }
  if (kind === "un") {
    const value = evalNode(node[2], env);
    return node[1] === "!" ? !pyTruthy(value) : -pyNumReq(value);
  }
  if (kind === "tern") {
    return pyTruthy(evalNode(node[1], env)) ? evalNode(node[2], env) : evalNode(node[3], env);
  }
  if (kind === "member") {
    const obj = evalNode(node[1], env);
    const field = node[2];
    if (isPlainObj(obj)) return pyGet(obj, field, null);
    if (Array.isArray(obj)) {
      return obj.filter(isPlainObj).map((r) => pyGet(r, field, null));
    }
    return null;
  }
  if (kind === "index") {
    const obj = evalNode(node[1], env);
    const idx = evalNode(node[2], env);
    try {
      const i = pyInt(idx);
      if (Array.isArray(obj)) {
        const j = i < 0 ? obj.length + i : i;
        return j < 0 || j >= obj.length ? null : obj[j];
      }
      if (typeof obj === "string") {
        const j = i < 0 ? obj.length + i : i;
        return j < 0 || j >= obj.length ? null : obj[j];
      }
      // dict[int(key)] -> KeyError -> None (DSL object keys are always strings)
      return null;
    } catch {
      return null;
    }
  }
  throw new NoteUIError(`Cannot evaluate ${kind}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

/** json.dumps(v, ensure_ascii=False) — ", " / ": " separators unless compact. */
export function dumpsPy(v: any, compact = false): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (Number.isNaN(v)) return "NaN";
    if (v === Infinity) return "Infinity";
    if (v === -Infinity) return "-Infinity";
    return String(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map((x) => dumpsPy(x, compact)).join(compact ? "," : ", ") + "]";
  }
  if (typeof v === "object") {
    return (
      "{" +
      Object.entries(v)
        .map(([k, x]) => JSON.stringify(k) + (compact ? ":" : ": ") + dumpsPy(x, compact))
        .join(compact ? "," : ", ") +
      "}"
    );
  }
  return JSON.stringify(String(v));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Compile a ```noteui fence body into validated BlockNote blocks. */
export function compile_noteui(source: string): AnyDict[] {
  if (!source.trim()) return [];
  const program = new Parser(tokenize(source)).parse_program();
  const env = new Map<string, any>();
  const emitted: AnyDict[] = [];
  for (const stmt of program) {
    if (stmt[0] === "bind") {
      env.set(stmt[1], evalNode(stmt[2], env));
    } else {
      const value = evalNode(stmt[1], env);
      if (isBlocks(value)) {
        emitted.push(...value);
      } else if (Array.isArray(value) && value.length && isBlocks(value[0])) {
        emitted.push(...asBlocks(value));
      } else {
        throw new NoteUIError(
          "Top-level expressions must produce components, e.g. Page([...]) or Text(...)"
        );
      }
    }
  }
  if (env.has("root")) {
    const root = env.get("root");
    if (!isBlocks(root)) {
      throw new NoteUIError("root must be a component or list of components");
    }
    return asBlocks(root);
  }
  return emitted;
}

// ---------------------------------------------------------------------------
// Serialization: blocks -> DSL (round-trip through ```noteui fences)
// ---------------------------------------------------------------------------

function dslStrVal(text: any): string {
  return JSON.stringify(pyStr(text));
}

function dslValue(value: any): string {
  return dumpsPy(value);
}

function dslChildren(children: AnyDict[]): string {
  return "[" + children.map((c) => block_to_dsl(c)).join(", ") + "]";
}

function optChildren(children: AnyDict[], prefix: string): string {
  return prefix + (children.length ? ", " + dslChildren(children) : "") + ")";
}

/** One block as a DSL expression, or raise NoteUIError if unsupported. */
export function block_to_dsl(block: AnyDict): string {
  const kind = block["type"];
  const props = pyGet(block, "props", {}) || {};
  const content = pyGet(block, "content", undefined);
  const chRaw = pyGet(block, "children", []);
  const children: AnyDict[] = pyTruthy(chRaw) ? chRaw : [];

  const text = (): string => inline_markdown(content);

  if (kind === "heading") {
    return optChildren(children, `Heading(${pyInt(pyGet(props, "level", 1))}, ${dslStrVal(text())}`);
  }
  if (kind === "toggleHeading") {
    return optChildren(children, `ToggleHeading(${pyInt(pyGet(props, "level", 2))}, ${dslStrVal(text())}`);
  }
  if (kind === "paragraph") return `Text(${dslStrVal(text())})`;
  if (kind === "bulletListItem") return optChildren(children, `Bullet(${dslStrVal(text())}`);
  if (kind === "numberedListItem") return optChildren(children, `Numbered(${dslStrVal(text())}`);
  if (kind === "checkListItem") {
    const checked = pyGet(props, "checked", false) ? ", true" : "";
    return optChildren(children, `CheckItem(${dslStrVal(text())}${checked}`);
  }
  if (kind === "toggleListItem") return optChildren(children, `ToggleItem(${dslStrVal(text())}`);
  if (kind === "quote") return optChildren(children, `Quote(${dslStrVal(text())}`);
  if (kind === "callout") {
    const tone = pyStr(pyGet(props, "tone", null) || "tip");
    return optChildren(children, `Callout(${dslStrVal(tone)}, ${dslStrVal(text())}`);
  }
  if (kind === "codeBlock") {
    return `CodeBlock(${dslStrVal(pyGet(props, "language", ""))}, ${dslStrVal(text())})`;
  }
  if (kind === "divider") return "Divider()";
  if (kind === "mathBlock" || kind === "math") {
    const formula = pyGet(props, "formula", null) || text();
    return `Math(${dslStrVal(formula)})`;
  }
  if (kind === "image") {
    if (pyGet(props, "query", null)) {
      const name = pyGet(props, "via", null) === "wiki" ? "WikiImage" : "SearchImage";
      return `${name}(${dslStrVal(props["query"])}, ${dslStrVal(pyGet(props, "caption", ""))})`;
    }
    return `Image(${dslStrVal(pyGet(props, "url", ""))}, ${dslStrVal(pyGet(props, "caption", ""))})`;
  }
  if (kind === "video") {
    return `Video(${dslStrVal(pyGet(props, "url", ""))}, ${dslStrVal(pyGet(props, "caption", ""))})`;
  }
  if (kind === "audio") {
    return `Audio(${dslStrVal(pyGet(props, "url", ""))}, ${dslStrVal(pyGet(props, "caption", ""))})`;
  }
  if (kind === "file") {
    return `File(${dslStrVal(pyGet(props, "url", ""))}, ${dslStrVal(pyGet(props, "name", ""))})`;
  }
  if (kind === "table") {
    const rows = isPlainObj(content) ? pyGet(content, "rows", []) || [] : [];
    const body: string[] = [];
    for (const row of rows) {
      const cells: string[] = [];
      for (const cell of pyGet(row, "cells", []) || []) {
        cells.push(dslStrVal(inline_markdown(isPlainObj(cell) ? pyGet(cell, "content", undefined) : cell)));
      }
      body.push("[" + cells.join(", ") + "]");
    }
    return "Table([" + body.join(", ") + "])";
  }
  if (kind === "noteColumns") return "Columns(" + dslChildren(children) + ")";
  if (kind === "noteColumn") return "Column(" + dslChildren(children) + ")";
  if (kind === "tableOfContents") return "TableOfContents()";
  if (kind === "webCard") {
    return (
      `WebCard(${dslStrVal(pyGet(props, "url", ""))}, ${dslStrVal(pyGet(props, "title", ""))}, ` +
      `${dslStrVal(pyGet(props, "description", ""))})`
    );
  }
  if (kind === "htmlEmbed") return `HtmlEmbed(${dslStrVal(pyGet(props, "source", ""))})`;
  if (kind === "taskView") return `TaskView(${dslStrVal(pyGet(props, "view", "table"))})`;
  if (kind === "clip") {
    return (
      `Clip(${dslStrVal(pyGet(props, "title", ""))}, ${dslStrVal(pyGet(props, "markdown", ""))}, ` +
      `${dslStrVal(pyGet(props, "sourceUrl", ""))})`
    );
  }
  if (kind === "learning") {
    let data: any = {};
    try {
      data = JSON.parse(pyGet(props, "data", "{}") ?? "{}");
    } catch {
      data = {};
    }
    const markdown = pyStr(pyGet(props, "markdown", null) || "");
    const named: Record<string, string> = {
      quiz: "Quiz", flashcards: "Flashcards", timeline: "Timeline",
      concept_map: "ConceptMap", geogebra: "GeoGebra", research: "Research",
      task: "Task",
    };
    const lkind = pyStr(pyGet(props, "kind", null) || "");
    if (Object.prototype.hasOwnProperty.call(named, lkind) && isPlainObj(data) && Object.keys(data).length) {
      return `${named[lkind]}(${dslValue(data)})`;
    }
    if (lkind === "mermaid" && markdown) {
      const code = markdown.trim().replace(/^```mermaid\s*/, "").replace(/\s*```$/, "");
      return `Mermaid(${dslStrVal(code.trim())})`;
    }
    return `Learning(${dslStrVal(lkind)}, ${isPlainObj(data) ? dslValue(data) : "{}"}, ${dslStrVal(markdown)})`;
  }
  // Escape hatch: any other valid block serializes as raw BlockNote JSON.
  const raw: AnyDict = {};
  for (const [k, v] of Object.entries(block)) if (k !== "id") raw[k] = v;
  return `Block(${dslValue(raw)})`;
}

/** Serialize blocks to a ```noteui program (Page([...])). */
export function blocks_to_dsl(blocks: AnyDict[]): string {
  return "Page([\n  " + blocks.map((b) => block_to_dsl(b)).join(",\n  ") + "\n])";
}
