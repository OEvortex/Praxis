// Port of the self-update machinery in
//
// Scope notes for the TS backend:
//   * Version checks hit the same public GitHub latest-release endpoint the
//     Python backend uses (HKUDS/DeepTutor), with the same 24h process cache.
//   * Installation detection is simplified: this backend is not a PyPI
//     install under a launcher, so `detect_installation` reports
//     mode "source"/automatic_update=false and POST /update fails closed with
//     409 — matching upstream behaviour for non-updatable installs.
//   * The update job store is a single JSON file under the data dir.
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { get_settings } from "../../config.js";

export const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/HKUDS/DeepTutor/releases/latest";
export const GITHUB_LATEST_RELEASE_WEB_URL =
  "https://github.com/HKUDS/DeepTutor/releases/latest";
export const SYSTEMD_UPDATE_REASON =
  "DeepTutor is managed by systemd and cannot update itself from the web.";
const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 8000;

// Local package version (backend-ts/package.json is private; keep in sync).
export const CURRENT_VERSION = "0.1.0";

export interface ReleaseInfo {
  version: string;
  name: string;
  published_at: string;
  url: string;
  excerpt: string;
  migration_warning: boolean;
}

export interface VersionCheckResult {
  current_version: string;
  release: ReleaseInfo | null;
  checked_at: string;
  cached: boolean;
}

export class VersionCheckError extends Error {}

function versionTuple(value: string): [number, number, number] {
  const m = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`Invalid DeepTutor version: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareVersions(a: string, b: string): number {
  const [a1, a2, a3] = versionTuple(a);
  const [b1, b2, b3] = versionTuple(b);
  return a1 - b1 || a2 - b2 || a3 - b3;
}

function normaliseStableVersion(value: string): string {
  const v = String(value).trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error("Update target must be a stable semantic version");
  }
  return v;
}

function plainReleaseExcerpt(body: string): string {
  return body
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .slice(0, 400);
}

function releaseFromPayload(payload: unknown): ReleaseInfo {
  const p = payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.draft || p.prerelease) {
    throw new VersionCheckError("The latest stable release is unavailable");
  }
  let version: string;
  try {
    version = normaliseStableVersion(String(p.tag_name ?? ""));
  } catch {
    throw new VersionCheckError("The latest release has an invalid version");
  }
  const url = String(p.html_url ?? "").trim();
  if (!url.startsWith("https://github.com/HKUDS/DeepTutor/releases/")) {
    throw new VersionCheckError("The latest release has an invalid URL");
  }
  const body = String(p.body ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const lowered = body.toLowerCase();
  const migration_warning = /breaking chang|migration(?: needed|required)|database migration|run migration|migrate your/.test(lowered);
  return {
    version,
    name: String(p.name ?? "").trim(),
    published_at: String(p.published_at ?? "").trim(),
    url,
    excerpt: plainReleaseExcerpt(body),
    migration_warning,
  };
}

async function fetchLatestRelease(): Promise<ReleaseInfo> {
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "DeepTutor-Version-Check",
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return releaseFromPayload(await res.json());
  } catch {
    // Fall back to resolving the latest-release redirect (rate-limit free).
    try {
      const res = await fetch(GITHUB_LATEST_RELEASE_WEB_URL, {
        method: "HEAD",
        redirect: "manual",
        headers: { "User-Agent": "DeepTutor-Version-Check" },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const location = res.headers.get("location") ?? "";
      if (location) {
        const releaseUrl = new URL(location, GITHUB_LATEST_RELEASE_WEB_URL).toString();
        return releaseFromLatestUrl(releaseUrl);
      }
      throw new VersionCheckError("The latest stable release is unavailable");
    } catch (exc) {
      if (exc instanceof VersionCheckError) throw exc;
      throw new VersionCheckError(
        `Unable to check for updates: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }
}

function releaseFromLatestUrl(value: string): ReleaseInfo {
  // e.g. https://github.com/HKUDS/DeepTutor/releases/tag/v1.2.3
  const m = value.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)/);
  if (!m) throw new VersionCheckError("The latest stable release is unavailable");
  return {
    version: m[1],
    name: "",
    published_at: "",
    url: value,
    excerpt: "",
    migration_warning: false,
  };
}

export class VersionCheckService {
  private cache: VersionCheckResult | null = null;
  private cachedAt = 0;
  private lock: Promise<unknown> = Promise.resolve();

  cached(): VersionCheckResult | null {
    if (!this.cache || Date.now() - this.cachedAt >= VERSION_CHECK_TTL_MS) {
      return null;
    }
    return { ...this.cache, cached: true };
  }

  async check(force = false): Promise<VersionCheckResult> {
    // Simple mutex: chain onto the previous check.
    const run = this.lock.then(() => this._check(force));
    this.lock = run.catch(() => {});
    return run;
  }

  private async _check(force: boolean): Promise<VersionCheckResult> {
    if (!force) {
      const hit = this.cached();
      if (hit) return hit;
    }
    const release = await fetchLatestRelease();
    const result: VersionCheckResult = {
      current_version: CURRENT_VERSION,
      release,
      checked_at: new Date().toISOString(),
      cached: false,
    };
    this.cache = result;
    this.cachedAt = Date.now();
    return result;
  }
}

let _versionService: VersionCheckService | null = null;
export function get_version_check_service(): VersionCheckService {
  _versionService ??= new VersionCheckService();
  return _versionService;
}

// ---------------------------------------------------------------------------
// Installation detection (simplified — see header note)
// ---------------------------------------------------------------------------

export interface Installation {
  mode: "pypi" | "source" | "docker" | "unknown";
  current_version: string;
  automatic_update: boolean;
  command: string;
  reason: string;
}

export function detect_installation(): Installation {
  const inContainer = existsSync("/.dockerenv") || !!process.env.KUBERNETES_SERVICE_HOST;
  if (inContainer) {
    return {
      mode: "docker",
      current_version: CURRENT_VERSION,
      automatic_update: false,
      command: "",
      reason: "Docker installations update by pulling a new image.",
    };
  }
  return {
    mode: "source",
    current_version: CURRENT_VERSION,
    automatic_update: false,
    command: "",
    reason: "This TypeScript backend cannot update itself from the web.",
  };
}

export function launcher_available(): boolean {
  // No `deeptutor start` launcher supervises this process.
  return false;
}

export function running_under_systemd_service(): boolean {
  try {
    return readFileSync("/proc/self/cgroup", "utf8").includes("/system.slice/");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Update job store (single JSON document, atomic replace)
// ---------------------------------------------------------------------------

export interface UpdateJob {
  id: string;
  status: string;
  current_version: string;
  target_version: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  restart_count: number;
  schema_version: number;
}

export class UpdateInProgressError extends Error {}
export class UpdateRequestError extends Error {}

function updateStoreRoot(): string {
  return join(get_settings().data_dir, "update");
}

function jobPath(): string {
  return join(updateStoreRoot(), "job.json");
}

export class UpdateJobStore {
  private path: string;
  constructor(root?: string) {
    this.path = root ? join(root, "job.json") : jobPath();
  }

  load(): UpdateJob | null {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      if (raw?.schema_version !== 1) return null;
      return raw as UpdateJob;
    } catch {
      return null;
    }
  }

  create(current_version: string, target_version: string): UpdateJob {
    const existing = this.load();
    if (
      existing &&
      ["pending", "handoff", "running", "restarting"].includes(existing.status)
    ) {
      throw new UpdateInProgressError("An update is already in progress.");
    }
    const job: UpdateJob = {
      id: randomBytes(8).toString("hex"),
      status: "pending",
      current_version,
      target_version,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error: null,
      restart_count: 0,
      schema_version: 1,
    };
    mkdirSync(join(this.path, ".."), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(job, null, 2));
    renameSync(tmp, this.path);
    return job;
  }
}

export function get_update_job_store(): UpdateJobStore {
  return new UpdateJobStore();
}

// ---------------------------------------------------------------------------
// Runtime system settings (version_check_enabled etc.) — JSON under data dir
// ---------------------------------------------------------------------------

interface SystemSettings {
  version_check_enabled: boolean;
  [key: string]: unknown;
}

function systemSettingsPath(): string {
  return join(get_settings().data_dir, "system-settings.json");
}

export function load_system_settings(): SystemSettings {
  try {
    const raw = JSON.parse(readFileSync(systemSettingsPath(), "utf8"));
    return {
      version_check_enabled: raw?.version_check_enabled !== false,
      ...raw,
    };
  } catch {
    return { version_check_enabled: true };
  }
}

export function save_system_settings(patch: Record<string, unknown>): SystemSettings {
  const current = load_system_settings();
  const next = { ...current, ...patch };
  mkdirSync(join(systemSettingsPath(), ".."), { recursive: true });
  const tmp = systemSettingsPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, systemSettingsPath());
  return next;
}

// ---------------------------------------------------------------------------
// Payload shaping (mirrors _update_payload / _job_payload in system.py)
// ---------------------------------------------------------------------------

export function jobPayload(job: UpdateJob | null): Record<string, unknown> | null {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    current_version: job.current_version,
    target_version: job.target_version,
    created_at: job.created_at,
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
    restart_count: job.restart_count,
  };
}

export function storedJob(store?: UpdateJobStore): UpdateJob | null {
  try {
    return (store ?? get_update_job_store()).load();
  } catch {
    return null;
  }
}

export function updatePayload(opts: {
  result: VersionCheckResult | null;
  installation: Installation;
  check_enabled: boolean;
  check_error?: string;
  store?: UpdateJobStore;
}): Record<string, unknown> {
  const { result, installation, check_enabled, check_error = "", store } = opts;
  const release = result?.release ?? null;
  return {
    current_version: result?.current_version ?? installation.current_version,
    check_enabled,
    checked_at: result?.checked_at ?? "",
    cached: result?.cached ?? false,
    check_error,
    update_available:
      !!release && compareVersions(release.version, CURRENT_VERSION) > 0,
    release: release
      ? {
          version: release.version,
          name: release.name,
          published_at: release.published_at,
          url: release.url,
          excerpt: release.excerpt,
          migration_warning: release.migration_warning,
        }
      : null,
    installation: {
      mode: installation.mode,
      automatic_update: installation.automatic_update,
      command: installation.command,
      reason: installation.reason,
    },
    launcher_managed: launcher_available(),
    is_admin: true,
    job: jobPayload(storedJob(store)),
  };
}
