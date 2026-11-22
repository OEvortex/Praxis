// render notebook flashcards
// as Anki's tab-separated import text.
//
// The format follows Anki 2.1.55+ header lines so File -> Import creates Basic
// notes in a deck named after each note. GUIDs are the stable review
// ``card_id`` values, so a later import updates the same cards instead of
// duplicating them.

import { page_cards } from "./review.js";
import type { CoWriterStorage } from "./storage.js";

const _loadDocument = (s: CoWriterStorage, id: string) => s.loadDocument(id);
const _listDocuments = (s: CoWriterStorage) => s.listDocuments();

export const ANKI_HEADERS: readonly string[] = [
  "#separator:tab",
  "#html:true",
  "#notetype:Basic",
  "#deck column:3",
  "#tags column:4",
  "#guid column:5",
];

// (?P<fence>```[\s\S]*?```)|(?P<code>`[^`]+`)|(?P<block_math>\$\$[\s\S]+?\$\$)|(?P<math>(?<!\$)\$(?!\$)[^$\n]+?\$)
const _PROTECTED_SPANS =
  /(```[\s\S]*?```)|(`[^`]+`)|(\$\$[\s\S]+?\$\$)|((?<!\$)\$(?!\$)[^$\n]+?\$)/g;
const _BOLD = /\*\*(.+?)\*\*|__(.+?)__/g;
// (?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<![A-Za-z0-9_])_(?!_)(.+?)(?<![A-Za-z0-9_])_(?![A-Za-z0-9_])
const _ITALIC =
  /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<![A-Za-z0-9_])_(?!_)(.+?)(?<![A-Za-z0-9_])_(?![A-Za-z0-9_])/g;
const _CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const _SLUG_SPLIT = /[^\p{L}\p{N}_]+/gu;
const _SLOT = /\x00(\d+)\x00/g;

export function deck_name(title: string): string {
  /** Return the Anki deck name ``Praxis::<note title>``. */
  let cleaned = (title || "").replace(_CONTROL_CHARS, "").trim() || "Untitled";
  cleaned = cleaned.replaceAll("::", " — ");
  return `Praxis::${cleaned}`;
}

export function note_tags(title: string): string {
  /** Return space-separated Anki tags for a note. */
  let slug = (title || "").trim().replace(_SLUG_SPLIT, "-");
  slug = slug.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  if (!slug || slug === "praxis") {
    return "praxis";
  }
  return `praxis ${slug}`;
}

function html_escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

export function markdown_to_anki_html(text: string): string {
  /** Convert card Markdown to minimal HTML Anki can import safely. */
  if (!text) {
    return "";
  }
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\x00/g, "");
  const slots: string[] = [];

  const stash = (fragment: string): string => {
    slots.push(fragment);
    return `\x00${slots.length - 1}\x00`;
  };

  // Match order mirrors the named groups: fence, code, block_math, math.
  const protectedText = normalized.replace(
    _PROTECTED_SPANS,
    (
      raw: string,
      fence: string | undefined,
      code: string | undefined,
      blockMath: string | undefined,
      // math is group 4
      math: string | undefined,
    ) => {
      if (fence !== undefined) {
        const inner = raw.slice(3, -3);
        // The opening fence line holds the optional info string (language),
        // which is not code; the body starts after that line's newline.
        const newline = inner.indexOf("\n");
        const codeBody = newline !== -1 ? inner.slice(newline + 1) : inner;
        const body = html_escape(codeBody.replace(/^\n+|\n+$/g, "")).replaceAll(
          "\n",
          "<br>",
        );
        return stash(`<pre><code>${body}</code></pre>`);
      }
      if (code !== undefined) {
        return stash(`<code>${html_escape(raw.slice(1, -1))}</code>`);
      }
      if (blockMath !== undefined) {
        return stash(`\\[${html_escape(raw.slice(2, -2).trim())}\\]`);
      }
      // math
      return stash(`\\(${html_escape((math ?? raw).slice(1, -1).trim())}\\)`);
    },
  );

  const escaped = html_escape(protectedText);
  const marked = escaped.replace(_BOLD, (_m, g1, g2) => `<b>${g1 || g2}</b>`);
  const italicized = marked.replace(
    _ITALIC,
    (_m, g1, g2) => `<i>${g1 || g2}</i>`,
  );
  let htmlBody = _paragraphs(italicized);
  htmlBody = htmlBody.replace(_SLOT, (_m, idx) => slots[Number(idx)]);
  return _anki_field(htmlBody);
}

export function cards_from_storage(
  storage: CoWriterStorage,
): Record<string, unknown>[] {
  /** Return flashcards from every note in the active workspace. */
  const cards: Record<string, unknown>[] = [];
  for (const summary of _listDocuments(storage)) {
    const doc = _loadDocument(storage, summary.id);
    if (doc === null || doc === undefined) continue;
    // TODO(verify): page_cards expects the review.ts DocLike shape; the
    // storage document is structurally compatible.
    for (const card of page_cards(
      doc as unknown as Parameters<typeof page_cards>[0],
    )) {
      cards.push(card as unknown as Record<string, unknown>);
    }
  }
  return cards;
}

export function render_anki_export(
  cards: readonly Record<string, unknown>[],
): string {
  /** Render cards as Anki 2.1.55+ tab-separated import text. */
  const lines = [...ANKI_HEADERS];
  for (const card of cards) {
    const title = String(card.page_title ?? "");
    const front = markdown_to_anki_html(String(card.front ?? ""));
    const back = markdown_to_anki_html(String(card.back ?? ""));
    const deck = _anki_field(deck_name(title));
    const tags = _anki_field(note_tags(title));
    const guid = _anki_field(String(card.card_id ?? ""));
    lines.push([front, back, deck, tags, guid].join("\t"));
  }
  return lines.join("\n") + "\n";
}

function _paragraphs(text: string): string {
  const chunks = text.trim().split(/\n{2,}/);
  const parts = chunks
    .filter((chunk) => chunk !== "")
    .map((chunk) => `<p>${chunk.replace(/\n/g, "<br>")}</p>`);
  return parts.join("");
}

function _anki_field(value: string): string {
  return value.replaceAll("\t", " ").replaceAll("\r", "").replaceAll("\n", "");
}
