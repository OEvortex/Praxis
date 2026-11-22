// Port of backend/app/services/calendar/models.py
// Wire models for the account calendar. The encodings follow RFC 5545 so an
// ICS file maps onto them one to one: all-day events carry plain dates with an
// *exclusive* end date, timed events carry UTC instants on the wire and local
// wall time in `tzid` in storage.
//
// Pydantic validators are ported as explicit validate/parse functions that
// throw Error on invalid input; the interfaces are the wire/storage shapes.

import {
  format_instant,
  format_rule,
  parse_date,
  parse_instant,
  parse_rule,
  zone,
} from "./recurrence.js";

export type CalendarColor = string; // ^#[0-9a-fA-F]{6}$
export type Scope = "this" | "following" | "all";
export type EventSource = "user" | "co_writer" | "import";

// Minutes before the start. All-day events may also go negative, down to one
// minute before the day ends: -540 reads "on the day at 09:00".
export const MIN_REMINDER = -1439;
export const MAX_REMINDER = 40320; // four weeks
export const MAX_REMINDERS = 5;

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const SCOPES = new Set<Scope>(["this", "following", "all"]);
const SOURCES = new Set<EventSource>(["user", "co_writer", "import"]);

function fail(msg: string): never {
  throw new Error(msg);
}

function reqString(v: unknown, name: string): string {
  if (typeof v !== "string") fail(`${name} must be a string.`);
  return v as string;
}

function optString(v: unknown, name: string): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return reqString(v, name);
}

function reqBool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") fail(`${name} must be a boolean.`);
  return v as boolean;
}

function optBool(v: unknown, name: string): boolean | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return reqBool(v, name);
}

function reqInt(v: unknown, name: string, lo?: number, hi?: number): number {
  if (typeof v !== "number" || !Number.isInteger(v)) fail(`${name} must be an integer.`);
  if (lo !== undefined && (v as number) < lo) fail(`${name} must be >= ${lo}.`);
  if (hi !== undefined && (v as number) > hi) fail(`${name} must be <= ${hi}.`);
  return v as number;
}

function optInt(v: unknown, name: string, lo?: number, hi?: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return reqInt(v, name, lo, hi);
}

function bounded(v: unknown, name: string, max: number, strip = false): string {
  let s = reqString(v, name);
  if (strip) s = s.trim();
  if (s.length > max) fail(`${name} must be at most ${max} characters.`);
  return s;
}

function optBounded(v: unknown, name: string, max: number, strip = false): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return bounded(v, name, max, strip);
}

function color(v: unknown): CalendarColor {
  const s = reqString(v, "color");
  if (!COLOR_RE.test(s)) fail("color must be #RRGGBB.");
  return s;
}

function optColor(v: unknown): CalendarColor | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return color(v);
}

function tzid(v: unknown): string {
  const s = reqString(v, "tzid");
  if (s.length < 1 || s.length > 64) fail("tzid must be 1-64 characters.");
  zone(s); // raises on unknown zone
  return s;
}

function optTzid(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return tzid(v);
}

function rrule(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = reqString(v, "rrule");
  if (s.length > 500) fail("rrule must be at most 500 characters.");
  // Syntax only; UNTIL is normalised against the event's start in the store.
  return format_rule(parse_rule(s));
}

function optRrule(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  return rrule(v);
}

function reminders(v: unknown): number[] {
  if (!Array.isArray(v) || v.length > 20) fail("reminders must be a list of at most 20 integers.");
  const items = (v as unknown[]).map((x) => reqInt(x, "reminder"));
  const unique = [...new Set(items)].sort((a, b) => a - b);
  if (unique.length > MAX_REMINDERS) fail(`At most ${MAX_REMINDERS} reminders.`);
  if (unique.some((i) => i < MIN_REMINDER || i > MAX_REMINDER)) {
    fail(`Reminders must be between ${MIN_REMINDER} and ${MAX_REMINDER} minutes.`);
  }
  return unique;
}

function optReminders(v: unknown): number[] | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return reminders(v);
}

function identifier(v: unknown): string {
  const s = reqString(v, "id");
  if (s.length < 1 || s.length > 200) fail("id must be 1-200 characters.");
  return s;
}

function optIdentifier(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return identifier(v);
}

function rejectNull(v: unknown, name: string): unknown {
  if (v === null) fail(`${name} cannot be null.`);
  return v;
}

function forbidExtra(obj: Record<string, unknown>, allowed: Set<string>, name: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) fail(`${name}: unexpected field '${key}'.`);
  }
}

// ── Stored/read models (plain data; produced by the store or JSON columns) ───

export interface CalendarEntry {
  id: string;
  // Empty for the default calendar: the UI shows its localized name.
  name: string;
  color: string;
  visible: boolean;
  position: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface EventInput {
  calendar_id: string | null; // null: the default calendar
  title: string; // may be empty; the UI shows "Untitled"
  notes: string;
  location: string;
  all_day: boolean;
  // all_day: "YYYY-MM-DD" with an exclusive end; timed: instants with an
  // offset or Z, normalised to "YYYY-MM-DDTHH:MM:SSZ".
  start: string;
  end: string;
  tzid: string; // the browser's zone when the event was made
  rrule: string | null; // RFC 5545 RRULE value, no "RRULE:"
  reminders: number[];
  color: CalendarColor | null;
  task_id: string | null; // a time block for a task card
  task_workspace_id: string | null; // "" = General
}

export interface CreateCalendar {
  name: string;
  color: CalendarColor;
}

export interface UpdateCalendar {
  name?: string;
  color?: CalendarColor;
  visible?: boolean;
  position?: number;
}

export interface EventPatch {
  calendar_id?: string | null;
  title?: string | null;
  notes?: string | null;
  location?: string | null;
  all_day?: boolean | null;
  start?: string | null;
  end?: string | null;
  tzid?: string | null;
  rrule?: string | null;
  reminders?: number[] | null;
  color?: CalendarColor | null;
  task_id?: string | null;
  task_workspace_id?: string | null;
}

export interface EventPatchRequest {
  changes: EventPatch;
  scope: Scope;
  // The occurrence key being edited. With it, `changes.start`/`end` are that
  // occurrence's new times rather than the series' first instance.
  occurrence: string | null;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  title: string;
  notes: string;
  location: string;
  all_day: boolean;
  start: string;
  end: string;
  tzid: string;
  rrule: string | null;
  exdates: string[];
  reminders: number[];
  color: string | null;
  task_id: string | null;
  task_workspace_id: string | null;
  series_id: string | null; // override rows: the master's id
  recurrence_id: string | null; // override rows: the occurrence key it replaces
  source: EventSource;
  created_at: string;
  updated_at: string;
}

export interface Occurrence {
  id: string; // `${event_id}:${occurrence}`, unique per instance
  event_id: string; // the row to PATCH/DELETE: master, override or single event
  series_id: string | null; // the master when part of a recurring series
  occurrence: string; // all-day: original start date; timed: original start in UTC
  recurring: boolean;
  calendar_id: string;
  title: string;
  notes: string;
  location: string;
  all_day: boolean;
  start: string;
  end: string;
  tzid: string;
  rrule: string | null; // the series' rule
  reminders: number[];
  color: string | null;
  task_id: string | null;
  task_workspace_id: string | null;
  source: EventSource;
  reminder_times: string[];
}

export interface CalendarSearchHit extends CalendarEvent {
  // The next instance at or after now; a past single event keeps its start.
  next_start: string | null;
}

export interface CalendarList {
  calendars: CalendarEntry[];
  revision: number;
}

export interface CalendarResponse {
  calendar: CalendarEntry;
  revision: number;
}

export interface CalendarRevision {
  revision: number;
}

export interface OccurrenceList {
  occurrences: Occurrence[];
  revision: number;
}

export interface CalendarEventResponse {
  event: CalendarEvent;
  revision: number;
}

export interface CalendarSearchResponse {
  events: CalendarSearchHit[];
}

export interface ReviewPathCount {
  id: string;
  title: string;
  count: number;
}

export interface ReviewDay {
  date: string;
  mastery: number;
  practice: number;
  paths: ReviewPathCount[];
}

export interface AutomationRun {
  id: string; // `${job_id}:${at}`
  job_id: string;
  name: string;
  message: string;
  at: string; // UTC instant
  kind: "at" | "every" | "cron";
  expr: string | null;
  every_seconds: number | null;
  session_id: string | null;
  enabled: boolean;
}

export interface FootprintSession {
  id: string;
  title: string;
}

export interface FootprintDay {
  date: string;
  session_count: number;
  sessions: FootprintSession[];
  practice_reviews: number;
  mastery_evidence: number;
}

export interface CalendarLayers {
  workspace_id: string;
  reviews: ReviewDay[];
  automations: AutomationRun[];
  footprints: FootprintDay[];
}

export interface CalendarOk {
  ok: boolean;
}

// ── Input validation (pydantic model_validate equivalents) ───────────────────

const EVENT_INPUT_FIELDS = new Set([
  "calendar_id", "title", "notes", "location", "all_day", "start", "end",
  "tzid", "rrule", "reminders", "color", "task_id", "task_workspace_id",
]);

export function validate_create_calendar(data: unknown): { name: string; color: CalendarColor } {
  const obj = (data ?? {}) as Record<string, unknown>;
  forbidExtra(obj, new Set(["name", "color"]), "calendar");
  const name = bounded(rejectNull(obj.name, "name"), "name", 80, true);
  if (name.length < 1) fail("name must be at least 1 character.");
  return { name, color: color(obj.color) };
}

const UPDATE_CALENDAR_FIELDS = new Set(["name", "color", "visible", "position"]);

export function validate_update_calendar(data: unknown): {
  name?: string; color?: CalendarColor; visible?: boolean; position?: number;
} {
  const obj = (data ?? {}) as Record<string, unknown>;
  forbidExtra(obj, UPDATE_CALENDAR_FIELDS, "calendar");
  const out: { name?: string; color?: CalendarColor; visible?: boolean; position?: number } = {};
  for (const key of Object.keys(obj)) {
    rejectNull(obj[key], key); // explicit null rejected for every field
  }
  if ("name" in obj) {
    const name = bounded(obj.name, "name", 80, true);
    if (name.length < 1) fail("name must be at least 1 character.");
    out.name = name;
  }
  if ("color" in obj) out.color = color(obj.color);
  if ("visible" in obj) out.visible = reqBool(obj.visible, "visible");
  if ("position" in obj) out.position = reqInt(obj.position, "position", 0, 100000);
  return out;
}

/** A new event, or the merged result of a patch before it is stored. */
export function validate_event_input(data: unknown): EventInput {
  const obj = (data ?? {}) as Record<string, unknown>;
  forbidExtra(obj, EVENT_INPUT_FIELDS, "event");
  const all_day = obj.all_day === undefined ? false : reqBool(obj.all_day, "all_day");
  let start = bounded(rejectNull(obj.start, "start") ?? "", "start", 40);
  let end = bounded(rejectNull(obj.end, "end") ?? "", "end", 40);
  const tz = obj.tzid === undefined ? "UTC" : tzid(obj.tzid);
  const rem = obj.reminders === undefined ? [] : reminders(obj.reminders);
  const input: EventInput = {
    calendar_id: optIdentifier(obj.calendar_id) ?? null,
    title: obj.title === undefined ? "" : bounded(obj.title, "title", 200, true),
    notes: obj.notes === undefined ? "" : bounded(obj.notes, "notes", 5000),
    location: obj.location === undefined ? "" : bounded(obj.location, "location", 300, true),
    all_day,
    start,
    end,
    tzid: tz,
    rrule: optRrule(obj.rrule) ?? null,
    reminders: rem,
    color: optColor(obj.color) ?? null,
    task_id: optIdentifier(obj.task_id) ?? null,
    task_workspace_id:
      obj.task_workspace_id === undefined || obj.task_workspace_id === null
        ? null
        : bounded(obj.task_workspace_id, "task_workspace_id", 200),
  };
  // check_times model validator
  if (input.all_day) {
    const s = parse_date(input.start);
    const e = parse_date(input.end);
    input.start = new Date(s).toISOString().slice(0, 10);
    input.end = new Date(e).toISOString().slice(0, 10);
  } else {
    input.start = format_instant(parse_instant(input.start));
    input.end = format_instant(parse_instant(input.end));
  }
  const endMs = input.all_day ? parse_date(input.end) : parse_instant(input.end);
  const startMs = input.all_day ? parse_date(input.start) : parse_instant(input.start);
  if (endMs <= startMs) fail("The end must be after the start.");
  if (!input.all_day && input.reminders.some((m) => m < 0)) {
    fail("Only all-day events take reminders after the day starts.");
  }
  return input;
}

const PATCH_NULLABLE = new Set([
  "calendar_id", "title", "notes", "location", "all_day", "start", "end",
  "tzid", "reminders",
]);

/** Every field optional; explicit null clears rrule/color/task links only. */
export function validate_event_patch(data: unknown): EventPatch {
  const obj = (data ?? {}) as Record<string, unknown>;
  forbidExtra(obj, EVENT_INPUT_FIELDS, "event");
  const out: EventPatch = {};
  for (const key of Object.keys(obj)) {
    if (PATCH_NULLABLE.has(key)) rejectNull(obj[key], key);
  }
  if ("calendar_id" in obj) out.calendar_id = optIdentifier(obj.calendar_id) ?? null;
  if ("title" in obj) out.title = bounded(obj.title, "title", 200, true);
  if ("notes" in obj) out.notes = bounded(obj.notes, "notes", 5000);
  if ("location" in obj) out.location = bounded(obj.location, "location", 300, true);
  if ("all_day" in obj) out.all_day = reqBool(obj.all_day, "all_day");
  if ("start" in obj) out.start = bounded(obj.start, "start", 40);
  if ("end" in obj) out.end = bounded(obj.end, "end", 40);
  if ("tzid" in obj) out.tzid = optTzid(obj.tzid) ?? undefined;
  if ("rrule" in obj) out.rrule = optRrule(obj.rrule) ?? null;
  if ("reminders" in obj) out.reminders = optReminders(obj.reminders) ?? undefined;
  if ("color" in obj) out.color = optColor(obj.color) ?? null;
  if ("task_id" in obj) out.task_id = optIdentifier(obj.task_id) ?? null;
  if ("task_workspace_id" in obj) {
    out.task_workspace_id =
      obj.task_workspace_id === null ? null : bounded(obj.task_workspace_id, "task_workspace_id", 200);
  }
  return out;
}

const PATCH_REQUEST_FIELDS = new Set(["changes", "scope", "occurrence"]);

export function validate_patch_request(data: unknown): EventPatchRequest {
  const obj = (data ?? {}) as Record<string, unknown>;
  forbidExtra(obj, PATCH_REQUEST_FIELDS, "request");
  const scope = obj.scope === undefined ? "all" : reqString(obj.scope, "scope");
  if (!SCOPES.has(scope as Scope)) fail("scope must be this, following or all.");
  let occurrence: string | null = null;
  if (obj.occurrence !== undefined && obj.occurrence !== null) {
    occurrence = bounded(obj.occurrence, "occurrence", 40);
  }
  return {
    changes: validate_event_patch(obj.changes ?? {}),
    scope: scope as Scope,
    occurrence,
  };
}

/** Fields of EventInput shared with CalendarEvent (store._fields). */
export const EVENT_INPUT_FIELD_NAMES = [
  "calendar_id", "title", "notes", "location", "all_day", "start", "end",
  "tzid", "rrule", "reminders", "color", "task_id", "task_workspace_id",
] as const;

/** CalendarEvent.model_dump() equivalent — all fields, JSON-safe. */
export function event_to_json(event: CalendarEvent): Record<string, unknown> {
  return { ...event };
}

/** CalendarEvent.model_validate_json equivalent (payload column trust). */
export function event_from_json(text: string): CalendarEvent {
  const obj = JSON.parse(text) as CalendarEvent;
  if (typeof obj !== "object" || obj === null || typeof obj.id !== "string") {
    fail("Corrupt calendar event payload.");
  }
  return obj;
}

export function calendar_entry_from_json(text: string): CalendarEntry {
  const obj = JSON.parse(text) as CalendarEntry;
  if (typeof obj !== "object" || obj === null || typeof obj.id !== "string") {
    fail("Corrupt calendar payload.");
  }
  return obj;
}

/** CalendarEntry.model_dump_json equivalent. */
export function calendar_entry_to_json(entry: CalendarEntry): string {
  return JSON.stringify(entry);
}

export function event_to_json_string(event: CalendarEvent): string {
  return JSON.stringify(event);
}
