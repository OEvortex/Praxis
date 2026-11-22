// GitHub/web source registry methods. The sources are persisted
// lists inside ``<kb>/metadata.json``; this backend keeps KB payloads in the
// shared ``kb_meta`` sqlite table (same pattern as ``linked_folders``), so the
// ``github_sources`` / ``web_sources`` arrays live on the KB entry verbatim.
import { createHash } from "node:crypto";
import type { Settings } from "../../config.js";
import { getKbEntry, updateKbEntry, KbConnectorError } from "./store.js";
import type { AnyRecord } from "./types.js";

export const MAX_CRAWL_DEPTH = 5;
export const MAX_CRAWL_PAGES = 200;

function md5_8(value: string): string {
  return createHash("md5").update(value, "utf8").digest("hex").slice(0, 8);
}

function requireEntry(settings: Settings, kbName: string): AnyRecord {
  const entry = getKbEntry(settings, kbName);
  if (entry === null) {
    throw new KbConnectorError(`Knowledge base not found: ${kbName}`);
  }
  return entry;
}

function mutateSources(
  settings: Settings,
  kbName: string,
  key: "github_sources" | "web_sources",
  mutate: (sources: AnyRecord[]) => AnyRecord[] | void,
): AnyRecord[] {
  let result: AnyRecord[] = [];
  updateKbEntry(settings, kbName, (entry) => {
    const sources = Array.isArray(entry[key]) ? [...(entry[key] as AnyRecord[])] : [];
    const out = mutate(sources);
    result = Array.isArray(out) ? out : sources;
    entry[key] = result;
  });
  return result;
}

// -- GitHub sources -----------------------------------------------------------

/** Upstream repo normalization: strip scheme/host/.git/trailing slash. */
export function normalizeGithubRepo(repo: string): string {
  let clean = String(repo ?? "").trim().replace(/\/+$/, "");
  if (clean.toLowerCase().endsWith(".git")) clean = clean.slice(0, -4);
  const idx = clean.toLowerCase().indexOf("github.com/");
  if (idx >= 0) clean = clean.slice(idx + "github.com/".length);
  return clean.replace(/^\/+|\/+$/g, "");
}

export function addGithubSource(
  settings: Settings,
  kbName: string,
  fields: { repo: string; branch?: string; path?: string; glob?: string },
): AnyRecord {
  requireEntry(settings, kbName);
  const repo = normalizeGithubRepo(fields.repo);
  if (!repo) throw new KbConnectorError("GitHub repository is required");
  const branch = String(fields.branch ?? "main") || "main";
  const path = String(fields.path ?? "");
  const glob = String(fields.glob ?? "*.md") || "*.md";
  const sourceId = md5_8(`${repo}:${branch}:${path}`);
  let info: AnyRecord | null = null;
  mutateSources(settings, kbName, "github_sources", (sources) => {
    const existing = sources.find((s) => s["id"] === sourceId);
    if (existing) {
      info = existing;
      return sources;
    }
    info = {
      id: sourceId,
      repo,
      branch,
      path,
      glob,
      enabled: true,
      last_synced_sha: "",
      last_synced_at: "",
      last_sync_status: "pending",
      last_sync_error: null,
      files_synced: 0,
      added_at: new Date().toISOString(),
    };
    return [...sources, info];
  });
  return info!;
}

export function getGithubSources(settings: Settings, kbName: string): AnyRecord[] {
  const entry = requireEntry(settings, kbName);
  const sources = entry["github_sources"];
  return Array.isArray(sources) ? (sources as AnyRecord[]) : [];
}

export function removeGithubSource(settings: Settings, kbName: string, sourceId: string): boolean {
  requireEntry(settings, kbName);
  let removed = false;
  mutateSources(settings, kbName, "github_sources", (sources) => {
    const remaining = sources.filter((s) => s["id"] !== sourceId);
    removed = remaining.length !== sources.length;
    return remaining;
  });
  return removed;
}

export function updateGithubSourceState(
  settings: Settings,
  kbName: string,
  sourceId: string,
  fields: AnyRecord,
): void {
  requireEntry(settings, kbName);
  mutateSources(settings, kbName, "github_sources", (sources) => {
    for (const src of sources) {
      if (src["id"] === sourceId) Object.assign(src, fields);
    }
    return sources;
  });
}

// -- Web sources --------------------------------------------------------------

export function addWebSource(
  settings: Settings,
  kbName: string,
  fields: { url: string; max_depth?: number; max_pages?: number },
): AnyRecord {
  requireEntry(settings, kbName);
  const maxDepth = Number(fields.max_depth ?? 3);
  const maxPages = Number(fields.max_pages ?? 200);
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_CRAWL_DEPTH) {
    throw new KbConnectorError(`Web source crawl depth must be between 1 and ${MAX_CRAWL_DEPTH}`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_CRAWL_PAGES) {
    throw new KbConnectorError(`Web source crawl page count must be between 1 and ${MAX_CRAWL_PAGES}`);
  }
  const url = String(fields.url ?? "").trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KbConnectorError("Web source URL must be an absolute http(s) URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new KbConnectorError("Web source URL must be an absolute http(s) URL");
  }
  const sourceId = md5_8(url);
  let info: AnyRecord | null = null;
  mutateSources(settings, kbName, "web_sources", (sources) => {
    const existing = sources.find((s) => s["id"] === sourceId);
    if (existing) {
      info = existing;
      return sources;
    }
    info = {
      id: sourceId,
      url,
      max_depth: maxDepth,
      max_pages: maxPages,
      enabled: true,
      auto_sync_enabled: true,
      sync_interval_hours: 24,
      page_hashes: {},
      page_count: 0,
      last_synced_at: "",
      last_sync_status: "pending",
      last_sync_error: null,
      added_at: new Date().toISOString(),
    };
    sources.push(info);
    return sources;
  });
  return info!;
}

export function getWebSources(settings: Settings, kbName: string): AnyRecord[] {
  const entry = requireEntry(settings, kbName);
  const sources = entry["web_sources"];
  return Array.isArray(sources) ? (sources as AnyRecord[]) : [];
}

export function getWebSource(
  settings: Settings,
  kbName: string,
  sourceId: string,
): AnyRecord | null {
  return getWebSources(settings, kbName).find((s) => s["id"] === sourceId) ?? null;
}

export function removeWebSource(settings: Settings, kbName: string, sourceId: string): boolean {
  requireEntry(settings, kbName);
  let removed = false;
  mutateSources(settings, kbName, "web_sources", (sources) => {
    const remaining = sources.filter((s) => s["id"] !== sourceId);
    removed = remaining.length !== sources.length;
    return remaining;
  });
  return removed;
}

export function updateWebSourceState(
  settings: Settings,
  kbName: string,
  sourceId: string,
  fields: AnyRecord,
): void {
  requireEntry(settings, kbName);
  mutateSources(settings, kbName, "web_sources", (sources) => {
    for (const src of sources) {
      if (src["id"] === sourceId) Object.assign(src, fields);
    }
    return sources;
  });
}

export function updateWebSourceSchedule(
  settings: Settings,
  kbName: string,
  sourceId: string,
  fields: { auto_sync_enabled: boolean; sync_interval_hours: number },
): AnyRecord {
  requireEntry(settings, kbName);
  const interval = Number(fields.sync_interval_hours);
  if (!Number.isInteger(interval) || interval < 1 || interval > 168) {
    throw new KbConnectorError("sync_interval_hours must be between 1 and 168");
  }
  const source = getWebSource(settings, kbName, sourceId);
  if (source === null) {
    throw new KbConnectorError(`Source '${sourceId}' not found`);
  }
  updateWebSourceState(settings, kbName, sourceId, {
    auto_sync_enabled: Boolean(fields.auto_sync_enabled),
    sync_interval_hours: interval,
  });
  return getWebSource(settings, kbName, sourceId)!;
}
