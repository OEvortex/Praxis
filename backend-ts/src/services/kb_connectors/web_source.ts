// — bounded doc-site crawl, hash diff into a KB's raw/ dir, and the SQLite
// job repository + interval scheduler that drives auto-sync.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Settings } from "../../config.js";
import { KnowledgeBaseStore } from "../../store/kb_store.js";
import { rawDir, safeJoin } from "./store.js";
import { updateWebSourceState } from "./kb_sources.js";
import type { AnyRecord } from "./types.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_PAGES = 200;
const MAX_CRAWL_DEPTH = 5;
const MAX_CRAWL_PAGES = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const CONCURRENCY = 4;
const DEFAULT_MAX_CHARS = 200_000;
const USER_AGENT = "DeepTutor/1.0 (+https://hkuds.dev/deeptutor) WebSourceBot";
// Single-tenant deployment: upstream keys jobs by get_current_user().id.
export const WEB_SOURCE_OWNER_ID = "local";

// -- URL helpers ---------------------------------------------------------------

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function defrag(url: string): string {
  const i = url.indexOf("#");
  return i >= 0 ? url.slice(0, i) : url;
}

function normalizeLink(base: string, href: string): string | null {
  const h = href.trim();
  if (!h || h.startsWith("#")) return null;
  const lower = h.toLowerCase();
  if (["javascript:", "mailto:", "tel:", "data:", "blob:"].some((p) => lower.startsWith(p))) {
    return null;
  }
  const absolute = new URL(defrag(h), base).toString();
  const scheme = new URL(absolute).protocol.toLowerCase();
  return scheme === "http:" || scheme === "https:" ? absolute : null;
}

function isInternal(url: string, baseHost: string, prefix: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.hostname !== baseHost) return false;
  const path = u.pathname.replace(/\/+$/, "") || "/";
  const p = prefix.replace(/\/+$/, "") || "/";
  if (p === "/") return true;
  return path === p || path.startsWith(p + "/");
}

function looksLikeAsset(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return /\.(png|jpe?g|gif|webp|svg|ico|css|js|map|json|xml|pdf|zip|mp4|mp3|woff2?|ttf|eot)(\?|$)/.test(path);
  } catch {
    return true;
  }
}

// -- filename mapping (crawler._to_filename / _source_filename) ----------------

function toFilename(url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/^\/+|\/+$/g, "");
  let filename: string;
  if (!path) {
    filename = "index";
  } else {
    const segments: string[] = [];
    for (const rawSegment of path.split("/")) {
      if (!rawSegment) continue;
      let decoded = rawSegment;
      try {
        decoded = decodeURIComponent(rawSegment);
      } catch {
        /* keep raw */
      }
      let safe = decoded.replace(/[^\w\-._~]/g, (ch) => {
        // quote() equivalent for the safe set -_.~ : percent-encode the rest.
        return "%" + Buffer.from(ch, "utf8").toString("hex").toUpperCase();
      });
      if (decoded === "." || decoded === ".." || safe === "." || safe === "..") {
        safe = `segment-${sha256(rawSegment).slice(0, 10)}`;
      }
      segments.push(safe || "segment");
    }
    filename = segments.join("/") || "index";
  }
  if (u.search) filename += `-q-${sha256(u.search.slice(1)).slice(0, 10)}`;
  return `${filename}.md`;
}

function sourceFilename(source: AnyRecord, pageUrl: string): string {
  const identity = String(source["url"] ?? source["id"] ?? "");
  return `_web/${sha256(identity).slice(0, 16)}/${toFilename(pageUrl)}`;
}

function containedPath(root: string, relative: string): string | null {
  const target = safeJoin(root, relative);
  if (target === null) return null;
  const rootResolved = resolve(root);
  const candidate = resolve(target);
  if (candidate !== rootResolved && !candidate.startsWith(rootResolved + sep)) {
    return null;
  }
  return candidate;
}

// -- HTML → markdown ------------------------------------------------------------

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToMarkdown(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Keep heading structure.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, lvl, inner) => `\n\n${"#".repeat(Number(lvl))} ${stripTags(inner)}\n\n`);
  s = s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_, href, inner) => {
    const text = stripTags(inner).trim();
    return text ? `[${text}](${href})` : "";
  });
  s = s.replace(/<\/(p|div|section|article|li|tr|blockquote|pre|ul|ol|table|header|footer|nav|aside|main|figure|figcaption)>/gi, "\n\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  s = stripTags(s);
  s = decodeEntities(s);
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.slice(0, DEFAULT_MAX_CHARS);
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}

function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const abs = normalizeLink(baseUrl, m[1]);
    if (abs) out.push(abs);
  }
  return out;
}

function extractHreflang(html: string, baseUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<link\s[^>]*rel=["']alternate["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const hreflang = /hreflang=["']([^"']+)["']/i.exec(tag)?.[1];
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (hreflang && href) {
      const abs = normalizeLink(baseUrl, href);
      if (abs) out[hreflang.toLowerCase()] = abs;
    }
  }
  return out;
}

// -- crawler ---------------------------------------------------------------------

interface CrawledPage {
  url: string;
  title: string;
  markdown: string;
  content_hash: string;
  language: string;
  alternate_links: Record<string, string>;
}

interface CrawlResult {
  ok: boolean;
  pages: CrawledPage[];
  errors: string[];
  navigation_links: AnyRecord[];
  navigation_kind: string;
}

const SKIP_PATH_RE = /\/(api|_next|static|assets|images|img|fonts|node_modules)\//i;

async function fetchText(url: string): Promise<{ status: number; text: string; finalUrl: string }> {
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text, finalUrl: resp.url || url };
}

async function robotsPermits(baseUrl: string, path: string): Promise<boolean> {
  // Minimal robots.txt honouring: fetch once per origin, apply `Disallow` for
  // `*`. Upstream has a fuller CrawlAccess policy; this covers the common case.
  try {
    const origin = new URL(baseUrl).origin;
    const resp = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return true; // no robots → allow (upstream blocks on fetch failure; be lenient)
    const text = await resp.text();
    const groups = text.split(/(?=User-agent:)/i);
    const star = groups.find((g) => /User-agent:\s*\*/i.test(g)) ?? "";
    const disallows = [...star.matchAll(/Disallow:\s*(\S*)/gi)].map((m) => m[1]);
    return !disallows.some((d) => d && path.startsWith(d));
  } catch {
    return true;
  }
}

export async function crawlDocsSite(
  baseUrl: string,
  opts: { max_depth?: number; max_pages?: number } = {},
): Promise<CrawlResult> {
  const result: CrawlResult = { ok: false, pages: [], errors: [], navigation_links: [], navigation_kind: "" };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    result.errors.push("Invalid base URL");
    return result;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    result.errors.push(`Invalid scheme: ${parsed.protocol}`);
    return result;
  }
  const baseHost = parsed.hostname;
  const maxDepth = Math.min(Math.max(Number(opts.max_depth ?? DEFAULT_MAX_DEPTH) || DEFAULT_MAX_DEPTH, 0), MAX_CRAWL_DEPTH);
  const maxPages = Math.min(Math.max(Number(opts.max_pages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES, 1), MAX_CRAWL_PAGES);

  const rawPath = parsed.pathname || "/";
  const basePrefix = rawPath.endsWith("/") ? rawPath : rawPath.replace(/\/[^/]*$/, "") || "/";

  if (!(await robotsPermits(baseUrl, parsed.pathname || "/"))) {
    result.errors.push("robots.txt disallows the configured URL");
    return result;
  }

  const visited = new Set<string>();
  const queue: Array<[string, number]> = [[baseUrl, 0]];
  const inFlight = new Set<Promise<void>>();

  const processPage = async (url: string, depth: number): Promise<void> => {
    if (visited.has(url) || result.pages.length >= maxPages) return;
    visited.add(url);
    let fetched: { status: number; text: string; finalUrl: string };
    try {
      fetched = await fetchText(url);
    } catch (exc) {
      result.errors.push(`${url}: ${exc instanceof Error ? exc.message : String(exc)}`);
      return;
    }
    if (fetched.status >= 400) {
      result.errors.push(`${url}: HTTP ${fetched.status}`);
      return;
    }
    const ct = "";
    void ct;
    const html = fetched.text;
    if (!/<html|<body|<article|<main/i.test(html)) {
      // Not an HTML document (or a stub); still record it as text if non-trivial.
      if (html.trim().length < 40) return;
    }
    const title = extractTitle(html);
    const body = htmlToMarkdown(html);
    if (!body) return;
    const page: CrawledPage = {
      url: fetched.finalUrl || url,
      title,
      markdown: body,
      content_hash: sha256(body),
      language: /<html[^>]*lang=["']([^"']+)["']/i.exec(html)?.[1] ?? "",
      alternate_links: extractHreflang(html, fetched.finalUrl || url),
    };
    result.pages.push(page);
    if (depth >= maxDepth) return;
    for (const link of extractLinks(html, fetched.finalUrl || url)) {
      if (visited.has(link)) continue;
      if (looksLikeAsset(link)) continue;
      if (!isInternal(link, baseHost, basePrefix)) continue;
      if (SKIP_PATH_RE.test(new URL(link).pathname)) continue;
      if (!await robotsPermits(link, new URL(link).pathname)) continue;
      queue.push([link, depth + 1]);
    }
  };

  while (queue.length && result.pages.length < maxPages) {
    const batch = queue.splice(0, CONCURRENCY);
    await Promise.all(
      batch.map(([url, depth]) => {
        const p = processPage(url, depth).finally(() => inFlight.delete(p));
        inFlight.add(p);
        return p;
      }),
    );
  }
  result.ok = result.pages.length > 0;
  if (!result.ok && !result.errors.length) result.errors.push("Crawl returned no pages");
  if (result.pages.length) result.navigation_kind = "inferred";
  return result;
}

// -- bilingual pairings (bilingual.detect_bilingual_pairings, simplified) ---------

const LANG_PREFIX_RE = /^\/([a-z]{2}(?:-[a-z]{2})?)(?:\/|$)/i;

function normalizeLanguage(lang: string): string {
  return lang.trim().toLowerCase().split("-")[0] || "";
}

function urlLanguage(url: string): string {
  try {
    const m = LANG_PREFIX_RE.exec(new URL(url).pathname);
    return m ? normalizeLanguage(m[1]) : "";
  } catch {
    return "";
  }
}

function detectBilingualPairings(pages: CrawledPage[], fileMap: Map<string, string>): AnyRecord[] {
  const byUrl = new Map(pages.map((p) => [p.url, p]));
  const pairings = new Map<string, AnyRecord>();
  const add = (a: CrawledPage, b: CrawledPage, method: string, langA: string, langB: string) => {
    const [src, tgt, sLang, tLang] = langA === "en" ? [a, b, langA, langB]
      : langB === "en" ? [b, a, langB, langA]
      : a.url <= b.url ? [a, b, langA, langB] : [b, a, langB, langA];
    const id = sha256(`${src.url}::${tgt.url}`).slice(0, 16);
    pairings.set(id, {
      pairing_id: id,
      source_url: src.url,
      target_url: tgt.url,
      source_file: fileMap.get(src.url) ?? "",
      target_file: fileMap.get(tgt.url) ?? "",
      source_lang: sLang,
      target_lang: tLang,
      pairing_method: method,
      updated_at: Date.now(),
    });
  };
  for (const page of pages) {
    const p1 = normalizeLanguage(page.language) || urlLanguage(page.url) || "en";
    for (const [hreflang, target] of Object.entries(page.alternate_links)) {
      const tp = byUrl.get(target);
      if (!tp || target === page.url) continue;
      const p2 = normalizeLanguage(hreflang) || normalizeLanguage(tp.language) || urlLanguage(target) || "zh";
      if (p1 === p2) continue;
      add(page, tp, "hreflang", p1, p2);
    }
  }
  // URL-prefix heuristic for sites without hreflang (e.g. /en/… /zh/…).
  const stems = new Map<string, CrawledPage[]>();
  for (const page of pages) {
    const lang = urlLanguage(page.url);
    if (!lang) continue;
    const stem = new URL(page.url).pathname.replace(LANG_PREFIX_RE, "/");
    const key = `${new URL(page.url).host}${stem}`;
    const list = stems.get(key) ?? [];
    list.push(page);
    stems.set(key, list);
  }
  for (const group of stems.values()) {
    const langs = new Set(group.map((p) => urlLanguage(p.url)));
    if (langs.size < 2) continue;
    const en = group.find((p) => urlLanguage(p.url) === "en");
    const other = group.find((p) => urlLanguage(p.url) !== "en");
    if (en && other) add(en, other, "url_prefix", "en", urlLanguage(other.url));
  }
  return [...pairings.values()].sort((a, b) => String(a["pairing_id"]).localeCompare(String(b["pairing_id"])));
}

function buildNavigationManifest(links: AnyRecord[], pageUrls: Map<string, string>): AnyRecord {
  // Upstream builds a sidebar tree; we emit a flat title→file list, which is
  // the same information in the shape consumers already tolerate (dict).
  const items = links
    .map((l) => ({ title: String(l["title"] ?? l["text"] ?? ""), url: String(l["url"] ?? "") }))
    .filter((l) => l.url);
  return { kind: "inferred", items, page_count: pageUrls.size };
}

// -- crawl + diff + write (crawler.crawl_and_diff) -------------------------------

export interface WebSyncResult {
  ok: boolean;
  pages_added: number;
  pages_updated: number;
  pages_removed: number;
  pages_unchanged: number;
  error: string;
  bilingual_pairs_count: number;
}

interface CrawlDiff {
  ok: boolean;
  error: string;
  page_hashes: Record<string, string>;
  page_count: number;
  pages_added: string[];
  pages_updated: string[];
  pages_unchanged: string[];
  pages_removed: string[];
  changed_paths: string[];
  removed_paths: string[];
  navigation: AnyRecord;
  pairings: AnyRecord[];
}

export async function crawlAndDiff(
  source: AnyRecord,
  rawDirPath: string,
  opts: { max_depth?: number | null; max_pages?: number | null } = {},
): Promise<CrawlDiff> {
  const empty: CrawlDiff = {
    ok: false, error: "", page_hashes: {}, page_count: 0,
    pages_added: [], pages_updated: [], pages_unchanged: [], pages_removed: [],
    changed_paths: [], removed_paths: [], navigation: {}, pairings: [],
  };
  const url = String(source["url"] ?? "");
  const depth = opts.max_depth ?? source["max_depth"] ?? DEFAULT_MAX_DEPTH;
  const pages = opts.max_pages ?? source["max_pages"] ?? DEFAULT_MAX_PAGES;
  const oldHashes = (source["page_hashes"] ?? {}) as Record<string, string>;

  let crawl: CrawlResult;
  try {
    crawl = await crawlDocsSite(url, { max_depth: Number(depth), max_pages: Number(pages) });
  } catch (exc) {
    empty.error = exc instanceof Error ? exc.message : String(exc);
    return empty;
  }
  if (!crawl.ok) {
    empty.error = `Crawl returned no pages from ${url}` + (crawl.errors.length ? `: ${crawl.errors.join("; ")}` : "");
    return empty;
  }

  const current: Record<string, string> = {};
  const contents = new Map<string, string>();
  const pageUrls = new Map<string, string>();
  for (const page of crawl.pages) {
    const fname = sourceFilename(source, page.url);
    current[fname] = page.content_hash;
    contents.set(fname, page.markdown);
    pageUrls.set(fname, page.url);
  }

  const added: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  const removed: string[] = [];
  for (const [fname, chash] of Object.entries(current)) {
    const old = oldHashes[fname];
    if (old === undefined) added.push(fname);
    else if (old !== chash) updated.push(fname);
    else {
      const target = containedPath(rawDirPath, fname);
      if (target !== null && existsSync(target)) unchanged.push(fname);
      else updated.push(fname);
    }
  }
  for (const fname of Object.keys(oldHashes)) {
    if (!(fname in current)) removed.push(fname);
  }

  const changedPaths: string[] = [];
  const removedPaths: string[] = [];
  for (const fname of [...added, ...updated]) {
    const dest = containedPath(rawDirPath, fname);
    if (dest === null) {
      empty.error = `Unsafe page filename: ${fname}`;
      return empty;
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, contents.get(fname) ?? "", "utf8");
    changedPaths.push(dest);
  }
  for (const fname of removed) {
    const dest = containedPath(rawDirPath, fname);
    if (dest !== null) removedPaths.push(dest);
  }

  const fileMap = new Map<string, string>();
  for (const page of crawl.pages) fileMap.set(page.url, sourceFilename(source, page.url));
  const pairings = detectBilingualPairings(crawl.pages, fileMap);
  const navigation = buildNavigationManifest(
    crawl.pages.map((p) => ({ title: p.title, url: p.url })),
    pageUrls,
  );

  return {
    ok: true,
    error: "",
    page_hashes: current,
    page_count: crawl.pages.length,
    pages_added: added,
    pages_updated: updated,
    pages_unchanged: unchanged,
    pages_removed: removed,
    changed_paths: changedPaths,
    removed_paths: removedPaths,
    navigation,
    pairings,
  };
}

// -- sync_source -----------------------------------------------------------------

function utcnowIso(): string {
  return new Date().toISOString();
}

function indexFiles(settings: Settings, kbName: string, filePaths: string[]): number {
  if (!filePaths.length) return 0;
  const kb = new KnowledgeBaseStore(settings);
  let count = 0;
  const root = rawDir(settings, kbName);
  for (const path of filePaths) {
    try {
      const rel = path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : path;
      kb.add_document(kbName, rel, new Uint8Array(readFileSync(path)));
      count++;
    } catch {
      /* non-fatal per-file */
    }
  }
  return count;
}

export async function syncWebSource(
  settings: Settings,
  kbName: string,
  source: AnyRecord,
  opts: { max_depth?: number | null; max_pages?: number | null } = {},
): Promise<WebSyncResult> {
  const result: WebSyncResult = {
    ok: false, pages_added: 0, pages_updated: 0, pages_removed: 0,
    pages_unchanged: 0, error: "", bilingual_pairs_count: 0,
  };
  const raw = rawDir(settings, kbName);
  mkdirSync(raw, { recursive: true });
  const sourceId = String(source["id"] ?? "");

  const recordFailure = (error: string) =>
    updateWebSourceState(settings, kbName, sourceId, {
      last_synced_at: utcnowIso(),
      last_sync_status: "error",
      last_sync_error: error,
    });

  let diff: CrawlDiff;
  try {
    diff = await crawlAndDiff(source, raw, opts);
  } catch (exc) {
    const error = exc instanceof Error ? exc.message : String(exc);
    recordFailure(error);
    result.error = error;
    return result;
  }
  if (!diff.ok) {
    recordFailure(diff.error);
    result.error = diff.error;
    return result;
  }

  // Remove deleted pages from raw storage and the document index.
  const kb = new KnowledgeBaseStore(settings);
  let removedCount = 0;
  const removalErrors: string[] = [];
  for (const target of diff.removed_paths) {
    try {
      if (existsSync(target)) unlinkSync(target);
      const rel = target.startsWith(raw) ? target.slice(raw.length).replace(/^[/\\]+/, "") : target;
      kb.delete_document(kbName, rel);
      removedCount++;
    } catch (exc) {
      removalErrors.push(`${target}: ${exc instanceof Error ? exc.message : String(exc)}`);
    }
  }
  if (removalErrors.length) {
    const error = `Failed to remove deleted pages: ${removalErrors.join("; ")}`;
    recordFailure(error);
    result.error = error;
    return result;
  }

  try {
    // The sqlite document index supports per-document deletion (unlike most
    // vector providers), so removed pages are already gone after the deletes
    // above; changed pages just need indexing.
    if (diff.changed_paths.length) {
      indexFiles(settings, kbName, diff.changed_paths);
    }
  } catch (exc) {
    const error = `Indexing failed: ${exc instanceof Error ? exc.message : String(exc)}`;
    recordFailure(error);
    result.error = error;
    return result;
  }

  updateWebSourceState(settings, kbName, sourceId, {
    page_hashes: diff.page_hashes,
    page_count: diff.page_count,
    last_synced_at: utcnowIso(),
    last_sync_status: "success",
    last_sync_error: null,
    navigation: diff.navigation,
    bilingual_pairings: diff.pairings,
  });
  webSourceSyncRepo.recordPairings(settings, WEB_SOURCE_OWNER_ID, kbName, sourceId, diff.pairings);

  result.ok = true;
  result.pages_added = diff.pages_added.length;
  result.pages_updated = diff.pages_updated.length;
  result.pages_removed = removedCount;
  result.pages_unchanged = diff.pages_unchanged.length;
  result.bilingual_pairs_count = diff.pairings.length;
  return result;
}

// -- SQLite job repository (web_source/repository.py) ----------------------------

export interface WebSourceSyncJob {
  owner_id: string;
  kb_name: string;
  source_id: string;
  state: string;
  next_run_at: number;
  last_run_at: number | null;
  attempt: number;
  error: string | null;
  cancel_requested: boolean;
}

export interface WebSourceBilingualPairing {
  owner_id: string;
  kb_name: string;
  source_id: string;
  pairing_id: string;
  source_url: string;
  target_url: string;
  source_file: string;
  target_file: string;
  source_lang: string;
  target_lang: string;
  pairing_method: string;
  updated_at: number;
}

function repoPath(settings: Settings): string {
  return join(resolve(String(settings.data_dir ?? "./data")), "web-source-sync.sqlite");
}

function withRepo<T>(settings: Settings, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(repoPath(settings));
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=30000");
    db.exec("PRAGMA synchronous=NORMAL");
    db.exec(`CREATE TABLE IF NOT EXISTS web_source_sync_jobs (
      owner_id TEXT NOT NULL, kb_name TEXT NOT NULL, source_id TEXT NOT NULL,
      state TEXT NOT NULL, next_run_at_ms INTEGER NOT NULL,
      last_run_at_ms INTEGER, attempt INTEGER NOT NULL DEFAULT 0,
      error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      runner_id TEXT NOT NULL DEFAULT '', lease_until_ms INTEGER,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (owner_id, kb_name, source_id))`);
    db.exec(`CREATE TABLE IF NOT EXISTS web_source_bilingual_pairings (
      owner_id TEXT NOT NULL, kb_name TEXT NOT NULL, source_id TEXT NOT NULL,
      pairing_id TEXT NOT NULL, source_url TEXT NOT NULL, target_url TEXT NOT NULL,
      source_file TEXT NOT NULL, target_file TEXT NOT NULL,
      source_lang TEXT NOT NULL, target_lang TEXT NOT NULL,
      pairing_method TEXT NOT NULL, updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (owner_id, kb_name, source_id, pairing_id))`);
    return fn(db);
  } finally {
    db.close();
  }
}

const nowMs = () => Date.now();
const hoursMs = (h: number) => h * 3600_000;

function rowToJob(row: Record<string, unknown>): WebSourceSyncJob {
  return {
    owner_id: String(row["owner_id"]),
    kb_name: String(row["kb_name"]),
    source_id: String(row["source_id"]),
    state: String(row["state"]),
    next_run_at: Number(row["next_run_at_ms"]),
    last_run_at: row["last_run_at_ms"] === null || row["last_run_at_ms"] === undefined ? null : Number(row["last_run_at_ms"]),
    attempt: Number(row["attempt"] ?? 0),
    error: row["error"] === null || row["error"] === undefined ? null : String(row["error"]),
    cancel_requested: Boolean(row["cancel_requested"]),
  };
}

function publicJob(job: WebSourceSyncJob): AnyRecord {
  return {
    owner_id: job.owner_id,
    kb_name: job.kb_name,
    source_id: job.source_id,
    state: job.state,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    attempt: job.attempt,
    error: job.error,
    cancel_requested: job.cancel_requested,
  };
}

function rowToPairing(row: Record<string, unknown>): WebSourceBilingualPairing {
  return {
    owner_id: String(row["owner_id"]),
    kb_name: String(row["kb_name"]),
    source_id: String(row["source_id"]),
    pairing_id: String(row["pairing_id"]),
    source_url: String(row["source_url"]),
    target_url: String(row["target_url"]),
    source_file: String(row["source_file"] ?? ""),
    target_file: String(row["target_file"] ?? ""),
    source_lang: String(row["source_lang"] ?? ""),
    target_lang: String(row["target_lang"] ?? ""),
    pairing_method: String(row["pairing_method"] ?? "hreflang"),
    updated_at: Number(row["updated_at_ms"] ?? 0),
  };
}

export const webSourceSyncRepo = {
  ensureSource(settings: Settings, key: [string, string, string], intervalHours = 24): WebSourceSyncJob {
    return withRepo(settings, (db) => {
      const now = nowMs();
      db.prepare(
        `INSERT OR IGNORE INTO web_source_sync_jobs
           (owner_id, kb_name, source_id, state, next_run_at_ms, updated_at_ms)
         VALUES (?, ?, ?, 'pending', ?, ?)`,
      ).run(key[0], key[1], key[2], now + hoursMs(intervalHours), now);
      const row = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .get(...key) as Record<string, unknown> | undefined;
      if (!row) throw new Error("Web source synchronization job could not be created");
      return rowToJob(row);
    });
  },

  listJobs(settings: Settings, ownerId: string, kbName: string): WebSourceSyncJob[] {
    return withRepo(settings, (db) => {
      const rows = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? ORDER BY next_run_at_ms, source_id`)
        .all(ownerId, kbName) as Record<string, unknown>[];
      return rows.map(rowToJob);
    });
  },

  listPairings(settings: Settings, ownerId: string, kbName: string, sourceId: string): WebSourceBilingualPairing[] {
    return withRepo(settings, (db) => {
      const rows = db
        .prepare(`SELECT * FROM web_source_bilingual_pairings WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .all(ownerId, kbName, sourceId) as Record<string, unknown>[];
      return rows.map(rowToPairing);
    });
  },

  recordPairings(settings: Settings, ownerId: string, kbName: string, sourceId: string, pairings: AnyRecord[]): void {
    withRepo(settings, (db) => {
      const del = db.prepare(`DELETE FROM web_source_bilingual_pairings WHERE owner_id=? AND kb_name=? AND source_id=?`);
      del.run(ownerId, kbName, sourceId);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO web_source_bilingual_pairings
           (owner_id, kb_name, source_id, pairing_id, source_url, target_url,
            source_file, target_file, source_lang, target_lang, pairing_method,
            updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const now = nowMs();
      for (const p of pairings) {
        ins.run(
          ownerId, kbName, sourceId,
          String(p["pairing_id"] ?? ""), String(p["source_url"] ?? ""), String(p["target_url"] ?? ""),
          String(p["source_file"] ?? ""), String(p["target_file"] ?? ""),
          String(p["source_lang"] ?? ""), String(p["target_lang"] ?? ""),
          String(p["pairing_method"] ?? "hreflang"), now,
        );
      }
    });
  },

  get(settings: Settings, key: [string, string, string]): WebSourceSyncJob | null {
    return withRepo(settings, (db) => {
      const row = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .get(...key) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : null;
    });
  },

  requestCancel(settings: Settings, key: [string, string, string]): boolean {
    return withRepo(settings, (db) => {
      const now = nowMs();
      const row = db
        .prepare(`SELECT state FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .get(...key) as { state: string } | undefined;
      if (!row) return false;
      const state = row.state;
      if (!["pending", "running", "interrupted", "error"].includes(state)) return false;
      const cancelRequested = state === "running" ? 1 : 0;
      if (state === "pending") {
        db.prepare(
          `UPDATE web_source_sync_jobs SET state='cancelled', cancel_requested=0, runner_id='', lease_until_ms=NULL, updated_at_ms=? WHERE owner_id=? AND kb_name=? AND source_id=?`,
        ).run(now, ...key);
      } else {
        db.prepare(
          `UPDATE web_source_sync_jobs SET cancel_requested=?, updated_at_ms=? WHERE owner_id=? AND kb_name=? AND source_id=?`,
        ).run(cancelRequested, now, ...key);
      }
      return true;
    });
  },

  retry(settings: Settings, key: [string, string, string]): WebSourceSyncJob | null {
    return withRepo(settings, (db) => {
      const now = nowMs();
      const res = db
        .prepare(
          `UPDATE web_source_sync_jobs
             SET state='pending', next_run_at_ms=?, attempt=0, error=NULL,
                 cancel_requested=0, runner_id='', lease_until_ms=NULL, updated_at_ms=?
           WHERE owner_id=? AND kb_name=? AND source_id=?
             AND state IN ('error', 'interrupted', 'cancelled')`,
        )
        .run(now, now, ...key);
      if (Number(res.changes ?? 0) === 0) return null;
      const row = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .get(...key) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : null;
    });
  },

  delete(settings: Settings, key: [string, string, string]): boolean {
    return withRepo(settings, (db) => {
      const res = db
        .prepare(`DELETE FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .run(...key);
      db.prepare(`DELETE FROM web_source_bilingual_pairings WHERE owner_id=? AND kb_name=? AND source_id=?`).run(...key);
      return Number(res.changes ?? 0) > 0;
    });
  },

  dueJobs(settings: Settings): WebSourceSyncJob[] {
    return withRepo(settings, (db) => {
      const rows = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE state IN ('pending','interrupted','error') AND next_run_at_ms<=? ORDER BY next_run_at_ms`)
        .all(nowMs()) as Record<string, unknown>[];
      return rows.map(rowToJob);
    });
  },

  claim(settings: Settings, job: WebSourceSyncJob, runnerId: string, leaseMs: number): WebSourceSyncJob | null {
    return withRepo(settings, (db) => {
      const now = nowMs();
      const res = db
        .prepare(
          `UPDATE web_source_sync_jobs
             SET state='running', runner_id=?, lease_until_ms=?, attempt=attempt+1, updated_at_ms=?
           WHERE owner_id=? AND kb_name=? AND source_id=?
             AND state IN ('pending','interrupted','cancelled','error')`,
        )
        .run(runnerId, now + leaseMs, now, job.owner_id, job.kb_name, job.source_id);
      if (Number(res.changes ?? 0) === 0) return null;
      const row = db
        .prepare(`SELECT * FROM web_source_sync_jobs WHERE owner_id=? AND kb_name=? AND source_id=?`)
        .get(job.owner_id, job.kb_name, job.source_id) as Record<string, unknown> | undefined;
      return row ? rowToJob(row) : null;
    });
  },

  markSuccess(settings: Settings, job: WebSourceSyncJob, intervalHours: number): void {
    withRepo(settings, (db) => {
      const now = nowMs();
      db.prepare(
        `UPDATE web_source_sync_jobs SET state='pending', next_run_at_ms=?, last_run_at_ms=?, error=NULL, cancel_requested=0, runner_id='', lease_until_ms=NULL, updated_at_ms=? WHERE owner_id=? AND kb_name=? AND source_id=?`,
      ).run(now + hoursMs(intervalHours), now, now, job.owner_id, job.kb_name, job.source_id);
    });
  },

  markFailure(settings: Settings, job: WebSourceSyncJob, error: string, intervalHours: number): void {
    withRepo(settings, (db) => {
      const now = nowMs();
      db.prepare(
        `UPDATE web_source_sync_jobs SET state='error', next_run_at_ms=?, last_run_at_ms=?, error=?, runner_id='', lease_until_ms=NULL, updated_at_ms=? WHERE owner_id=? AND kb_name=? AND source_id=?`,
      ).run(now + hoursMs(intervalHours), now, error.slice(0, 1000), now, job.owner_id, job.kb_name, job.source_id);
    });
  },
};

export { publicJob as webSourceJobPublic };

// -- scheduler (web_source/scheduler.py, interval-driven) -------------------------

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;
const RUNNER_ID = `runner-${process.pid}`;

async function runDueJobs(settings: Settings): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const due = webSourceSyncRepo.dueJobs(settings);
    for (const job of due) {
      const claimed = webSourceSyncRepo.claim(settings, job, RUNNER_ID, 10 * 60_000);
      if (!claimed) continue;
      try {
        const { getWebSource } = await import("./kb_sources.js");
        const source = getWebSource(settings, claimed.kb_name, claimed.source_id);
        if (!source) {
          webSourceSyncRepo.delete(settings, [claimed.owner_id, claimed.kb_name, claimed.source_id]);
          continue;
        }
        const interval = Math.min(Math.max(Number(source["sync_interval_hours"] ?? 24) || 24, 1), 168);
        const result = await syncWebSource(settings, claimed.kb_name, source);
        if (result.ok) {
          webSourceSyncRepo.markSuccess(settings, claimed, interval);
        } else {
          webSourceSyncRepo.markFailure(settings, claimed, result.error || "sync failed", interval);
        }
      } catch (exc) {
        webSourceSyncRepo.markFailure(
          settings, claimed,
          exc instanceof Error ? exc.message : String(exc), 24,
        );
      }
    }
  } finally {
    schedulerRunning = false;
  }
}

export function startWebSourceScheduler(settings: Settings): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void runDueJobs(settings).catch(() => {});
  }, 60_000);
  schedulerTimer.unref?.();
  void runDueJobs(settings).catch(() => {});
}

export function stopWebSourceScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}
