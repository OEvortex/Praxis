// conversations held at
// one line of a note page.
//
// The transcript itself lives in the chat session; the page only keeps where
// the conversation belongs, so reopening a note restores the margin threads
// without copying messages. Stored beside the page manifest.

import type { CoWriterStorage } from "./storage.js";

const _loadDocument = (s: CoWriterStorage, id: string) => s.loadDocument(id);
const _loadExtra = (s: CoWriterStorage, docId: string, kind: string, dflt: unknown) =>
  s.loadExtra(docId, kind, dflt);
const _saveExtra = (s: CoWriterStorage, docId: string, kind: string, payload: unknown) =>
  s.saveExtra(docId, kind, payload);

export interface Thread {
  session_id?: string;
  block_id?: string;
  quote?: string;
  origin?: string;
  created_at?: number;
  updated_at?: number;
  [k: string]: unknown;
}

const _now = (): number => Date.now() / 1000;

export function list_threads(
  storage: CoWriterStorage,
  doc_id: string,
): Thread[] {
  const raw = _loadExtra(storage, doc_id, "threads", []);
  return Array.isArray(raw) ? (raw as Thread[]) : [];
}

export function anchor(
  storage: CoWriterStorage,
  doc_id: string,
  opts: {
    session_id: string;
    block_id: string;
    quote?: string;
    origin?: string;
  },
): Thread {
  const { session_id, block_id } = opts;
  const quote = opts.quote ?? "";
  const origin = opts.origin ?? "ask";
  if (!session_id) {
    throw new Error("A thread needs a session");
  }
  return storage.locked(() => {
    const doc = _loadDocument(storage, doc_id);
    if (doc === null || doc === undefined) {
      throw new Error("Page not found");
    }
    const threads = list_threads(storage, doc_id);
    const now = _now();
    for (const thread of threads) {
      if (thread.session_id === session_id) {
        thread.block_id = block_id || thread.block_id || "";
        thread.quote = quote || thread.quote || "";
        thread.origin = origin || thread.origin || "ask";
        thread.updated_at = now;
        _saveExtra(storage, doc_id, "threads", threads);
        return thread;
      }
    }
    const thread: Thread = {
      session_id,
      block_id,
      quote,
      origin: origin === "ask" || origin === "generate" ? origin : "ask",
      created_at: now,
      updated_at: now,
    };
    threads.push(thread);
    _saveExtra(storage, doc_id, "threads", threads);
    return thread;
  });
}

export function remove(
  storage: CoWriterStorage,
  doc_id: string,
  session_id: string,
): boolean {
  return storage.locked(() => {
    const threads = list_threads(storage, doc_id);
    const kept = threads.filter((t) => t.session_id !== session_id);
    if (kept.length === threads.length) {
      return false;
    }
    _saveExtra(storage, doc_id, "threads", kept);
    return true;
  });
}
