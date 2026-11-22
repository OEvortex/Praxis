// Port of deeptutor/services/memory/paths.py — per-user memory root layout:
//
//   <workspace>/memory/trace/<surface>/<YYYY-MM-DD>.jsonl   (L1, append-only)
//   <workspace>/memory/L2/<surface>.md                      (L2 per-surface)
//   <workspace>/memory/L3/<recent|profile|scope|preferences>.md
//   <workspace>/memory/backup/<timestamp>/...              (v1 migration archive)
//
// Upstream resolves the root through PathService.get_memory_dir() which is
// ``<workspace_root>/memory``. This backend is single-user/local-admin, so the
// root is ``<settings.workspace_dir>/memory`` (default ``data/workspace``).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { get_settings } from "../../config.js";

export type Surface =
  | "chat"
  | "notebook"
  | "quiz"
  | "kb"
  | "book"
  | "partner"
  | "cowriter";
export type L3Slot = "recent" | "profile" | "scope" | "preferences";

export const SURFACES: readonly Surface[] = [
  "chat",
  "notebook",
  "quiz",
  "kb",
  "book",
  "partner",
  "cowriter",
];
export const L3_SLOTS: readonly L3Slot[] = [
  "recent",
  "profile",
  "scope",
  "preferences",
];

export function memory_root(): string {
  return join(get_settings().workspace_dir, "memory");
}

export function trace_dir(surface: Surface): string {
  return join(memory_root(), "trace", surface);
}

export function trace_file(surface: Surface, day: Date): string {
  return join(trace_dir(surface), `${day.toISOString().slice(0, 10)}.jsonl`);
}

export function l2_dir(): string {
  return join(memory_root(), "L2");
}

export function l2_file(surface: Surface): string {
  return join(l2_dir(), `${surface}.md`);
}

export function l3_dir(): string {
  return join(memory_root(), "L3");
}

export function l3_file(slot: L3Slot): string {
  return join(l3_dir(), `${slot}.md`);
}

export function backup_root(): string {
  return join(memory_root(), "backup");
}

export function snapshot_dir(surface: Surface): string {
  return join(memory_root(), "snapshot", surface);
}

export function ensure_dirs(): void {
  const root = memory_root();
  mkdirSync(root, { recursive: true });
  mkdirSync(l2_dir(), { recursive: true });
  mkdirSync(l3_dir(), { recursive: true });
  for (const surface of SURFACES) {
    mkdirSync(trace_dir(surface), { recursive: true });
  }
}
