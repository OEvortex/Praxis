// Turn-scoped state for the composer tutor modes.
//
// Mirrors DeepTutor's per-mode sessions (the SolveSession for deep_solve): the
// model authors the content, while the loop owns the deterministic bookkeeping
// — how many hints have been given, which sources are cited, and so on. State
// is keyed by turn, never supplied by the model, and pruned so long-lived
// servers do not accumulate entries forever.

import type { Dict } from "../../shared/types.js";

export interface TutorItem extends Dict {}

interface TurnState {
  items: TutorItem[];
}

const STATES = new Map<string, TurnState>();
const MAX_STATES = 256;

function sanitize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "_") || "default";
}

/** Create a fresh state handle for one turn and return its private id. */
export function create_state(turn_id: string): string {
  const id = `tutor:${sanitize(turn_id)}`;
  STATES.set(id, { items: [] });
  while (STATES.size > MAX_STATES) {
    const oldest = STATES.keys().next().value;
    if (oldest === undefined) break;
    STATES.delete(oldest);
  }
  return id;
}

export function get_state(id: string): TurnState | null {
  return STATES.get(id) ?? null;
}

/** Append one item; returns the 1-based index, or null for an unknown id. */
export function append_item(id: string, item: TutorItem): number | null {
  const state = STATES.get(id);
  if (!state) return null;
  state.items.push(item);
  return state.items.length;
}
