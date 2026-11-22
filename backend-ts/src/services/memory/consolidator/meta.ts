// per-doc
// *.meta.json sidecars capturing "seen ids" for update diffs.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { l2_dir, l3_dir, type L3Slot, type Surface } from "../paths.js";
import type { Dict } from "../../../shared/types.js";

export interface L2Meta {
  last_update_at: string | null;
  seen_entity_refs: Set<string>;
}
export interface L3Meta {
  last_update_at: string | null;
  seen_l2_entry_ids: Map<string, Set<string>>;
}

export function l2_meta_path(surface: Surface): string {
  return join(l2_dir(), `${surface}.meta.json`);
}
export function l3_meta_path(slot: L3Slot): string {
  return join(l3_dir(), `${slot}.meta.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function readJson(path: string): Dict | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Dict;
  } catch {
    return null;
  }
}

function atomicWriteJson(path: string, payload: Dict): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  renameSync(tmp, path);
}

export function load_l2_meta(surface: Surface): L2Meta {
  const data = readJson(l2_meta_path(surface));
  if (!data) return { last_update_at: null, seen_entity_refs: new Set() };
  const refs = data["seen_entity_refs"];
  return {
    last_update_at: (data["last_update_at"] as string | null) ?? null,
    seen_entity_refs: Array.isArray(refs) ? new Set(refs.map(String)) : new Set(),
  };
}

export function save_l2_meta(
  surface: Surface,
  opts: { seen_entity_refs: Set<string> },
): L2Meta {
  const meta: L2Meta = {
    last_update_at: nowIso(),
    seen_entity_refs: new Set(opts.seen_entity_refs),
  };
  atomicWriteJson(l2_meta_path(surface), {
    version: 1,
    last_update_at: meta.last_update_at,
    seen_entity_refs: [...meta.seen_entity_refs].sort(),
  });
  return meta;
}

export function load_l3_meta(slot: L3Slot): L3Meta {
  const data = readJson(l3_meta_path(slot));
  if (!data) return { last_update_at: null, seen_l2_entry_ids: new Map() };
  const raw = data["seen_l2_entry_ids"];
  const map = new Map<string, Set<string>>();
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [surface, ids] of Object.entries(raw as Dict)) {
      map.set(surface, Array.isArray(ids) ? new Set(ids.map(String)) : new Set());
    }
  }
  return {
    last_update_at: (data["last_update_at"] as string | null) ?? null,
    seen_l2_entry_ids: map,
  };
}

export function save_l3_meta(
  slot: L3Slot,
  opts: { seen_l2_entry_ids: Map<string, Set<string>> },
): L3Meta {
  const meta: L3Meta = {
    last_update_at: nowIso(),
    seen_l2_entry_ids: new Map(
      [...opts.seen_l2_entry_ids.entries()].map(([k, v]) => [k, new Set(v)]),
    ),
  };
  const seen: Dict = {};
  for (const [surface, ids] of meta.seen_l2_entry_ids) {
    seen[surface] = [...ids].sort();
  }
  atomicWriteJson(l3_meta_path(slot), {
    version: 1,
    last_update_at: meta.last_update_at,
    seen_l2_entry_ids: seen,
  });
  return meta;
}
