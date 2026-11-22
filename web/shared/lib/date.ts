/** Return the browser's IANA time zone, falling back to `"UTC"`. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Format an ISO `YYYY-MM-DD` key as a localized short date with weekday. */
export function formatDay(key: string, lang: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return d.toLocaleDateString(lang, {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}
