// Port of backend/app/services/calendar/store.py
// Account-local calendar persistence. Every mutation is one SQLite transaction.
// Uses the shared database module (src/store/database.ts), whose SCHEMA already
// creates the calendars/events/undo/state tables in praxis.sqlite3.

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  connect,
  ensure_schema,
} from "../../store/database.js";
import { get_settings, type Settings } from "../../config.js";
import {
  calendar_entry_from_json,
  event_from_json,
  event_to_json_string,
  validate_event_input,
  validate_patch_request,
  type CalendarEntry,
  type CalendarEvent,
  type EventInput,
  type EventPatch,
} from "./models.js";
import {
  Timing,
  continuation,
  expand,
  format_instant,
  normalize_rule,
  parse_date,
  parse_instant,
  shift_weekdays,
  truncate_before,
  utcToWall,
  wallToUtc,
  zone,
} from "./recurrence.js";
import type { Occurrence } from "./models.js";

export function now(): string {
  return format_instant(Date.now());
}

export function timing(event: CalendarEvent): Timing {
  return Timing.from_api({
    all_day: event.all_day,
    start: event.start,
    end: event.end,
    tzid: event.tzid,
    rrule: event.rrule,
  });
}

const UNDO_TTL_MS = 15 * 60 * 1000;

export class CalendarStore {
  private settings: Settings;

  constructor(settings: Settings) {
    this.settings = settings;
    ensure_schema(settings);
    const db = connect(settings);
    try {
      db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT 1 FROM calendars LIMIT 1").get();
      if (row === undefined) {
        const stamp = now();
        const entry: CalendarEntry = {
          id: "default",
          name: "",
          color: "#2f6fde",
          visible: true,
          position: 0,
          is_default: true,
          created_at: stamp,
          updated_at: stamp,
        };
        db.prepare("INSERT INTO calendars VALUES(?,?)").run(entry.id, JSON.stringify(entry));
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    } finally {
      db.close();
    }
  }

  /** Run `fn` on a fresh connection; write=true wraps in BEGIN IMMEDIATE. */
  private with_db<T>(write: boolean, fn: (db: DatabaseSync) => T): T {
    const db = connect(this.settings);
    try {
      if (write) db.exec("BEGIN IMMEDIATE");
      const out = fn(db);
      if (write) db.exec("COMMIT");
      return out;
    } catch (e) {
      if (write) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      throw e;
    } finally {
      db.close();
    }
  }

  private static _revision(db: DatabaseSync): number {
    const row = db.prepare("SELECT revision FROM state WHERE id=1").get() as { revision: number };
    return row.revision;
  }

  private static _changed(db: DatabaseSync): number {
    db.prepare("UPDATE state SET revision=revision+1 WHERE id=1").run();
    return CalendarStore._revision(db);
  }

  revision(): number {
    return this.with_db(false, (db) => CalendarStore._revision(db));
  }

  calendars(): { calendars: CalendarEntry[]; revision: number } {
    return this.with_db(false, (db) => {
      db.exec("BEGIN");
      const rows = db.prepare("SELECT payload FROM calendars").all() as { payload: string }[];
      return {
        calendars: rows.map((r) => calendar_entry_from_json(r.payload)),
        revision: CalendarStore._revision(db),
      };
    });
  }

  /** Calendar rows and events for an iCalendar export. */
  export(calendar_id: string | null = null): { calendars: CalendarEntry[]; events: CalendarEvent[] } {
    const { calendars, events } = this.with_db(false, (db) => {
      db.exec("BEGIN");
      const calRows = db.prepare("SELECT payload FROM calendars").all() as { payload: string }[];
      const evRows = db.prepare("SELECT payload FROM events").all() as { payload: string }[];
      return {
        calendars: calRows.map((r) => calendar_entry_from_json(r.payload)),
        events: evRows.map((r) => event_from_json(r.payload)),
      };
    });
    let selected = calendars;
    let selectedEvents = events;
    if (calendar_id !== null) {
      if (!calendars.some((e) => e.id === calendar_id)) {
        const err = new Error(`Unknown calendar ${calendar_id}`) as Error & { status?: number };
        err.status = 404;
        throw err; // KeyError equivalent
      }
      selected = calendars.filter((e) => e.id === calendar_id);
    } else {
      selected = calendars.filter((e) => e.visible);
    }
    const wanted = new Set(selected.map((e) => e.id));
    selectedEvents = events.filter((e) => wanted.has(e.calendar_id));
    selected.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    selectedEvents.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { calendars: selected, events: selectedEvents };
  }

  create_calendar(payload: { name: string; color: string }): { calendar: CalendarEntry; revision: number } {
    return this.with_db(true, (db) => {
      const stamp = now();
      const entry: CalendarEntry = {
        name: payload.name,
        color: payload.color,
        id: randomUUID().replace(/-/g, ""),
        visible: true,
        position: 0,
        is_default: false,
        created_at: stamp,
        updated_at: stamp,
      };
      const count = (db.prepare("SELECT COUNT(*) AS n FROM calendars").get() as { n: number }).n;
      entry.position = count;
      db.prepare("INSERT INTO calendars VALUES(?,?)").run(entry.id, JSON.stringify(entry));
      return { calendar: entry, revision: CalendarStore._changed(db) };
    });
  }

  update_calendar(id: string, payload: {
    name?: string; color?: string; visible?: boolean; position?: number;
  }): { calendar: CalendarEntry; revision: number } {
    return this.with_db(true, (db) => {
      const row = db.prepare("SELECT payload FROM calendars WHERE id=?").get(id) as { payload: string } | undefined;
      if (!row) throw new Error(`Unknown calendar ${id}`);
      const entry = { ...calendar_entry_from_json(row.payload), updated_at: now() };
      if (payload.name !== undefined) entry.name = payload.name;
      if (payload.color !== undefined) entry.color = payload.color;
      if (payload.visible !== undefined) entry.visible = payload.visible;
      if (payload.position !== undefined) entry.position = payload.position;
      db.prepare("UPDATE calendars SET payload=? WHERE id=?").run(JSON.stringify(entry), id);
      return { calendar: entry, revision: CalendarStore._changed(db) };
    });
  }

  delete_calendar(id: string): { revision: number } {
    return this.with_db(true, (db) => {
      const row = db.prepare("SELECT payload FROM calendars WHERE id=?").get(id) as { payload: string } | undefined;
      if (!row) throw new Error(`Unknown calendar ${id}`);
      const entry = calendar_entry_from_json(row.payload);
      if (entry.is_default) throw new Error("The default calendar cannot be deleted.");
      db.prepare("DELETE FROM events WHERE calendar_id=?").run(id);
      db.prepare("DELETE FROM calendars WHERE id=?").run(id);
      return { revision: CalendarStore._changed(db) };
    });
  }

  private static _get(db: DatabaseSync, id: string): CalendarEvent {
    const row = db.prepare("SELECT payload FROM events WHERE id=?").get(id) as { payload: string } | undefined;
    if (!row) throw new Error(`Unknown event ${id}`);
    return event_from_json(row.payload);
  }

  private static _put(db: DatabaseSync, event: CalendarEvent): void {
    db.prepare(
      "INSERT INTO events VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET calendar_id=excluded.calendar_id,series_id=excluded.series_id,payload=excluded.payload",
    ).run(event.id, event.calendar_id, event.series_id, event_to_json_string(event));
  }

  /** Validate + normalise an EventInput-shaped dict; returns stored fields. */
  private _validated(db: DatabaseSync, data: unknown): Record<string, unknown> {
    const payload = validate_event_input(data);
    payload.calendar_id = payload.calendar_id || "default";
    const found = db.prepare("SELECT 1 FROM calendars WHERE id=?").get(payload.calendar_id);
    if (!found) throw new Error("Calendar not found.");
    if (payload.rrule) {
      payload.rrule = normalize_rule(payload.rrule, Timing.from_api({
        all_day: payload.all_day,
        start: payload.start,
        end: payload.end,
        tzid: payload.tzid,
        rrule: payload.rrule,
      }));
    }
    return { ...payload };
  }

  private _new(db: DatabaseSync, data: unknown, extra: Partial<CalendarEvent> = {}): CalendarEvent {
    const fields = this._validated(db, data) as unknown as Omit<CalendarEvent, "id" | "exdates" | "series_id" | "recurrence_id" | "source" | "created_at" | "updated_at">;
    const stamp = now();
    const event: CalendarEvent = {
      ...fields,
      id: randomUUID().replace(/-/g, ""),
      exdates: [],
      series_id: null,
      recurrence_id: null,
      source: "user",
      created_at: stamp,
      updated_at: stamp,
      ...extra,
    } as CalendarEvent;
    CalendarStore._put(db, event);
    return event;
  }

  create(payload: EventInput): { event: CalendarEvent; revision: number } {
    return this.with_db(true, (db) => {
      const event = this._new(db, payload);
      return { event, revision: CalendarStore._changed(db) };
    });
  }

  /** EventInput-shaped fields of a stored event (store._fields). */
  private static _fields(event: CalendarEvent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of [
      "calendar_id", "title", "notes", "location", "all_day", "start", "end",
      "tzid", "rrule", "reminders", "color", "task_id", "task_workspace_id",
    ]) {
      out[k] = (event as unknown as Record<string, unknown>)[k];
    }
    return out;
  }

  private _patch(db: DatabaseSync, event: CalendarEvent, changes: EventPatch): CalendarEvent {
    const merged = { ...CalendarStore._fields(event), ...changes };
    const validated = this._validated(db, merged) as unknown as Partial<CalendarEvent>;
    const updated: CalendarEvent = { ...event, ...validated, updated_at: now() };
    CalendarStore._put(db, updated);
    return updated;
  }

  update(id: string, request: { changes: EventPatch; scope: string; occurrence: string | null }): { revision: number } {
    return this.with_db(true, (db) => {
      const req = validate_patch_request({ changes: request.changes, scope: request.scope, occurrence: request.occurrence });
      const event = CalendarStore._get(db, id);
      const master = event.series_id ? CalendarStore._get(db, event.series_id) : event;
      const changes = { ...req.changes };
      const key = req.occurrence ?? event.recurrence_id;
      let scope = req.scope;
      const rule = timing(master);
      if (!master.rrule) {
        this._patch(db, event, changes);
      } else {
        if (!key && scope !== "all") throw new Error("An occurrence is required.");
        if (key && !rule.is_instance(key)) {
          throw new Error("Occurrence does not belong to this series.");
        }
        if (scope === "following" && key === rule.first_key()) scope = "all";
        if (scope === "this") {
          const instance = rule.instance(rule.at_key(key as string), zone(master.tzid));
          const override = db.prepare(
            "SELECT id FROM events WHERE series_id=? AND json_extract(payload,'$.recurrence_id')=?",
          ).get(master.id, key) as { id: string } | undefined;
          if (override) {
            this._patch(db, CalendarStore._get(db, override.id), { ...changes, rrule: null });
          } else {
            this._new(db, {
              ...CalendarStore._fields(master),
              start: instance.start,
              end: instance.end,
              ...changes,
              rrule: null,
            }, { series_id: master.id, recurrence_id: key as string });
          }
        } else if (scope === "following") {
          const instance = rule.instance(rule.at_key(key as string), zone(master.tzid));
          if (
            "start" in changes &&
            !("rrule" in changes) &&
            (changes.all_day ?? master.all_day) === master.all_day
          ) {
            const tz = zone(master.tzid);
            const origin = master.all_day
              ? instance.start.slice(0, 10)
              : toDateInZone(parse_instant(instance.start), tz);
            const target = master.all_day
              ? String(changes.start).slice(0, 10)
              : toDateInZone(parse_instant(changes.start as string), tz);
            const dayDelta = daysBetween(origin, target);
            changes.rrule = shift_weekdays(continuation(rule, key as string), dayDelta);
          }
          const newEvent = this._new(db, {
            ...CalendarStore._fields(master),
            start: instance.start,
            end: instance.end,
            rrule: continuation(rule, key as string),
            ...changes,
          });
          // Existing exceptions stay attached to their original instances when
          // only descriptive fields change. A reschedule intentionally resets them.
          const reset = ["start", "all_day", "tzid", "rrule"].some((k) => k in changes);
          const later = this._series(db, master.id).filter(
            (r) => r.series_id && (r.recurrence_id as string) >= (key as string),
          );
          for (const row of later) {
            if (reset) {
              db.prepare("DELETE FROM events WHERE id=?").run(row.id);
            } else {
              CalendarStore._put(db, { ...row, series_id: newEvent.id, calendar_id: newEvent.calendar_id });
            }
          }
          newEvent.exdates = reset ? [] : master.exdates.filter((x) => x >= (key as string));
          CalendarStore._put(db, newEvent);
          master.exdates = master.exdates.filter((x) => x < (key as string));
          this._patch(db, master, { rrule: truncate_before(rule, key as string) });
        } else {
          // "all": dragging an occurrence shifts the series in its own wall clock.
          if (key && ("start" in changes || "end" in changes)) {
            const instance = rule.instance(rule.at_key(key), zone(master.tzid));
            if (!("start" in changes)) (changes as Record<string, unknown>).start = instance.start;
            if (!("end" in changes)) (changes as Record<string, unknown>).end = instance.end;
          }
          if (
            key &&
            "start" in changes &&
            (changes.all_day ?? master.all_day) === master.all_day
          ) {
            let dayDelta: number;
            let newStart: string;
            let newEnd: string;
            if (master.all_day) {
              const keyDate = parse_date(key);
              const changeStart = parse_date(changes.start as string);
              const deltaDays = Math.round((changeStart - keyDate) / 86400000);
              const changeEnd = parse_date((changes.end as string) ?? master.end);
              const durationDays = Math.round((changeEnd - changeStart) / 86400000);
              const start = parse_date(master.start) + deltaDays * 86400000;
              newStart = new Date(start).toISOString().slice(0, 10);
              newEnd = new Date(start + durationDays * 86400000).toISOString().slice(0, 10);
              dayDelta = deltaDays;
            } else {
              const tz = zone(master.tzid);
              const target = utcToWallLocal(parse_instant(changes.start as string), tz);
              const origin = utcToWallLocal(parse_instant(key), tz);
              const delta = target - origin; // wall-clock delta
              dayDelta = Math.round((startOfDayLocal(target) - startOfDayLocal(origin)) / 86400000);
              const duration = parse_instant((changes.end as string) ?? master.end) - parse_instant(changes.start as string);
              const startWall = utcToWallLocal(parse_instant(master.start), tz) + delta;
              newStart = format_instant(wallToUtcLocal(startWall, tz));
              newEnd = format_instant(wallToUtcLocal(startWall, tz) + duration);
            }
            changes.start = newStart;
            changes.end = newEnd;
            if (!("rrule" in changes)) {
              changes.rrule = shift_weekdays(master.rrule as string, dayDelta);
            }
          }
          const reset = ["start", "all_day", "tzid", "rrule"].some((k) => k in changes);
          if (reset) {
            db.prepare("DELETE FROM events WHERE series_id=?").run(master.id);
            master.exdates = [];
          }
          this._patch(db, master, changes);
          if (!reset) {
            for (const row of this._series(db, master.id)) {
              if (row.series_id) this._patch(db, row, changes);
            }
          }
        }
      }
      return { revision: CalendarStore._changed(db) };
    });
  }

  private _series(db: DatabaseSync, id: string): CalendarEvent[] {
    const rows = db.prepare("SELECT payload FROM events WHERE id=? OR series_id=?").all(id, id) as { payload: string }[];
    return rows.map((r) => event_from_json(r.payload));
  }

  delete(id: string, scope: string = "all", occurrence: string | null = null): { revision: number; undo_token: string } {
    return this.with_db(true, (db) => {
      const event = CalendarStore._get(db, id);
      const master = event.series_id ? CalendarStore._get(db, event.series_id) : event;
      const key = occurrence ?? event.recurrence_id;
      const before = this._series(db, master.id);
      const rule = timing(master);
      let sc = scope;
      if (master.rrule && sc !== "all") {
        if (!key || !rule.is_instance(key)) throw new Error("A valid occurrence is required.");
        if (sc === "following" && key === rule.first_key()) sc = "all";
      }
      if (!master.rrule || sc === "all") {
        db.prepare("DELETE FROM events WHERE id=? OR series_id=?").run(master.id, master.id);
      } else if (sc === "this") {
        master.exdates = [...new Set([...master.exdates, key as string])].sort();
        CalendarStore._put(db, master);
        for (const row of before) {
          if (row.series_id && row.recurrence_id === key) {
            db.prepare("DELETE FROM events WHERE id=?").run(row.id);
          }
        }
      } else {
        this._patch(db, master, { rrule: truncate_before(rule, key as string) });
        for (const row of before) {
          if (row.series_id && (row.recurrence_id as string) >= (key as string)) {
            db.prepare("DELETE FROM events WHERE id=?").run(row.id);
          }
        }
      }
      const token = randomUUID().replace(/-/g, "");
      const after = this._series(db, master.id);
      const dumpSorted = (rows: CalendarEvent[]) =>
        JSON.stringify(rows.map((r) => sortKeys({ ...r })));
      db.prepare("DELETE FROM undo WHERE created_at<?").run(format_instant(Date.now() - UNDO_TTL_MS));
      db.prepare("INSERT INTO undo VALUES(?,?,?,?)").run(token, now(), dumpSorted(before), dumpSorted(after));
      return { revision: CalendarStore._changed(db), undo_token: token };
    });
  }

  restore(token: string): { revision: number } {
    return this.with_db(true, (db) => {
      const row = db.prepare("SELECT before_json,after_json,created_at FROM undo WHERE token=?").get(token) as
        | { before_json: string; after_json: string; created_at: string }
        | undefined;
      if (!row || parse_instant(row.created_at) < Date.now() - UNDO_TTL_MS) {
        throw new Error(`Unknown undo token ${token}`);
      }
      const before = JSON.parse(row.before_json) as Record<string, unknown>[];
      const after = JSON.parse(row.after_json) as Record<string, unknown>[];
      const master_id = before.find((r) => !r.series_id)?.id as string;
      const canon = (rows: Record<string, unknown>[]) =>
        JSON.stringify(
          rows
            .map((r) => sortKeys(r) as Record<string, unknown>)
            .sort((a, b) => String(a.id).localeCompare(String(b.id))),
        );
      const current = this._series(db, master_id).map((r) => ({ ...r }) as unknown as Record<string, unknown>);
      if (canon(current) !== canon(after)) {
        throw new Error("This series changed since deletion; undo would overwrite newer edits.");
      }
      for (const r of before) {
        const found = db.prepare("SELECT 1 FROM calendars WHERE id=?").get(String(r.calendar_id));
        if (!found) throw new Error("The calendar has been deleted.");
      }
      db.prepare("DELETE FROM events WHERE id=? OR series_id=?").run(master_id, master_id);
      for (const data of before) {
        CalendarStore._put(db, data as unknown as CalendarEvent);
      }
      db.prepare("DELETE FROM undo WHERE token=?").run(token);
      return { revision: CalendarStore._changed(db) };
    });
  }

  occurrences(start: number, end: number, tzid: string): { occurrences: Occurrence[]; revision: number } {
    const { rows, revision } = this.with_db(false, (db) => {
      db.exec("BEGIN");
      const rs = db.prepare("SELECT payload FROM events").all() as { payload: string }[];
      return {
        rows: rs.map((r) => event_from_json(r.payload)),
        revision: CalendarStore._revision(db),
      };
    });
    const masters = new Map<string, CalendarEvent>();
    for (const row of rows) if (!row.series_id) masters.set(row.id, row);
    const excluded = new Map<string, Set<string>>();
    for (const [id, row] of masters) excluded.set(id, new Set(row.exdates));
    for (const row of rows) {
      if (row.series_id && excluded.has(row.series_id) && row.recurrence_id !== null) {
        excluded.get(row.series_id)!.add(row.recurrence_id);
      }
    }
    const z = zone(tzid);
    const result: Occurrence[] = [];
    for (const row of rows) {
      const master = row.series_id ? masters.get(row.series_id) : row;
      if (!master || (row.series_id && master.exdates.includes(row.recurrence_id as string))) continue;
      for (const item of expand(timing(row), start, end, z, excluded.get(row.id) ?? new Set())) {
        result.push({
          ...(CalendarStore._fields(row) as unknown as Omit<Occurrence, "id" | "event_id" | "series_id" | "occurrence" | "recurring" | "rrule" | "start" | "end" | "source" | "reminder_times">),
          rrule: master.rrule,
          start: item.start,
          end: item.end,
          id: `${row.id}:${row.recurrence_id ?? item.key}`,
          event_id: row.id,
          series_id: master.rrule ? master.id : null,
          occurrence: row.recurrence_id ?? item.key,
          recurring: !!master.rrule,
          source: row.source,
          reminder_times: row.reminders.map((minutes) =>
            format_instant(
              (row.all_day
                ? wallToUtcLocal(parse_date(item.start), zone(row.tzid))
                : parse_instant(item.start)) - minutes * 60000,
            ),
          ),
        } as Occurrence);
      }
    }
    result.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { occurrences: result, revision };
  }

  task_blocks(workspace_id: string): Record<string, number> {
    return this.with_db(false, (db) => {
      const rows = db.prepare("SELECT payload FROM events WHERE series_id IS NULL").all() as { payload: string }[];
      const counts: Record<string, number> = {};
      for (const r of rows) {
        const event = event_from_json(r.payload);
        if (event.task_id && event.task_workspace_id === workspace_id) {
          counts[event.task_id] = (counts[event.task_id] ?? 0) + 1;
        }
      }
      return counts;
    });
  }

  search(query: string, limit = 50): { events: Record<string, unknown>[] } {
    const rows = this.with_db(false, (db) => {
      db.exec("BEGIN");
      return (db.prepare("SELECT payload FROM events").all() as { payload: string }[]).map((r) =>
        event_from_json(r.payload),
      );
    });
    const excluded = new Map<string, Set<string>>();
    for (const row of rows) if (!row.series_id) excluded.set(row.id, new Set(row.exdates));
    for (const row of rows) {
      if (row.series_id && excluded.has(row.series_id) && row.recurrence_id !== null) {
        excluded.get(row.series_id)!.add(row.recurrence_id);
      }
    }
    const hits: Record<string, unknown>[] = [];
    const moment = Date.now();
    const needle = query.toLowerCase();
    for (const event of rows) {
      const hay = [event.title, event.notes, event.location].join("\n").toLowerCase();
      if (!hay.includes(needle)) continue;
      const future = expand(
        timing(event),
        moment,
        moment + 3660 * 86400000,
        zone(event.tzid),
        excluded.get(event.id) ?? new Set(),
        1,
      );
      hits.push({
        ...event,
        next_start: future.length ? future[0].start : event.rrule ? null : event.start,
      });
    }
    const order = (hit: Record<string, unknown>): [number, number] => {
      const value = (hit.next_start as string | null) ?? (hit.start as string);
      let timestamp: number;
      if (hit.all_day) {
        timestamp = wallToUtcLocal(parse_date(value), zone(hit.tzid as string)) / 1000;
      } else {
        timestamp = parse_instant(value) / 1000;
      }
      return timestamp >= moment / 1000 ? [0, timestamp] : [1, -timestamp];
    };
    hits.sort((a, b) => {
      const [ga, ta] = order(a);
      const [gb, tb] = order(b);
      return ga - gb || ta - tb;
    });
    return { events: hits.slice(0, limit) };
  }
}

// ── local helpers ────────────────────────────────────────────────────────────

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

function startOfDayLocal(ms: number): number {
  return Math.floor(ms / 86400000) * 86400000;
}

/** Wall ms of a UTC instant in tzid (recurrence.utcToWall is not re-exported
 *  under this name; kept local to avoid a wider API surface). */
function utcToWallLocal(utcMs: number, tzid: string): number {
  // utcToWall is exported from recurrence.ts
  return utcToWall(utcMs, tzid);
}

function wallToUtcLocal(wallMs: number, tzid: string): number {
  return wallToUtc(wallMs, tzid, 0);
}

function toDateInZone(utcMs: number, tzid: string): string {
  return new Date(utcToWall(utcMs, tzid)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}

export function get_calendar_store(): CalendarStore {
  // Calendars share the one application database.
  return new CalendarStore(get_settings());
}
