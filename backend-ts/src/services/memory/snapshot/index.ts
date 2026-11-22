// workspace snapshot
// subsystem for L1 memory.
import { diff_snapshots } from "./diff.js";
import * as adapters from "./adapters.js";
import * as store from "./store.js";
import type { Surface } from "../paths.js";
import type { ChangeEntry, Entity, EntityStamp, Stamped } from "./entity.js";
import { change_to_dict, entity_to_dict } from "./entity.js";

export function read_snapshot(surface: Surface): Entity[] {
  return adapters.read_entities(surface);
}

export function read_stamps(surface: Surface): EntityStamp[] {
  return adapters.read_stamps(surface);
}

export function pending_changes(
  surface: Surface,
  entities?: Stamped[] | null,
): ChangeEntry[] {
  const stamps: Stamped[] =
    entities ?? (adapters.read_stamps(surface) as Stamped[]);
  const currFp: Record<string, string> = {};
  const currLabels: Record<string, string> = {};
  for (const e of stamps) {
    currFp[e.id] = e.fingerprint;
    currLabels[e.id] = e.label;
  }
  const prev = store.load_state(surface);
  return diff_snapshots({ ...prev.fingerprints }, currFp, {
    label_map: currLabels,
    prev_label_map: prev.labels,
  });
}

export function refresh_snapshot(surface: Surface): ChangeEntry[] {
  const stamps = adapters.read_stamps(surface);
  const changes = pending_changes(surface, stamps as Stamped[]);
  const currFp: Record<string, string> = {};
  const currLabels: Record<string, string> = {};
  for (const e of stamps) {
    currFp[e.id] = e.fingerprint;
    currLabels[e.id] = e.label;
  }
  store.append_changes(surface, changes);
  store.save_state(surface, {
    fingerprints: currFp,
    labels: currLabels,
    last_refresh: new Date().toISOString(),
  });
  return changes;
}

export function read_changes(surface: Surface, limit = 200, offset = 0): ChangeEntry[] {
  const bound = Math.max(1, Math.min(limit, 1000));
  const all = [...store.iter_changes(surface)];
  all.reverse(); // file is append-order; most recent first
  return all.slice(offset, offset + bound);
}

export function current_state(surface: Surface): Record<string, unknown> {
  return { ...store.load_state(surface) };
}

export function clear_changes(surface: Surface): void {
  store.clear_changes(surface);
}

export { adapters, store, entity_to_dict, change_to_dict };
export type { Entity, EntityStamp, Stamped, ChangeEntry };
