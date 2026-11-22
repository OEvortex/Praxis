// Port of deeptutor/services/rag/pipelines/kiwix/client.py — bounded client for
// kiwix-serve's OPDS catalog, search XML and raw article APIs.
export class KiwixError extends Error {}

export const KIWIX_MAX_SEARCH_BYTES = 512_000;
export const KIWIX_MAX_CATALOG_BYTES = 1_000_000;
export const KIWIX_MAX_ARTICLE_BYTES = 2_000_000;
export const KIWIX_MAX_ARTICLE_CHARS = 12_000;
export const KIWIX_MAX_TITLE_BYTES = 32_000;

const ZIM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const BLOCKS = new Set(["article", "br", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "p", "section", "tr"]);
const SKIP = new Set(["script", "style", "nav", "footer", "header", "noscript"]);

export function normalizeKiwixBaseUrl(value: string): string {
  const raw = String(value ?? "").trim();
  if (raw.length > 2048 || [...raw].some((ch) => ch.charCodeAt(0) < 32)) {
    throw new KiwixError("Enter a valid kiwix-serve base URL.");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new KiwixError(
      "Enter a kiwix-serve HTTP(S) base URL without credentials or query parameters.",
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    decodeURIComponent(parsed.pathname)
      .split("/")
      .some((part) => part === "." || part === "..")
  ) {
    throw new KiwixError(
      "Enter a kiwix-serve HTTP(S) base URL without credentials or query parameters.",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function validateZimName(value: string): string {
  const name = String(value ?? "").trim();
  if (!ZIM_NAME_RE.test(name)) {
    throw new KiwixError(
      "Enter one ZIM name from the Kiwix library (letters, numbers, _, - or .).",
    );
  }
  return name;
}

export function validateArticlePath(value: string): string {
  let path = decodeURIComponent(String(value ?? "").trim()).replace(/^\/+/, "");
  if (
    !path ||
    path.length > 2048 ||
    path.split("/").some((part) => part === "" || part === "." || part === "..") ||
    [...path].some((ch) => ch.charCodeAt(0) < 32) ||
    path.includes("\\")
  ) {
    throw new KiwixError("Invalid ZIM article path.");
  }
  return path;
}

// -- HTML -> text (subset of html.parser behaviour) ---------------------------------

export function htmlToText(raw: string, maxChars = KIWIX_MAX_ARTICLE_CHARS): string {
  const parts: string[] = [];
  let skipDepth = 0;
  // Strip tags with a tiny state machine; good enough for ZIM article HTML.
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (s: string) => {
    if (!skipDepth) parts.push(s);
  };
  while ((m = tagRe.exec(raw)) !== null) {
    pushText(raw.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[0].startsWith("</");
    const tag = m[1].toLowerCase();
    if (SKIP.has(tag)) {
      skipDepth += closing ? -1 : 1;
      if (skipDepth < 0) skipDepth = 0;
    } else if (!skipDepth && BLOCKS.has(tag)) {
      parts.push("\n");
    }
  }
  pushText(raw.slice(last));
  const text = parts
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
  return text
    .split("\n")
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

// -- minimal XML helpers (defusedxml-free; we only read text/attrs) -------------------

function localName(tag: string): string {
  return tag.includes("}") ? tag.split("}").pop()! : tag;
}

function* xmlElements(xml: string, tagName: string): Generator<string> {
  const re = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) yield m[2];
}

function xmlAttr(attrs: string, name: string): string {
  const m = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs);
  return m ? m[1] : "";
}

function xmlText(xml: string, tagName: string): string {
  const m = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`).exec(xml);
  if (!m) return "";
  return m[1]
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

// -- OPDS catalog / RSS parsing ---------------------------------------------------------

export interface KiwixArchive {
  zim_name: string;
  title: string;
}
export interface KiwixHit {
  title: string;
  article_path: string;
  snippet: string;
}

export function parseCatalogXml(data: string, baseUrl: string): KiwixArchive[] {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, "")}/content/`;
  const archives: KiwixArchive[] = [];
  const seen = new Set<string>();
  for (const entry of xmlElements(data, "entry")) {
    let name = "";
    const linkRe = /<link\s([^>]*)>/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(entry)) !== null) {
      const type = xmlAttr(lm[1], "type").split(";")[0].toLowerCase();
      if (type !== "text/html") continue;
      const href = xmlAttr(lm[1], "href");
      if (!href) continue;
      let u: URL;
      try {
        u = new URL(href, baseUrl);
      } catch {
        continue;
      }
      if (u.origin !== base.origin) continue;
      if (u.search) continue;
      const path = decodeURIComponent(u.pathname);
      if (!path.startsWith(prefix)) continue;
      name = decodeURIComponent(path.slice(prefix.length).split("/")[0]);
      break;
    }
    if (!name) name = xmlText(entry, "name");
    try {
      name = validateZimName(name);
    } catch {
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    const title = xmlText(entry, "title").replace(/\s+/g, " ").slice(0, 300) || name;
    archives.push({ zim_name: name, title });
    if (archives.length >= 50) break;
  }
  return archives;
}

export function parseSearchXml(data: string, baseUrl: string, zimName: string): KiwixHit[] {
  const base = new URL(baseUrl);
  const prefix = `${base.pathname.replace(/\/+$/, "")}/content/${encodeURIComponent(zimName)}/`;
  const hits: KiwixHit[] = [];
  for (const item of xmlElements(data, "item")) {
    const link = xmlText(item, "link");
    let u: URL;
    try {
      u = new URL(link, baseUrl);
    } catch {
      continue;
    }
    if (u.origin !== base.origin || u.search) continue;
    const path = decodeURIComponent(u.pathname);
    if (!path.startsWith(prefix)) continue;
    let articlePath: string;
    try {
      articlePath = validateArticlePath(path.slice(prefix.length));
    } catch {
      continue;
    }
    const title = xmlText(item, "title").replace(/\s+/g, " ").slice(0, 300);
    const desc = xmlText(item, "description").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").slice(0, 1000);
    hits.push({
      title: title || articlePath,
      article_path: articlePath,
      snippet: desc,
    });
  }
  return hits;
}

// -- client ------------------------------------------------------------------------------

export class KiwixClient {
  baseUrl: string;
  zimName: string;

  constructor(baseUrl: string, zimName: string) {
    this.baseUrl = normalizeKiwixBaseUrl(baseUrl);
    this.zimName = validateZimName(zimName);
  }

  static async listArchives(baseUrl: string, query = ""): Promise<KiwixArchive[]> {
    const client = new KiwixClient(baseUrl, "catalog");
    const params = new URLSearchParams({ count: "50", start: "0" });
    const q = String(query ?? "").trim().slice(0, 100);
    if (q) params.set("q", q);
    const { raw } = await client.get("catalog/search", params, KIWIX_MAX_CATALOG_BYTES);
    return parseCatalogXml(raw, client.baseUrl);
  }

  private async get(
    path: string,
    params: URLSearchParams | null,
    limit: number,
  ): Promise<{ raw: string; contentType: string }> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}${params ? `?${params}` : ""}`;
    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
    } catch {
      throw new KiwixError("Could not reach kiwix-serve.");
    }
    if (response.status !== 200) {
      throw new KiwixError(`kiwix-serve returned HTTP ${response.status}.`);
    }
    const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.length > limit) {
      throw new KiwixError("kiwix-serve response exceeded the article size limit.");
    }
    return { raw: new TextDecoder("utf-8", { fatal: false }).decode(buf), contentType };
  }

  /** probe — metadata + one-result search, no ZIM scan. Returns title. */
  async probe(): Promise<string> {
    const { raw } = await this.get(
      `raw/${encodeURIComponent(this.zimName)}/meta/Title`,
      null,
      KIWIX_MAX_TITLE_BYTES,
    );
    try {
      const params = new URLSearchParams({
        "books.name": this.zimName,
        pattern: "a",
        format: "xml",
        pageLength: "1",
      });
      const { raw: xml } = await this.get("search", params, KIWIX_MAX_SEARCH_BYTES);
      parseSearchXml(xml, this.baseUrl, this.zimName);
    } catch (exc) {
      if (exc instanceof KiwixError) {
        throw new KiwixError(
          "The archive is readable, but kiwix-serve full-text search is unavailable. " +
            "Book and Guided Learning need a searchable ZIM.",
        );
      }
      throw exc;
    }
    const title = raw.trim();
    if (!title) {
      throw new KiwixError("The selected ZIM archive has no readable title metadata.");
    }
    return title.slice(0, 300);
  }

  /** search — hits hydrated with article text for the first few results. */
  async search(query: string, topK = 5): Promise<{ hit: KiwixHit; content: string }[]> {
    const count = Math.max(1, Math.min(Math.trunc(topK), 10));
    const params = new URLSearchParams({
      "books.name": this.zimName,
      pattern: String(query ?? "").slice(0, 500),
      format: "xml",
      pageLength: String(count),
    });
    const { raw: xml } = await this.get("search", params, KIWIX_MAX_SEARCH_BYTES);
    const hits = parseSearchXml(xml, this.baseUrl, this.zimName).slice(0, count);
    const result: { hit: KiwixHit; content: string }[] = [];
    for (const hit of hits) {
      let text = "";
      if (result.length < 4) {
        try {
          text = await this.readArticle(hit.article_path, KIWIX_MAX_ARTICLE_CHARS);
        } catch {
          text = "";
        }
      }
      if (text || hit.snippet) {
        const context =
          hit.snippet && text
            ? `Search match: ${hit.snippet}\n\nArticle opening: ${text}`
            : hit.snippet
              ? `Search match: ${hit.snippet}`
              : text;
        result.push({ hit, content: context });
      }
    }
    return result;
  }

  async readArticle(articlePath: string, maxChars = 500_000): Promise<string> {
    const path = validateArticlePath(articlePath);
    const { raw, contentType: mime } = await this.get(
      `raw/${encodeURIComponent(this.zimName)}/content/${path.split("/").map(encodeURIComponent).join("/")}`,
      null,
      KIWIX_MAX_ARTICLE_BYTES,
    );
    if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mime)) {
      throw new KiwixError("The selected ZIM entry is not a readable article.");
    }
    const text = mime !== "text/plain" ? htmlToText(raw, maxChars) : raw.trim().slice(0, maxChars);
    if (!text) throw new KiwixError("The selected ZIM article has no readable text.");
    return text;
  }
}
