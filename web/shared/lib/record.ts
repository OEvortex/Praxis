/** Type guard for non-null, non-array plain objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Return `value` as a record, or `null` if it is not a plain object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** Return `value` as a record, or `{}` if it is not a non-null object. */
export function asRecordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
