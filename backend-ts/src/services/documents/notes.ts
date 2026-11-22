// Port of backend/app/services/documents/notes.py — one-time import of legacy
// markdown notes into the Co-Writer notebook.
//
// Older versions wrote standalone markdown files under ``data/notes``; the
// import runs once at startup so those notes remain visible as notebook pages.
// The ``notes/index`` key records which files were already imported.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { get_settings } from "../../config.js";
import { get_state, put_state } from "../../store/database.js";
import { get_co_writer_storage } from "./storage.js";
import type { CoWriterStorage } from "./storage.js";

// ^ anchors at string start (no `m` flag), matching Python's \A.
const _FRONTMATTER = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
const _INDEX_KEY = "notes/index";

function _legacy_dir(): string {
  return join(get_settings().data_dir, "notes");
}

function _load_index(): Record<string, string> {
  const data = get_state<Record<string, unknown>>(
    get_settings(),
    _INDEX_KEY,
    {},
  );
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, string>)
    : {};
}

function _save_index(index: Record<string, string>): void {
  put_state(get_settings(), _INDEX_KEY, index);
}

/** Return [title, tags, body] from a note's YAML-ish frontmatter. */
function _parse_markdown(
  text: string,
  fallback_title: string,
): [string, string[], string] {
  let title = fallback_title;
  let tags: string[] = [];
  let body = text;
  const match = _FRONTMATTER.exec(text);
  if (match) {
    // splitlines() equivalent: handles \n, \r\n, \r and unicode line breaks.
    for (const line of match[1].split(/\r\n|\r|\n|\u2028|\u2029/)) {
      const sep = line.indexOf(":");
      const rawKey = sep === -1 ? line : line.slice(0, sep);
      const rawValue = sep === -1 ? "" : line.slice(sep + 1);
      const key = rawKey.trim().toLowerCase();
      const value = rawValue.trim();
      if (key === "title" && value) {
        title = value;
      } else if (key === "tags" && value) {
        tags = value
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0);
      }
    }
    body = text.slice(match[0].length).replace(/^\n+/, "");
  }
  return [title, tags, body];
}

/** Import notes written by older versions into Co-Writer, once each. */
export function sync_legacy_notes(): void {
  const root = _legacy_dir();
  const storage = get_co_writer_storage();
  const docExists = (id: string) => storage.docExists(id);
  const createDocument = (opts: {
    title?: string;
    content?: string;
    tags?: string[];
  }) => storage.createDocument(opts);
  const index = _load_index();
  let changed = false;
  let names: string[] = [];
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name)
      .sort();
  } catch {
    // No legacy notes directory — nothing to import.
    return;
  }
  for (const name of names) {
    const doc_id = index[name];
    if (doc_id && docExists(doc_id)) {
      continue;
    }
    // errors="replace" equivalent: Node's utf8 decoder substitutes U+FFFD.
    const text = readFileSync(join(root, name), "utf8");
    const stem = name.replace(/\.md$/, "");
    const [title, tags, body] = _parse_markdown(text, stem);
    const doc = createDocument({ title, content: body, tags });
    index[name] = doc.id;
    changed = true;
  }
  if (changed) {
    _save_index(index);
  }
}
