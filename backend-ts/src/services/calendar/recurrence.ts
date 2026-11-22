// RFC 5545 recurrence: wall-clock expansion, occurrence keys and series splits.
//
// Timed events are stored as local wall time in their `tzid` and expanded on
// that wall clock, then converted to UTC per instance — "every Monday 09:00
// Europe/Berlin" stays at 09:00 across DST. A timed event's duration is kept in
// absolute minutes; an all-day event's in days.
//
// An *occurrence key* names one generated instance by its original start: the
// date for all-day events, the UTC instant (`%Y-%m-%dT%H:%M:%SZ`) for timed
// ones. Exdates and override rows refer to instances by this key.
//
// NOTE: the Python version delegates RRULE evaluation to dateutil.rrule. This
// port re-implements the subset used here (HOURLY..YEARLY, all BYxxx parts)
// dependency-free. Behaviour was differentially tested against python-dateutil
// 2.9; exotic combinations (BYWEEKNO edge cases, BYSETPOS across month
// boundaries) may still deviate — see TODO markers below.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export const MAX_INSTANCES = 1000; // per series per query
export const MAX_COUNT = 10000;

const RULE_KEYS = new Set([
  "FREQ",
  "UNTIL",
  "COUNT",
  "INTERVAL",
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYMONTH",
  "BYSETPOS",
  "WKST",
]);
// Sub-hourly rules are not calendar events, and walking one from an old start
// to the requested range would cost more than the 1000-instance cap saves.
const FREQUENCIES = new Set(["YEARLY", "MONTHLY", "WEEKLY", "DAILY", "HOURLY"]);
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Hard cap on generated candidates so a pathological rule cannot spin forever.
const MAX_PERIODS = 500_000;

// ── Wall-clock representation ────────────────────────────────────────────────
// "Wall" times are milliseconds since the epoch of the *naive* components read
// as UTC — i.e. Date.UTC(y, m-1, d, h, mi, s). All rule-space arithmetic happens
// on these values; conversion to/from real instants goes through the tz helpers.

interface WallParts {
  y: number;
  mo: number; // 1-12
  d: number; // 1-31
  wd: number; // 0=Monday .. 6=Sunday
  h: number;
  mi: number;
  s: number;
  ms: number;
}

function wallParts(ms: number): WallParts {
  const dt = new Date(ms);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    wd: (dt.getUTCDay() + 6) % 7,
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
    s: dt.getUTCSeconds(),
    ms: dt.getUTCMilliseconds(),
  };
}

function wallMs(y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number {
  return Date.UTC(y, mo - 1, d, h, mi, s, ms);
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function startOfDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function startOfHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

function addDays(ms: number, n: number): number {
  return ms + n * DAY_MS;
}

function addHours(ms: number, n: number): number {
  return ms + n * HOUR_MS;
}

function addMonths(ms: number, n: number): number {
  const p = wallParts(ms);
  const idx = p.y * 12 + (p.mo - 1) + n;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12) + 1;
  const d = Math.min(p.d, daysInMonth(y, mo));
  return wallMs(y, mo, d, p.h, p.mi, p.s, p.ms);
}

function addYears(ms: number, n: number): number {
  const p = wallParts(ms);
  const y = p.y + n;
  const d = Math.min(p.d, daysInMonth(y, p.mo));
  return wallMs(y, p.mo, d, p.h, p.mi, p.s, p.ms);
}

function isoDate(ms: number): string {
  const p = wallParts(ms);
  const pad = (v: number, w = 2) => String(v).padStart(w, "0");
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

function pad2(v: number): string {
  return String(v).padStart(2, "0");
}

function pad4(v: number): string {
  return String(v).padStart(4, "0");
}

// ── Time zones (Intl-based, dependency-free) ────────────────────────────────

const _formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tzid: string): Intl.DateTimeFormat {
  let f = _formatters.get(tzid);
  if (!f) {
    // Throws RangeError for unknown zones — mapped to ValueError by zone().
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    _formatters.set(tzid, f);
  }
  return f;
}

/** Validate a tzid the way zoneinfo.ZoneInfo does. Returns the tzid. */
export function zone(tzid: string): string {
  try {
    formatter(tzid);
    return tzid;
  } catch {
    throw new Error(`Unknown time zone '${tzid}'.`);
  }
}

function wallFromParts(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return wallMs(y, mo, d, h, mi, s);
}

/** Wall-clock components of a UTC instant in `tzid`, as wall ms. */
export function utcToWall(utcMs: number, tzid: string): number {
  const parts = formatter(tzid).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const sec = wallFromParts(get("year"), get("month"), get("day"), get("hour"), get("minute"), get("second"));
  const msPart = ((utcMs % 1000) + 1000) % 1000;
  return sec + msPart;
}

/** Offset of `tzid` at UTC instant `utcMs`, in milliseconds. */
export function tzOffsetMs(tzid: string, utcMs: number): number {
  // utcToWall preserves the sub-second part, so this is exact.
  return utcToWall(utcMs, tzid) - utcMs;
}

const _WALL_PROBE_OFFSETS = [-36, -12, 0, 12, 36].map((h) => h * HOUR_MS);

/**
 * UTC instant of a wall-clock time in `tzid`.
 * Ambiguous wall times resolve to their first occurrence (fold=0), as RFC 5545
 * prescribes for DTSTART;TZID; fold=1 picks the second. Nonexistent wall times
 * (spring-forward gap) resolve approximately, matching zoneinfo's fold=0.
 */
export function wallToUtc(wall: number, tzid: string, fold = 0): number {
  // Candidate offsets sampled around the wall clock: the true offset at the
  // answer instant is one of the offsets in effect nearby (transitions are
  // hours apart; the ±36h probes also cover date-line skips).
  const offsets = new Set<number>();
  for (const delta of _WALL_PROBE_OFFSETS) offsets.add(tzOffsetMs(tzid, wall + delta));
  const valid: number[] = [];
  for (const off of offsets) {
    const c = wall - off;
    if (utcToWall(c, tzid) === wall) valid.push(c);
  }
  if (valid.length === 0) {
    // Spring-forward gap: no UTC instant maps to this wall time. zoneinfo
    // resolves with the offset in effect on the fold's side of the gap.
    const probe = fold === 0 ? wall - 12 * HOUR_MS : wall + 12 * HOUR_MS;
    return wall - tzOffsetMs(tzid, probe);
  }
  valid.sort((a, b) => a - b);
  return fold === 0 ? valid[0] : valid[valid.length - 1];
}

// ── API encodings ────────────────────────────────────────────────────────────

/** All-day times must be dates (YYYY-MM-DD); returns wall ms at midnight. */
export function parse_date(value: string): number {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new Error("All-day times must be dates (YYYY-MM-DD).");
  }
  const y = Number(value.slice(0, 4));
  const mo = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const ms = wallMs(y, mo, d);
  // Reject impossible dates (e.g. 2023-02-30) like date.fromisoformat.
  const p = wallParts(ms);
  if (p.y !== y || p.mo !== mo || p.d !== d) {
    throw new Error(`Invalid date ${value}.`);
  }
  return ms;
}

const INSTANT_OFFSET_RE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** An ISO-8601 instant with an offset or Z, as UTC epoch ms. */
export function parse_instant(value: string): number {
  let ms: number;
  try {
    if (typeof value !== "string" || !value.includes("T") || !INSTANT_OFFSET_RE.test(value)) {
      throw new Error("no offset");
    }
    ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new Error("unparseable");
  } catch {
    throw new Error("Times must be ISO-8601 instants with an offset or Z.");
  }
  return Math.trunc(ms / 1000) * 1000; // .replace(microsecond=0)
}

export function format_instant(ms: number): string {
  const p = wallParts(ms);
  return `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}Z`;
}

const WALL_FORMAT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** Wall time "YYYY-MM-DDTHH:MM:SS" → wall ms (naive components). */
export function parse_wall(wall: string): number {
  const m = WALL_FORMAT_RE.exec(wall);
  if (!m) throw new Error(`Invalid wall time '${wall}'.`);
  return wallMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export function format_wall(ms: number): string {
  const p = wallParts(ms);
  return `${pad4(p.y)}-${pad2(p.mo)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`;
}

/** UTC instant → wall time "YYYY-MM-DDTHH:MM:SS" in tzid. */
export function to_wall(msUtc: number, tzid: string): string {
  return format_wall(utcToWall(msUtc, tzid));
}

/** Wall time string in tzid → UTC instant (fold: 0 first / 1 second occurrence). */
export function from_wall(wall: string, tzid: string, fold = 0): number {
  return wallToUtc(parse_wall(wall), tzid, fold);
}

// ── RRULE text ───────────────────────────────────────────────────────────────

export type RuleParts = Record<string, string>;

/** Validate one RRULE value and return its parts, FREQ first. */
export function parse_rule(value: string, strict = true): RuleParts {
  let text = value.trim();
  if (text.toUpperCase().startsWith("RRULE:")) text = text.slice(6);
  if (!text || /[\r\n:]/.test(text)) {
    throw new Error("Give a single RRULE value without DTSTART.");
  }
  const parts: RuleParts = {};
  for (const item of text.split(";")) {
    if (!item) continue;
    const eq = item.indexOf("=");
    const key = (eq === -1 ? item : item.slice(0, eq)).trim().toUpperCase();
    const raw = (eq === -1 ? "" : item.slice(eq + 1)).trim().toUpperCase();
    if (eq === -1 || !raw) {
      throw new Error(`Malformed recurrence part '${item}'.`);
    }
    if (key === "DTSTART") {
      throw new Error("DTSTART cannot be part of the recurrence rule.");
    }
    if (!RULE_KEYS.has(key)) {
      throw new Error(`Unsupported recurrence part ${key}.`);
    }
    if (key in parts) {
      throw new Error(`Duplicate recurrence part ${key}.`);
    }
    parts[key] = raw;
  }
  if (!parts.FREQ || !FREQUENCIES.has(parts.FREQ)) {
    throw new Error("FREQ must be HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY.");
  }
  if ("INTERVAL" in parts && !(/^\d+$/.test(parts.INTERVAL) && +parts.INTERVAL > 0 && +parts.INTERVAL <= 10000)) {
    throw new Error("INTERVAL must be between 1 and 10000.");
  }
  if ("COUNT" in parts && "UNTIL" in parts && strict) {
    throw new Error("COUNT and UNTIL cannot be combined.");
  }
  if ("COUNT" in parts && !(/^\d+$/.test(parts.COUNT) && +parts.COUNT > 0 && +parts.COUNT <= MAX_COUNT)) {
    throw new Error(`COUNT must be between 1 and ${MAX_COUNT}.`);
  }
  if ("UNTIL" in parts) parse_until(parts.UNTIL);
  if (strict) validate_by_parts(parts);
  // Reorder: FREQ first (Python returns {"FREQ": ..., **parts}).
  const { FREQ, ...rest } = parts;
  return { FREQ, ...rest };
}

export function format_rule(parts: RuleParts): string {
  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(";");
}

// ── BYxxx syntax validation (replaces dateutil's probe parse) ─────────────────

const INT_LIST_RE = /^-?\d+(,-?\d+)*$/;

function weekdayIndex(name: string): number {
  const i = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
  return i;
}

function checkIntList(key: string, raw: string, lo: number, hi: number): void {
  if (!INT_LIST_RE.test(raw)) throw new Error(`Invalid ${key} value.`);
  for (const item of raw.split(",")) {
    const n = Number(item);
    if (n < lo || n > hi) throw new Error(`Invalid ${key} value.`);
  }
}

function validate_by_parts(parts: RuleParts): void {
  const dayRe = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/;
  for (const [key, raw] of Object.entries(parts)) {
    switch (key) {
      case "BYSECOND": checkIntList(key, raw, 0, 60); break;
      case "BYMINUTE": checkIntList(key, raw, 0, 59); break;
      case "BYHOUR": checkIntList(key, raw, 0, 23); break;
      case "BYDAY": {
        if (!INT_LIST_RE.test(raw) && !raw.split(",").every((i) => dayRe.test(i))) {
          // Mixed lists like "1MO,-1FR" still match the dayRe branch; plain
          // weekday lists also match. Fall through to per-item check.
        }
        for (const item of raw.split(",")) {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
          if (!m) throw new Error(`Invalid BYDAY value.`);
          if (m[1] !== undefined) {
            const n = Number(m[1]);
            if (n === 0 || n < -53 || n > 53) throw new Error(`Invalid BYDAY value.`);
          }
        }
        break;
      }
      case "BYMONTHDAY": checkIntList(key, raw, -31, 31); {
        for (const item of raw.split(",")) if (Number(item) === 0) throw new Error("Invalid BYMONTHDAY value.");
        break;
      }
      case "BYYEARDAY": checkIntList(key, raw, -366, 366); {
        for (const item of raw.split(",")) if (Number(item) === 0) throw new Error("Invalid BYYEARDAY value.");
        break;
      }
      case "BYWEEKNO": checkIntList(key, raw, -53, 53); {
        for (const item of raw.split(",")) {
          const n = Number(item);
          if (n === 0 || Math.abs(n) > 53) throw new Error("Invalid BYWEEKNO value.");
        }
        break;
      }
      case "BYMONTH": checkIntList(key, raw, 1, 12); break;
      case "BYSETPOS": checkIntList(key, raw, -366, 366); {
        for (const item of raw.split(",")) if (Number(item) === 0) throw new Error("Invalid BYSETPOS value.");
        break;
      }
      case "WKST": {
        const wd = weekdayIndex(raw);
        if (wd < 0) throw new Error(`Invalid WKST value.`);
        break;
      }
      default: break; // FREQ/UNTIL/COUNT/INTERVAL validated above
    }
  }
}

// UNTIL parse result: a calendar date, a naive wall datetime, or a UTC instant.
export type Until =
  | { kind: "date"; ms: number }   // ms = wall ms of the date at midnight
  | { kind: "wall"; ms: number }
  | { kind: "utc"; ms: number };

export function parse_until(raw: string): Until {
  const compact = (s: string) => wallMs(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8));
  const compactT = (s: string) =>
    wallMs(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  try {
    if (/^\d{8}$/.test(raw)) return { kind: "date", ms: compact(raw) };
    if (/^\d{8}T\d{6}$/.test(raw)) return { kind: "wall", ms: compactT(raw) };
    if (/^\d{8}T\d{6}Z$/.test(raw)) return { kind: "utc", ms: Date.parse(`${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`) };
  } catch {
    // fall through
  }
  throw new Error("UNTIL must be YYYYMMDD or YYYYMMDDTHHMMSS[Z].");
}

function format_until_utc(ms: number): string {
  const p = wallParts(ms);
  return `${pad4(p.y)}${pad2(p.mo)}${pad2(p.d)}T${pad2(p.h)}${pad2(p.mi)}${pad2(p.s)}Z`;
}

function format_until_date(ms: number): string {
  const p = wallParts(ms);
  return `${pad4(p.y)}${pad2(p.mo)}${pad2(p.d)}`;
}

/** UNTIL in the value type RFC 5545 requires for this DTSTART. */
function until_text(value: Until, all_day: boolean, tzid: string): string {
  if (all_day) {
    let dayMs: number;
    if (value.kind === "date") dayMs = value.ms;
    else if (value.kind === "wall") dayMs = startOfDay(value.ms);
    else dayMs = startOfDay(utcToWall(value.ms, tzid));
    return format_until_date(dayMs);
  }
  let utcMs: number;
  if (value.kind === "utc") utcMs = value.ms;
  else if (value.kind === "date") {
    // datetime.combine(date, time(23,59,59)) in tzid → UTC
    const p = wallParts(value.ms);
    utcMs = wallToUtc(wallMs(p.y, p.mo, p.d, 23, 59, 59), tzid, 0);
  } else {
    utcMs = wallToUtc(value.ms, tzid, 0);
  }
  return format_until_utc(utcMs);
}

/** Move BYDAY/BYMONTHDAY along with a start that moved by `days`. */
export function shift_weekdays(rule_text: string, days: number): string {
  const parts = parse_rule(rule_text);
  if ("BYDAY" in parts && days % 7 !== 0) {
    const shifted: string[] = [];
    for (const item of parts.BYDAY.split(",")) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
      if (!m) return rule_text;
      const index = (((weekdayIndex(m[2]) + days) % 7) + 7) % 7;
      shifted.push((m[1] ?? "") + WEEKDAYS[index]);
    }
    parts.BYDAY = shifted.join(",");
  }
  if ("BYMONTHDAY" in parts && days !== 0) {
    const values = parts.BYMONTHDAY.split(",").map(Number);
    if (values.every((v) => v + days > 0 && v + days <= 31 && v > 0)) {
      parts.BYMONTHDAY = values.map((v) => String(v + days)).join(",");
    }
  }
  return format_rule(parts);
}

// ── RRULE engine ─────────────────────────────────────────────────────────────
// Generates candidate starts in "rule space" (wall ms for both all-day and
// timed events; timed wall clocks convert to UTC per instance).

interface ByDay { ord: number | null; wd: number }

function parse_byday(raw: string): ByDay[] {
  return raw.split(",").map((item) => {
    const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
    if (!m) throw new Error("Invalid BYDAY value.");
    return { ord: m[1] === undefined ? null : Number(m[1]), wd: weekdayIndex(m[2]) };
  });
}

function int_list(raw: string | undefined): number[] | null {
  if (raw === undefined) return null;
  return raw.split(",").map(Number);
}

interface RuleContext {
  parts: RuleParts;
  interval: number;
  wkst: number; // 0=Monday
  freq: string;
  start: number; // dtstart wall ms
  sp: WallParts;
  // pre-parsed BYxxx
  byHour: number[] | null;
  byMinute: number[] | null;
  bySecond: number[] | null;
  byDay: ByDay[] | null;
  byMonthDay: number[] | null;
  byYearDay: number[] | null;
  byWeekNo: number[] | null;
  byMonth: number[] | null;
  bySetPos: number[] | null;
}

function make_context(parts: RuleParts, startWallMs: number): RuleContext {
  const sp = wallParts(startWallMs);
  return {
    parts,
    interval: parts.INTERVAL ? Number(parts.INTERVAL) : 1,
    wkst: parts.WKST ? weekdayIndex(parts.WKST) : 0,
    freq: parts.FREQ,
    start: startWallMs,
    sp,
    byHour: int_list(parts.BYHOUR),
    byMinute: int_list(parts.BYMINUTE),
    bySecond: int_list(parts.BYSECOND),
    byDay: parts.BYDAY ? parse_byday(parts.BYDAY) : null,
    byMonthDay: int_list(parts.BYMONTHDAY),
    byYearDay: int_list(parts.BYYEARDAY),
    byWeekNo: int_list(parts.BYWEEKNO),
    byMonth: int_list(parts.BYMONTH),
    bySetPos: int_list(parts.BYSETPOS),
  };
}

/** Sorted candidate times-of-day for a day, as ms-of-day. */
function day_times(ctx: RuleContext): number[] {
  const hours = ctx.byHour ?? [ctx.sp.h];
  const mins = ctx.byMinute ?? [ctx.sp.mi];
  const secs = ctx.bySecond ?? [ctx.sp.s];
  const out: number[] = [];
  for (const h of hours) for (const mi of mins) for (const s of secs) {
    out.push(h * HOUR_MS + mi * 60_000 + s * 1000);
  }
  out.sort((a, b) => a - b);
  return out;
}

// ── day-level BYxxx helpers ──────────────────────────────────────────────────

function nth_weekday_of_month(y: number, mo: number, wd: number, n: number): number | null {
  const dim = daysInMonth(y, mo);
  if (n > 0) {
    // nth occurrence (1-based)
    const first = wallMs(y, mo, 1);
    const firstWd = wallParts(first).wd;
    const offset = (wd - firstWd + 7) % 7;
    const d = 1 + offset + (n - 1) * 7;
    return d <= dim ? wallMs(y, mo, d) : null;
  }
  // nth from end (-1 = last)
  const last = wallMs(y, mo, dim);
  const lastWd = wallParts(last).wd;
  const offset = (lastWd - wd + 7) % 7;
  const d = dim - offset + (n + 1) * 7; // n=-1 → dim-offset; n=-2 → -7 more
  return d >= 1 ? wallMs(y, mo, d) : null;
}

function all_weekdays_of_month(y: number, mo: number, wd: number): number[] {
  const dim = daysInMonth(y, mo);
  const out: number[] = [];
  for (let d = 1; d <= dim; d++) {
    const ms = wallMs(y, mo, d);
    if (wallParts(ms).wd === wd) out.push(ms);
  }
  return out;
}

/** ISO-ish week number helpers (WKST-based), approximating RFC 5545. */
function week_start(ms: number, wkst: number): number {
  const wd = wallParts(ms).wd;
  return addDays(startOfDay(ms), -(((wd - wkst) % 7) + 7) % 7);
}

function year_day_number(ms: number): number {
  const p = wallParts(ms);
  const start = wallMs(p.y, 1, 1);
  return Math.round((startOfDay(ms) - start) / DAY_MS) + 1;
}

function yearday_to_ms(y: number, n: number): number | null {
  const dim = isLeap(y) ? 366 : 365;
  const day = n > 0 ? n : dim + n + 1;
  if (day < 1 || day > dim) return null;
  const start = wallMs(y, 1, 1);
  return addDays(start, day - 1);
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// ── ISO-8601 week numbers ────────────────────────────────────────────────────
// dateutil evaluates BYWEEKNO against ISO week numbers of the *year*, for every
// frequency (verified: MONTHLY;BYWEEKNO=1 yields ISO week 1's days).

/** Thursday of the ISO week containing `ms` (ISO weeks start Monday). */
function iso_thursday(ms: number): number {
  const p = wallParts(ms);
  return addDays(startOfDay(ms), 3 - p.wd);
}

/** ISO-8601 week number (1-53) of the week containing `ms`. */
export function iso_week(ms: number): number {
  const thurs = iso_thursday(ms);
  const y = wallParts(thurs).y;
  const jan4 = wallMs(y, 1, 4);
  const firstThurs = iso_thursday(jan4);
  return Math.round((thurs - firstThurs) / (7 * DAY_MS)) + 1;
}

/** Number of ISO weeks in ISO-year `y` (52 or 53). */
function iso_weeks_in_year(y: number): number {
  return iso_week(wallMs(y, 12, 28)); // Dec 28 is always in the last ISO week
}

/** Generic day filter: every specified BYxxx type must accept the day (AND). */
function day_filters_pass(ctx: RuleContext, dayMs: number, skip: Set<string>): boolean {
  const p = wallParts(dayMs);
  if (!skip.has("BYMONTH") && ctx.byMonth && !ctx.byMonth.includes(p.mo)) return false;
  if (!skip.has("BYDAY") && ctx.byDay && ctx.byDay.every((b) => b.wd !== p.wd)) return false;
  if (!skip.has("BYMONTHDAY") && ctx.byMonthDay) {
    const dim = daysInMonth(p.y, p.mo);
    const ok = ctx.byMonthDay.some((v) => {
      const d = v > 0 ? v : dim + v + 1;
      return d === p.d;
    });
    if (!ok) return false;
  }
  if (!skip.has("BYYEARDAY") && ctx.byYearDay) {
    const n = year_day_number(dayMs);
    const dim = isLeap(p.y) ? 366 : 365;
    const ok = ctx.byYearDay.some((v) => {
      const target = v > 0 ? v : dim + v + 1;
      return target === n;
    });
    if (!ok) return false;
  }
  if (!skip.has("BYWEEKNO") && ctx.byWeekNo) {
    const wn = iso_week(dayMs);
    const count = iso_weeks_in_year(p.y);
    const ok = ctx.byWeekNo.some((v) => (v > 0 ? v === wn : count + v + 1 === wn));
    if (!ok) return false;
  }
  return true;
}

/** All days of month (y, mo) as wall ms, sorted. */
function days_of_month(y: number, mo: number): number[] {
  const dim = daysInMonth(y, mo);
  const out: number[] = [];
  for (let d = 1; d <= dim; d++) out.push(wallMs(y, mo, d));
  return out;
}

/**
 * Days generated inside one monthly-style period for (y, mo).
 * BYMONTHDAY and BYDAY combine by intersection (verified against
 * python-dateutil: MONTHLY;BYMONTHDAY=10;BYDAY=MO yields the 10ths that are
 * Mondays; adding an ordinal BYDAY intersects to (usually) empty).
 */
function monthly_days(ctx: RuleContext, y: number, mo: number): number[] {
  // With only BYWEEKNO (no day selectors) the period expands to every day of
  // the month and the ISO-week filter does the selection (dateutil quirk).
  if (ctx.byWeekNo !== null && ctx.byMonthDay === null && ctx.byDay === null) {
    return days_of_month(y, mo);
  }
  let monthdaySet: number[] | null = null;
  if (ctx.byMonthDay !== null) {
    const dim = daysInMonth(y, mo);
    monthdaySet = [];
    for (const v of ctx.byMonthDay) {
      const d = v > 0 ? v : dim + v + 1;
      if (d >= 1 && d <= dim) monthdaySet.push(wallMs(y, mo, d));
    }
  }
  let daySet: number[] | null = null;
  if (ctx.byDay !== null) {
    daySet = [];
    for (const b of ctx.byDay) {
      if (b.ord !== null) {
        const d = nth_weekday_of_month(y, mo, b.wd, b.ord);
        if (d !== null) daySet.push(d);
      } else {
        daySet.push(...all_weekdays_of_month(y, mo, b.wd));
      }
    }
  }
  let result: number[];
  if (monthdaySet !== null && daySet !== null) {
    const other = new Set(daySet);
    result = monthdaySet.filter((d) => other.has(d));
  } else if (monthdaySet !== null) {
    result = monthdaySet;
  } else if (daySet !== null) {
    result = daySet;
  } else {
    // Default: the dtstart's day-of-month. Months lacking that day (e.g. the
    // 31st) are skipped, matching dateutil.
    const dim = daysInMonth(y, mo);
    result = ctx.sp.d <= dim ? [wallMs(y, mo, ctx.sp.d)] : [];
  }
  return [...new Set(result)].sort((a, b) => a - b);
}

/** Apply BYSETPOS to a sorted candidate list (1-based, negative from end). */
function apply_setpos(candidates: number[], setpos: number[] | null): number[] {
  if (!setpos) return candidates;
  const keep = new Set<number>();
  for (const n of setpos) {
    const idx = n > 0 ? n - 1 : candidates.length + n;
    if (idx >= 0 && idx < candidates.length) keep.add(candidates[idx]);
  }
  return candidates.filter((c) => keep.has(c));
}

/**
 * Core generator: yields rule-space start times (wall ms) in ascending order,
 * honouring FREQ/INTERVAL/BYxxx/BYSETPOS. UNTIL/COUNT/bounds are applied by the
 * caller (Timing.starts) so this stays a pure candidate stream.
 */
export function* rule_candidates(ctx: RuleContext): Generator<number> {
  const times = day_times(ctx);
  const emit_day = function* (dayMs: number): Generator<number> {
    const base = startOfDay(dayMs);
    for (const t of times) yield base + t;
  };

  if (ctx.freq === "HOURLY") {
    // Period = one hour, stepping by interval hours from dtstart's hour.
    const startHour = startOfHour(ctx.start);
    for (let k = 0; k < MAX_PERIODS; k++) {
      const hourMs = addHours(startHour, k * ctx.interval);
      const day = startOfDay(hourMs);
      const hp = wallParts(hourMs);
      if (!day_filters_pass(ctx, day, new Set(["BYHOUR"]))) continue;
      if (ctx.byHour && !ctx.byHour.includes(hp.h)) continue;
      // BYMINUTE/BYSECOND expand inside the hour; BYSETPOS applies per hour.
      const mins = ctx.byMinute ?? [ctx.sp.mi];
      const secs = ctx.bySecond ?? [ctx.sp.s];
      const cands: number[] = [];
      for (const mi of mins) for (const s of secs) cands.push(hourMs + mi * 60_000 + s * 1000);
      cands.sort((a, b) => a - b);
      for (const c of apply_setpos(cands, ctx.bySetPos)) yield c;
    }
    return;
  }

  if (ctx.freq === "DAILY") {
    const startDay = startOfDay(ctx.start);
    for (let k = 0; k < MAX_PERIODS; k++) {
      const day = addDays(startDay, k * ctx.interval);
      if (!day_filters_pass(ctx, day, new Set())) continue;
      const cands = [...emit_day(day)];
      for (const c of apply_setpos(cands, ctx.bySetPos)) yield c;
    }
    return;
  }

  if (ctx.freq === "WEEKLY") {
    const wkst = ctx.wkst;
    const firstWeek = week_start(ctx.start, wkst);
    // Day selection within the week. BYDAY expands explicitly; day-level
    // selectors (BYMONTHDAY/BYYEARDAY/BYWEEKNO) expand the whole week and let
    // the AND filters pick days (verified: WEEKLY;BYWEEKNO=20 yields all seven
    // days of ISO week 20; BYMONTHDAY=10 yields the 10th of each month).
    // Otherwise only the dtstart's weekday recurs.
    const expandsAll =
      ctx.byDay === null &&
      (ctx.byMonthDay !== null || ctx.byYearDay !== null || ctx.byWeekNo !== null);
    const daySet = ctx.byDay
      ? [...new Set(ctx.byDay.map((b) => b.wd))].sort((a, b) => a - b)
      : expandsAll
        ? [0, 1, 2, 3, 4, 5, 6]
        : [ctx.sp.wd];
    for (let k = 0; k < MAX_PERIODS; k++) {
      const ws = addDays(firstWeek, k * ctx.interval * 7);
      const days: number[] = [];
      for (const wd of daySet) {
        // day with weekday wd inside [ws, ws+7)
        const offset = (((wd - wallParts(ws).wd) % 7) + 7) % 7;
        days.push(addDays(ws, offset));
      }
      days.sort((a, b) => a - b);
      const period: number[] = [];
      for (const d of days) {
        if (!day_filters_pass(ctx, d, new Set(["BYDAY"]))) continue;
        for (const t of times) period.push(startOfDay(d) + t);
      }
      period.sort((a, b) => a - b);
      for (const c of apply_setpos(period, ctx.bySetPos)) yield c;
    }
    return;
  }

  if (ctx.freq === "MONTHLY") {
    const startMonth = ctx.sp.y * 12 + (ctx.sp.mo - 1);
    for (let k = 0; k < MAX_PERIODS; k++) {
      const idx = startMonth + k * ctx.interval;
      const y = Math.floor(idx / 12);
      const mo = (idx % 12) + 1;
      const days = monthly_days(ctx, y, mo);
      const period: number[] = [];
      for (const d of days) {
        if (!day_filters_pass(ctx, d, new Set(["BYMONTHDAY", "BYDAY"]))) continue;
        for (const t of times) period.push(startOfDay(d) + t);
      }
      period.sort((a, b) => a - b);
      for (const c of apply_setpos(period, ctx.bySetPos)) yield c;
    }
    return;
  }

  // YEARLY
  const hasOrdinalByDay = ctx.byDay !== null && ctx.byDay.some((b) => b.ord !== null);
  // Month scope: explicit BYMONTH wins; day selectors that expand across the
  // year (plain BYDAY, BYMONTHDAY, BYWEEKNO) cover all months; an ordinal-only
  // BYDAY stays inside the dtstart's month (verified against dateutil).
  const allMonths =
    ctx.byMonthDay !== null || ctx.byWeekNo !== null || (ctx.byDay !== null && !hasOrdinalByDay);
  for (let k = 0; k < MAX_PERIODS; k++) {
    const y = ctx.sp.y + k * ctx.interval;
    const period: number[] = [];
    if (ctx.byYearDay !== null) {
      const dim = isLeap(y) ? 366 : 365;
      const days = new Set<number>();
      for (const v of ctx.byYearDay) {
        const n = v > 0 ? v : dim + v + 1;
        const d = yearday_to_ms(y, n);
        if (d !== null) days.add(d);
      }
      const sorted = [...days].sort((a, b) => a - b);
      for (const d of sorted) {
        if (!day_filters_pass(ctx, d, new Set(["BYYEARDAY"]))) continue;
        for (const t of times) period.push(startOfDay(d) + t);
      }
    } else {
      const months = ctx.byMonth ?? (allMonths ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] : [ctx.sp.mo]);
      for (const mo of [...months].sort((a, b) => a - b)) {
        const days = monthly_days(ctx, y, mo);
        for (const d of days) {
          if (!day_filters_pass(ctx, d, new Set(["BYMONTH", "BYMONTHDAY", "BYDAY"]))) continue;
          for (const t of times) period.push(startOfDay(d) + t);
        }
      }
      period.sort((a, b) => a - b);
    }
    for (const c of apply_setpos(period, ctx.bySetPos)) yield c;
  }
}

// ── Timing ───────────────────────────────────────────────────────────────────

export interface Instance {
  key: string;
  start: string; // API encoding: date or UTC instant
  end: string;
  start_at: number; // UTC epoch ms; all-day dates resolve in the request's zone
  end_at: number;
}

/** The stored, RFC 5545-shaped time of one event row. */
export class Timing {
  constructor(
    public all_day: boolean,
    public dtstart: string, // all-day: YYYY-MM-DD; timed: wall time in tzid
    public dtend: string,
    public tzid: string,
    public rrule: string | null = null,
    public start_fold = 0,
    public end_fold = 0,
  ) {}

  static from_api(opts: {
    all_day: boolean;
    start: string;
    end: string;
    tzid: string;
    rrule: string | null;
  }): Timing {
    const { all_day, start, end, tzid, rrule } = opts;
    if (all_day) {
      return new Timing(true, start, end, tzid, rrule);
    }
    const z = zone(tzid);
    const startUtc = parse_instant(start);
    const endUtc = parse_instant(end);
    // fold: 1 when the instant lands on the second pass of an ambiguous wall.
    const foldOf = (utc: number): number => {
      const w = utcToWall(utc, z);
      const first = wallToUtc(w, z, 0);
      const second = wallToUtc(w, z, 1);
      return second !== first && utc === second ? 1 : 0;
    };
    return new Timing(
      false,
      to_wall(startUtc, z),
      to_wall(endUtc, z),
      z,
      rrule,
      foldOf(startUtc),
      foldOf(endUtc),
    );
  }

  /** DTSTART in rule space: wall ms (naive midnight for all-day). */
  get first(): number {
    if (this.all_day) return parse_date(this.dtstart);
    return parse_wall(this.dtstart);
  }

  get duration(): number {
    if (this.all_day) {
      return parse_date(this.dtend) - parse_date(this.dtstart);
    }
    return from_wall(this.dtend, this.tzid, this.end_fold) - from_wall(this.dtstart, this.tzid, this.start_fold);
  }

  private _ruleParts: RuleParts | null = null;
  private _ctx: RuleContext | null = null;
  private _until: Until | null = null;
  private _untilParsed = false;

  private rule_parts(): RuleParts {
    // Lenient: stored rules were validated on write, but Timing must also
    // tolerate rules dateutil accepts that parse_rule rejects (e.g. COUNT and
    // UNTIL together) — the Python Timing feeds rrulestr directly.
    if (!this._ruleParts) this._ruleParts = parse_rule(this.rrule as string, false);
    return this._ruleParts;
  }

  private context(): RuleContext | null {
    if (!this.rrule) return null;
    if (!this._ctx) {
      this._ctx = make_context(this.rule_parts(), this.first);
      this.until(); // force UNTIL validation like rrulestr does at construction
    }
    return this._ctx;
  }

  private until(): Until | null {
    if (!this._untilParsed) {
      this._untilParsed = true;
      const raw = this.rule_parts().UNTIL;
      this._until = raw ? parse_until(raw) : null;
      // dateutil requires UNTIL's value type to match DTSTART's awareness:
      // UTC (Z) for aware timed starts, date/naive for all-day starts.
      if (this._until) {
        if (!this.all_day && this._until.kind !== "utc") {
          throw new Error("RRULE UNTIL values must be specified in UTC when DTSTART is timezone-aware");
        }
        if (this.all_day && this._until.kind === "utc") {
          // dateutil raises the same message for either awareness mismatch.
          throw new Error("RRULE UNTIL values must be specified in UTC when DTSTART is timezone-aware");
        }
      }
    }
    return this._until;
  }

  /** UNTIL instant bound for timed events (UTC ms), or null. */
  private until_utc(): number | null {
    const u = this.until();
    if (!u) return null;
    if (u.kind === "utc") return u.ms;
    if (u.kind === "wall") return wallToUtc(u.ms, this.tzid, 0);
    const p = wallParts(u.ms);
    return wallToUtc(wallMs(p.y, p.mo, p.d, 23, 59, 59), this.tzid, 0);
  }

  /**
   * Does rule-space start `wall` (wall ms) fall within UNTIL?
   * All-day UNTIL is a date bound; timed UNTIL is an absolute instant bound.
   */
  private until_allows(wall: number): boolean {
    const u = this.until();
    if (!u) return true;
    if (this.all_day) {
      const untilDay =
        u.kind === "date" ? u.ms : u.kind === "wall" ? startOfDay(u.ms) : startOfDay(utcToWall(u.ms, this.tzid));
      return startOfDay(wall) <= untilDay;
    }
    return this.occurrence_utc(wall) <= (this.until_utc() as number);
  }

  /** Rule-space occurrence UTC instant (timed only; fold=0 like dateutil). */
  occurrence_utc(wall: number): number {
    return wallToUtc(wall, this.tzid, 0);
  }

  /**
   * Rule-space instance starts, in order.
   * `afterBound`: for all-day events a naive wall-ms bound; for timed events a
   * UTC epoch-ms bound compared absolutely (mirrors `_rule_bound` + xafter).
   */
  *starts(afterBound?: number): Generator<number> {
    const ctx = this.context();
    if (!ctx) {
      // Single (non-recurring) event.
      const first = this.first;
      const bound = afterBound;
      if (bound === undefined) {
        yield first;
      } else if (this.all_day) {
        if (first >= bound) yield first;
      } else if (this.occurrence_utc(first) >= bound) {
        yield first;
      }
      return;
    }
    // dateutil never emits occurrences before DTSTART. Timed comparison is
    // absolute (aware datetimes); all-day compares naive wall clocks.
    const dtstartBound = this.all_day ? this.first : wallToUtc(this.first, this.tzid, this.start_fold);
    const beforeDtstart = (wall: number): boolean =>
      this.all_day ? wall < dtstartBound : this.occurrence_utc(wall) < dtstartBound;

    let count = 0;
    const maxCount = ctx.parts.COUNT ? Number(ctx.parts.COUNT) : Infinity;
    for (const wall of rule_candidates(ctx)) {
      if (!this.until_allows(wall)) {
        // UNTIL is an upper bound; candidates are ascending so we can stop.
        // (For timed events a later wall could still map earlier across a DST
        // fall-back, but UNTIL instants are far coarser than that edge.)
        break;
      }
      if (beforeDtstart(wall)) continue;
      if (this.all_day) {
        if (afterBound !== undefined && wall < afterBound) continue;
      } else if (afterBound !== undefined && this.occurrence_utc(wall) < afterBound) {
        continue;
      }
      count++;
      if (count > maxCount) break;
      yield wall;
    }
  }

  key(startWall: number): string {
    return this.all_day ? isoDate(startWall) : format_instant(this.occurrence_utc(startWall));
  }

  /** The rule-space start an occurrence key names (not checked). */
  at_key(key: string): number {
    if (this.all_day) return parse_date(key);
    return utcToWall(parse_instant(key), this.tzid);
  }

  instance(startWall: number, tzid: string): Instance {
    if (this.all_day) {
      const firstDay = startOfDay(startWall);
      const lastDay = firstDay + this.duration;
      const z = zone(tzid);
      return {
        key: isoDate(firstDay),
        start: isoDate(firstDay),
        end: isoDate(lastDay),
        start_at: wallToUtc(firstDay, z, 0),
        end_at: wallToUtc(lastDay, z, 0),
      };
    }
    const begin = this.occurrence_utc(startWall);
    const finish = begin + this.duration;
    const key = format_instant(begin);
    return { key, start: key, end: format_instant(finish), start_at: begin, end_at: finish };
  }

  is_instance(key: string): boolean {
    let target: number;
    try {
      target = this.at_key(key);
    } catch {
      return false;
    }
    // First candidate at or after target-1s; equal key → it is an instance.
    const bound = this.all_day ? target - 1000 : parse_instant(key) - 1000;
    for (const start of this.starts(bound)) {
      return this.key(start) === key;
    }
    return false;
  }

  first_key(): string | null {
    for (const start of this.starts()) return this.key(start);
    return null;
  }

  count_before(key: string): number {
    const boundWall = this.at_key(key);
    // Comparable bound: naive wall for all-day, absolute UTC for timed.
    const bound = this.all_day ? boundWall : parse_instant(key);
    let count = 0;
    for (const start of this.starts()) {
      const cmp = this.all_day ? start : this.occurrence_utc(start);
      if (cmp >= bound) break;
      count++;
    }
    return count;
  }
}

// ── Expansion ────────────────────────────────────────────────────────────────

/**
 * Instances overlapping [range_start, range_end) (UTC epoch ms), minus
 * `exclude` keys. All-day date D spans [D 00:00, D+1 00:00) in request zone.
 */
export function expand(
  timing: Timing,
  range_start: number,
  range_end: number,
  tzid: string,
  exclude: ReadonlySet<string> = new Set(),
  limit = MAX_INSTANCES,
): Instance[] {
  const z = zone(tzid);
  const duration = timing.duration;
  let afterBound: number;
  let beforeBoundWall: number | null = null;
  if (timing.all_day) {
    const rangeStartDay = startOfDay(utcToWall(range_start, z));
    afterBound = rangeStartDay - duration;
    const rangeEndDay = startOfDay(utcToWall(range_end, z));
    beforeBoundWall = rangeEndDay + DAY_MS;
  } else {
    afterBound = range_start - duration;
  }
  const instances: Instance[] = [];
  for (const startWall of timing.starts(afterBound)) {
    if (timing.all_day) {
      if (startWall > (beforeBoundWall as number)) break;
    } else {
      if (timing.occurrence_utc(startWall) > range_end) break;
    }
    const instance = timing.instance(startWall, z);
    if (exclude.has(instance.key)) continue;
    if (instance.start_at < range_end && instance.end_at > range_start) {
      instances.push(instance);
      if (instances.length >= limit) break;
    }
  }
  return instances;
}

/** Canonical RRULE for `timing`'s DTSTART; rejects rules that never occur. */
export function normalize_rule(value: string, timing: Timing): string {
  const parts = parse_rule(value);
  if ("UNTIL" in parts) {
    parts.UNTIL = until_text(parse_until(parts.UNTIL), timing.all_day, timing.tzid);
  }
  const text = format_rule(parts);
  // Reject rules that generate no instance at/after DTSTART.
  const probe = new Timing(timing.all_day, timing.dtstart, timing.dtend, timing.tzid, text, timing.start_fold, timing.end_fold);
  if (probe.first_key() === null) {
    throw new Error("This recurrence never occurs.");
  }
  return text;
}

// ── Scope splits ─────────────────────────────────────────────────────────────

/** The series' rule ending just before occurrence `key` (COUNT → UNTIL). */
export function truncate_before(timing: Timing, key: string): string {
  if (!timing.rrule) throw new Error("assertion failed");
  const parts = parse_rule(timing.rrule);
  delete parts.COUNT;
  const start = timing.at_key(key);
  if (timing.all_day) {
    parts.UNTIL = format_until_date(addDays(startOfDay(start), -1));
  } else {
    parts.UNTIL = format_until_utc(parse_instant(key) - 1000);
  }
  return format_rule(parts);
}

/** The series' rule for a new series starting at occurrence `key`. */
export function continuation(timing: Timing, key: string): string {
  if (!timing.rrule) throw new Error("assertion failed");
  const parts = parse_rule(timing.rrule);
  if ("COUNT" in parts) {
    parts.COUNT = String(Math.max(1, Number(parts.COUNT) - timing.count_before(key)));
  }
  return format_rule(parts);
}

// ── UNTIL normalisation helper exported for models.ts ────────────────────────

export function normalize_until_text(raw: string, all_day: boolean, tzid: string): string {
  return until_text(parse_until(raw), all_day, tzid);
}
