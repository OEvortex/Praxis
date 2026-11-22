// Port of deeptutor/video_learning/marks.py — private learning marks on timed
// media materials (stored under material.learning.marks).
import { createHash } from "node:crypto";
import {
  TimedMediaError,
  TimedMediaNotFound,
} from "./service.js";
import { get_settings, type Settings } from "../../config.js";
import { completeText } from "../llm_text.js";

export const MARK_KINDS = new Set(["key_point", "question", "review"]);
export const MARK_AUTHORS = new Set(["user", "assistant"]);
const MARK_SOURCES = new Set(["immersive"]);
const MAX_MARKS_PER_MATERIAL = 500;
const MAX_QUOTE_CHARS = 4000;
const MAX_NOTE_CHARS = 2000;
const MAX_SUGGESTIONS = 5;
const NEARBY_WINDOW_SECONDS = 60.0;

const JSON_FENCE = /^```(?:json)?\s*|\s*```$/gim;

export class MarkNotFound extends TimedMediaNotFound {}

export function utcnow(): string {
  return new Date().toISOString();
}

function clipText(value: unknown, limit: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function asSeconds(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    throw new TimedMediaError("Mark timestamps must be numbers.");
  }
  if (seconds < 0 || seconds > 24 * 60 * 60) {
    throw new TimedMediaError("Mark timestamps are outside the allowed range.");
  }
  return seconds;
}

function durationSeconds(material: Record<string, any>): number {
  const source = material.source !== null && typeof material.source === "object"
    ? (material.source as Record<string, unknown>) : {};
  const metadata = material.metadata !== null && typeof material.metadata === "object"
    ? (material.metadata as Record<string, unknown>) : {};
  for (const row of [source, metadata]) {
    const duration = Number(row.duration_seconds ?? 0) || 0;
    if (duration > 0) return duration;
  }
  return 0;
}

function segments(material: Record<string, any>): Array<Record<string, any>> {
  return Array.isArray(material.segments)
    ? material.segments.filter((r: unknown) => r !== null && typeof r === "object")
    : [];
}

function cues(material: Record<string, any>): Array<Record<string, any>> {
  const transcript = material.transcript !== null && typeof material.transcript === "object"
    ? (material.transcript as Record<string, any>) : {};
  return Array.isArray(transcript.cues)
    ? transcript.cues.filter((r: unknown) => r !== null && typeof r === "object")
    : [];
}

export function locatorsForRange(
  material: Record<string, any>, start: number, end: number,
): [number, number] {
  const overlapping = segments(material).filter(
    (row) => Number(row.end ?? 0) >= start && Number(row.start ?? 0) <= end,
  );
  if (!overlapping.length) return [0, 0];
  const startLocator = Number(overlapping[0].locator ?? 0) || 0;
  const endLocator = Number(overlapping[overlapping.length - 1].locator ?? startLocator) || startLocator;
  return [Math.max(0, startLocator), Math.max(0, endLocator)];
}

export function quoteForRange(material: Record<string, any>, start: number, end: number): string {
  const selected = cues(material)
    .filter(
      (row) =>
        String(row.text ?? "").trim() &&
        Number(row.end ?? 0) >= start &&
        Number(row.start ?? 0) <= end,
    )
    .map((row) => String(row.text ?? "").trim());
  return clipText(selected.join(" "), MAX_QUOTE_CHARS);
}

export function nearbyCues(material: Record<string, any>, timeSeconds: number, window = NEARBY_WINDOW_SECONDS) {
  return cues(material).filter(
    (row) => Math.abs(Number(row.start ?? 0) - timeSeconds) <= window,
  );
}

export function currentSegment(material: Record<string, any>, timeSeconds: number) {
  return (
    segments(material).find(
      (row) => Number(row.start ?? 0) <= timeSeconds && timeSeconds <= Number(row.end ?? 0),
    ) ?? null
  );
}

export function marksList(material: Record<string, any>): Array<Record<string, any>> {
  if (material.learning === null || typeof material.learning !== "object") {
    material.learning = {};
  }
  const learning = material.learning as Record<string, any>;
  if (!Array.isArray(learning.marks)) learning.marks = [];
  return learning.marks;
}

export function getMark(material: Record<string, any>, markId: string): Record<string, any> {
  for (const mark of marksList(material)) {
    if (String(mark.mark_id ?? "") === markId) return mark;
  }
  throw new MarkNotFound("Timed media mark was not found.");
}

export function normalizeMark(
  material: Record<string, any>,
  payload: Record<string, any>,
  existing?: Record<string, any> | null,
): Record<string, any> {
  const kind = String(payload.kind ?? existing?.kind ?? "").trim();
  if (!MARK_KINDS.has(kind)) {
    throw new TimedMediaError("Mark kind must be key_point, question, or review.");
  }
  const start = asSeconds(
    "start_seconds" in payload ? payload.start_seconds : (existing?.start_seconds ?? 0),
  );
  let end = asSeconds(
    "end_seconds" in payload ? payload.end_seconds : (existing?.end_seconds ?? start),
  );
  if (end < start) throw new TimedMediaError("Mark end must be at or after the start time.");
  const duration = durationSeconds(material);
  if (duration > 0) {
    if (start > duration) throw new TimedMediaError("Mark start is beyond the video duration.");
    end = Math.min(end, duration);
  }

  const [derivedStart, derivedEnd] = locatorsForRange(material, start, end);
  let startLocator = payload.start_locator ?? existing?.start_locator ?? derivedStart;
  let endLocator = payload.end_locator ?? existing?.end_locator ?? derivedEnd;
  try {
    startLocator = Math.max(0, Math.trunc(Number(startLocator) || 0));
    endLocator = Math.max(0, Math.trunc(Number(endLocator) || 0));
  } catch {
    throw new TimedMediaError("Mark locators must be integers.");
  }
  if (startLocator === 0) startLocator = derivedStart;
  if (endLocator === 0) endLocator = derivedEnd || startLocator;

  let quote = payload.quote;
  if (quote === undefined || quote === null) {
    quote = existing?.quote || quoteForRange(material, start, end);
  }
  let note = payload.note;
  if (note === undefined || note === null) note = existing?.note || "";
  const author = String(payload.author ?? existing?.author ?? "user");
  if (!MARK_AUTHORS.has(author)) {
    throw new TimedMediaError("Mark author must be user or assistant.");
  }
  const source = String(payload.source ?? existing?.source ?? "immersive");
  if (!MARK_SOURCES.has(source)) {
    throw new TimedMediaError("Mark source must be immersive.");
  }
  let rawMetadata = payload.metadata ?? existing?.metadata ?? {};
  if (rawMetadata === null) rawMetadata = {};
  if (typeof rawMetadata !== "object" || Array.isArray(rawMetadata)) {
    throw new TimedMediaError("Mark metadata must be an object.");
  }
  const metadata = { ...(rawMetadata as Record<string, unknown>) };
  if (Object.keys(metadata).length > 16) {
    throw new TimedMediaError("Mark metadata has too many fields.");
  }
  if (JSON.stringify(metadata).length > 4000) {
    throw new TimedMediaError("Mark metadata is too large.");
  }

  const stamp = utcnow();
  let markId = String(existing?.mark_id ?? payload.mark_id ?? "");
  if (!/^[0-9a-f]{16,64}$/.test(markId)) {
    const seed = `${material.material_id}-${kind}-${start}-${end}-${stamp}`;
    markId = createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 24);
  }
  const mark: Record<string, any> = {
    mark_id: markId,
    kind,
    start_seconds: start,
    end_seconds: end,
    start_locator: startLocator,
    end_locator: endLocator,
    quote: clipText(quote, MAX_QUOTE_CHARS),
    note: clipText(note, MAX_NOTE_CHARS),
    author,
    source,
    metadata,
    created_at: String(existing?.created_at ?? stamp),
    updated_at: stamp,
  };
  let reviewedAt = payload.reviewed_at ?? existing?.reviewed_at;
  if (payload.reviewed === true) reviewedAt = stamp;
  if (payload.reviewed === false) reviewedAt = null;
  if (reviewedAt) mark.reviewed_at = String(reviewedAt);
  return mark;
}

export function createMark(material: Record<string, any>, payload: Record<string, any>): Record<string, any> {
  const marks = marksList(material);
  if (marks.length >= MAX_MARKS_PER_MATERIAL) {
    throw new TimedMediaError("This video already has the maximum number of marks.");
  }
  const mark = normalizeMark(material, payload);
  marks.push(mark);
  return mark;
}

export function updateMark(
  material: Record<string, any>, markId: string, payload: Record<string, any>,
): Record<string, any> {
  if (!Object.keys(payload).length) {
    throw new TimedMediaError("No mark fields to update.");
  }
  const current = getMark(material, markId);
  const updated = normalizeMark(material, payload, current);
  const marks = marksList(material);
  for (let i = 0; i < marks.length; i += 1) {
    if (String(marks[i].mark_id ?? "") === markId) {
      marks[i] = updated;
      return updated;
    }
  }
  throw new MarkNotFound("Timed media mark was not found.");
}

export function deleteMark(material: Record<string, any>, markId: string): Record<string, any> {
  const marks = marksList(material);
  for (let i = 0; i < marks.length; i += 1) {
    if (String(marks[i].mark_id ?? "") === markId) {
      return marks.splice(i, 1)[0];
    }
  }
  throw new MarkNotFound("Timed media mark was not found.");
}

function parseJsonArray(text: string): unknown[] {
  const raw = String(text ?? "").trim().replace(JSON_FENCE, "");
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const payload: unknown = JSON.parse(raw.slice(start, end + 1));
    return Array.isArray(payload) ? payload : [];
  } catch {
    return [];
  }
}

function publicSuggestion(material: Record<string, any>, payload: Record<string, any>): Record<string, any> | null {
  let mark: Record<string, any>;
  try {
    mark = normalizeMark(material, { ...payload, author: "assistant" });
  } catch (e) {
    if (e instanceof TimedMediaError) return null;
    throw e;
  }
  delete mark.mark_id;
  mark.quote = quoteForRange(material, mark.start_seconds, mark.end_seconds);
  if (!mark.quote) return null;
  delete mark.created_at;
  delete mark.updated_at;
  delete mark.reviewed_at;
  return mark;
}

export function heuristicSuggestions(material: Record<string, any>, timeSeconds: number) {
  const segment = currentSegment(material, timeSeconds);
  let start: number;
  let end: number;
  let text: string;
  if (segment === null) {
    const nearby = nearbyCues(material, timeSeconds);
    if (!nearby.length) return [];
    start = Number(nearby[0].start ?? timeSeconds);
    end = Number(nearby[nearby.length - 1].end ?? timeSeconds);
    text = nearby.map((r) => String(r.text ?? "")).join(" ");
  } else {
    start = Number(segment.start ?? timeSeconds);
    end = Number(segment.end ?? timeSeconds);
    text = String(segment.text ?? "");
  }
  const candidates: Array<Record<string, unknown>> = [
    { kind: "key_point", start_seconds: start, end_seconds: Math.max(start, end), quote: text, note: "" },
  ];
  if (text.includes("?") || text.includes("？")) {
    candidates.push(
      { kind: "question", start_seconds: start, end_seconds: Math.max(start, end), quote: text, note: "" },
    );
  }
  return candidates
    .slice(0, MAX_SUGGESTIONS)
    .map((row) => publicSuggestion(material, { ...row, author: "assistant" }))
    .filter((s): s is Record<string, any> => s !== null);
}

export async function suggestMarks(
  material: Record<string, any>, timeSeconds: number, settings?: Settings,
): Promise<Array<Record<string, any>>> {
  const segment = currentSegment(material, timeSeconds);
  const nearby = nearbyCues(material, timeSeconds);
  if (!segment && !nearby.length) return [];
  const transcript = nearby
    .slice(0, 40)
    .map(
      (row) =>
        `[${Number(row.start ?? 0).toFixed(1)}-${Number(row.end ?? 0).toFixed(1)}] ${row.text ?? ""}`,
    )
    .join("\n");
  const prompt =
    "Extract up to 5 learning marks from this video excerpt. Return JSON only: " +
    '[{"kind":"key_point|question|review","start_seconds":number,"end_seconds":number,' +
    '"quote":"verbatim subtitle span","note":"optional short note"}]. ' +
    "Use kind=key_point for core claims, question for unclear or asked points, and " +
    "review for items the learner should revisit. Keep quotes short.\n" +
    `Current time: ${timeSeconds.toFixed(1)}\n` +
    `Current segment: ${JSON.stringify(segment ?? {})}\n` +
    `Nearby transcript:\n${transcript}`;
  let parsed: unknown[] = [];
  try {
    const raw = await completeText(settings ?? get_settings(), {
      prompt,
      system:
        "You help a learner mark a video. Reply with a JSON array and no markdown. " +
        "Do not invent timestamps outside the supplied transcript.",
    });
    parsed = parseJsonArray(String(raw ?? ""));
  } catch {
    parsed = [];
  }
  const suggestions: Array<Record<string, any>> = [];
  for (const row of parsed) {
    if (row === null || typeof row !== "object") continue;
    const suggestion = publicSuggestion(material, row as Record<string, any>);
    if (suggestion !== null) suggestions.push(suggestion);
    if (suggestions.length >= MAX_SUGGESTIONS) break;
  }
  return suggestions.length ? suggestions : heuristicSuggestions(material, timeSeconds);
}
export const MARK_SOURCES_SET = MARK_SOURCES;
