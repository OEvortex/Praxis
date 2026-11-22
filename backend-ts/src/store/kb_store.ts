// knowledge-base store: uploaded
// documents + a chunk index in SQLite.
//
// Layout in the shared database (`data/praxis.sqlite3`):
//
//     kb_meta    (name, payload)            {name, created_at, last_updated}
//     kb_docs    (kb, name, data, size)     original uploads (txt/md/pdf/docx)
//     kb_chunks  (kb, chunk_id, doc, text)  parsed text, one row per chunk
//
// Retrieval is dependency-free BM25-style keyword scoring — good enough for
// tutor citations without an embedding service. Legacy `data/kbs/<name>/`
// directories are imported once by `app.store.database`.
import { inflateRawSync } from "node:zlib";
import type { Settings } from "../config.js";
import { docxToMarkdown } from "../services/documents/docx.js";
import * as database from "./database.js";

const _CHUNK_SIZE = 1200;
const _CHUNK_OVERLAP = 150;

function _tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-zA-Z0-9]+/g) ?? [];
}

function _extract_text(name: string, data: Uint8Array): string {
  const suffix = name.includes(".")
    ? name.split(".").pop()!.toLowerCase()
    : "";
  if (suffix === "pdf") {
    try {
      return _extract_pdf_text(data);
    } catch {
      return "";
    }
  }
  if (suffix === "docx") {
    try {
      // Reuses the dependency-free OOXML reader in
      // services/documents/docx.ts (returns markdown-flavoured text, which
      // is fine for chunking/tokenization).
      return docxToMarkdown(data, name);
    } catch {
      return "";
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(data);
}

// ===========================================================================
// Minimal synchronous PDF text extraction
// ===========================================================================
// pdf-parse/pdfjs are Promise-based and the KB indexing path is synchronous,
// so this is a deliberately small best-effort extractor: it inflates stream
// objects, reads ToUnicode CMaps when present, and pulls strings out of the
// text-showing operators (Tj, TJ, ', "). Strings in fonts without a usable
// CMap fall back to a WinAnsi-ish decode. Object streams, actual glyph
// positioning and font-specific encodings are only approximated — good
// enough for keyword-search chunks.

const _PDF_MAX_STREAMS = 512;
const _PDF_MAX_STREAM_BYTES = 32 * 1024 * 1024;
const _PDF_MAX_TEXT_CHARS = 2_000_000;
const _PDF_MAX_FILE_BYTES = 64 * 1024 * 1024;

const _PDF_WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

const _PDF_FILTER_RE =
  /\/(FlateDecode|ASCII85Decode|ASCIIHexDecode|RunLengthDecode|LZWDecode|Crypt|DCTDecode|JPXDecode|JBIG2Decode|CCITTFaxDecode|Fl|A85|AHx)\b/g;

// WinAnsi characters that differ from Latin-1 in the 0x80-0x9F range.
const _PDF_WINANSI: Record<number, string> = {
  0x80: "\u20ac",
  0x82: "\u201a",
  0x83: "\u0192",
  0x84: "\u201e",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02c6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017d",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02dc",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203a",
  0x9c: "\u0153",
  0x9e: "\u017e",
  0x9f: "\u0178",
};

/** Uint8Array -> "binary" string where charCode == byte value (1:1). */
function _pdf_bin(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function _pdf_is_delim(c: number): boolean {
  return (
    _PDF_WS.has(c) ||
    c === 0x28 || // (
    c === 0x29 || // )
    c === 0x3c || // <
    c === 0x3e || // >
    c === 0x5b || // [
    c === 0x5d || // ]
    c === 0x7b || // {
    c === 0x7d || // }
    c === 0x2f || // /
    c === 0x25 // %
  );
}

function _pdf_skip_ws(s: string, i: number): number {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 0x25) {
      // % comment -> end of line
      while (i < n && s.charCodeAt(i) !== 0x0a && s.charCodeAt(i) !== 0x0d) i++;
      continue;
    }
    if (_PDF_WS.has(c)) {
      i++;
      continue;
    }
    break;
  }
  return i;
}

// --- stream objects ---------------------------------------------------------

interface _PdfStream {
  dict: string;
  raw: Uint8Array;
}

function _pdf_find_streams(src: string, data: Uint8Array): _PdfStream[] {
  const out: _PdfStream[] = [];
  const kw = /stream(?:\r\n|\r|\n)/g;
  let m: RegExpExecArray | null;
  while ((m = kw.exec(src)) !== null && out.length < _PDF_MAX_STREAMS) {
    const start = m.index;
    // Skip the "stream" inside "endstream".
    if (src.slice(Math.max(0, start - 3), start) === "end") continue;
    const contentStart = start + m[0].length;
    const e = src.indexOf("endstream", contentStart);
    if (e < 0) break;
    // EOL before "endstream" is not part of the stream data.
    let rawEnd = e;
    if (rawEnd > contentStart && src[rawEnd - 1] === "\n") rawEnd--;
    if (rawEnd > contentStart && src[rawEnd - 1] === "\r") rawEnd--;
    // The stream dict is the nearest "<< ... >>" before the keyword.
    const dictStart = src.lastIndexOf("<<", start);
    const dict =
      dictStart >= 0 && start - dictStart < 4000
        ? src.slice(dictStart, start)
        : src.slice(Math.max(0, start - 400), start);
    out.push({
      dict,
      raw: data.subarray(contentStart, Math.max(contentStart, rawEnd)),
    });
    kw.lastIndex = e + 9;
  }
  return out;
}

function _pdf_asciihex(raw: Uint8Array): Uint8Array | null {
  const s = _pdf_bin(raw);
  let hex = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ">") break;
    if (!_PDF_WS.has(s.charCodeAt(i))) hex += c;
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) return null;
  if (hex.length % 2) hex += "0";
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function _pdf_ascii85(raw: Uint8Array): Uint8Array | null {
  const s = _pdf_bin(raw);
  const end = s.indexOf("~>");
  const body = end >= 0 ? s.slice(0, end) : s;
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    if (code <= 0x20) continue; // whitespace
    if (code === 0x7a && count === 0) {
      // 'z' -> four zero bytes
      out.push(0, 0, 0, 0);
      continue;
    }
    if (code < 0x21 || code > 0x75) return null;
    tuple = tuple * 85 + (code - 0x21);
    count++;
    if (count === 5) {
      out.push(
        (tuple >>> 24) & 0xff,
        (tuple >>> 16) & 0xff,
        (tuple >>> 8) & 0xff,
        tuple & 0xff
      );
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const b = [
      (tuple >>> 24) & 0xff,
      (tuple >>> 16) & 0xff,
      (tuple >>> 8) & 0xff,
      tuple & 0xff,
    ];
    for (let k = 0; k < count - 1; k++) out.push(b[k]);
  }
  return Uint8Array.from(out);
}

function _pdf_runlength(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < raw.length) {
    const n = raw[i++];
    if (n === 128) break;
    if (n < 128) {
      for (let k = 0; k <= n && i < raw.length; k++) out.push(raw[i++]);
    } else {
      const v = i < raw.length ? raw[i++] : 0;
      for (let k = 0; k <= 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

function _pdf_decode_stream(dict: string, raw: Uint8Array): Uint8Array | null {
  if (raw.length === 0 || raw.length > _PDF_MAX_STREAM_BYTES) return null;
  const filters: string[] = [];
  for (const m of dict.matchAll(_PDF_FILTER_RE)) filters.push(m[1]);
  let bytes = raw;
  for (const f of filters) {
    if (f === "FlateDecode" || f === "Fl") {
      try {
        bytes = new Uint8Array(inflateRawSync(Buffer.from(bytes)));
      } catch {
        return null;
      }
    } else if (f === "ASCIIHexDecode" || f === "AHx") {
      const d = _pdf_asciihex(bytes);
      if (!d) return null;
      bytes = d;
    } else if (f === "ASCII85Decode" || f === "A85") {
      const d = _pdf_ascii85(bytes);
      if (!d) return null;
      bytes = d;
    } else if (f === "RunLengthDecode") {
      bytes = _pdf_runlength(bytes);
    } else {
      // LZWDecode, Crypt, DCTDecode, JPXDecode, JBIG2Decode, CCITTFaxDecode
      return null;
    }
    if (bytes.length > _PDF_MAX_STREAM_BYTES) return null;
  }
  return bytes;
}

// --- ToUnicode CMaps ----------------------------------------------------------

interface _PdfCMap {
  map: Map<string, string>;
  maxLen: number;
}

function _pdf_hex_bytes(hex: string): number[] {
  const h = hex.replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < h.length; i += 2) {
    out.push(parseInt(h.slice(i, i + 2), 16));
  }
  if (h.length % 2) out.push(parseInt(h[h.length - 1] + "0", 16));
  return out;
}

function _pdf_utf16be_from_hex(hex: string): string {
  const bytes = _pdf_hex_bytes(hex);
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  if (bytes.length % 2) out += String.fromCharCode(bytes[bytes.length - 1]);
  return out;
}

function _pdf_hex_of_int(v: number, len: number): string {
  return v.toString(16).padStart(len, "0");
}

function _pdf_bump_hex(hex: string, k: number): string {
  // Increment a UTF-16BE hex string by k, carrying across 16-bit units.
  let h = hex.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  if (!h) return hex;
  const pad = (4 - (h.length % 4)) % 4;
  h = "0".repeat(pad) + h;
  const units: number[] = [];
  for (let i = 0; i < h.length; i += 4) {
    units.push(parseInt(h.slice(i, i + 4), 16) || 0);
  }
  let carry = k;
  for (let idx = units.length - 1; idx >= 0 && carry > 0; idx--) {
    const sum = units[idx] + carry;
    units[idx] = sum % 0x10000;
    carry = Math.floor(sum / 0x10000);
  }
  return units.map((u) => u.toString(16).padStart(4, "0")).join("");
}

function _pdf_parse_cmap(text: string): _PdfCMap | null {
  const map = new Map<string, string>();
  let maxLen = 0;
  const put = (srcHex: string, dstHex: string) => {
    let key = srcHex.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
    if (!key) return;
    if (key.length % 2) key = "0" + key;
    map.set(key, _pdf_utf16be_from_hex(dstHex));
    maxLen = Math.max(maxLen, key.length / 2);
  };

  for (const m of text.matchAll(/beginbfchar\b([\s\S]*?)endbfchar/g)) {
    const re = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let e: RegExpExecArray | null;
    while ((e = re.exec(m[1])) !== null) put(e[1], e[2]);
  }

  for (const m of text.matchAll(/beginbfrange\b([\s\S]*?)endbfrange/g)) {
    const body = m[1];
    const re =
      /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[\s\S]*?\]|<([0-9A-Fa-f]+)>)/g;
    let e: RegExpExecArray | null;
    while ((e = re.exec(body)) !== null) {
      const loHex = e[1];
      const hiHex = e[2];
      const loV = parseInt(loHex, 16);
      const hiV = parseInt(hiHex, 16);
      if (!Number.isFinite(loV) || !Number.isFinite(hiV)) continue;
      if (hiV < loV || hiV - loV > 0x10000) continue;
      if (e[3].startsWith("[")) {
        const dsts = [...e[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]);
        const count = Math.min(hiV - loV + 1, dsts.length);
        for (let k = 0; k < count; k++) {
          put(_pdf_hex_of_int(loV + k, loHex.length), dsts[k]);
        }
      } else {
        const dstStart = e[4];
        for (let k = 0; k <= hiV - loV; k++) {
          put(
            _pdf_hex_of_int(loV + k, loHex.length),
            _pdf_bump_hex(dstStart, k)
          );
        }
      }
    }
  }

  if (!map.size) return null;
  return { map, maxLen: Math.min(maxLen, 8) };
}

// --- content stream parsing ---------------------------------------------------

interface _PdfTok {
  t: "str" | "num" | "arr" | "op" | "name";
  v: unknown;
}

function _pdf_literal(s: string, i: number): { v: string; next: number } {
  // s[i] === '('
  let depth = 1;
  let j = i + 1;
  let out = "";
  const n = s.length;
  while (j < n && depth > 0) {
    const c = s.charCodeAt(j);
    if (c === 0x5c) {
      // backslash escape
      j++;
      if (j >= n) break;
      const e = s.charCodeAt(j);
      if (e === 0x6e) out += "\n";
      else if (e === 0x72) out += "\r";
      else if (e === 0x74) out += "\t";
      else if (e === 0x62) out += "\b";
      else if (e === 0x66) out += "\f";
      else if (e === 0x28 || e === 0x29 || e === 0x5c) {
        out += String.fromCharCode(e);
      } else if (e === 0x0a) {
        // line continuation: nothing
      } else if (e === 0x0d) {
        if (s.charCodeAt(j + 1) === 0x0a) j++;
      } else if (e >= 0x30 && e <= 0x37) {
        // octal escape, up to 3 digits
        let v = 0;
        let cnt = 0;
        while (cnt < 3 && j < n) {
          const d = s.charCodeAt(j);
          if (d < 0x30 || d > 0x37) break;
          v = v * 8 + (d - 0x30);
          j++;
          cnt++;
        }
        j--;
        out += String.fromCharCode(v & 0xff);
      } else {
        out += String.fromCharCode(e);
      }
      j++;
      continue;
    }
    if (c === 0x28) {
      depth++;
      out += "(";
      j++;
      continue;
    }
    if (c === 0x29) {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
      out += ")";
      j++;
      continue;
    }
    out += s[j];
    j++;
  }
  return { v: out, next: j };
}

function _pdf_hexstr(s: string, i: number): { v: string; next: number } {
  // s[i] === '<' and s[i+1] !== '<'
  let j = i + 1;
  let hex = "";
  const n = s.length;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 0x3e) {
      j++;
      break;
    }
    if (!_PDF_WS.has(c)) hex += s[j];
    j++;
  }
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  const h = clean.length % 2 ? clean + "0" : clean;
  let out = "";
  for (let k = 0; k + 1 < h.length; k += 2) {
    out += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
  }
  return { v: out, next: j };
}

function _pdf_next_token(s: string, i: number): { tok: _PdfTok; next: number } {
  const n = s.length;
  const c = s.charCodeAt(i);
  if (c === 0x28) {
    // (
    const r = _pdf_literal(s, i);
    return { tok: { t: "str", v: r.v }, next: r.next };
  }
  if (c === 0x3c) {
    // <
    if (s.charCodeAt(i + 1) === 0x3c) {
      return { tok: { t: "op", v: "<<" }, next: i + 2 };
    }
    const r = _pdf_hexstr(s, i);
    return { tok: { t: "str", v: r.v }, next: r.next };
  }
  if (c === 0x3e) {
    // >
    if (s.charCodeAt(i + 1) === 0x3e) {
      return { tok: { t: "op", v: ">>" }, next: i + 2 };
    }
    return { tok: { t: "op", v: ">" }, next: i + 1 };
  }
  if (c === 0x5b) {
    // [ -> array
    const items: _PdfTok[] = [];
    let j = i + 1;
    while (j < n) {
      j = _pdf_skip_ws(s, j);
      if (j >= n) break;
      if (s.charCodeAt(j) === 0x5d) {
        j++;
        break;
      }
      const r = _pdf_next_token(s, j);
      items.push(r.tok);
      j = r.next;
    }
    return { tok: { t: "arr", v: items }, next: j };
  }
  if (c === 0x5d) {
    // stray ]
    return { tok: { t: "op", v: "]" }, next: i + 1 };
  }
  if (c === 0x2f) {
    // /name
    let j = i + 1;
    while (j < n && !_pdf_is_delim(s.charCodeAt(j))) j++;
    return { tok: { t: "name", v: s.slice(i + 1, j) }, next: j };
  }
  if (c === 0x7b || c === 0x7d) {
    // { }
    return { tok: { t: "op", v: String.fromCharCode(c) }, next: i + 1 };
  }
  if (c === 0x27 || c === 0x22) {
    // ' and " are self-delimiting text operators
    return { tok: { t: "op", v: String.fromCharCode(c) }, next: i + 1 };
  }
  // number or bareword operator
  let j = i;
  while (
    j < n &&
    !_pdf_is_delim(s.charCodeAt(j)) &&
    s.charCodeAt(j) !== 0x27 &&
    s.charCodeAt(j) !== 0x22
  ) {
    j++;
  }
  const w = s.slice(i, j);
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(w)) {
    return { tok: { t: "num", v: parseFloat(w) }, next: j };
  }
  return { tok: { t: "op", v: w }, next: j };
}

function _pdf_tokenize(s: string): _PdfTok[] {
  const toks: _PdfTok[] = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    i = _pdf_skip_ws(s, i);
    if (i >= n) break;
    const r = _pdf_next_token(s, i);
    toks.push(r.tok);
    i = r.next > i ? r.next : i + 1;
  }
  return toks;
}

// --- string decoding ---------------------------------------------------------

function _pdf_hex_of(s: string, i: number, len: number): string {
  let h = "";
  for (let k = 0; k < len; k++) {
    h += s.charCodeAt(i + k).toString(16).padStart(2, "0");
  }
  return h;
}

function _pdf_cmap_decode(
  s: string,
  cmap: _PdfCMap
): { text: string; hits: number; total: number } {
  let i = 0;
  let hits = 0;
  let total = 0;
  let out = "";
  const maxL = Math.min(cmap.maxLen, 8);
  while (i < s.length) {
    let matched = false;
    const top = Math.min(maxL, s.length - i);
    for (let L = top; L >= 1; L--) {
      const u = cmap.map.get(_pdf_hex_of(s, i, L));
      if (u !== undefined) {
        out += u;
        hits++;
        i += L;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += s[i];
      i++;
    }
    total++;
  }
  return { text: out, hits, total };
}

function _pdf_utf16_units(s: string, off: number, le: boolean): string {
  let out = "";
  for (let i = off; i + 1 < s.length; i += 2) {
    const a = s.charCodeAt(i);
    const b = s.charCodeAt(i + 1);
    out += String.fromCharCode(le ? (b << 8) | a : (a << 8) | b);
  }
  return out;
}

function _pdf_winansi(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += _PDF_WINANSI[c] ?? s[i];
  }
  return out;
}

function _pdf_decode_string(s: string, cmaps: _PdfCMap[]): string {
  if (s.length >= 2) {
    const b0 = s.charCodeAt(0);
    const b1 = s.charCodeAt(1);
    if (b0 === 0xfe && b1 === 0xff) return _pdf_utf16_units(s, 2, false);
    if (b0 === 0xff && b1 === 0xfe) return _pdf_utf16_units(s, 2, true);
  }
  let best: { text: string; score: number } | null = null;
  for (const cmap of cmaps) {
    const r = _pdf_cmap_decode(s, cmap);
    const score = r.total === 0 ? 0 : r.hits / r.total;
    if (r.hits > 0 && score >= 0.5 && (!best || score > best.score)) {
      best = { text: r.text, score };
    }
  }
  return best ? best.text : _pdf_winansi(s);
}

// --- content stream -> text ----------------------------------------------------

function _pdf_content_text(src: string, cmaps: _PdfCMap[]): string {
  const toks = _pdf_tokenize(src);
  const parts: string[] = [];
  let operands: _PdfTok[] = [];
  const newline = () => {
    if (parts.length > 0 && parts[parts.length - 1] !== "\n") parts.push("\n");
  };
  const lastStr = (): string | null => {
    for (let i = operands.length - 1; i >= 0; i--) {
      if (operands[i].t === "str") return operands[i].v as string;
    }
    return null;
  };
  for (const t of toks) {
    if (t.t !== "op") {
      operands.push(t);
      continue;
    }
    const op = t.v as string;
    if (op === "Tj") {
      const s = lastStr();
      if (s !== null) parts.push(_pdf_decode_string(s, cmaps));
    } else if (op === "TJ") {
      for (let i = operands.length - 1; i >= 0; i--) {
        const it = operands[i];
        if (it.t === "arr") {
          for (const el of it.v as _PdfTok[]) {
            if (el.t === "str") {
              parts.push(_pdf_decode_string(el.v as string, cmaps));
            } else if (el.t === "num" && (el.v as number) <= -120) {
              // Large negative TJ adjustments usually mean a word gap.
              parts.push(" ");
            }
          }
          break;
        }
      }
    } else if (op === "'" || op === '"') {
      newline();
      const s = lastStr();
      if (s !== null) parts.push(_pdf_decode_string(s, cmaps));
    } else if (
      op === "Td" ||
      op === "TD" ||
      op === "Tm" ||
      op === "T*" ||
      op === "ET"
    ) {
      newline();
    }
    operands = [];
  }
  return parts.join("");
}

// --- top level -----------------------------------------------------------------

const _PDF_SKIP_DICT_RE = /ObjStm|XRef|Metadata|FontFile|\/Image|\/ICC|\/Profile/;

function _extract_pdf_text(data: Uint8Array): string {
  if (data.length > _PDF_MAX_FILE_BYTES) return "";
  const src = _pdf_bin(data);
  const streams = _pdf_find_streams(src, data);
  const cmaps: _PdfCMap[] = [];
  const contents: string[] = [];
  let budget = _PDF_MAX_TEXT_CHARS * 4;
  for (const st of streams) {
    if (budget <= 0) break;
    if (_PDF_SKIP_DICT_RE.test(st.dict)) continue;
    const bytes = _pdf_decode_stream(st.dict, st.raw);
    if (!bytes || bytes.length === 0) continue;
    const text = _pdf_bin(bytes);
    if (
      text.includes("beginbfchar") ||
      text.includes("beginbfrange") ||
      text.includes("begincmap")
    ) {
      const cmap = _pdf_parse_cmap(text);
      if (cmap) cmaps.push(cmap);
    } else if (text.includes("BT") && /T[Jj]/.test(text)) {
      contents.push(text.slice(0, _PDF_MAX_STREAM_BYTES));
      budget -= text.length;
    }
  }
  let out = "";
  for (const c of contents) {
    if (out.length >= _PDF_MAX_TEXT_CHARS) break;
    try {
      out += _pdf_content_text(c, cmaps) + "\n";
    } catch {
      // skip unparseable content stream
    }
  }
  return out
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, _PDF_MAX_TEXT_CHARS);
}

/** Public alias: best-effort whole-document PDF text (see _extract_pdf_text). */
export function extractPdfText(data: Uint8Array): string {
  return _extract_pdf_text(data);
}

function _chunk(text: string): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let i = 0;
  while (i < words.length) {
    const chunk = words.slice(i, i + _CHUNK_SIZE).join(" ");
    if (chunk.trim()) {
      chunks.push(chunk);
    }
    i += _CHUNK_SIZE - _CHUNK_OVERLAP;
  }
  return chunks.length ? chunks : text.trim() ? [text] : [];
}

function _safe_name(name: string): string {
  return [...name]
    .filter((c) => /[\p{L}\p{N}\-_ ]/u.test(c))
    .join("")
    .trim();
}

// time.strftime("%Y-%m-%dT%H:%M:%S") — local time, no fractional seconds.
function _stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Safe scalar/metadata fields mirrored into list() responses — the same
// allowlist the KB detail endpoint uses, minus secrets like api_key.
const KB_LIST_METADATA_KEYS = [
  "description",
  "rag_provider",
  "needs_reindex",
  "last_indexed_at",
  "last_indexed_action",
  "type",
  "vault_path",
  "external_path",
  "db_path",
  "server_url",
  "zim_name",
  "zim_title",
  "knowledge_base_id",
  "agent_kind",
  "cwd",
  "partner_id",
  "embedding_model",
  "embedding_dim",
  "embedding_selection",
  "embedding_status",
  "indexing_policy",
  "indexing_model_unavailable",
  "embedding_mismatch",
] as const;

export class KnowledgeBaseStore {
  private _settings: Settings;

  constructor(settings: Settings) {
    this._settings = settings;
    database.ensure_tables(settings);
  }

  // -- helpers ------------------------------------------------------------

  private static _meta_payload(raw: unknown): Record<string, unknown> {
    let payload: unknown = raw;
    if (typeof raw === "string") {
      try {
        payload = JSON.parse(raw);
      } catch {
        return {};
      }
    }
    return isRecord(payload) ? database.normalizeKbMetaTimestamps(payload) : {};
  }

  private _meta(name: string): Record<string, unknown> | null {
    const connection = database.connect(this._settings);
    try {
      const row = connection
        .prepare("SELECT payload FROM kb_meta WHERE name = ?")
        .get(name) as { payload: string } | undefined;
      return row === undefined
        ? null
        : KnowledgeBaseStore._meta_payload(row.payload);
    } finally {
      connection.close();
    }
  }

  private _save_meta(name: string, payload: Record<string, unknown>): void {
    const connection = database.connect(this._settings);
    try {
      connection
        .prepare(
          `
          INSERT INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET
              payload = excluded.payload,
              updated_at = excluded.updated_at
          `,
        )
        .run(name, JSON.stringify(payload), Date.now() / 1000);
    } finally {
      connection.close();
    }
  }

  // -- CRUD ---------------------------------------------------------------

  list(): Record<string, unknown>[] {
    const connection = database.connect(this._settings);
    let rows: { name: string; payload: string }[];
    let counts = new Map<string, number>();
    let docCounts = new Map<string, number>();
    try {
      rows = connection
        .prepare("SELECT name, payload FROM kb_meta ORDER BY name")
        .all() as { name: string; payload: string }[];
      counts = new Map(
        (
          connection
            .prepare(
              "SELECT kb, COUNT(*) AS count FROM kb_chunks GROUP BY kb",
            )
            .all() as { kb: string; count: number }[]
        ).map((r) => [r.kb, Number(r.count)]),
      );
      docCounts = new Map(
        (
          connection
            .prepare("SELECT kb, COUNT(*) AS count FROM kb_docs GROUP BY kb")
            .all() as { kb: string; count: number }[]
        ).map((r) => [r.kb, Number(r.count)]),
      );
    } finally {
      connection.close();
    }
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const meta = KnowledgeBaseStore._meta_payload(row.payload);
      const chunks = counts.get(row.name) ?? 0;
      out.push({
        name: meta["name"] ?? row.name,
        id: row.name,
        is_default: false,
        status: "ready",
        path: `sqlite:///${this._settings.sessions_db}?kb=${row.name}`,
        metadata: {
          ...Object.fromEntries(
            KB_LIST_METADATA_KEYS.filter((key) => meta[key] !== undefined)
              .map((key) => [key, meta[key]]),
          ),
          created_at: meta["created_at"],
          last_updated: meta["last_updated"],
          last_indexed_count: chunks,
          rag_provider: meta["rag_provider"] ?? "keyword",
        },
        statistics: {
          raw_documents: docCounts.get(row.name) ?? 0,
          rag_initialized: chunks > 0,
          status: "ready",
        },
      });
    }
    return out;
  }

  create(name: string): Record<string, unknown> {
    const safe = _safe_name(name);
    if (!safe) {
      throw new Error("Knowledge base needs a name");
    }
    if (this._meta(safe) === null) {
      const stamp = _stamp();
      this._save_meta(safe, {
        name: safe,
        created_at: stamp,
        last_updated: stamp,
      });
    }
    return { name: safe, id: safe, status: "ready" };
  }

  delete(name: string): boolean {
    const safe = _safe_name(name);
    const connection = database.connect(this._settings);
    try {
      const exists = connection
        .prepare("SELECT 1 FROM kb_meta WHERE name = ?")
        .get(safe);
      if (exists === undefined) return false;
      connection.prepare("DELETE FROM kb_meta WHERE name = ?").run(safe);
      connection.prepare("DELETE FROM kb_docs WHERE kb = ?").run(safe);
      connection.prepare("DELETE FROM kb_chunks WHERE kb = ?").run(safe);
      return true;
    } finally {
      connection.close();
    }
  }

  exists(name: string): boolean {
    return this._meta(_safe_name(name)) !== null;
  }

  // -- documents ------------------------------------------------------------

  add_document(
    name: string,
    filename: string,
    data: Uint8Array,
  ): Record<string, unknown> {
    const safe = _safe_name(name);
    if (!this.exists(safe)) {
      this.create(safe);
    }
    const docName = filename.split("/").pop() || "upload.bin";
    const connection = database.connect(this._settings);
    try {
      connection
        .prepare(
          `
          INSERT OR REPLACE INTO kb_docs (kb, name, data, size) VALUES (?, ?, ?, ?)
          `,
        )
        .run(safe, docName, data, data.length);
    } finally {
      connection.close();
    }
    this.reindex(safe);
    return { filename: docName, size: data.length };
  }

  list_documents(name: string): Record<string, unknown>[] {
    const safe = _safe_name(name);
    const connection = database.connect(this._settings);
    try {
      const rows = connection
        .prepare(
          "SELECT name, size FROM kb_docs WHERE kb = ? ORDER BY name",
        )
        .all(safe) as { name: string; size: number }[];
      return rows.map((row) => ({
        name: row.name,
        size: Number(row.size ?? 0),
        suffix: row.name.includes(".")
          ? "." + row.name.split(".").pop()
          : "",
      }));
    } finally {
      connection.close();
    }
  }

  delete_document(name: string, filename: string): boolean {
    const safe = _safe_name(name);
    const docName = filename.split("/").pop() ?? filename;
    const connection = database.connect(this._settings);
    let deleted = false;
    try {
      const result = connection
        .prepare("DELETE FROM kb_docs WHERE kb = ? AND name = ?")
        .run(safe, docName);
      deleted = Number(result.changes) !== 0;
    } finally {
      connection.close();
    }
    if (!deleted) return false;
    this.reindex(safe);
    return true;
  }

  // -- indexing / retrieval ---------------------------------------------------

  reindex(name: string): number {
    const safe = _safe_name(name);
    const connection = database.connect(this._settings);
    let docs: { name: string; data: unknown }[];
    try {
      docs = connection
        .prepare("SELECT name, data FROM kb_docs WHERE kb = ? ORDER BY name")
        .all(safe) as { name: string; data: unknown }[];
    } finally {
      connection.close();
    }
    const chunks: [string, string, string, string, number][] = [];
    for (const doc of docs) {
      const raw =
        doc.data instanceof Uint8Array
          ? doc.data
          : Buffer.from(String(doc.data ?? ""), "utf-8");
      const text = _extract_text(doc.name, raw);
      if (!text.trim()) continue;
      _chunk(text).forEach((chunk, index) => {
        chunks.push([safe, `${doc.name}#${index}`, doc.name, chunk, chunks.length]);
      });
    }
    const conn = database.connect(this._settings);
    try {
      conn.exec("BEGIN IMMEDIATE");
      try {
        conn.prepare("DELETE FROM kb_chunks WHERE kb = ?").run(safe);
        const insert = conn.prepare(
          `
          INSERT OR REPLACE INTO kb_chunks
              (kb, chunk_id, doc, text, tokens, seq)
          VALUES (?, ?, ?, ?, '[]', ?)
          `,
        );
        for (const row of chunks) insert.run(...row);
        conn.exec("COMMIT");
      } catch (e) {
        conn.exec("ROLLBACK");
        throw e;
      }
    } finally {
      conn.close();
    }
    const meta = this._meta(safe) ?? { name: safe };
    meta["last_updated"] = _stamp();
    this._save_meta(safe, meta);
    return chunks.length;
  }

  search(
    name: string,
    query: string,
    topK = 5,
  ): Record<string, unknown>[] {
    const safe = _safe_name(name);
    const connection = database.connect(this._settings);
    let rows: { chunk_id: string; doc: string; text: string }[];
    try {
      rows = connection
        .prepare(
          "SELECT chunk_id, doc, text FROM kb_chunks WHERE kb = ?",
        )
        .all(safe) as { chunk_id: string; doc: string; text: string }[];
    } finally {
      connection.close();
    }
    if (!rows.length) return [];
    const qTokens = _tokenize(query);
    if (!qTokens.length) return [];
    const chunks = rows.map((row) => ({
      id: row.chunk_id,
      doc: row.doc,
      text: row.text,
      tokens: _tokenize(row.text),
    }));
    const df = new Map<string, number>();
    for (const chunk of chunks) {
      for (const token of new Set(chunk.tokens)) {
        df.set(token, (df.get(token) ?? 0) + 1);
      }
    }
    const total = chunks.length;
    const scored: { score: number; chunk: (typeof chunks)[number] }[] = [];
    for (const chunk of chunks) {
      const tf = new Map<string, number>();
      for (const token of chunk.tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      let score = 0;
      for (const token of qTokens) {
        const tfCount = tf.get(token);
        if (tfCount !== undefined) {
          const dfCount = df.get(token) ?? 0;
          const idf = Math.log(1 + (total - dfCount + 0.5) / (dfCount + 0.5));
          score += idf * ((tfCount * 2.2) / (tfCount + 1.2));
        }
      }
      if (score > 0) {
        scored.push({ score, chunk });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ score, chunk }) => ({
      id: chunk.id,
      doc: chunk.doc,
      text: chunk.text,
      score: Math.round(score * 1000) / 1000,
    }));
  }

  read_source(name: string, doc: string): string {
    const safe = _safe_name(name);
    const connection = database.connect(this._settings);
    try {
      const rows = connection
        .prepare(
          "SELECT text FROM kb_chunks WHERE kb = ? AND doc = ? ORDER BY seq",
        )
        .all(safe, doc) as { text: string }[];
      return rows.length
        ? rows.map((r) => r.text).join("\n\n").slice(0, 30000)
        : "";
    } finally {
      connection.close();
    }
  }
}
