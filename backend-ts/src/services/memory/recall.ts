// Port of deeptutor/services/memory/recall.py — reading memory back:
// what the learner has been doing lately (snapshot stamps + trace queries).
import type { Surface } from "./paths.js";
import { SURFACES } from "./paths.js";
import * as adapters from "./snapshot/adapters.js";
import * as trace from "./trace.js";
import type { Dict } from "../../shared/types.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_DAYS = 7;
const MAX_LABEL_CHARS = 200;

export interface RecallHit {
  surface: string;
  label: string;
  ts: string;
  days_ago: number | null;
}

function hitToDict(h: RecallHit): Dict {
  return { surface: h.surface, label: h.label, ts: h.ts, days_ago: h.days_ago };
}

function now(): Date {
  return new Date();
}

function parseTs(ts: string): Date | null {
  if (!ts) return null;
  const d = new Date(String(ts).replace("Z", "+00:00"));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function days_ago(ts: string, nowDate?: Date): number | null {
  const parsed = parseTs(ts);
  if (!parsed) return null;
  const deltaMs = (nowDate ?? now()).getTime() - parsed.getTime();
  return Math.max(0, Math.floor(deltaMs / 86400000));
}

function cutoff(days: number | null, nowDate: Date): Date | null {
  if (days === null || days < 0) return null;
  return new Date(nowDate.getTime() - days * 86400000);
}

function cleanLabel(raw: unknown): string {
  return String(raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, MAX_LABEL_CHARS);
}

function resolveSurfaces(surfaces?: Iterable<string> | null): Surface[] {
  if (!surfaces) return [...SURFACES];
  const wanted = new Set([...surfaces].map((s) => s.trim().toLowerCase()));
  const resolved = SURFACES.filter((s) => wanted.has(s));
  return resolved.length ? resolved : [...SURFACES];
}

function clampLimit(limit?: number | null): number {
  if (!limit || limit < 1) return DEFAULT_LIMIT;
  return Math.min(Math.trunc(limit), MAX_LIMIT);
}

function newestFirst(hits: RecallHit[]): RecallHit[] {
  hits.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  const seen = new Set<string>();
  const out: RecallHit[] = [];
  for (const hit of hits) {
    const key = `${hit.surface}:${hit.label.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

export function recent(opts: {
  days?: number | null;
  limit?: number | null;
  surfaces?: Iterable<string> | null;
} = {}): RecallHit[] {
  const days = opts.days ?? DEFAULT_DAYS;
  const nowDate = now();
  const cut = cutoff(days, nowDate);
  const hits: RecallHit[] = [];
  for (const surface of resolveSurfaces(opts.surfaces)) {
    let stamps;
    try {
      stamps = adapters.read_stamps(surface);
    } catch {
      continue;
    }
    for (const stamp of stamps) {
      const parsed = parseTs(stamp.ts ?? "");
      if (!parsed || (cut && parsed < cut)) continue;
      const label = cleanLabel(stamp.label);
      if (!label) continue;
      hits.push({
        surface,
        label,
        ts: stamp.ts ?? "",
        days_ago: days_ago(stamp.ts ?? "", nowDate),
      });
    }
  }
  return newestFirst(hits).slice(0, clampLimit(opts.limit));
}

const QUERY_KINDS: Partial<Record<Surface, string>> = { chat: "query", kb: "query" };

export function recent_queries(opts: {
  days?: number | null;
  limit?: number | null;
} = {}): RecallHit[] {
  const days = opts.days ?? DEFAULT_DAYS;
  const nowDate = now();
  const cut = cutoff(days, nowDate);
  const hits: RecallHit[] = [];
  for (const [surface, kind] of Object.entries(QUERY_KINDS) as [Surface, string][]) {
    let events;
    try {
      events = trace.iter_since(surface, cut);
    } catch {
      continue;
    }
    for (const event of events) {
      if (event.kind !== kind) continue;
      const label = cleanLabel(String((event.payload ?? {})["query"] ?? ""));
      if (!label) continue;
      hits.push({
        surface,
        label,
        ts: event.ts,
        days_ago: days_ago(event.ts, nowDate),
      });
    }
  }
  return newestFirst(hits).slice(0, clampLimit(opts.limit));
}

export const _hit_to_dict = hitToDict;
