export interface ParsedInternalHref {
  to: string;
  search?: Record<string, string>;
  hash?: string;
}

export function isExternalHref(href: string): boolean {
  return (
    href.startsWith("http://") ||
    href.startsWith("https://") ||
    href.startsWith("//") ||
    href.startsWith("mailto:") ||
    href.startsWith("tel:")
  );
}

export function parseInternalHref(href: string): ParsedInternalHref {
  try {
    const url = new URL(href, "http://localhost");
    const searchObj = Object.fromEntries(url.searchParams.entries());
    return {
      to: url.pathname,
      search: Object.keys(searchObj).length > 0 ? searchObj : undefined,
      hash: url.hash ? url.hash.slice(1) : undefined,
    };
  } catch {
    return { to: href };
  }
}
