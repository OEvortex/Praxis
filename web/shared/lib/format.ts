export interface FormatBytesOptions {
  /** Returned when value is null, undefined, non-finite, negative (or 0 with `zeroEmpty`). Default `""`. */
  empty?: string;
  /** Treat `0` as empty. Default `false`. */
  zeroEmpty?: boolean;
  /** Round KB to whole numbers and MB >= 100 to whole numbers. Default `false`. */
  compact?: boolean;
  /** Format values >= 1 GiB as GB. Default `false`. */
  allowGb?: boolean;
  /** Minimum unit to display. Default `"B"`. */
  minUnit?: "B" | "MB";
}

/** Format a byte count into a human-readable string (`B`, `KB`, `MB`, optionally `GB`). */
export function formatBytes(
  bytes: number | null | undefined,
  options: FormatBytesOptions = {},
): string {
  const {
    empty = "",
    zeroEmpty = false,
    compact = false,
    allowGb = false,
    minUnit = "B",
  } = options;

  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return empty;
  if (zeroEmpty && bytes === 0) return empty;

  if (allowGb && bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  if (minUnit === "MB" || bytes >= 1024 ** 2) {
    const mb = bytes / 1024 ** 2;
    if (minUnit === "MB") return `${Math.round(mb)} MB`;
    return `${compact && mb >= 100 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${compact ? Math.round(kb) : kb.toFixed(1)} KB`;
}
