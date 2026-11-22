// persistent review
// scheduling for flashcards embedded in notebook pages.

import { createHash } from "node:crypto";

import { walk_blocks } from "./blocks.js";
import type { CoWriterStorage } from "./storage.js";

const _walkBlocks = walk_blocks as (
  blocks: Record<string, unknown>[] | null | undefined,
) => Iterable<Record<string, unknown>>;

const _loadDocument = (s: CoWriterStorage, id: string) => s.loadDocument(id);
const _listDocuments = (s: CoWriterStorage) => s.listDocuments();
const _loadExtra = (s: CoWriterStorage, docId: string, kind: string, dflt: unknown) =>
  s.loadExtra(docId, kind, dflt);
const _saveExtra = (s: CoWriterStorage, docId: string, kind: string, payload: unknown) =>
  s.saveExtra(docId, kind, payload);

interface ReviewProgress {
  interval_days?: number;
  due_at?: number;
  reviewed_at?: number;
  [k: string]: unknown;
}

export interface PageCard {
  page_id: string;
  page_title: string;
  block_id: string;
  card_id: string;
  front: string;
  back: string;
  due_at?: number;
  [k: string]: unknown;
}

const _now = (): number => Date.now() / 1000;

/**
 * Replicates ``json.dumps(value, sort_keys=True)`` closely enough for stable
 * card hashing: sorted keys, ``, ``/``: `` separators, ensure_ascii escaping.
 * JSON.parse collapses both to JS numbers, so float-valued card fields may
 */
function py_dumps(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    // JSON.parse already lost the distinction, so emit JS shortest form.
    return String(value);
  }
  if (typeof value === "string") return py_quote(value);
  if (Array.isArray(value)) {
    return `[${value.map(py_dumps).join(", ")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${py_quote(k)}: ${py_dumps(obj[k])}`);
    return `{${parts.join(", ")}}`;
  }
  return py_quote(String(value));
}

/** JSON string literal with ensure_ascii=True semantics. */
function py_quote(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0d) out += "\\r";
    else if (c === 0x09) out += "\\t";
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else if (c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += s[i];
  }
  return out + '"';
}

function _card_hash(card: Record<string, unknown>): string {
  return createHash("sha256")
    .update(py_dumps(card), "utf8")
    .digest("hex")
    .slice(0, 16);
}

// TODO(verify): doc/blocks shapes depend on storage.ts Dict rows; kept
// structural so this compiles against either naming.
interface DocLike {
  id: string;
  title?: string | null;
  blocks?: Record<string, unknown>[] | null;
  [k: string]: unknown;
}

export function* page_cards(doc: DocLike): Generator<PageCard> {
  for (const block of _walkBlocks(doc.blocks ?? [])) {
    const b = block as Record<string, unknown>;
    const props = (b.props ?? {}) as Record<string, unknown>;
    if (b.type !== "learning" || props.kind !== "flashcards") {
      continue;
    }
    let cards: unknown;
    try {
      cards = (JSON.parse(String(props.data ?? "{}")) as Record<string, unknown>)
        .cards;
    } catch {
      continue;
    }
    if (!Array.isArray(cards)) continue;
    for (const card of cards) {
      if (
        typeof card !== "object" ||
        card === null ||
        Array.isArray(card) ||
        !("front" in card) ||
        !(card as Record<string, unknown>).front
      ) {
        continue;
      }
      const c = card as Record<string, unknown>;
      const key = `${String(b.id)}:${_card_hash(c)}`;
      yield {
        page_id: doc.id,
        page_title: String(doc.title ?? ""),
        block_id: String(b.id),
        card_id: key,
        front: String(c.front ?? ""),
        back: String(c.back ?? ""),
      };
    }
  }
}

export function due_cards(storage: CoWriterStorage, now?: number): PageCard[] {
  const t = now ?? _now();
  const result: PageCard[] = [];
  for (const summary of _listDocuments(storage)) {
    const doc = _loadDocument(storage, summary.id) as DocLike | null;
    if (doc === null || doc === undefined) continue;
    const raw = _loadExtra(storage, doc.id, "review", {});
    const progress =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, ReviewProgress>)
        : {};
    for (const card of page_cards(doc)) {
      const entry = progress[card.card_id];
      const due = typeof entry?.due_at === "number" ? entry.due_at : 0;
      if (due <= t) {
        result.push({ ...card, due_at: due });
      }
    }
  }
  return result
    .sort((a, b) => (a.due_at ?? 0) - (b.due_at ?? 0))
    .slice(0, 200);
}

export function grade_card(
  storage: CoWriterStorage,
  page_id: string,
  card_id: string,
  remembered: boolean,
): ReviewProgress {
  return storage.locked(() => {
    const doc = _loadDocument(storage, page_id) as DocLike | null;
    if (doc === null || doc === undefined) {
      throw new Error("Page not found");
    }
    const valid = new Set<string>();
    for (const card of page_cards(doc)) valid.add(card.card_id);
    if (!valid.has(card_id)) {
      throw new Error("This flashcard has changed or no longer exists");
    }
    const raw = _loadExtra(storage, page_id, "review", {});
    const stored =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, ReviewProgress>)
        : {};
    const progress: Record<string, ReviewProgress> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (valid.has(key)) progress[key] = value;
    }
    const previous = progress[card_id] ?? {};
    const prevInterval =
      typeof previous.interval_days === "number" ? previous.interval_days : 0;
    const interval = remembered
      ? Math.min(180, Math.max(1, prevInterval * 2 + 1))
      : 0;
    const result: ReviewProgress = {
      interval_days: interval,
      due_at: _now() + (interval * 86400 || 600),
      reviewed_at: _now(),
    };
    progress[card_id] = result;
    _saveExtra(storage, page_id, "review", progress);
    return result;
  });
}
