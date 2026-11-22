// Port of backend/app/services/calendar/ics.py
// Render stored calendar events as RFC 5545 iCalendar text.
//
// Timed events use local wall time with `TZID` and a `VTIMEZONE` per used
// zone. Offsets come from Intl (zoneinfo equivalent) transitions in a window
// covering the exported events (padded by a year; spans over 40 years are
// rejected). UTC timed events use the `Z` form and skip `VTIMEZONE`. All-day
// events use `VALUE=DATE` with the store's exclusive end date.
//
// A series is one `VEVENT` (UID `<id>@praxis`) plus `EXDATE` for deleted
// occurrences and separate `VEVENT`s with `RECURRENCE-ID` for per-occurrence
// overrides. Workspace overlay layers are not stored as events and are omitted.

import {
  Timing,
  parse_instant,
  to_wall,
  tzOffsetMs,
  utcToWall,
  wallToUtc,
  zone,
} from "./recurrence.js";
import type { CalendarEntry, CalendarEvent } from "./models.js";

const PRODID = "-//HKUDS//Praxis//EN";
const UID_HOST = "praxis";
const DEFAULT_CALENDAR_NAME = "Praxis";
const FOLD = 75;
const TZ_PAD_YEARS = 1;
const TZ_MAX_SPAN = 40;
const UNSAFE_FILENAME = /[\\\\/:*?"<>|\x00-\x1f]+/g;
const UNTIL_YEAR = /UNTIL=(\d{4})/;

export function ics_filename(name: string): string {
  /** Return a sanitised `.ics` attachment name for `name`. */
  let cleaned = name.replace(UNSAFE_FILENAME, "-").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80) || "calendar";
  if (!cleaned.toLowerCase().endsWith(".ics")) cleaned = `${cleaned}.ics`;
  return cleaned;
}

export function render_calendar(
  calendars: readonly CalendarEntry[],
  events: readonly CalendarEvent[],
  opts: { calendar_name?: string | null } = {},
): string {
  /** RFC 5545 text (CRLF, folded) for the given calendars and events. */
  const calendar_name = opts.calendar_name;
  const title = calendar_name || calendar_title(calendars);
  const masters = events.filter((e) => !e.series_id);
  const overrides = new Map<string, CalendarEvent[]>();
  const masterIds = new Set(masters.map((e) => e.id));
  for (const event of events) {
    if (event.series_id && masterIds.has(event.series_id)) {
      const list = overrides.get(event.series_id) ?? [];
      list.push(event);
      overrides.set(event.series_id, list);
    }
  }
  for (const group of overrides.values()) {
    group.sort((a, b) =>
      (a.recurrence_id ?? "") < (b.recurrence_id ?? "") ? -1
      : (a.recurrence_id ?? "") > (b.recurrence_id ?? "") ? 1
      : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
  masters.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    text("X-WR-CALNAME", title),
  ];
  for (const tzid of used_zones(events)) {
    lines.push(...vtimezone(tzid, events));
  }
  for (const event of masters) {
    lines.push(...vevent(event, overrides.get(event.id) ?? []));
  }
  lines.push("END:VCALENDAR");
  return lines.map((l) => fold(l)).join("\r\n") + "\r\n";
}

function calendar_title(calendars: readonly CalendarEntry[]): string {
  if (calendars.length === 1 && calendars[0].name.trim()) return calendars[0].name.trim();
  return DEFAULT_CALENDAR_NAME;
}

function used_zones(events: readonly CalendarEvent[]): string[] {
  const zones = new Set<string>();
  for (const event of events) {
    if (!event.all_day && event.tzid && event.tzid !== "UTC") zones.add(event.tzid);
  }
  return [...zones].sort();
}

function timingOf(event: CalendarEvent): Timing {
  return Timing.from_api({
    all_day: event.all_day,
    start: event.start,
    end: event.end,
    tzid: event.tzid,
    rrule: event.rrule,
  });
}

function uid(eventId: string): string {
  return `${eventId}@${UID_HOST}`;
}

function vevent(master: CalendarEvent, exceptions: readonly CalendarEvent[]): string[] {
  const lines = event_body(master, { uid: uid(master.id), rrule: master.rrule, exdates: master.exdates });
  for (const item of exceptions) {
    if (!item.recurrence_id) continue;
    lines.push(
      ...event_body(item, {
        uid: uid(master.id),
        recurrence_id: item.recurrence_id,
        recurrence_all_day: master.all_day,
        recurrence_tzid: master.tzid,
      }),
    );
  }
  return lines;
}

interface EventBodyOpts {
  uid: string;
  rrule?: string | null;
  exdates?: readonly string[];
  recurrence_id?: string | null;
  recurrence_all_day?: boolean;
  recurrence_tzid?: string;
}

function event_body(event: CalendarEvent, opts: EventBodyOpts): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${opts.uid}`, `DTSTAMP:${stamp(event.updated_at)}`];
  if (opts.recurrence_id) {
    lines.push(recurrence_stamp(opts.recurrence_id, opts.recurrence_all_day ?? false, opts.recurrence_tzid ?? "UTC"));
  }
  lines.push(...dtstart_dtend(event));
  lines.push(text("SUMMARY", event.title));
  if (event.notes) lines.push(text("DESCRIPTION", event.notes));
  if (event.location) lines.push(text("LOCATION", event.location));
  if (opts.rrule) lines.push(`RRULE:${opts.rrule}`);
  for (const key of opts.exdates ?? []) {
    lines.push(recurrence_stamp(key, event.all_day, event.tzid, "EXDATE"));
  }
  for (const minutes of event.reminders) {
    lines.push(...valarm(minutes, event.all_day, event.title));
  }
  lines.push("END:VEVENT");
  return lines;
}

function dtstart_dtend(event: CalendarEvent): string[] {
  const timing = timingOf(event);
  if (event.all_day) {
    return [
      prop("DTSTART", ics_date(timing.dtstart), { VALUE: "DATE" }),
      prop("DTEND", ics_date(timing.dtend), { VALUE: "DATE" }),
    ];
  }
  if (event.tzid === "UTC") {
    return [
      prop("DTSTART", `${ics_datetime(timing.dtstart)}Z`),
      prop("DTEND", `${ics_datetime(timing.dtend)}Z`),
    ];
  }
  return [
    prop("DTSTART", ics_datetime(timing.dtstart), { TZID: event.tzid }),
    prop("DTEND", ics_datetime(timing.dtend), { TZID: event.tzid }),
  ];
}

function recurrence_stamp(key: string, all_day: boolean, tzid: string, name = "RECURRENCE-ID"): string {
  if (all_day) return prop(name, ics_date(key), { VALUE: "DATE" });
  const wall = to_wall(parse_instant(key), tzid);
  if (tzid === "UTC") return prop(name, `${ics_datetime(wall)}Z`);
  return prop(name, ics_datetime(wall), { TZID: tzid });
}

function valarm(minutes: number, all_day: boolean, title: string): string[] {
  let trigger: string;
  if (all_day && minutes < 0) trigger = `PT${Math.abs(minutes)}M`;
  else if (minutes === 0) trigger = "PT0M";
  else trigger = `-PT${minutes}M`;
  return [
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    text("DESCRIPTION", title || "Reminder"),
    `TRIGGER:${trigger}`,
    "END:VALARM",
  ];
}

function stamp(instant: string): string {
  const ms = parse_instant(instant);
  const p = wallPartsUtc(ms);
  return `${p.y}${p.mo}${p.d}T${p.h}${p.mi}${p.s}Z`;
}

function ics_date(value: string): string {
  return value.replace(/-/g, "");
}

function ics_datetime(wall: string): string {
  return `${wall.slice(0, 4)}${wall.slice(5, 7)}${wall.slice(8, 10)}T${wall.slice(11, 13)}${wall.slice(14, 16)}${wall.slice(17, 19)}`;
}

function text(name: string, value: string): string {
  return prop(name, escapeText(value));
}

function prop(name: string, value: string, params: Record<string, string> = {}): string {
  const extra = Object.entries(params).map(([k, v]) => `;${k}=${v}`).join("");
  return `${name}${extra}:${value}`;
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\n");
}

/** Fold `line` to 75 UTF-8 octets, splitting on character boundaries. */
function fold(line: string): string {
  const data = new TextEncoder().encode(line);
  if (data.length <= FOLD) return line;
  const chunks: Uint8Array[] = [];
  let rest = data;
  let limit = FOLD;
  while (rest.length) {
    if (rest.length <= limit) {
      chunks.push(rest);
      break;
    }
    let n = limit;
    while (n > 0 && (rest[n] & 0xc0) === 0x80) n--;
    if (n === 0) n = limit;
    chunks.push(rest.slice(0, n));
    rest = rest.slice(n);
    limit = FOLD - 1;
  }
  const decoder = new TextDecoder();
  const [first, ...more] = chunks.map((c) => decoder.decode(c));
  return [first, ...more.map((p) => ` ${p}`)].join("\r\n");
}

// ── VTIMEZONE generation ─────────────────────────────────────────────────────

function vtimezone(tzid: string, events: readonly CalendarEvent[]): string[] {
  const tz = zone(tzid);
  // All-day events are written as floating dates and never reference a
  // VTIMEZONE, so only timed events in this zone decide its window.
  const zoned = events.filter((e) => !e.all_day && e.tzid === tzid);
  const [start, end] = tz_window(zoned);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  const startWall = utcToWall(start, tz);
  const initialOffset = tzOffsetMs(tz, start);
  const startParts = wallPartsUtc(startWall);
  const isDst0 = isDst(tz, start);
  const name0 = tzName(tz, start);
  lines.push(
    ...observance(
      wallMsFrom(startParts.y, startParts.mo, startParts.d, startParts.h, startParts.mi, startParts.s),
      initialOffset,
      initialOffset,
      isDst0,
      name0,
    ),
  );
  for (const tr of transitions(tz, start, end)) {
    const wall = utcToWall(tr.onset + tr.fromOff, tz);
    const p = wallPartsUtc(wall);
    lines.push(
      ...observance(wallMsFrom(p.y, p.mo, p.d, p.h, p.mi, p.s), tr.fromOff, tr.toOff, tr.isDst, tr.name),
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function observance(
  localOnsetMs: number,
  offsetFrom: number,
  offsetTo: number,
  isDst: boolean,
  tzname: string,
): string[] {
  const kind = isDst ? "DAYLIGHT" : "STANDARD";
  const p = wallPartsUtc(localOnsetMs);
  const onset = `${p.y}${p.mo}${p.d}T${p.h}${p.mi}${p.s}`;
  const lines = [
    `BEGIN:${kind}`,
    `DTSTART:${onset}`,
    `TZOFFSETFROM:${offsetText(offsetFrom)}`,
    `TZOFFSETTO:${offsetText(offsetTo)}`,
  ];
  if (tzname) lines.push(text("TZNAME", tzname));
  lines.push(`END:${kind}`);
  return lines;
}

function offsetText(deltaMs: number): string {
  const sign = deltaMs >= 0 ? "+" : "-";
  const total = Math.abs(Math.trunc(deltaMs / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return `${sign}${String(hours).padStart(2, "0")}${String(minutes).padStart(2, "0")}`;
}

function tz_window(events: readonly CalendarEvent[]): [number, number] {
  const years: number[] = [];
  let unbounded = false;
  for (const event of events) {
    years.push(Number(event.start.slice(0, 4)), Number(event.end.slice(0, 4)));
    if (!event.rrule) continue;
    const until = UNTIL_YEAR.exec(event.rrule);
    if (until) {
      years.push(Number(until[1]));
    } else if (event.rrule.includes("COUNT=")) {
      const timing = timingOf(event);
      // COUNT is validated and bounded by the calendar recurrence layer.
      let n = 0;
      for (const occurrence of timing.starts()) {
        if (++n > 10000) break;
        years.push(Number(wallPartsUtc(occurrence + timing.duration).y));
      }
    } else {
      unbounded = true;
    }
  }
  const nowYear = Number(wallPartsUtc(Date.now()).y);
  const lo = Math.max(1, Math.min(...(years.length ? years : [nowYear])) - TZ_PAD_YEARS);
  let hi = Math.min(9999, Math.max(...(years.length ? years : [nowYear])) + TZ_PAD_YEARS + 1);
  if (unbounded) hi = Math.max(hi, nowYear + 15);
  if (hi - lo > TZ_MAX_SPAN) {
    throw new Error("Calendar export cannot cover more than 40 years of timezone transitions.");
  }
  return [Date.UTC(lo, 0, 1), Date.UTC(hi, 0, 1)];
}

interface Transition {
  onset: number; // UTC ms
  fromOff: number;
  toOff: number;
  isDst: boolean;
  name: string;
}

/** UTC onsets in `(start, end]` where the zone offset changes. */
function transitions(tz: string, start: number, end: number): Transition[] {
  const found: Transition[] = [];
  const step = 3600_000;
  let prev = start;
  let prevOff = tzOffsetMs(tz, start);
  let moment = start + step;
  while (moment <= end) {
    const off = tzOffsetMs(tz, moment);
    if (off !== prevOff) {
      const onset = firstChanged(tz, prev, moment, prevOff);
      const newOff = tzOffsetMs(tz, onset);
      found.push({
        onset,
        fromOff: prevOff,
        toOff: newOff,
        isDst: isDstAt(tz, onset),
        name: tzNameAt(tz, onset),
      });
      prevOff = newOff;
      prev = onset;
      moment = onset + step;
    } else {
      prev = moment;
      moment += step;
    }
  }
  return found;
}

function firstChanged(tz: string, start: number, end: number, previous: number): number {
  let lo = start;
  let hi = end;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (tzOffsetMs(tz, mid) === previous) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ── tz helpers via Intl ──────────────────────────────────────────────────────

const _nameFormatters = new Map<string, Intl.DateTimeFormat>();

function nameFormatter(tz: string): Intl.DateTimeFormat {
  let f = _nameFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" });
    _nameFormatters.set(tz, f);
  }
  return f;
}

function tzNameAt(tz: string, utcMs: number): string {
  const parts = nameFormatter(tz).formatToParts(new Date(utcMs));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

function isDstAt(tz: string, utcMs: number): boolean {
  // Heuristic: DST zones have "DT"/summer abbreviations or a positive
  // offset larger than the zone's standard offset. Approximate by comparing
  // the abbreviation against common DST markers; fall back to offset delta
  // vs January offset.
  const name = tzNameAt(tz, utcMs);
  if (/^[A-Z]{2,5}T$/.test(name) || /^(CEST|BST|EDT|CDT|MDT|PDT|AEDT|NZDT|IST|EEST|MSK|GST|AST)$/.test(name)) {
    // ambiguous list — treat known DST abbreviations as DST
    return /T$/.test(name) || ["CEST","BST","EDT","CDT","MDT","PDT","AEDT","NZDT","EEST","GST"].includes(name);
  }
  // Fallback: offset greater than the zone's January (standard) offset.
  const year = Number(wallPartsUtc(utcMs).y);
  const jan = Date.UTC(year, 0, 15);
  const jul = Date.UTC(year, 6, 15);
  const std = Math.min(tzOffsetMs(tz, jan), tzOffsetMs(tz, jul));
  return tzOffsetMs(tz, utcMs) > std;
}

// Python calls .dst()/.tzname() on the zoned datetime; expose small wrappers
// used by vtimezone.
function isDst(tz: string, utcMs: number): boolean {
  return isDstAt(tz, utcMs);
}
function tzName(tz: string, utcMs: number): string {
  return tzNameAt(tz, utcMs);
}

function wallPartsUtc(ms: number): { y: string; mo: string; d: string; h: string; mi: string; s: string } {
  const dt = new Date(ms);
  const p = (v: number, w = 2) => String(v).padStart(w, "0");
  return {
    y: String(dt.getUTCFullYear()).padStart(4, "0"),
    mo: p(dt.getUTCMonth() + 1),
    d: p(dt.getUTCDate()),
    h: p(dt.getUTCHours()),
    mi: p(dt.getUTCMinutes()),
    s: p(dt.getUTCSeconds()),
  };
}

function wallMsFrom(y: string | number, mo: string | number, d: string | number, h: string | number, mi: string | number, s: string | number): number {
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
}

// silence unused-import warnings for helpers kept for parity with the Python API
void wallToUtc;
