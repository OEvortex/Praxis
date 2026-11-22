// pull Markdown
// and MDX from a GitHub repo into a KB's raw/ dir and index changed files
// through the deployment's document store.
import { mkdirSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { Settings } from "../../config.js";
import { KnowledgeBaseStore } from "../../store/kb_store.js";
import { rawDir, safeJoin } from "./store.js";
import { updateGithubSourceState } from "./kb_sources.js";
import type { AnyRecord } from "./types.js";

const GITHUB_API_BASE = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

export interface SyncResult {
  ok: boolean;
  skipped?: boolean;
  files_added?: number;
  files_updated?: number;
  files_removed?: number;
  error?: string;
}

export class GitHubAPIError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(`GitHub API ${statusCode}: ${message}`);
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DeepTutor/1.0 (+https://hkuds.dev/deeptutor)",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function requestJson(method: string, url: string): Promise<AnyRecord> {
  const resp = await fetch(url, { method, headers: headers(), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (resp.status >= 400) {
    let msg = "";
    try {
      const body: unknown = await resp.json();
      msg = String((body as AnyRecord)?.["message"] ?? "").slice(0, 500);
    } catch {
      msg = (await resp.text().catch(() => "")).slice(0, 500);
    }
    throw new GitHubAPIError(resp.status, msg || resp.statusText);
  }
  return (await resp.json()) as AnyRecord;
}

async function requestBytes(url: string): Promise<Uint8Array> {
  const resp = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS), redirect: "follow" });
  if (resp.status >= 400) {
    throw new GitHubAPIError(resp.status, (await resp.text().catch(() => "")).slice(0, 500));
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  return buf.length > MAX_FILE_BYTES ? buf.slice(0, MAX_FILE_BYTES) : buf;
}

export interface TreeEntry {
  path: string;
  sha: string;
  type: string;
}

export interface FileChange {
  path: string;
  status: string;
  sha: string;
}

export const githubClient = {
  async getLatestCommitSha(repo: string, branch: string): Promise<string> {
    const data = await requestJson("GET", `${GITHUB_API_BASE}/repos/${repo}/commits/${encodeURIComponent(branch)}`);
    return String(data["sha"] ?? "");
  },

  async getTree(repo: string, branch: string): Promise<TreeEntry[]> {
    const data = await requestJson(
      "GET",
      `${GITHUB_API_BASE}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    const tree = Array.isArray(data["tree"]) ? (data["tree"] as AnyRecord[]) : [];
    return tree
      .filter((item) => item["type"] === "blob")
      .map((item) => ({
        path: String(item["path"] ?? ""),
        sha: String(item["sha"] ?? ""),
        type: "blob",
      }));
  },

  async compareCommits(repo: string, base: string, head: string): Promise<FileChange[]> {
    const data = await requestJson(
      "GET",
      `${GITHUB_API_BASE}/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    const files = Array.isArray(data["files"]) ? (data["files"] as AnyRecord[]) : [];
    return files.map((item) => ({
      path: String(item["filename"] ?? ""),
      status: String(item["status"] ?? "modified"),
      sha: String(item["sha"] ?? ""),
    }));
  },

  async downloadFile(repo: string, path: string, ref: string): Promise<Uint8Array> {
    const url = `${RAW_BASE}/${repo}/${encodeURIComponent(ref)}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    return requestBytes(url);
  },
};

// -- sync ---------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  // fnmatch-lite: *, ?, [...], ** crosses separators.
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+(){}[]".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function matchGlob(path: string, glob: string): boolean {
  const re = globToRegExp(glob);
  return re.test(path) || re.test(path.split("/").pop() ?? "");
}

function rawRelPath(githubPath: string, pathPrefix: string): string {
  const prefix = pathPrefix.replace(/^\/+|\/+$/g, "");
  if (prefix && githubPath.startsWith(prefix + "/")) return githubPath.slice(prefix.length + 1);
  return githubPath;
}

function containedDest(rawDirPath: string, rel: string): string | null {
  const target = safeJoin(rawDirPath, rel);
  if (target === null) return null;
  const root = resolve(rawDirPath);
  const candidate = resolve(target);
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  return candidate;
}

function inPrefix(path: string, prefix: string): boolean {
  const p = prefix.replace(/^\/+|\/+$/g, "");
  return !p || path === p || path.startsWith(p + "/");
}

function redactSyncError(exc: unknown): string {
  let message = exc instanceof Error ? exc.message : String(exc);
  message = message.trim() || "Unknown error";
  message = message.replace(/https?:\/\/\S+/g, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return "[redacted-url]";
    }
  });
  message = message.replace(/\bsk-[A-Za-z0-9_-]{4,}\b/g, "[redacted]");
  message = message.replace(
    /((?:api[_-]?key|authorization|token|password)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[redacted]",
  );
  return message.slice(0, 1000);
}

function utcnowIso(): string {
  return new Date().toISOString();
}

function indexFiles(settings: Settings, kbName: string, filePaths: string[]): number {
  if (!filePaths.length) return 0;
  const kb = new KnowledgeBaseStore(settings);
  let count = 0;
  for (const path of filePaths) {
    try {
      const rel = path.startsWith(rawDir(settings, kbName))
        ? path.slice(rawDir(settings, kbName).length).replace(/^[/\\]+/, "")
        : path;
      kb.add_document(kbName, rel, new Uint8Array(readFileSync(path)));
      count++;
    } catch {
      /* individual file failure is non-fatal, like upstream add_documents */
    }
  }
  return count;
}

export async function syncGithubSource(
  settings: Settings,
  kbName: string,
  source: AnyRecord,
): Promise<SyncResult> {
  const raw = rawDir(settings, kbName);
  mkdirSync(raw, { recursive: true });

  const repo = String(source["repo"] ?? "");
  const branch = String(source["branch"] ?? "") || "main";
  const pathPrefix = String(source["path"] ?? "");
  const glob = String(source["glob"] ?? "") || "*.md";
  const oldSha = String(source["last_synced_sha"] ?? "");

  const recordFailure = (error: string) =>
    updateGithubSourceState(settings, kbName, String(source["id"]), {
      last_sync_status: "error",
      last_sync_error: error,
    });
  const recordSuccess = (sha: string, filesSynced?: number) =>
    updateGithubSourceState(settings, kbName, String(source["id"]), {
      last_synced_sha: sha,
      last_synced_at: utcnowIso(),
      last_sync_status: "success",
      last_sync_error: null,
      ...(filesSynced === undefined ? {} : { files_synced: filesSynced }),
    });

  let latestSha: string;
  try {
    latestSha = await githubClient.getLatestCommitSha(repo, branch);
  } catch (exc) {
    const error = redactSyncError(exc);
    recordFailure(error);
    return { ok: false, error };
  }
  if (!latestSha) {
    const error = "GitHub API returned no commit SHA";
    recordFailure(error);
    return { ok: false, error };
  }

  if (oldSha && oldSha === latestSha) {
    recordSuccess(latestSha);
    return { ok: true, skipped: true };
  }

  try {
    let result: SyncResult;
    if (!oldSha) {
      result = await fullSync(settings, kbName, raw, repo, branch, pathPrefix, glob, latestSha);
    } else {
      result = await incrementalSync(settings, kbName, raw, repo, branch, pathPrefix, glob, oldSha, latestSha);
    }
    if (!result.ok) {
      recordFailure(result.error ?? "sync failed");
      return result;
    }
    recordSuccess(latestSha, (result.files_added ?? 0) + (result.files_updated ?? 0));
    return result;
  } catch (exc) {
    const error = redactSyncError(exc);
    recordFailure(error);
    return { ok: false, error };
  }
}

async function fullSync(
  settings: Settings,
  kbName: string,
  raw: string,
  repo: string,
  branch: string,
  pathPrefix: string,
  glob: string,
  sha: string,
): Promise<SyncResult> {
  const tree = await githubClient.getTree(repo, branch);
  const entries = tree.filter(
    (e) => isMarkdown(e.path) && inPrefix(e.path, pathPrefix) && matchGlob(e.path, glob),
  );
  if (!entries.length) {
    const detail = tree.length
      ? `${tree.length} file(s) matched the GitHub source path and glob, but none have a supported Markdown extension.`
      : "No files matched the GitHub source path and glob.";
    return {
      ok: false,
      error: `${detail} Check the path and glob settings. Supported extensions: ${MARKDOWN_EXTENSIONS.join(", ")}.`,
    };
  }
  const downloaded: string[] = [];
  for (const entry of entries) {
    const rel = rawRelPath(entry.path, pathPrefix);
    const dest = containedDest(raw, rel);
    if (dest === null) continue;
    const content = await githubClient.downloadFile(repo, entry.path, sha);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    downloaded.push(dest);
  }
  indexFiles(settings, kbName, downloaded);
  return { ok: true, files_added: downloaded.length };
}

async function incrementalSync(
  settings: Settings,
  kbName: string,
  raw: string,
  repo: string,
  branch: string,
  pathPrefix: string,
  glob: string,
  oldSha: string,
  newSha: string,
): Promise<SyncResult> {
  void branch;
  const changes = await githubClient.compareCommits(repo, oldSha, newSha);
  const filtered = changes.filter(
    (ch) =>
      inPrefix(ch.path, pathPrefix) && isMarkdown(ch.path) && matchGlob(ch.path, glob),
  );
  const toDownload: string[] = [];
  const removed: string[] = [];
  for (const ch of filtered) {
    const rel = rawRelPath(ch.path, pathPrefix);
    if (ch.status === "removed") {
      removed.push(rel);
    } else {
      toDownload.push(ch.path);
    }
  }
  const downloaded: string[] = [];
  for (const ghPath of toDownload) {
    const rel = rawRelPath(ghPath, pathPrefix);
    const dest = containedDest(raw, rel);
    if (dest === null) continue;
    const content = await githubClient.downloadFile(repo, ghPath, newSha);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
    downloaded.push(dest);
  }
  indexFiles(settings, kbName, downloaded);

  let removedCount = 0;
  const kb = new KnowledgeBaseStore(settings);
  for (const rel of removed) {
    const target = containedDest(raw, rel);
    if (target !== null && existsSync(target)) {
      try {
        unlinkSync(target);
        kb.delete_document(kbName, rel);
        removedCount++;
      } catch {
        /* removal failure is non-fatal */
      }
    }
  }
  return { ok: true, files_added: downloaded.length, files_removed: removedCount };
}
