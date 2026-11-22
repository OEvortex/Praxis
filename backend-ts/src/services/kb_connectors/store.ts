// KB registry + filesystem layout for connector-backed knowledge bases.
//
// Upstream keeps KB entries in ``data/knowledge_bases/kb_config.json`` and each
// KB's payload under ``<base>/<name>/``. Here the registry row lives in the
// shared SQLite ``kb_meta`` table (the same table ``store/kb_store.ts`` owns),
// so connector KBs show up in ``KnowledgeBaseStore.list()`` automatically.
// The entry payload carries the upstream ``kb_config.json`` fields verbatim
// (``type``, ``vault_path``, ``external_path``, ``server_url``, ``api_key``,
// ``knowledge_base_id``, ``zim_name``, ``linked_folders``, ...).
//
// On-disk layout mirrors upstream under ``<data_dir>/knowledge_bases``:
//
//     <data_dir>/knowledge_bases/<name>/raw/...   managed raw documents
//     <data_dir>/knowledge_bases/<name>/visual_assets/...
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { Settings } from "../../config.js";
import * as database from "../../store/database.js";
import { isConnectedKb, type AnyRecord } from "./types.js";

export class KbConnectorError extends Error {}

// -- name validation (knowledge/naming.py) ------------------------------------

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const FORBIDDEN_CHARS = new Set('<>:"/\\|?*#%');
const MAX_KB_NAME_LENGTH = 120;

export function validateKnowledgeBaseName(name: string): string {
  const normalized = String(name ?? "")
    .normalize("NFC")
    .trim();
  if (!normalized) throw new KbConnectorError("Knowledge base name is required");
  if (normalized === "." || normalized === "..") {
    throw new KbConnectorError("Knowledge base name cannot be '.' or '..'");
  }
  if (normalized.length > MAX_KB_NAME_LENGTH) {
    throw new KbConnectorError(
      `Knowledge base name is too long; maximum length is ${MAX_KB_NAME_LENGTH}`,
    );
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new KbConnectorError(
      "Knowledge base name cannot contain control characters",
    );
  }
  const forbidden = [...normalized].filter((ch) => FORBIDDEN_CHARS.has(ch));
  if (forbidden.length) {
    throw new KbConnectorError(
      `Knowledge base name contains reserved characters: ${[...new Set(forbidden)].sort().join(" ")}. ` +
        "Avoid path or URL separators such as /, \\, ?, #, and %.",
    );
  }
  return normalized;
}

// -- paths --------------------------------------------------------------------

export function kbBaseDir(settings: Settings): string {
  return join(resolve(String(settings.data_dir ?? "./data")), "knowledge_bases");
}

export function kbDir(settings: Settings, name: string): string {
  return join(kbBaseDir(settings), name);
}

export function rawDir(settings: Settings, name: string): string {
  return join(kbDir(settings, name), "raw");
}

export function visualAssetsDir(settings: Settings, name: string): string {
  return join(kbDir(settings, name), "visual_assets");
}

// -- registry (kb_meta rows) ---------------------------------------------------

function _metaRow(settings: Settings, name: string): AnyRecord | null {
  const connection = database.connect(settings);
  try {
    const row = connection
      .prepare("SELECT payload FROM kb_meta WHERE name = ?")
      .get(name) as { payload: string } | undefined;
    if (row === undefined) return null;
    try {
      const payload: unknown = JSON.parse(row.payload);
      return payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as AnyRecord)
        : null;
    } catch {
      return null;
    }
  } finally {
    connection.close();
  }
}

function _saveMeta(settings: Settings, name: string, payload: AnyRecord): void {
  const connection = database.connect(settings);
  try {
    connection
      .prepare(
        `INSERT INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload,
             updated_at = excluded.updated_at`,
      )
      .run(name, JSON.stringify(payload), Date.now() / 1000);
  } finally {
    connection.close();
  }
}

/** The KB's registry entry (upstream ``kb_config.json`` row), or null. */
export function getKbEntry(settings: Settings, name: string): AnyRecord | null {
  const entry = _metaRow(settings, String(name ?? "").trim());
  if (entry === null) return null;
  // Keep the upstream entry shape: payload fields are the entry; `name` is the key.
  const out = { ...entry };
  out["name"] = out["name"] ?? name;
  return out;
}

export function kbEntryExists(settings: Settings, name: string): boolean {
  return _metaRow(settings, name) !== null;
}

export function listKbNames(settings: Settings): string[] {
  const connection = database.connect(settings);
  try {
    const rows = connection
      .prepare("SELECT name FROM kb_meta ORDER BY name")
      .all() as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    connection.close();
  }
}

export function updateKbEntry(
  settings: Settings,
  name: string,
  mutate: (entry: AnyRecord) => void,
): AnyRecord {
  const entry = getKbEntry(settings, name);
  if (entry === null) {
    throw new KbConnectorError(`Knowledge base not found: ${name}`);
  }
  mutate(entry);
  entry["updated_at"] = new Date().toISOString();
  _saveMeta(settings, name, entry);
  return entry;
}

export function registerKbEntry(settings: Settings, name: string, entry: AnyRecord): AnyRecord {
  const existing = getKbEntry(settings, name);
  if (existing !== null) {
    throw new KbConnectorError(`A knowledge base named '${name}' already exists.`);
  }
  const now = new Date().toISOString();
  const payload: AnyRecord = {
    name,
    created_at: now,
    last_updated: now,
    ...entry,
  };
  payload["created_at"] = payload["created_at"] ?? now;
  _saveMeta(settings, name, payload);
  return payload;
}

/** Upstream ``_connected_kb_registration``: validate name + reject clashes. */
export function assertNameAvailable(settings: Settings, rawName: string): string {
  const name = validateKnowledgeBaseName(rawName);
  if (kbEntryExists(settings, name)) {
    throw new KbConnectorError(`A knowledge base named '${name}' already exists.`);
  }
  return name;
}

// -- default KB -----------------------------------------------------------------

const DEFAULT_KB_KEY = "knowledge_bases/default";

export function getDefaultKb(settings: Settings): string | null {
  const value = database.get_state<unknown>(settings, DEFAULT_KB_KEY);
  if (typeof value === "string" && value) {
    const names = listKbNames(settings);
    if (names.includes(value)) return value;
  }
  const names = listKbNames(settings);
  return names.length ? names[0] : null;
}

export function setDefaultKb(settings: Settings, name: string): void {
  if (!kbEntryExists(settings, name)) {
    throw new KbConnectorError(`Knowledge base not found: ${name}`);
  }
  database.put_state(settings, DEFAULT_KB_KEY, name);
}

// -- KB status / progress ---------------------------------------------------------

export function updateKbStatus(
  settings: Settings,
  name: string,
  status: string,
  progress?: AnyRecord | null,
): void {
  updateKbEntry(settings, name, (entry) => {
    entry["status"] = status;
    if (progress !== undefined) {
      if (progress === null) {
        delete entry["progress"];
        delete entry["last_error"];
      } else {
        entry["progress"] = progress;
        entry["last_error"] = progress["error"] ?? progress["message"] ?? null;
        entry["last_error_at"] = progress["timestamp"] ?? new Date().toISOString();
      }
    }
  });
}

// -- linked folders (upstream stores them in <kb>/metadata.json) -------------------

export function getLinkedFolders(settings: Settings, name: string): AnyRecord[] {
  const entry = getKbEntry(settings, name);
  if (entry === null) {
    throw new KbConnectorError(`Knowledge base not found: ${name}`);
  }
  const folders = entry["linked_folders"];
  return Array.isArray(folders) ? (folders as AnyRecord[]) : [];
}

export function saveLinkedFolders(
  settings: Settings,
  name: string,
  folders: AnyRecord[],
): void {
  updateKbEntry(settings, name, (entry) => {
    entry["linked_folders"] = folders;
  });
}

// -- misc -------------------------------------------------------------------------

/** md5(path)[:8] — upstream folder id scheme. */
export function folderIdForPath(folderPath: string): string {
  return createHash("md5").update(folderPath, "utf8").digest("hex").slice(0, 8);
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function* walkFiles(root: string): Generator<string> {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(p);
    } else if (entry.isFile()) {
      yield p;
    }
  }
}

/** Resolve ``rel`` inside ``root``, rejecting traversal. Returns null on escape. */
export function safeJoin(root: string, rel: string): string | null {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, rel);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + sep)) {
    return null;
  }
  return target;
}

export { existsSync, mkdirSync, statSync, dirname, join };
