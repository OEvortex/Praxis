// Port of deeptutor/notes/threads.py — conversations held at a line of a
// note page, adapted to the Praxis document store.
//
// Upstream keeps threads in `<doc_root>/threads.json`; the Praxis port of the
// same feature (src/services/documents/threads.ts) stores them in the page's
// `threads` extra (`doc_extras` table). This module reuses that storage and
// adds the context helpers the notes capability needs
// (``thread_anchor_context``, ``block_text``, ``card_content``) plus the
// list/anchor/remove/prune/adopt operations for parity.

import type { CoWriterStorage } from "../../services/documents/storage.js";
import {
  blocks_to_markdown,
  LEAF_BLOCK_TYPES,
  walk_blocks,
} from "../../services/documents/blocks.js";
import * as threadStore from "../../services/documents/threads.js";
import type { Dict } from "../../shared/types.js";

const MAX_THREADS = 500;
const QUOTE_LIMIT = 600;
const CARD_CONTENT_LIMIT = 6000;

const _loadExtra = (s: CoWriterStorage, docId: string, kind: string, dflt: unknown) =>
  s.loadExtra(docId, kind, dflt);
const _saveExtra = (s: CoWriterStorage, docId: string, kind: string, payload: unknown) =>
  s.saveExtra(docId, kind, payload);

export interface NoteThread {
  session_id?: string;
  block_id?: string;
  quote?: string;
  origin?: string;
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

export function list_threads(
  storage: CoWriterStorage,
  doc_id: string,
): NoteThread[] {
  const rows = _loadExtra(storage, doc_id, "threads", []);
  return Array.isArray(rows) ? (rows as NoteThread[]) : [];
}

export function adopt_legacy_threads(
  storage: CoWriterStorage,
  doc_id: string,
  session_ids: string[],
): void {
  /** Give a page's conversations from before threads a line: its first block.

   * Runs once per page (an empty threads extra marks it done only when the
   * page actually has no threads file marker — the Praxis store has no file
   * marker, so adoption is gated on the caller passing legacy ids and an
   * empty existing list).
   */
  storage.locked(() => {
    if (list_threads(storage, doc_id).length > 0) return;
    const doc = storage.loadDocument(doc_id);
    const blocks = (doc?.blocks ?? []) as Dict[];
    const first = blocks.length ? blocks[0] : null;
    const now = Date.now() / 1000;
    const rows: NoteThread[] = first
      ? [...new Set(session_ids)].map((sid) => ({
          session_id: sid,
          block_id: String(first["id"] ?? ""),
          quote: "",
          origin: "ask",
          created_at: now,
        }))
      : [];
    _saveExtra(storage, doc_id, "threads", rows);
  });
}

export function find_thread(
  storage: CoWriterStorage,
  doc_id: string,
  session_id: string,
): NoteThread | null {
  return (
    list_threads(storage, doc_id).find((t) => t.session_id === session_id) ??
    null
  );
}

export function anchor_thread(
  storage: CoWriterStorage,
  doc_id: string,
  opts: {
    session_id: string;
    block_id: string;
    quote?: string;
    origin?: string;
  },
): NoteThread {
  /** Record (or move) the line a conversation belongs to. */
  const { session_id, block_id } = opts;
  const quote = opts.quote ?? "";
  const origin = opts.origin ?? "ask";
  return storage.locked(() => {
    if (storage.loadDocument(doc_id) === null) {
      throw new Error("Page not found");
    }
    const threads = list_threads(storage, doc_id);
    let existing = threads.find((t) => t.session_id === session_id);
    if (existing === undefined) {
      existing = { session_id, created_at: Date.now() / 1000 };
      threads.push(existing);
    }
    existing.block_id = block_id;
    existing.quote = (quote || existing.quote || "").slice(0, QUOTE_LIMIT);
    existing.origin =
      origin === "ask" || origin === "generate" ? origin : "ask";
    _saveExtra(storage, doc_id, "threads", threads.slice(-MAX_THREADS));
    return existing;
  });
}

export function remove_thread(
  storage: CoWriterStorage,
  doc_id: string,
  session_id: string,
): boolean {
  return storage.locked(() => {
    const threads = list_threads(storage, doc_id);
    const kept = threads.filter((t) => t.session_id !== session_id);
    if (kept.length === threads.length) return false;
    _saveExtra(storage, doc_id, "threads", kept);
    return true;
  });
}

/** Forget threads whose conversation was deleted elsewhere. */
export function prune_threads(
  storage: CoWriterStorage,
  doc_id: string,
  live_session_ids: Set<string>,
): void {
  storage.locked(() => {
    const threads = list_threads(storage, doc_id);
    const kept = threads.filter((t) =>
      live_session_ids.has(String(t.session_id ?? "")),
    );
    if (kept.length !== threads.length) {
      _saveExtra(storage, doc_id, "threads", kept);
    }
  });
}

export function block_text(block: Dict, limit = 400): string {
  /** The visible text of one block, for telling the model which line this is. */
  const parts: string[] = [];
  const content = block["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const row = item as Dict;
        parts.push(
          String(row["text"] ?? (row["props"] as Dict | undefined)?.["title"] ?? ""),
        );
      }
    }
  }
  const props = (block["props"] ?? {}) as Dict;
  if (parts.length === 0 && block["type"] === "learning") {
    parts.push(
      `[${String(props["kind"] ?? "learning")} block] ${String(props["prompt"] ?? "")}`,
    );
  }
  const text = parts.join("").split(/\s+/).filter(Boolean).join(" ");
  return text.slice(0, limit);
}

export function card_content(block: Dict | null | undefined): string {
  /** What a card (a learning block, a figure, a table) holds, as Markdown. */
  if (block === null || block === undefined) return "";
  const type = String(block["type"] ?? "");
  if (
    !LEAF_BLOCK_TYPES.has(type) &&
    type !== "table" &&
    type !== "codeBlock"
  ) {
    return "";
  }
  let text: string;
  try {
    text = blocks_to_markdown([{ ...block, children: [] }]).trim();
  } catch {
    return "";
  }
  if ([...text].length > CARD_CONTENT_LIMIT) {
    text = [...text].slice(0, CARD_CONTENT_LIMIT).join("") + "\n…";
  }
  return text;
}

export function thread_anchor_context(
  storage: CoWriterStorage,
  doc_id: string,
  session_id: string,
  opts: { zh?: boolean } = {},
): string {
  /** Which line of the page this conversation is held at, or "". */
  if (!doc_id || !session_id) return "";
  const zh = Boolean(opts.zh);
  const thread = find_thread(storage, doc_id, session_id);
  if (thread === null) return "";
  const doc = storage.loadDocument(doc_id);
  const blockId = String(thread["block_id"] ?? "");
  const block =
    [...walk_blocks(((doc?.blocks ?? []) as Dict[]) ?? [])].find(
      (b) => b["id"] === blockId,
    ) ?? null;
  const quote = String(thread["quote"] ?? "").trim();
  const content = block !== null ? card_content(block) : "";
  const lines: string[] = [];
  if (zh) {
    lines.push(
      `这段对话是在页面的块 ${blockId} 处发起的` +
        (block === null
          ? "（该块已被删除）。"
          : `：「${block_text(block)}」。`),
    );
    if (quote) lines.push(`用户当时选中的文字：「${quote}」。`);
    lines.push(
      "用户说「这里」「这段」「这句」时指的就是它；插入、改写、生成的内容默认放在这个块附近，" +
        "其余部分保持不动。",
    );
    if (content) lines.push(`这个块的内容如下：\n${content}`);
  } else {
    lines.push(
      `This conversation was opened at block ${blockId} of the page` +
        (block === null
          ? " (that block has since been deleted)."
          : `: "${block_text(block)}".`),
    );
    if (quote) lines.push(`The learner had selected: "${quote}".`);
    lines.push(
      '"Here", "this part" and "this sentence" mean that block. Place inserted, ' +
        "rewritten or generated material next to it and leave the rest of the page alone.",
    );
    if (content) lines.push(`The block holds:\n${content}`);
  }
  return lines.join(" ");
}

// Re-export the store helpers the REST router shares.
export { threadStore };
