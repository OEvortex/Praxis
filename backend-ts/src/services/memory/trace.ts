// Port of deeptutor/services/memory/trace.py — L1 raw event trace:
// append-only JSONL files, one per surface per UTC day. Writes never throw.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { new_trace_id } from "./ids.js";
import { SURFACES, trace_dir, trace_file, type Surface } from "./paths.js";
import type { Dict } from "../../shared/types.js";

export interface TraceEvent {
  id: string;
  ts: string;
  surface: Surface;
  kind: string;
  payload: Dict;
  session_id?: string | null;
  turn_id?: string | null;
}

export function trace_event_new(
  surface: Surface,
  kind: string,
  payload: Dict,
  opts: { session_id?: string | null; turn_id?: string | null } = {},
): TraceEvent {
  return {
    id: new_trace_id(surface),
    ts: new Date().toISOString(),
    surface,
    kind,
    payload,
    session_id: opts.session_id ?? null,
    turn_id: opts.turn_id ?? null,
  };
}

export async function append(event: TraceEvent): Promise<void> {
  try {
    const path = trace_file(event.surface, new Date());
    const line = JSON.stringify(event);
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, line + "\n", "utf-8");
  } catch {
    // trace capture must never break the producing surface
  }
}

function* iter_lines(path: string): Generator<string> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) yield trimmed;
  }
}

export function* iter_since(
  surface: Surface,
  since?: Date | null,
): Generator<TraceEvent> {
  const dir = trace_dir(surface);
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .map((n) => join(dir, n));
  } catch {
    return;
  }
  const cutoffIso = since ? since.toISOString() : "";
  const cutoffDateIso = since ? since.toISOString().slice(0, 10) : "";
  for (const path of files) {
    const stem = path.split("/").pop()!.replace(/\.jsonl$/, "");
    if (cutoffDateIso && stem < cutoffDateIso) continue;
    for (const raw of iter_lines(path)) {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const ts = String(obj["ts"] ?? "");
      if (cutoffIso && ts < cutoffIso) continue;
      yield {
        id: String(obj["id"] ?? ""),
        ts,
        surface: (obj["surface"] as Surface) ?? surface,
        kind: String(obj["kind"] ?? ""),
        payload: (obj["payload"] as Dict) ?? {},
        session_id: (obj["session_id"] as string | null) ?? null,
        turn_id: (obj["turn_id"] as string | null) ?? null,
      };
    }
  }
}

export function* iter_by_ids(ids: string[]): Generator<TraceEvent> {
  const wantedBySurface = new Map<string, Set<string>>();
  for (const tid of ids) {
    const idx = tid.indexOf(":");
    if (idx === -1) continue;
    const surface = tid.slice(0, idx);
    if ((SURFACES as readonly string[]).includes(surface)) {
      if (!wantedBySurface.has(surface)) wantedBySurface.set(surface, new Set());
      wantedBySurface.get(surface)!.add(tid);
    }
  }
  for (const [surface, wanted] of wantedBySurface) {
    for (const event of iter_since(surface as Surface)) {
      if (wanted.has(event.id)) yield event;
    }
  }
}

export function count_since(surface: Surface, since?: Date | null): number {
  let n = 0;
  for (const _ of iter_since(surface, since)) n++;
  return n;
}

export function latest_ts(surface: Surface): string | null {
  const dir = trace_dir(surface);
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((n) => n.endsWith(".jsonl"))
      .sort()
      .reverse()
      .map((n) => join(dir, n));
  } catch {
    return null;
  }
  for (const path of files) {
    let last = "";
    try {
      for (const line of iter_lines(path)) last = line;
    } catch {
      continue;
    }
    if (last) {
      try {
        const obj = JSON.parse(last) as Record<string, unknown>;
        const ts = obj["ts"];
        if (typeof ts === "string") return ts;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function trace_file_exists(path: string): boolean {
  return existsSync(path);
}
