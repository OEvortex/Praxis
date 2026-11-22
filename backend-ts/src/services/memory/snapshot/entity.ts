// Port of deeptutor/services/memory/snapshot/entity.py — pure data types.
import type { Dict } from "../../../shared/types.js";

export interface Entity {
  id: string;
  label: string;
  ts: string;
  content: string;
  metadata: Dict;
  fingerprint: string;
}

export function entity_to_dict(e: Entity): Dict {
  return { ...e, metadata: { ...e.metadata } };
}

// Fields the diff engine reads (id/label/fingerprint); ts rides along for
// "what happened lately" reads that never touch content.
export interface EntityStamp {
  id: string;
  label: string;
  fingerprint: string;
  ts?: string;
}
export type Stamped = Pick<EntityStamp, "id" | "label" | "fingerprint">;

export type ChangeKind = "added" | "modified" | "removed";

export interface ChangeEntry {
  ts: string;
  kind: ChangeKind;
  entity_id: string;
  label: string;
  prev_fingerprint?: string | null;
  new_fingerprint?: string | null;
}

export function change_to_dict(c: ChangeEntry): Dict {
  return { ...c };
}
