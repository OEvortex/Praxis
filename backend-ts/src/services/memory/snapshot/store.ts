// on-disk persistence
// for snapshot state + change log under <memory>/snapshot/<surface>/.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { snapshot_dir } from "../paths.js";
import type { Surface } from "../paths.js";
import type { ChangeEntry, ChangeKind } from "./entity.js";
import type { Dict } from "../../../shared/types.js";

export function state_file(surface: Surface): string {
  return join(snapshot_dir(surface), "state.json");
}

export function changes_file(surface: Surface): string {
  return join(snapshot_dir(surface), "changes.jsonl");
}

export interface SnapshotState {
  fingerprints: Record<string, string>;
  labels: Record<string, string>;
  last_refresh: string | null;
}

export function load_state(surface: Surface): SnapshotState {
  const empty: SnapshotState = { fingerprints: {}, labels: {}, last_refresh: null };
  const path = state_file(surface);
  if (!existsSync(path)) return empty;
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Dict;
    return {
      fingerprints: (data["fingerprints"] as Record<string, string>) ?? {},
      labels: (data["labels"] as Record<string, string>) ?? {},
      last_refresh: (data["last_refresh"] as string | null) ?? null,
    };
  } catch {
    return empty;
  }
}

export function save_state(
  surface: Surface,
  opts: {
    fingerprints: Record<string, string>;
    labels: Record<string, string>;
    last_refresh: string;
  },
): void {
  const target = state_file(surface);
  mkdirSync(join(target, ".."), { recursive: true });
  const tmp = target + ".tmp";
  writeFileSync(
    tmp,
    JSON.stringify(
      {
        fingerprints: opts.fingerprints,
        labels: opts.labels,
        last_refresh: opts.last_refresh,
      },
      null,
      2,
    ),
    "utf-8",
  );
  renameSync(tmp, target);
}

export function append_changes(surface: Surface, changes: ChangeEntry[]): void {
  if (!changes.length) return;
  const path = changes_file(surface);
  mkdirSync(join(path, ".."), { recursive: true });
  const lines = changes.map((c) => JSON.stringify(c)).join("\n") + "\n";
  appendFileSync(path, lines, "utf-8");
}

export function* iter_changes(surface: Surface): Generator<ChangeEntry> {
  const path = changes_file(surface);
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Dict;
    try {
      obj = JSON.parse(trimmed) as Dict;
    } catch {
      continue;
    }
    yield {
      ts: String(obj["ts"] ?? ""),
      kind: (obj["kind"] as ChangeKind) ?? "modified",
      entity_id: String(obj["entity_id"] ?? ""),
      label: String(obj["label"] ?? ""),
      prev_fingerprint: (obj["prev_fingerprint"] as string | null) ?? null,
      new_fingerprint: (obj["new_fingerprint"] as string | null) ?? null,
    };
  }
}

export function clear_changes(surface: Surface): void {
  const path = changes_file(surface);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best effort
  }
}

export function list_snapshot_surfaces(): string[] {
  const root = join(snapshot_dir("chat"), "..", ".."); // <memory>/snapshot
  try {
    return readdirSync(root).filter((n) => {
      try {
        return readdirSync(join(root, n)).length >= 0;
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
