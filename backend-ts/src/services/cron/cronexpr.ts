// Minimal cron-expression "next run" evaluator porting the `croniter` usage in
//
// Supports the standard 5-field cron format used by the settings UI:
//   minute hour day-of-month month day-of-week
// with `*`, `*/n`, `a`, `a-b`, `a-b/n`, `a/n` and comma lists, month/day names
// (JAN..DEC, SUN..SAT), `?` as `*`, and standard cron dom/dow OR semantics.
// Exotic extensions (`L`, `W`, `#`, seconds fields, `@daily` aliases handled by
// callers) raise an Error, which the service surfaces as a ValueError.
//
// TODO: croniter also supports `L`, `W`, `#`, `?` in dom/dow and named
// aliases — extend FIELD parsing if the UI ever emits them.

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

interface CronField {
  values: Set<number>;
  any: boolean; // unrestricted (`*` or `?`)
}

interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
}

const FIELD_RANGES: Array<{ min: number; max: number; names?: Record<string, number> }> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day of month
  { min: 1, max: 12, names: MONTH_NAMES }, // month
  { min: 0, max: 7, names: DOW_NAMES }, // day of week (0 and 7 = Sunday)
];

function parseField(spec: string, rangeIndex: number): CronField {
  const range = FIELD_RANGES[rangeIndex];
  if (spec === "*" || spec === "?") {
    return { values: allValues(range.min, range.max === 7 ? 6 : range.max), any: true };
  }
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`invalid cron field '${spec}'`);
    const stepMatch = piece.match(/^(.*)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    if (!Number.isFinite(step) || step < 1) throw new Error(`invalid cron step in '${spec}'`);
    const base = stepMatch ? stepMatch[1] : piece;
    let lo: number;
    let hi: number;
    if (base === "*" || base === "?") {
      lo = range.min;
      hi = range.max === 7 ? 6 : range.max;
    } else {
      const bounds = base.split("-");
      if (bounds.length > 2) throw new Error(`invalid cron range '${piece}'`);
      lo = parseCronValue(bounds[0], range);
      hi = bounds.length === 2 ? parseCronValue(bounds[1], range) : stepMatch ? (range.max === 7 ? 6 : range.max) : lo;
      if (lo > hi) throw new Error(`invalid cron range '${piece}'`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(rangeIndex === 4 && v === 7 ? 0 : v); // Sunday 7 -> 0
    }
  }
  if (values.size === 0) throw new Error(`empty cron field '${spec}'`);
  return { values, any: false };
}

function allValues(min: number, max: number): Set<number> {
  const s = new Set<number>();
  for (let v = min; v <= max; v++) s.add(v);
  return s;
}

function parseCronValue(token: string, range: { min: number; max: number; names?: Record<string, number> }): number {
  const lower = token.trim().toLowerCase();
  if (range.names && lower in range.names) return range.names[lower];
  if (!/^\d+$/.test(lower)) throw new Error(`invalid cron value '${token}'`);
  const n = parseInt(lower, 10);
  // DOW accepts 7 as Sunday; normalize at use site.
  const effectiveMax = range.max === 7 ? 7 : range.max;
  if (n < range.min || n > effectiveMax) {
    throw new Error(`cron value '${token}' out of range`);
  }
  return n;
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}`);
  }
  for (const f of fields) {
    if (/[LW#R]/.test(f)) {
      throw new Error(`unsupported cron extension in '${f}'`);
    }
  }
  return {
    minute: parseField(fields[0], 0),
    hour: parseField(fields[1], 1),
    dom: parseField(fields[2], 2),
    month: parseField(fields[3], 3),
    dow: parseField(fields[4], 4),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface WallTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
}

function dtf(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function wallTime(tz: string, utcMs: number): WallTime {
  const parts = dtf(tz).formatToParts(new Date(utcMs));
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
  };
}

// Offset (local - UTC) in ms for an instant, derived from Intl wall time.
function tzOffsetMs(tz: string, utcMs: number): number {
  const w = wallTime(tz, utcMs);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Convert a wall-clock time in `tz` to epoch ms (first matching instant).
function zonedTimeToUtc(tz: string, w: WallTime): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, 0);
  let guess = naive;
  for (let i = 0; i < 4; i++) {
    const offset = tzOffsetMs(tz, guess);
    const next = naive - offset;
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function addDays(y: number, m: number, d: number, days: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayOfWeek(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
}

/**
 * Next due time in epoch ms for a 5-field cron expression evaluated in `tz`
 * (IANA name; empty/undefined = server-local time, matching the original code's
 * naive `datetime.fromtimestamp(now, tz=None)` behavior — we use the process
 * local zone via `Intl`'s default when tz is empty).
 * Returns null when the expression can never fire within ~5 years.
 */
export function nextCronRunMs(expr: string, nowMs: number, tz?: string | null): number | null {
  if (tz && !isValidTimeZone(tz)) {
    throw new Error(`unknown timezone '${tz}'`);
  }
  const effectiveTz = tz ?? "";
  const parsed = parseCronExpression(expr);
  const nowWall = effectiveTz
    ? wallTime(effectiveTz, nowMs)
    : wallTimeLocal(nowMs);

  const sortedHours = [...parsed.hour.values].sort((a, b) => a - b);
  const sortedMinutes = [...parsed.minute.values].sort((a, b) => a - b);

  const domRestricted = !parsed.dom.any;
  const dowRestricted = !parsed.dow.any;

  // Iterate local dates; croniter's "next" is strictly after `now`.
  for (let offset = 0; offset <= 366 * 6; offset++) {
    const date = addDays(nowWall.year, nowWall.month, nowWall.day, offset);
    if (!parsed.month.values.has(date.m)) continue;
    const domMatch = parsed.dom.values.has(date.d);
    const dowMatch = parsed.dow.values.has(dayOfWeek(date.y, date.m, date.d));
    // Standard cron: if both dom and dow are restricted, either may match.
    const dayMatch = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
    if (!dayMatch) continue;

    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        if (offset === 0) {
          const nowMinutes = nowWall.hour * 60 + nowWall.minute;
          if (hour * 60 + minute <= nowMinutes) continue;
        }
        const utc = effectiveTz
          ? zonedTimeToUtc(effectiveTz, { year: date.y, month: date.m, day: date.d, hour, minute })
          : Date.UTC(date.y, date.m - 1, date.d, hour, minute) - localOffsetMs(Date.UTC(date.y, date.m - 1, date.d, hour, minute));
        if (utc > nowMs) return utc;
      }
    }
  }
  return null;
}

function wallTimeLocal(utcMs: number): WallTime {
  const d = new Date(utcMs);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
  };
}

// Offset of the process-local zone at an instant (local - UTC).
function localOffsetMs(utcMs: number): number {
  const d = new Date(utcMs);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - Math.floor(utcMs / 1000) * 1000;
}
