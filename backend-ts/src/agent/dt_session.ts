/**
 * A vtx Session whose persistence is Praxis's session record.
 *
 *
 * The agent talks to a normal ``vtx.agent.session.Session``, so nothing in the
 * vtx runtime needs to change. But instead of writing ``~/.vtx/sessions/<cwd>/*.jsonl``,
 * entries and the header are stored in the Praxis session row
 * (``data/praxis.sqlite3``) under ``vtx_header`` / ``vtx_entries``.
 *
 * A ContextVar binds the Praxis store + record while the runtime creates its
 * session. Sessions created outside that context stay in memory (still no vtx
 * files) — that covers sub-agents and other incidental Session.create() calls.
 *
 * TS port notes: vtx's pydantic entry models are represented as plain
 * type-tagged JSON objects; ``model_validate``/``model_dump`` map to
 * ``validateEntry``/identity. The persistence hook names are kept snake_case to
 * mirror the vtx ``Session`` overrides 1:1.
 */

import { ContextVar } from "./turn_context.js";

// -- session record / store shapes (structural; see ../store/session_store.js) --

export interface SessionRecordDict {
  id: string;
  vtx_header?: Record<string, unknown> | null;
  vtx_entries?: unknown[];
  [k: string]: unknown;
}

export interface SessionStoreLike {
  save(record: SessionRecordDict): void;
  [k: string]: unknown;
}

// -- vtx session entry types ---------------------------------------------------
// vtx.agent.session entry models, flattened to plain JSON objects. The `type`
// discriminator mirrors the pydantic ``type`` literal on each entry class.

export interface VtxSessionEntry {
  type: string;
  id: string;
  target_id?: string | null;
  timestamp?: string | number;
  [k: string]: unknown;
}

export type MessageEntry = VtxSessionEntry & { type: "message" };
export type ThinkingLevelChangeEntry = VtxSessionEntry & { type: "thinking_level_change" };
export type ModelChangeEntry = VtxSessionEntry & { type: "model_change" };
export type CompactionEntry = VtxSessionEntry & { type: "compaction" };
export type CustomMessageEntry = VtxSessionEntry & { type: "custom_message" };
export type HarnessStateEntry = VtxSessionEntry & { type: "harness_state" };
export type SessionInfoEntry = VtxSessionEntry & { type: "session_info" };
export type LeafEntry = VtxSessionEntry & { type: "leaf" };
export type RuntimeCheckpointEntry = VtxSessionEntry & { type: "runtime_checkpoint" };

export type SessionHeader = Record<string, unknown>;

const ENTRY_TYPES: ReadonlySet<string> = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "custom_message",
  "harness_state",
  "session_info",
  "leaf",
  "runtime_checkpoint",
]);

/**
 * Minimal stand-in for pydantic ``model_validate``: accepts a plain object
 * with a known ``type`` and string ``id``, returns it as a session entry.
 * Returns null (and the caller skips) on anything malformed — same as the
 * Python ``except Exception: continue`` path.
 */
function validateEntry(data: unknown): VtxSessionEntry | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.type !== "string" || !ENTRY_TYPES.has(d.type)) return null;
  if (typeof d.id !== "string" || !d.id) return null;
  return d as VtxSessionEntry;
}

const _SESSION_CONTEXT = new ContextVar<[SessionStoreLike, SessionRecordDict] | null>(null);

export function bind(store: SessionStoreLike, record: SessionRecordDict) {
  /** Bind a Praxis session for the duration of a ContextManager block. */
  return _SESSION_CONTEXT.set([store, record]);
}

export function unbind(token: { prev: [SessionStoreLike, SessionRecordDict] | null }): void {
  _SESSION_CONTEXT.reset(token);
}

export function rebind(
  session: PraxisSession,
  store: SessionStoreLike,
  record: SessionRecordDict,
): void {
  /**
   * Point an already-created vtx Session at this turn's record.
   *
   * ConversationRuntime is cached per Praxis session, but ``startTurn``
   * loads a fresh dict on every turn. Without this, vtx keeps writing its
   * entries into the first turn's dict while the turn-end save persists the
   * fresh one — so the model only ever sees the first turn's history.
   */
  if (session._dt_store === store && session._dt_record === record) return;
  session._dt_store = store;
  session._dt_record = record;
}

/**
 * Session with Praxis-backed persistence and no JSONL on disk.
 *
 * Mirrors ``vtx.agent.session.Session``'s persistence-relevant state
 * (``_header``, ``_entries``, ``_by_id``, ``_leaf_id``,
 * ``_persisted_entries_count``, ``_flushed``) and its persistence hooks
 * (``_persist_entry`` / ``_write_all`` / ``ensure_persisted``).
 */
export class PraxisSession {
  _dt_store: SessionStoreLike | null = null;
  _dt_record: SessionRecordDict | null = null;

  _header: SessionHeader | null = null;
  _entries: VtxSessionEntry[] = [];
  _by_id: Map<string, VtxSessionEntry> = new Map();
  _leaf_id: string | null = null;
  _persisted_entries_count = 0;
  _flushed = false;

  constructor() {
    const context = _SESSION_CONTEXT.get();
    this._dt_store = context ? context[0] : null;
    this._dt_record = context ? context[1] : null;
    // Persistence is handled by the overrides below, not by vtx's file I/O.
    // (Python passes kwargs["persist"] = True to super().__init__.)
    this._load_from_record();
  }

  _load_from_record(): void {
    const record = this._dt_record;
    if (!record) return;
    const headerData = record.vtx_header;
    if (typeof headerData === "object" && headerData !== null) {
      this._header = headerData as SessionHeader;
    }
    const entries: VtxSessionEntry[] = [];
    for (const raw of record.vtx_entries ?? []) {
      try {
        const data = typeof raw === "string" ? JSON.parse(raw) : raw;
        const entry = validateEntry(data);
        if (entry !== null) entries.push(entry);
      } catch {
        continue;
      }
    }
    this._entries = entries;
    this._by_id = new Map(entries.map((e) => [e.id, e]));
    this._leaf_id = null;
    for (const entry of entries) {
      this._leaf_id =
        entry.type === "leaf"
          ? ((entry.target_id ?? null) as string | null)
          : entry.id;
    }
    this._persisted_entries_count = entries.length;
    this._flushed = true;
  }

  _write_record(): void {
    if (this._dt_store === null || this._dt_record === null) return;
    this._dt_record.vtx_header = this._header ?? null;
    // model_dump_json() equivalent: entries are already plain JSON objects.
    this._dt_record.vtx_entries = this._entries.map((e) => JSON.stringify(e));
    this._dt_store.save(this._dt_record);
  }

  // -- vtx persistence hooks --------------------------------------------------

  _persist_entry(_entry: VtxSessionEntry): void {
    this._write_record();
  }

  _write_all(): void {
    this._write_record();
  }

  ensure_persisted(): void {
    this._write_record();
  }
}
