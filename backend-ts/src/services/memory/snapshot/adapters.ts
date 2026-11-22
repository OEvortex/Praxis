// Port of deeptutor/services/memory/snapshot/adapters.py — workspace → Entity
// adapters, one read-only function per surface.
//
// Backend differences vs upstream (single-user Praxis deployment):
//   * chat   → `sessions`/`messages` tables in the shared SQLite DB
//              (upstream read a separate chat-history sqlite per workspace).
//   * notebook → `notebooks` ext_items collection (each item carries
//              `records[]`, same shape upstream read from per-notebook JSON).
//   * cowriter → `documents` table via CoWriterStorage (upstream read
//              per-doc manifest.json dirs).
//   * kb     → `kb_meta`/`kb_docs`/`kb_chunks` tables (upstream read
//              kb_config.json + index versions).
//   * book / partner / quiz → no such stores in this deployment; adapters
//              return [] (TODO: wire when those surfaces are ported).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { get_settings } from "../../../config.js";
import { query, queryOne } from "../../../shared/db.js";
import * as database from "../../../store/database.js";
import { getCoWriterStorage } from "../../documents/storage.js";
import type { Surface } from "../paths.js";
import type { Dict } from "../../../shared/types.js";
import type { Entity, EntityStamp } from "./entity.js";

// ── Helpers ──────────────────────────────────────────────────────────

export function sha1(...parts: unknown[]): string {
  const h = createHash("sha1");
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    const blob =
      typeof part === "object"
        ? JSON.stringify(part, Object.keys(part as Dict).sort())
        : String(part);
    // JSON.stringify with a sorted key array only sorts top-level keys; for
    // fingerprint purposes a stable stringify of nested objects is nice-to-
    // have — sort recursively instead.
    h.update(stableStringify(part) ?? blob);
    h.update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Dict)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function iso(ts: unknown): string {
  if (typeof ts === "string") {
    const n = Number(ts);
    if (!Number.isNaN(n) && ts.trim() !== "" && /^-?\d+(\.\d+)?$/.test(ts.trim())) {
      const d = new Date(n > 1e12 ? n : n * 1000);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const parsed = new Date(ts);
    if (!Number.isNaN(parsed.getTime())) return ts;
    return "";
  }
  if (typeof ts === "number" && Number.isFinite(ts)) {
    // Upstream timestamps were epoch seconds (or ms); our DB stores seconds.
    const ms = ts > 1e12 ? ts : ts * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}

function settings() {
  return get_settings();
}

// ── notebook ─────────────────────────────────────────────────────────

export function read_notebook_entities(): Entity[] {
  const notebooks = database.list_items(settings(), "notebooks") as Dict[];
  const out: Entity[] = [];
  for (const nb of notebooks) {
    const nbId = String(nb["id"] ?? "");
    const nbName = String(nb["name"] ?? nbId);
    if (!nbId) continue;
    const records = Array.isArray(nb["records"]) ? (nb["records"] as Dict[]) : [];
    for (const r of records) {
      const rid = String(r["id"] ?? "");
      if (!rid) continue;
      const title = String(r["title"] ?? "") || "";
      const userQuery = String(r["user_query"] ?? "") || "";
      const output = String(r["output"] ?? "") || "";
      const summary = String(r["summary"] ?? "") || "";
      const content = [
        title ? `# ${title}` : "",
        userQuery ? `**User query**: ${userQuery}` : "",
        summary ? `**Summary**: ${summary}` : "",
        output,
      ]
        .filter(Boolean)
        .join("\n\n");
      out.push({
        id: rid,
        label: title ? `${title} · ${nbName}` : `(${rid}) · ${nbName}`,
        ts: iso(r["created_at"]),
        content,
        metadata: {
          notebook_id: nbId,
          notebook_name: nbName,
          record_type: String(r["record_type"] ?? ""),
          kb_name: r["kb_name"] ?? null,
        },
        fingerprint: sha1(title, userQuery, output, summary),
      });
    }
  }
  return out;
}

// ── cowriter ─────────────────────────────────────────────────────────

export function read_cowriter_entities(): Entity[] {
  const storage = getCoWriterStorage();
  const out: Entity[] = [];
  for (const summary of storage.listDocuments()) {
    const doc = storage.loadDocument(summary.id);
    if (!doc) continue;
    const title = doc.title || summary.title || "";
    const content = doc.content || "";
    out.push({
      id: doc.id,
      label: title || doc.id,
      ts: iso(doc.updated_at || doc.created_at),
      content,
      metadata: { doc_id: doc.id, title },
      fingerprint: sha1(title, content),
    });
  }
  return out;
}

// ── book ─────────────────────────────────────────────────────────────

export function read_book_entities(): Entity[] {
  // No book store in this deployment (see handlers.ts source-library note).
  return [];
}

// ── partner ──────────────────────────────────────────────────────────

export function read_partner_entities(): Entity[] {
  // Partner session JSONL stores are not ported; ext_items stubs only.
  return [];
}

// ── kb ───────────────────────────────────────────────────────────────

export function read_kb_entities(): Entity[] {
  const rows = query<Record<string, unknown>>(
    "SELECT name, payload FROM kb_meta ORDER BY name",
  );
  const out: Entity[] = [];
  for (const row of rows) {
    let meta: Dict = {};
    try {
      meta = JSON.parse(String(row["payload"] ?? "{}")) as Dict;
    } catch {
      meta = {};
    }
    const kbName = String(meta["name"] ?? row["name"] ?? "");
    if (!kbName) continue;
    const description = String(meta["description"] ?? "") || "";
    const lastUpdated = meta["last_updated"] ?? meta["updated_at"] ?? "";
    const content = [
      `# ${kbName}`,
      description,
      `Index versions: ${meta["index_versions"] ? (meta["index_versions"] as unknown[]).length : ""}`,
    ]
      .filter((p) => p !== "" && !p.endsWith(":"))
      .join("\n\n");
    out.push({
      id: kbName,
      label: kbName,
      ts: iso(lastUpdated),
      content,
      metadata: {
        kb_name: kbName,
        version_count: Array.isArray(meta["index_versions"])
          ? (meta["index_versions"] as unknown[]).length
          : 0,
        rag_provider: String(meta["rag_provider"] ?? ""),
      },
      fingerprint: sha1(description, meta["index_versions"] ?? [], lastUpdated),
    });
  }
  return out;
}

// ── chat ─────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  title: string | null;
  created_at: number;
  updated_at: number;
}
interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: number;
}

export function read_chat_entities(): Entity[] {
  const out: Entity[] = [];
  const sessions = query<SessionRow>(
    "SELECT id, title, created_at, updated_at FROM sessions ORDER BY updated_at DESC",
  );
  const lastMsg = new Map<string, number>();
  for (const row of query<{ session_id: string; id: number }>(
    `SELECT session_id, id FROM (
       SELECT session_id, id,
              ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rn
       FROM messages
     ) WHERE rn = 1`,
  )) {
    lastMsg.set(row.session_id, Number(row.id));
  }
  for (const sess of sessions) {
    const msgs = query<MessageRow>(
      "SELECT id, session_id, role, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC, id ASC",
      sess.id,
    );
    const blocks: string[] = [];
    for (const m of msgs) {
      const body = (m.content ?? "").trim();
      if (!body) continue;
      blocks.push(`### ${m.role}\n${body}`);
    }
    const content = blocks.join("\n\n");
    const lastId = msgs.length ? Number(msgs[msgs.length - 1].id) : 0;
    out.push({
      id: sess.id,
      label: sess.title || sess.id,
      ts: iso(sess.updated_at),
      content,
      metadata: {
        session_id: sess.id,
        message_count: msgs.length,
      },
      fingerprint: sha1(lastId, sess.updated_at),
    });
  }
  return out;
}

// ── quiz ─────────────────────────────────────────────────────────────

export function read_quiz_entities(): Entity[] {
  // Upstream read `notebook_entries` from the chat-history DB; that table is
  // not part of this deployment's schema. TODO when quiz attempts land.
  return [];
}

// ── Probes ───────────────────────────────────────────────────────────

export function probe_chat_entities(): EntityStamp[] {
  const out: EntityStamp[] = [];
  const sessions = query<SessionRow>(
    "SELECT id, title, updated_at FROM sessions ORDER BY updated_at DESC",
  );
  const lastMsg = new Map<string, number>();
  try {
    for (const row of query<{ session_id: string; id: number }>(
      `SELECT session_id, id FROM (
         SELECT session_id, id,
                ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rn
         FROM messages
       ) WHERE rn = 1`,
    )) {
      lastMsg.set(row.session_id, Number(row.id));
    }
  } catch {
    // messages table may not exist yet on a fresh DB
  }
  for (const sess of sessions) {
    out.push({
      id: sess.id,
      label: sess.title || sess.id,
      fingerprint: sha1(lastMsg.get(sess.id) ?? 0, sess.updated_at),
      ts: iso(sess.updated_at),
    });
  }
  return out;
}

// ── Dispatch ─────────────────────────────────────────────────────────

const READERS: Record<Surface, () => Entity[]> = {
  notebook: read_notebook_entities,
  cowriter: read_cowriter_entities,
  book: read_book_entities,
  partner: read_partner_entities,
  kb: read_kb_entities,
  chat: read_chat_entities,
  quiz: read_quiz_entities,
};

const PROBES: Partial<Record<Surface, () => EntityStamp[]>> = {
  chat: probe_chat_entities,
};

export function read_entities(surface: Surface): Entity[] {
  const reader = READERS[surface];
  if (!reader) return [];
  try {
    return reader();
  } catch {
    return [];
  }
}

export function read_stamps(surface: Surface): EntityStamp[] {
  const probe = PROBES[surface];
  if (probe) {
    try {
      return probe();
    } catch {
      // fall through to full read
    }
  }
  return read_entities(surface).map((e) => ({
    id: e.id,
    label: e.label,
    fingerprint: e.fingerprint,
    ts: e.ts,
  }));
}

export const SUPPORTED_SURFACES = Object.keys(READERS) as Surface[];

// Re-exports for callers that want the upstream names.
export { existsSync, readFileSync, join, queryOne };
