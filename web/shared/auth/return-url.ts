const RETURN_URL_BASE = "https://praxis.invalid";

/** Return a same-origin application path or the supplied safe fallback. */
export function normalizeInternalReturnPath(
  raw: string | null | undefined,
  fallback = "/",
): string {
  const candidate = String(raw ?? "").trim();
  if (
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, RETURN_URL_BASE);
    if (parsed.origin !== RETURN_URL_BASE) return fallback;
    const decodedPath = decodeURIComponent(parsed.pathname);
    if (
      decodedPath.startsWith("//") ||
      decodedPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/.test(decodedPath)
    ) {
      return fallback;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
