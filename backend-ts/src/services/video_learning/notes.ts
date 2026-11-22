// Port of deeptutor/video_learning/notes.py — timestamped notes for timed
// media materials.
//
// Upstream stores notes as records inside the NotebookManager ("Video
// Learning" notebook). The TS backend has no NotebookManager port, so notes
// are persisted in the shared ext_items store under collection
// "video-learning/notes". The wire shape is identical; `notebook_id` is the
// stable constant "nb_video_learning" instead of a generated notebook id.
import { get_settings } from "../../config.js";
import type { Settings } from "../../config.js";
import * as database from "../../store/database.js";
import {
  TimedMediaError,
  TimedMediaNotFound,
  getTimedMediaStore,
} from "./service.js";

export const NOTEBOOK_NAME = "Video Learning";
export const NOTEBOOK_ID = "nb_video_learning";
const MAX_QUOTE_CHARS = 280;
const COLLECTION = "video-learning/notes";

type Rec = Record<string, any>;

function formatTime(seconds: number): string {
  const total = Math.max(0, Math.trunc(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function clipText(value: unknown, limit = MAX_QUOTE_CHARS): string {
  const text = String(value ?? "").split(/\s+/).filter(Boolean).join(" ");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).replace(/\s+$/, "")}...`;
}

function segmentAt(material: Rec, timeSeconds: number): Rec | null {
  let segments = (Array.isArray(material.segments) ? material.segments : []).filter(
    (r: unknown) => r !== null && typeof r === "object",
  ) as Rec[];
  if (!segments.length) {
    const cues = ((material.transcript ?? {}) as Rec).cues;
    segments = (Array.isArray(cues) ? cues : [])
      .filter((r: unknown) => r !== null && typeof r === "object")
      .map((r, i) => ({ ...(r as Rec), locator: i + 1 }));
  }
  const containing = segments.filter(
    (row) => Number(row.start ?? 0) <= timeSeconds && timeSeconds <= Number(row.end ?? 0),
  );
  if (containing.length) return containing[containing.length - 1];
  const preceding = segments.filter((row) => Number(row.start ?? 0) <= timeSeconds);
  if (preceding.length) return preceding[preceding.length - 1];
  return segments[0] ?? null;
}

function isMaterialNote(record: Rec, materialId: string): boolean {
  const metadata = record.metadata !== null && typeof record.metadata === "object"
    ? (record.metadata as Rec) : {};
  return (
    String(record.type ?? "") === "video_learning" &&
    String(metadata.material_id ?? "") === materialId
  );
}

function matchingRecords(
  settings: Settings, materialId: string, noteId?: string,
): Array<[Rec]> {
  const items = database.list_items(settings, COLLECTION) as Rec[];
  const matches: Rec[] = [];
  for (const record of items) {
    if (!isMaterialNote(record, materialId)) continue;
    if (noteId !== undefined && String(record.id ?? "") !== noteId) continue;
    matches.push(record);
  }
  return matches.map((r) => [r]);
}

function toNote(record: Rec): Rec {
  const metadata = record.metadata !== null && typeof record.metadata === "object"
    ? (record.metadata as Rec) : {};
  const updatedAt = Number(metadata.updated_at ?? record.created_at ?? 0);
  return {
    notebook_id: NOTEBOOK_ID,
    note_id: String(record.id ?? ""),
    material_id: String(metadata.material_id ?? ""),
    body: String(record.output ?? ""),
    time_seconds: Number(metadata.time_seconds ?? 0) || 0,
    locator: Math.trunc(Number(metadata.locator ?? 0)) || 0,
    quote: String(metadata.quote ?? ""),
    created_at: Number(record.created_at ?? 0) || 0,
    updated_at: updatedAt,
  };
}

export function listNotes(materialId: string, settings?: Settings): Rec[] {
  const s = settings ?? get_settings();
  getTimedMediaStore(s).get(materialId);
  const unique = new Map<string, Rec>();
  for (const [record] of matchingRecords(s, materialId)) {
    unique.set(String(record.id ?? ""), record);
  }
  const notes = [...unique.values()].map(toNote);
  notes.sort(
    (a, b) =>
      a.time_seconds - b.time_seconds ||
      a.created_at - b.created_at ||
      String(a.note_id).localeCompare(String(b.note_id)),
  );
  return notes;
}

export function exportNotes(materialId: string, settings?: Settings): string {
  const s = settings ?? get_settings();
  const material = getTimedMediaStore(s).get(materialId);
  const notes = listNotes(materialId, s);
  const metadata = material.metadata !== null && typeof material.metadata === "object"
    ? (material.metadata as Rec) : {};
  const title = clipText(String(metadata.title ?? "").trim() || "Timed media", 140);
  const lines = [`# Video notes: ${title}`];
  if (!notes.length) {
    lines.push("", "_No timestamped notes captured yet._");
    return lines.join("\n").trim() + "\n";
  }
  for (const note of notes) {
    lines.push("", `## ${formatTime(note.time_seconds)}`, "", String(note.body ?? "").trim());
    const quote = clipText(note.quote);
    if (quote) lines.push("", `> ${quote}`);
  }
  return lines.join("\n").trim() + "\n";
}

export function createNote(
  materialId: string,
  body: string,
  timeSeconds: number,
  settings?: Settings,
): Rec {
  const s = settings ?? get_settings();
  const cleanBody = String(body ?? "").trim();
  if (!cleanBody) throw new TimedMediaError("A timed-media note needs text.");
  const material = getTimedMediaStore(s).get(materialId);
  const duration = Number(material.metadata?.duration_seconds ?? 0) || 0;
  if (duration && timeSeconds > duration) {
    throw new TimedMediaError("Timed-media note timestamp is beyond the material duration.");
  }
  const segment = segmentAt(material, timeSeconds);
  const quote = segment ? clipText(segment.text) : "";
  const metadata = material.metadata !== null && typeof material.metadata === "object"
    ? (material.metadata as Rec) : {};
  const title = clipText(String(metadata.title ?? "").trim() || "Timed media", 140);
  const now = Date.now() / 1000;
  const noteId = `vn_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`;
  const record: Rec = {
    id: noteId,
    type: "video_learning",
    title: `${title} - ${formatTime(timeSeconds)}`,
    summary: clipText(cleanBody, 160),
    user_query: quote,
    output: cleanBody,
    created_at: now,
    metadata: {
      material_id: materialId,
      time_seconds: timeSeconds,
      locator: segment ? Math.trunc(Number(segment.locator ?? 0)) || 0 : 0,
      quote,
      updated_at: now,
    },
  };
  database.put_item(s, COLLECTION, record);
  return toNote(record);
}

export function updateNote(
  materialId: string,
  noteId: string,
  body: string,
  settings?: Settings,
): Rec {
  const s = settings ?? get_settings();
  const cleanBody = String(body ?? "").trim();
  if (!cleanBody) throw new TimedMediaError("A timed-media note needs text.");
  getTimedMediaStore(s).get(materialId);
  const matches = matchingRecords(s, materialId, noteId).map((m) => m[0]);
  if (!matches.length) {
    throw new TimedMediaNotFound("Timed-media note was not found.");
  }
  const now = Date.now() / 1000;
  let updated: Rec | null = null;
  for (const record of matches) {
    record.summary = clipText(cleanBody, 160);
    record.output = cleanBody;
    record.metadata = { ...(record.metadata ?? {}), updated_at: now };
    database.put_item(s, COLLECTION, record);
    updated = record;
  }
  if (updated === null) throw new TimedMediaNotFound("Timed-media note was not found.");
  return toNote(updated);
}

export function deleteNote(materialId: string, noteId: string, settings?: Settings): boolean {
  const s = settings ?? get_settings();
  getTimedMediaStore(s).get(materialId);
  const matches = matchingRecords(s, materialId, noteId).map((m) => m[0]);
  if (!matches.length) throw new TimedMediaNotFound("Timed-media note was not found.");
  let removed = false;
  for (const record of matches) {
    if (database.delete_item(s, COLLECTION, String(record.id))) removed = true;
  }
  return removed;
}
