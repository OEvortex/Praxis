// Port of deeptutor/book/chat_sessions.py — mark chat sessions that belong to
// a book page so the chat UI can route them back to the book reader.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { get_settings } from "../../config.js";

export interface ChatSessionRecord {
  id: string;
  [k: string]: unknown;
}

function session_path(session_id: string): string | null {
  const clean = (session_id ?? "").trim();
  if (!clean || /[^A-Za-z0-9_-]/.test(clean)) return null;
  return join(get_settings().data_dir, "sessions", `${clean}.json`);
}

function load_session(session_id: string): Record<string, unknown> | null {
  const path = session_path(session_id);
  if (!path || !existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function save_session(path: string, data: Record<string, unknown>): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

/** Tag a chat session as belonging to a book page. Best-effort: missing
 * session files are ignored so book flows never break on stale links. */
export async function tag_book_chat_session(
  session_id: string,
  ref: { book_id: string; page_id: string },
): Promise<boolean> {
  const path = session_path(session_id);
  if (!path || !existsSync(path)) return false;
  const session = load_session(session_id);
  if (!session) return false;
  const metadata = (session["metadata"] as Record<string, unknown>) ?? {};
  metadata["book"] = { book_id: ref.book_id, page_id: ref.page_id };
  session["metadata"] = metadata;
  try {
    save_session(path, session);
    return true;
  } catch {
    return false;
  }
}
