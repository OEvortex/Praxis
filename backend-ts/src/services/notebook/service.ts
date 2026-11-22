// shared notebook manager.
//
// Favorites notebooks are plain JSON files under
// `<data_dir>/user/workspace/notebook/` (`{id}.json` + `notebooks_index.json`),
// the same layout the web client documents ("file-backed under
// data/user/workspace/notebook"). Method names keep the Python snake_case
// surface so the ported router can call them unchanged.
//
// Python guards every read-modify-write cycle with per-notebook RLocks; Node
// is single-threaded and every filesystem call below is synchronous, so no
// `await` can interleave between a load and its save — the same mutual
// exclusion holds without explicit locks.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { get_settings, type Settings } from "../../config.js";
import { cleanThinkingTags } from "../llm_text.js";
import type { Dict } from "../../shared/types.js";

export const RECORD_TYPES = [
  "solve",
  "question",
  "research",
  "chat",
  "co_writer",
  "tutorbot",
  "reading",
  "video_learning",
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export interface NotebookRecord {
  id: string;
  type: string;
  title: string;
  summary?: string;
  user_query: string;
  output: string;
  metadata?: Dict;
  created_at: number;
  kb_name?: string | null;
  [k: string]: unknown;
}

export interface Notebook {
  id: string;
  name: string;
  description?: string;
  created_at: number;
  updated_at: number;
  records?: NotebookRecord[];
  color?: string;
  icon?: string;
  [k: string]: unknown;
}

/** Thrown when a notebook file exists but its JSON cannot be parsed. */
export class NotebookCorruptedError extends Error {
  notebook_id: string;
  path: string;
  cause: unknown;
  constructor(notebook_id: string, path: string, cause: unknown) {
    super(
      `Notebook ${JSON.stringify(notebook_id)} is unreadable (${path}): ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = "NotebookCorruptedError";
    this.notebook_id = notebook_id;
    this.path = path;
    this.cause = cause;
  }
}

/** Raised by move_record when the destination holds a different version. */
export class NotebookMoveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotebookMoveConflictError";
  }
}

// Sentinel mirroring Python's ``kb_name=_UNSET`` default argument.
const _UNSET = Symbol("unset");
export type Unset = typeof _UNSET;
export { _UNSET as UNSET };

function _clean_record_summary(summary: unknown): string {
  return cleanThinkingTags(String(summary ?? "")).trim();
}

/** Port of services/file_io.atomic_write_json — never expose a partial file. */
function atomicWriteJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      /* already moved */
    }
  }
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export class NotebookManager {
  base_dir: string;
  index_file: string;
  private settings: Settings;

  constructor(base_dir?: string | null, settings?: Settings) {
    this.settings = settings ?? get_settings();
    this.base_dir = resolve(
      base_dir ??
        join(this.settings.data_dir, "user", "workspace", "notebook"),
    );
    mkdirSync(this.base_dir, { recursive: true });
    this.index_file = join(this.base_dir, "notebooks_index.json");
    this._ensure_index();
  }

  /** Synchronous critical section; see the module header for why it's a no-op. */
  locked<T>(fn: () => T): T {
    return fn();
  }

  private _ensure_index(): void {
    if (!existsSync(this.index_file)) {
      atomicWriteJson(this.index_file, { notebooks: [] });
    }
  }

  private _load_index(): Dict {
    try {
      const data = readJsonFile(this.index_file);
      return data !== null && typeof data === "object" && !Array.isArray(data)
        ? (data as Dict)
        : { notebooks: [] };
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") {
        return { notebooks: [] };
      }
      // The index is a derived cache: every entry can be rebuilt from the
      // notebook files themselves, so recovering here loses nothing.
      console.warn(
        `notebook index unreadable (${String(exc)}); rebuilding`,
      );
      return { notebooks: this._rebuild_index_entries() };
    }
  }

  private _rebuild_index_entries(): Dict[] {
    const entries: Dict[] = [];
    for (const name of readdirSync(this.base_dir).sort()) {
      if (!name.endsWith(".json") || join(this.base_dir, name) === this.index_file) {
        continue;
      }
      const path = join(this.base_dir, name);
      try {
        const notebook = readJsonFile(path) as Dict;
        entries.push(NotebookManager._index_row(notebook));
      } catch (exc) {
        // The file is left untouched on disk, so the damage stays visible
        // and repairable: list_notebooks() re-adopts it as an `unreadable`
        // entry instead of the notebook quietly vanishing.
        console.warn(
          `notebook file ${path} is unreadable (${String(exc)}); excluded from the rebuilt index`,
        );
      }
    }
    return entries;
  }

  private static _index_row(notebook: Dict): Dict {
    return {
      id: notebook["id"],
      name: notebook["name"] ?? "",
      description: notebook["description"] ?? "",
      created_at: notebook["created_at"] ?? 0,
      updated_at: notebook["updated_at"] ?? 0,
      record_count: Array.isArray(notebook["records"])
        ? (notebook["records"] as unknown[]).length
        : 0,
      color: notebook["color"] ?? "#3B82F6",
      icon: notebook["icon"] ?? "book",
    };
  }

  private _save_index(index: Dict): void {
    atomicWriteJson(this.index_file, index);
  }

  private _get_notebook_file(notebook_id: string): string {
    const base = resolve(this.base_dir);
    const target = resolve(base, `${notebook_id}.json`);
    if (target !== base && !target.startsWith(base + sep)) {
      throw new Error(`notebook id escapes base directory: ${JSON.stringify(notebook_id)}`);
    }
    return target;
  }

  private _load_notebook(
    notebook_id: string,
    opts: { read_only?: boolean } = {},
  ): Dict | null {
    /** Return the notebook, or null when no such file exists.

     * A file that exists but cannot be parsed raises NotebookCorruptedError
     * rather than returning null — conflating the two is what made damaged
     * notebooks look deleted. ``read_only`` sanitizes the returned copy
     * without persisting repairs.
     */
    const filepath = this._get_notebook_file(notebook_id);
    if (!existsSync(filepath)) return null;
    let notebook: Dict;
    try {
      notebook = readJsonFile(filepath) as Dict;
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException).code === "ENOENT") return null;
      console.error(
        `notebook ${notebook_id} failed to load from ${filepath}: ${String(exc)}`,
      );
      throw new NotebookCorruptedError(notebook_id, filepath, exc);
    }
    if (this._sanitize_loaded_notebook(notebook) && !opts.read_only) {
      try {
        this._save_notebook(notebook_id, notebook);
      } catch {
        console.warn(`could not persist sanitized notebook ${notebook_id}`);
      }
    }
    return notebook;
  }

  private _sanitize_loaded_notebook(notebook: Dict): boolean {
    let changed = false;
    const records = notebook["records"];
    if (!Array.isArray(records)) return false;
    for (const record of records) {
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        continue;
      }
      const row = record as Dict;
      const raw = row["summary"] ?? "";
      const cleaned = _clean_record_summary(raw);
      if (cleaned !== raw) {
        row["summary"] = cleaned;
        changed = true;
      }
    }
    return changed;
  }

  private _save_notebook(notebook_id: string, notebook: Dict): void {
    atomicWriteJson(this._get_notebook_file(notebook_id), notebook);
  }

  private _touch_index_entry(notebook_id: string, notebook: Dict): void {
    /** Refresh this notebook's index row, re-adding it if it went missing. */
    const index = this._load_index();
    const rows = (index["notebooks"] ??= []) as Dict[];
    const row = NotebookManager._index_row(notebook);
    const position = rows.findIndex((nb) => nb["id"] === notebook_id);
    if (position >= 0) {
      // Keep created_at from the index when the file lacks it.
      row["created_at"] =
        notebook["created_at"] ?? rows[position]["created_at"] ?? 0;
      rows[position] = row;
    } else {
      rows.push(row);
    }
    this._save_index(index);
  }

  // === Notebook Operations ===

  create_notebook(
    name: string,
    description = "",
    color = "#3B82F6",
    icon = "book",
  ): Notebook {
    const notebook_id = randomUUID().replace(/-/g, "").slice(0, 8);
    const now = Date.now() / 1000;
    const notebook: Notebook = {
      id: notebook_id,
      name,
      description,
      created_at: now,
      updated_at: now,
      records: [],
      color,
      icon,
    };
    this.locked(() => {
      this._save_notebook(notebook_id, notebook as unknown as Dict);
      this._touch_index_entry(notebook_id, notebook as unknown as Dict);
    });
    return notebook;
  }

  get_or_create_notebook(
    name: string,
    description = "",
    color = "#3B82F6",
    icon = "book",
  ): Notebook {
    /** Return an existing notebook with this exact name, or create one. */
    const index = this._load_index();
    const rows = (index["notebooks"] ?? []) as Dict[];
    for (const row of rows) {
      if (row["name"] !== name) continue;
      const notebook_id = String(row["id"] ?? "");
      const notebook = notebook_id
        ? this._load_notebook(notebook_id)
        : null;
      if (notebook) return notebook as unknown as Notebook;
    }
    return this.create_notebook(name, description, color, icon);
  }

  list_notebooks(): Dict[] {
    /** List every notebook on disk, newest first.

     * Rows come from the index rather than from parsing each notebook in
     * full, and the index is reconciled against the directory first, so a
     * notebook whose index row was lost still shows up. A notebook whose
     * file is damaged is reported with ``unreadable`` set instead of being
     * dropped — silently omitting it is what made data look deleted.
     */
    const damaged: Dict[] = [];
    const index = this._load_index();
    const rows = new Map<string, Dict>();
    for (const row of (index["notebooks"] ?? []) as Dict[]) {
      if (row["id"]) rows.set(String(row["id"]), row);
    }

    const onDisk = new Set<string>();
    for (const name of readdirSync(this.base_dir)) {
      if (name.endsWith(".json") && join(this.base_dir, name) !== this.index_file) {
        onDisk.add(name.slice(0, -".json".length));
      }
    }
    // Drop rows whose file is gone; adopt files the index never learned
    // about. Only the unknown files are parsed — indexed ones are taken
    // at their word, which keeps listing O(index) rather than O(content).
    let changed = false;
    for (const notebook_id of [...rows.keys()]) {
      if (!onDisk.has(notebook_id)) {
        rows.delete(notebook_id);
        changed = true;
      }
    }
    for (const notebook_id of [...onDisk].filter((id) => !rows.has(id)).sort()) {
      let notebook: Dict | null;
      try {
        notebook = this._load_notebook(notebook_id);
      } catch (exc) {
        if (exc instanceof NotebookCorruptedError) {
          // Surface it as a placeholder instead of dropping it: the
          // file is still on disk and the user needs to know that.
          damaged.push({ id: notebook_id, unreadable: true });
          continue;
        }
        throw exc;
      }
      if (notebook) {
        rows.set(notebook_id, NotebookManager._index_row(notebook));
        changed = true;
      }
    }
    if (changed) {
      this._save_index({ notebooks: [...rows.values()] });
    }

    const notebooks: Dict[] = [...rows.entries()].map(([notebook_id, row]) => ({
      id: notebook_id,
      name: row["name"] ?? "",
      description: row["description"] ?? "",
      created_at: row["created_at"] ?? 0,
      updated_at: row["updated_at"] ?? 0,
      record_count: row["record_count"] ?? 0,
      color: row["color"] ?? "#3B82F6",
      icon: row["icon"] ?? "book",
    }));
    notebooks.sort((a, b) => Number(b["updated_at"]) - Number(a["updated_at"]));

    // Damaged notebooks have no trustworthy metadata to sort by, so they
    // ride at the end with just enough for the UI to flag them.
    for (const entry of damaged) {
      notebooks.push({
        id: entry["id"],
        name: entry["id"],
        description: "",
        created_at: 0,
        updated_at: 0,
        record_count: 0,
        color: "#3B82F6",
        icon: "book",
        unreadable: true,
      });
    }
    return notebooks;
  }

  get_notebook(notebook_id: string): Dict | null {
    return this._load_notebook(notebook_id);
  }

  update_notebook(
    notebook_id: string,
    opts: {
      name?: string | null;
      description?: string | null;
      color?: string | null;
      icon?: string | null;
    } = {},
  ): Dict | null {
    const { name = null, description = null, color = null, icon = null } = opts;
    return this.locked(() => {
      const notebook = this._load_notebook(notebook_id);
      if (!notebook) return null;

      if (name !== null && name !== undefined) notebook["name"] = name;
      if (description !== null && description !== undefined) {
        notebook["description"] = description;
      }
      if (color !== null && color !== undefined) notebook["color"] = color;
      if (icon !== null && icon !== undefined) notebook["icon"] = icon;

      notebook["updated_at"] = Date.now() / 1000;
      this._save_notebook(notebook_id, notebook);
      this._touch_index_entry(notebook_id, notebook);
      return notebook;
    });
  }

  delete_notebook(notebook_id: string): boolean {
    return this.locked(() => {
      const filepath = this._get_notebook_file(notebook_id);
      if (!existsSync(filepath)) return false;
      unlinkSync(filepath);
      const index = this._load_index();
      index["notebooks"] = ((index["notebooks"] ?? []) as Dict[]).filter(
        (nb) => nb["id"] !== notebook_id,
      );
      this._save_index(index);
      return true;
    });
  }

  // === Record Operations ===

  add_record(opts: {
    notebook_ids: string[];
    record_type: RecordType | string;
    title: string;
    user_query: string;
    output: string;
    summary?: string;
    metadata?: Dict | null;
    kb_name?: string | null;
  }): { record: NotebookRecord; added_to_notebooks: string[] } {
    const record_id = randomUUID().replace(/-/g, "").slice(0, 8);
    const now = Date.now() / 1000;
    const resolved_type = String(opts.record_type);
    if (!RECORD_TYPES.includes(resolved_type as RecordType)) {
      throw new Error(`Unknown record type: ${resolved_type}`);
    }

    const record: NotebookRecord = {
      id: record_id,
      type: resolved_type,
      title: opts.title,
      summary: _clean_record_summary(opts.summary ?? ""),
      user_query: opts.user_query,
      output: opts.output,
      metadata: opts.metadata ?? {},
      created_at: now,
      kb_name: opts.kb_name ?? null,
    };

    const added_to: string[] = [];
    for (const notebook_id of opts.notebook_ids) {
      this.locked(() => {
        let notebook: Dict | null;
        try {
          notebook = this._load_notebook(notebook_id);
        } catch (exc) {
          if (exc instanceof NotebookCorruptedError) {
            console.warn(
              `skipping unreadable notebook ${notebook_id} while saving`,
            );
            return;
          }
          throw exc;
        }
        if (!notebook) return;
        // Each notebook stores its own copy. They share a record id so
        // the save is traceable, but editing one does not touch the
        // others — use ``copy_record`` for an explicit independent copy.
        const records = (notebook["records"] ??= []) as NotebookRecord[];
        records.push({ ...(record as unknown as Dict) } as NotebookRecord);
        notebook["updated_at"] = now;
        this._save_notebook(notebook_id, notebook);
        this._touch_index_entry(notebook_id, notebook);
        added_to.push(notebook_id);
      });
    }

    return { record, added_to_notebooks: added_to };
  }

  get_records(notebook_id: string, record_ids?: string[] | null): Dict[] {
    const notebook = this._load_notebook(notebook_id);
    if (!notebook) return [];
    const records = [...((notebook["records"] ?? []) as Dict[])];
    if (!record_ids || record_ids.length === 0) return records;
    const wanted = new Set(record_ids.map(String));
    return records.filter((record) => wanted.has(String(record["id"] ?? "")));
  }

  get_record(
    notebook_id: string,
    record_id: string,
    opts: { read_only?: boolean } = {},
  ): Dict | null {
    /** Return one record; preserve the legacy repair behavior by default. */
    if (!opts.read_only) {
      const records = this.get_records(notebook_id, [record_id]);
      return records.length ? records[0] : null;
    }
    const notebook = this._load_notebook(notebook_id, { read_only: true });
    if (!notebook) return null;
    return (
      ((notebook["records"] ?? []) as Dict[]).find(
        (record) => String(record["id"] ?? "") === record_id,
      ) ?? null
    );
  }

  update_record(
    notebook_id: string,
    record_id: string,
    opts: {
      title?: string | null;
      summary?: string | null;
      user_query?: string | null;
      output?: string | null;
      metadata?: Dict | null;
      kb_name?: string | null | Unset;
    } = {},
  ): Dict | null {
    /** Edit one record in place. Only this notebook's copy is affected.

     * Every parameter defaults to "leave alone". ``kb_name`` additionally
     * distinguishes *omitted* from an explicit ``null``, so a caller that
     * only renames a record cannot accidentally drop its knowledge-base
     * link — pass ``kb_name=null`` when clearing it is what you mean.
     */
    const {
      title = null,
      summary = null,
      user_query = null,
      output = null,
      metadata = null,
      kb_name = _UNSET,
    } = opts;
    return this.locked(() => {
      const notebook = this._load_notebook(notebook_id);
      if (!notebook) return null;

      let updated_record: Dict | null = null;
      for (const record of (notebook["records"] ?? []) as Dict[]) {
        if (String(record["id"] ?? "") !== String(record_id)) continue;
        if (title !== null && title !== undefined) record["title"] = title;
        if (summary !== null && summary !== undefined) {
          record["summary"] = _clean_record_summary(summary);
        }
        if (user_query !== null && user_query !== undefined) {
          record["user_query"] = user_query;
        }
        if (output !== null && output !== undefined) record["output"] = output;
        if (metadata !== null && metadata !== undefined) {
          const current = (record["metadata"] ?? {}) as Dict;
          record["metadata"] = { ...current, ...metadata };
        }
        if (kb_name !== _UNSET) record["kb_name"] = kb_name;
        updated_record = record;
        break;
      }

      if (updated_record === null) return null;

      notebook["updated_at"] = Date.now() / 1000;
      this._save_notebook(notebook_id, notebook);
      this._touch_index_entry(notebook_id, notebook);
      return updated_record;
    });
  }

  get_records_by_references(notebook_references: Dict[]): Dict[] {
    const resolved: Dict[] = [];
    for (const ref of notebook_references) {
      const notebook_id = String(ref["notebook_id"] ?? "").trim();
      if (!notebook_id) continue;
      const record_ids = (
        Array.isArray(ref["record_ids"]) ? (ref["record_ids"] as unknown[]) : []
      )
        .map((id) => String(id).trim())
        .filter(Boolean);
      let notebook: Dict | null;
      try {
        notebook = this._load_notebook(notebook_id);
      } catch (exc) {
        if (exc instanceof NotebookCorruptedError) {
          // Resolving references feeds a chat turn; one damaged notebook
          // must not take the whole turn down with it.
          console.warn(
            `skipping unreadable notebook ${notebook_id} while resolving refs`,
          );
          continue;
        }
        throw exc;
      }
      if (!notebook) continue;

      const notebook_name = String(notebook["name"] ?? "") || notebook_id;
      for (const record of this.get_records(notebook_id, record_ids)) {
        resolved.push({
          ...record,
          notebook_id,
          notebook_name: notebook_name,
        });
      }
    }
    return resolved;
  }

  remove_record(notebook_id: string, record_id: string): boolean {
    return this.locked(() => {
      const notebook = this._load_notebook(notebook_id);
      if (!notebook) return false;

      const records = (notebook["records"] ?? []) as Dict[];
      const original_count = records.length;
      notebook["records"] = records.filter(
        (r) => String(r["id"]) !== String(record_id),
      );

      if ((notebook["records"] as Dict[]).length === original_count) {
        return false;
      }

      notebook["updated_at"] = Date.now() / 1000;
      this._save_notebook(notebook_id, notebook);
      this._touch_index_entry(notebook_id, notebook);
      return true;
    });
  }

  copy_record(
    source_notebook_id: string,
    record_id: string,
    target_notebook_id: string,
  ): Dict | null {
    /** Duplicate a record into another notebook under a fresh id.

     * The copy is independent from the moment it lands: editing either side
     * leaves the other untouched. Returns null when the source record or
     * the target notebook does not exist.
     */
    if (source_notebook_id === target_notebook_id) return null;

    const source_record = this.get_record(source_notebook_id, record_id);
    if (source_record === null) return null;

    const copied: Dict = { ...source_record };
    copied["id"] = randomUUID().replace(/-/g, "").slice(0, 8);
    copied["metadata"] = {
      ...(((source_record["metadata"] as Dict | undefined) ?? {}) as Dict),
      copied_from: {
        notebook_id: source_notebook_id,
        record_id,
      },
    };

    return this.locked(() => {
      const target = this._load_notebook(target_notebook_id);
      if (!target) return null;
      ((target["records"] ??= []) as Dict[]).push(copied);
      target["updated_at"] = Date.now() / 1000;
      this._save_notebook(target_notebook_id, target);
      this._touch_index_entry(target_notebook_id, target);
      return copied;
    });
  }

  locate_record(record_id: string, notebook_id = ""): string | null {
    /** Find a saved source within this workspace, preferring its original
     * collection. */
    const ids = notebook_id ? [notebook_id] : [];
    for (const item of this.list_notebooks()) {
      const id = String(item["id"] ?? "");
      if (id && id !== notebook_id) ids.push(id);
    }
    for (const candidate of ids) {
      try {
        if (this.get_record(candidate, record_id) !== null) return candidate;
      } catch (exc) {
        if (exc instanceof NotebookCorruptedError) continue;
        throw exc;
      }
    }
    return null;
  }

  move_record(
    source_notebook_id: string,
    record_id: string,
    target_notebook_id: string,
  ): Dict | null {
    /** Move without changing identity, so existing note citations remain valid.

     * Write the destination first so an interrupted write can never destroy
     * the only copy of the source.
     */
    if (source_notebook_id === target_notebook_id) return null;
    // Python locks both collections in stable (sorted) order; Node's
    // synchronous sections make the ordering moot but kept for parity.
    const ordered = [source_notebook_id, target_notebook_id].sort();
    void ordered;
    return this.locked(() => {
      const source = this._load_notebook(source_notebook_id);
      const target = this._load_notebook(target_notebook_id);
      if (source === null || target === null) return null;
      const record = ((source["records"] ?? []) as Dict[]).find(
        (r) => r["id"] === record_id,
      );
      if (record === undefined) return null;
      const existing = ((target["records"] ?? []) as Dict[]).find(
        (r) => r["id"] === record_id,
      );
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new NotebookMoveConflictError(
          "The destination already contains a different version of this favorite.",
        );
      }
      if (existing === undefined) {
        ((target["records"] ??= []) as Dict[]).push(record);
      }
      target["updated_at"] = Date.now() / 1000;
      this._save_notebook(target_notebook_id, target);
      this._touch_index_entry(target_notebook_id, target);
      source["records"] = ((source["records"] ?? []) as Dict[]).filter(
        (r) => r["id"] !== record_id,
      );
      source["updated_at"] = Date.now() / 1000;
      this._save_notebook(source_notebook_id, source);
      this._touch_index_entry(source_notebook_id, source);
      return record;
    });
  }

  export_markdown(notebook_id: string): string | null {
    /** Render a whole notebook as one Markdown document. */
    const notebook = this._load_notebook(notebook_id);
    if (!notebook) return null;

    const lines: string[] = [
      `# ${String(notebook["name"] ?? notebook_id)}`,
    ];
    const description = String(notebook["description"] ?? "").trim();
    if (description) {
      lines.push("", `> ${description}`);
    }

    for (const record of (notebook["records"] ?? []) as Dict[]) {
      lines.push("", "---", "");
      lines.push(`## ${String(record["title"] ?? "") || "(untitled)"}`);

      const created_at = Number(record["created_at"] ?? 0);
      const stamp = created_at
        ? formatLocalStamp(created_at * 1000)
        : "";
      const meta_bits = [
        String(record["type"] ?? ""),
        stamp,
      ].filter(Boolean);
      if (meta_bits.length) {
        lines.push("", `*${meta_bits.join(" · ")}*`);
      }

      const summary = String(record["summary"] ?? "").trim();
      if (summary) {
        lines.push("", `> ${summary}`);
      }

      const output = String(record["output"] ?? "").trim();
      if (output) {
        lines.push("", output);
      }
    }

    return lines.join("\n") + "\n";
  }

  get_statistics(): Dict {
    const notebooks = this.list_notebooks();

    let total_records = 0;
    // Derived from RECORD_TYPES so a newly added record type is counted the
    // day it is introduced, instead of silently missing from the totals.
    const type_counts: Dict = Object.fromEntries(
      RECORD_TYPES.map((t) => [t, 0]),
    );

    for (const nb_info of notebooks) {
      let notebook: Dict | null;
      try {
        notebook = this._load_notebook(String(nb_info["id"]));
      } catch (exc) {
        if (exc instanceof NotebookCorruptedError) continue;
        throw exc;
      }
      if (!notebook) continue;
      for (const record of (notebook["records"] ?? []) as Dict[]) {
        total_records += 1;
        const record_type = String(record["type"] ?? "");
        if (record_type in type_counts) {
          type_counts[record_type] = Number(type_counts[record_type]) + 1;
        }
      }
    }

    return {
      total_notebooks: notebooks.length,
      total_records,
      records_by_type: type_counts,
      recent_notebooks: notebooks.slice(0, 5),
    };
  }
}

/** ``time.strftime("%Y-%m-%d %H:%M", time.localtime(ts))`` equivalent. */
function formatLocalStamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

const _instances = new Map<string, NotebookManager>();

export function get_notebook_manager(
  base_dir?: string | null,
  settings?: Settings,
): NotebookManager {
  const dir = resolve(
    base_dir ??
      join((settings ?? get_settings()).data_dir, "user", "workspace", "notebook"),
  );
  const key = dir;
  let instance = _instances.get(key);
  if (!instance) {
    instance = new NotebookManager(dir, settings);
    _instances.set(key, instance);
  }
  return instance;
}

/** Module-level proxy mirroring Python's ``notebook_manager``. */
export const notebook_manager: NotebookManager = new Proxy(
  {} as NotebookManager,
  {
    get(_target, prop) {
      const manager = get_notebook_manager();
      const value = (manager as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(manager)
        : value;
    },
  },
);

export const getNotebookManager = get_notebook_manager;
export const getNotebookDir = (): string =>
  join(get_settings().data_dir, "user", "workspace", "notebook");
