// subagent backend registry, detection (real PATH + --version probes), and
// the persisted per-backend run settings.
//
// Detection is machine-global: local CLIs run on the host with the host
// user's credentials. Persistence uses the shared kv store (the Python
// version wrote data/user/settings/subagent.json; here the canonical DB is
// the single store, keyed "subagent_settings").

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import { get_settings, type Settings } from "../../config.js";
import * as database from "../../store/database.js";

// -- types ---------------------------------------------------------------------

export interface DetectResult {
  kind: string;
  display_name: string;
  available: boolean;
  version: string;
  detail: string;
}

export interface BackendConfig {
  enabled: boolean;
  model: string;
  effort: string;
  system_prompt: string;
  permission_mode: string;
  sandbox: string;
  approval: string;
  network_access: boolean;
  ephemeral: boolean;
  auto_approve: boolean;
  thinking: boolean;
  forward_images: boolean;
  extra_args: string[];
  base_url: string;
  api_key_env: string;
  profile: string;
  idle_timeout_seconds: number;
}

export interface SubagentSettings {
  consult_budget: number;
  backends: Record<string, BackendConfig>;
}

// -- constants -------------------------------------------------------------------

export const DEFAULT_CONSULT_BUDGET = 5;
export const CONSULT_BUDGET_MIN = 1;
export const CONSULT_BUDGET_MAX = 12;
const SETTINGS_KEY = "subagent_settings";
const ACP_COMMAND_ENV = "DEEPTUTOR_ACP_COMMAND";

interface BackendSpec {
  kind: string;
  display_name: string;
  cli_command: string;
  local_cli: boolean;
  detectable: boolean;
}

/** Mirrors registry.py's _BACKENDS (partner is excluded — it is not connectable). */
const BACKENDS: BackendSpec[] = [
  { kind: "claude_code", display_name: "Claude Code", cli_command: "claude", local_cli: true, detectable: true },
  { kind: "codex", display_name: "Codex", cli_command: "codex", local_cli: true, detectable: true },
  { kind: "grok", display_name: "Grok CLI", cli_command: "grok", local_cli: true, detectable: true },
  { kind: "antigravity", display_name: "Antigravity CLI", cli_command: "agy", local_cli: true, detectable: true },
  { kind: "kimi", display_name: "Kimi CLI", cli_command: "kimi", local_cli: true, detectable: true },
  { kind: "opencode", display_name: "opencode", cli_command: "opencode", local_cli: true, detectable: true },
  { kind: "mimo", display_name: "MiMo Code", cli_command: "mimo", local_cli: true, detectable: true },
  { kind: "hermes", display_name: "Hermes Agent", cli_command: "hermes", local_cli: true, detectable: true },
  { kind: "hermes_remote", display_name: "Hermes Agent (remote)", cli_command: "", local_cli: false, detectable: true },
  { kind: "openclaw", display_name: "OpenClaw", cli_command: "openclaw", local_cli: true, detectable: true },
  { kind: "deepseek_harness", display_name: "DeepSeek Harness", cli_command: "dsh", local_cli: true, detectable: true },
  { kind: "acp", display_name: "ACP (Agent Client Protocol)", cli_command: "", local_cli: true, detectable: true },
];

const BY_KIND = new Map(BACKENDS.map((b) => [b.kind, b]));

export function list_backend_kinds(): string[] {
  return BACKENDS.map((b) => b.kind);
}

export function get_backend(kind: string): BackendSpec | null {
  return BY_KIND.get(String(kind ?? "").trim()) ?? null;
}

// -- detection (process/fs checks) ----------------------------------------------

function which(cmd: string): string | null {
  if (!cmd) return null;
  // Absolute/relative paths with a separator are checked directly.
  if (cmd.includes("/") || cmd.includes("\\")) {
    return existsSync(cmd) ? cmd : null;
  }
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32"
    ? ["", ".exe", ".cmd", ".bat", ".ps1"]
    : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function probeVersion(cmd: string[], timeoutMs = 8000): Promise<[boolean, string]> {
  return new Promise((resolvePromise) => {
    const resolved = which(cmd[0]);
    if (resolved === null) {
      resolvePromise([false, "not installed"]);
      return;
    }
    execFile(
      resolved,
      cmd.slice(1),
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          // Non-zero exit with output still counts as "installed" for --version
          // probes on CLIs that print to stderr or exit oddly; prefer output.
          const out = String(stdout || stderr || "").trim();
          resolvePromise([Boolean(out), out || String(error.message)]);
          return;
        }
        resolvePromise([true, String(stdout || "").trim()]);
      },
    );
  });
}

function parseAcpCommand(): string[] {
  const raw = (process.env[ACP_COMMAND_ENV] ?? "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      const argv = parsed.map((p) => String(p)).filter(Boolean);
      return argv;
    }
  } catch {
    // Fall through to shell-ish split.
  }
  return raw.split(/\s+/).filter(Boolean);
}

async function detectBackend(spec: BackendSpec): Promise<DetectResult> {
  const base: DetectResult = {
    kind: spec.kind,
    display_name: spec.display_name,
    available: false,
    version: "",
    detail: "",
  };
  if (spec.kind === "hermes_remote") {
    // Remote backend: usable only when a base_url is configured in settings.
    const cfg = backend_config(load_subagent_settings(), spec.kind);
    if (cfg.base_url.trim()) {
      return { ...base, available: true, detail: "configured remote endpoint" };
    }
    return { ...base, detail: "no base_url configured" };
  }
  if (spec.kind === "acp") {
    const argv = parseAcpCommand();
    if (!argv.length) {
      return { ...base, detail: `set ${ACP_COMMAND_ENV} to an ACP agent argv` };
    }
    const ok = which(argv[0]) !== null;
    return ok
      ? { ...base, available: true, detail: argv.join(" ") }
      : { ...base, detail: `configured ACP agent command not found on PATH: ${argv[0]}` };
  }
  const [ok, text] = await probeVersion([spec.cli_command, "--version"]);
  if (!ok) {
    return { ...base, detail: text === "not installed" ? "CLI not found on PATH" : text };
  }
  // First non-empty line is the version banner for every supported CLI.
  const version = String(text).split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return { ...base, available: true, version };
}

export async function detect_all(): Promise<DetectResult[]> {
  const targets = BACKENDS.filter((b) => b.local_cli || b.detectable);
  return Promise.all(targets.map((b) => detectBackend(b)));
}

// -- settings persistence ---------------------------------------------------------

function defaultBackendConfig(kind: string): BackendConfig {
  return {
    enabled: true,
    model: "",
    effort: "",
    system_prompt: "",
    // Grok defaults to "dontAsk"; everyone else bypassPermissions.
    permission_mode: kind === "grok" ? "dontAsk" : "bypassPermissions",
    sandbox: "workspace-write",
    approval: "never",
    network_access: false,
    ephemeral: false,
    auto_approve: true,
    thinking: true,
    forward_images: false,
    extra_args: [],
    base_url: "",
    api_key_env: "DEEPTUTOR_HERMES_REMOTE_API_KEY",
    profile: "",
    idle_timeout_seconds: 600,
  };
}

function coerceBudget(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONSULT_BUDGET;
  return Math.max(CONSULT_BUDGET_MIN, Math.min(CONSULT_BUDGET_MAX, Math.trunc(n)));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function coerceBackend(raw: unknown, kind: string): BackendConfig {
  const base = defaultBackendConfig(kind);
  if (!isRecord(raw)) return base;
  const extra = raw["extra_args"];
  let idle = Number(raw["idle_timeout_seconds"] ?? base.idle_timeout_seconds);
  if (!Number.isFinite(idle)) idle = base.idle_timeout_seconds;
  return {
    enabled: Boolean(raw["enabled"] ?? base.enabled),
    model: String(raw["model"] ?? "").trim(),
    effort: String(raw["effort"] ?? "").trim(),
    system_prompt: String(raw["system_prompt"] ?? ""),
    permission_mode: String(raw["permission_mode"] ?? base.permission_mode),
    sandbox: String(raw["sandbox"] ?? base.sandbox),
    approval: String(raw["approval"] ?? base.approval),
    network_access: Boolean(raw["network_access"] ?? base.network_access),
    ephemeral: Boolean(raw["ephemeral"] ?? base.ephemeral),
    auto_approve: Boolean(raw["auto_approve"] ?? base.auto_approve),
    thinking: Boolean(raw["thinking"] ?? base.thinking),
    forward_images: Boolean(raw["forward_images"] ?? base.forward_images),
    extra_args: Array.isArray(extra) ? extra.map((a) => String(a)) : [],
    base_url: String(raw["base_url"] ?? "").trim(),
    api_key_env: String(raw["api_key_env"] ?? base.api_key_env).trim() || base.api_key_env,
    profile: String(raw["profile"] ?? "").trim(),
    idle_timeout_seconds: Math.max(1, Math.min(86400, Math.trunc(idle))),
  };
}

function backendToDict(kind: string, cfg: BackendConfig): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    enabled: cfg.enabled,
    model: cfg.model,
    effort: cfg.effort,
    system_prompt: cfg.system_prompt,
    permission_mode: cfg.permission_mode,
    sandbox: cfg.sandbox,
    approval: cfg.approval,
    network_access: cfg.network_access,
    ephemeral: cfg.ephemeral,
    auto_approve: cfg.auto_approve,
    thinking: cfg.thinking,
    forward_images: cfg.forward_images,
    extra_args: [...cfg.extra_args],
  };
  if (kind === "hermes_remote") {
    payload["base_url"] = cfg.base_url;
    payload["api_key_env"] = cfg.api_key_env;
    payload["profile"] = cfg.profile;
    payload["idle_timeout_seconds"] = cfg.idle_timeout_seconds;
  }
  return payload;
}

export function settings_to_dict(settings: SubagentSettings): Record<string, unknown> {
  return {
    consult_budget: settings.consult_budget,
    backends: Object.fromEntries(
      Object.entries(settings.backends).map(([kind, cfg]) => [kind, backendToDict(kind, cfg)]),
    ),
  };
}

export function settings_from_dict(raw: unknown): SubagentSettings {
  const obj = isRecord(raw) ? raw : {};
  const backendsRaw = isRecord(obj["backends"]) ? obj["backends"] : {};
  const backends: Record<string, BackendConfig> = {};
  for (const [kind, cfg] of Object.entries(backendsRaw)) {
    backends[String(kind)] = coerceBackend(cfg, String(kind));
  }
  return { consult_budget: coerceBudget(obj["consult_budget"]), backends };
}

export function load_subagent_settings(settings?: Settings): SubagentSettings {
  const s = settings ?? get_settings();
  const raw = database.get_state(s, SETTINGS_KEY, null);
  if (raw === null || raw === undefined) return { consult_budget: DEFAULT_CONSULT_BUDGET, backends: {} };
  return settings_from_dict(raw);
}

export function save_subagent_settings(settingsObj: SubagentSettings, settings?: Settings): void {
  const s = settings ?? get_settings();
  database.put_state(s, SETTINGS_KEY, settings_to_dict(settingsObj));
}

/** Port of SubagentSettings.backend(kind): stored config or kind defaults. */
export function backend_config(settingsObj: SubagentSettings, kind: string): BackendConfig {
  return settingsObj.backends[kind] ?? defaultBackendConfig(kind);
}

// -- connections (pointer KBs) -----------------------------------------------------
// Upstream stores connections as ``type: subagent`` knowledge-base entries via
// the KB manager. The TS kb store keeps arbitrary meta payloads in kb_meta, so
// we write the same shape there (name + type + agent_kind + cwd + ...).

const SUBAGENT_KB_TYPE = "subagent";

function kbConnection(name: string): Record<string, unknown> | null {
  const s = get_settings();
  const conn = database.connect(s);
  try {
    const row = conn
      .prepare("SELECT payload FROM kb_meta WHERE name = ?")
      .get(name) as { payload: string } | undefined;
    if (row === undefined) return null;
    const meta: unknown = JSON.parse(row.payload);
    return meta !== null && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : null;
  } finally {
    conn.close();
  }
}

function saveKbConnection(name: string, meta: Record<string, unknown>): void {
  const s = get_settings();
  const conn = database.connect(s);
  try {
    const stamp = Date.now() / 1000;
    const payload = { ...meta, name, last_updated: stamp };
    conn
      .prepare(
        `INSERT INTO kb_meta (name, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(name, JSON.stringify(payload), stamp);
  } finally {
    conn.close();
  }
}

function deleteKbConnection(name: string): boolean {
  const s = get_settings();
  const conn = database.connect(s);
  try {
    const r = conn.prepare("DELETE FROM kb_meta WHERE name = ?").run(name);
    return Number(r.changes) > 0;
  } finally {
    conn.close();
  }
}

function listKbConnections(): Array<{ name: string; meta: Record<string, unknown> }> {
  const s = get_settings();
  const conn = database.connect(s);
  try {
    const rows = conn.prepare("SELECT name, payload FROM kb_meta ORDER BY name").all() as Array<{
      name: string;
      payload: string;
    }>;
    const out: Array<{ name: string; meta: Record<string, unknown> }> = [];
    for (const row of rows) {
      try {
        const meta: unknown = JSON.parse(row.payload);
        if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
          out.push({ name: row.name, meta: meta as Record<string, unknown> });
        }
      } catch { /* skip malformed */ }
    }
    return out;
  } finally {
    conn.close();
  }
}

export function list_connections(): Array<Record<string, unknown>> {
  const connections: Array<Record<string, unknown>> = [];
  for (const { name, meta } of listKbConnections()) {
    if (meta["type"] !== SUBAGENT_KB_TYPE) continue;
    if (meta["agent_kind"] === "partner") continue;
    connections.push({
      name,
      agent_kind: meta["agent_kind"] ?? "",
      cwd: meta["cwd"] ?? "",
      partner_id: meta["partner_id"] ?? "",
      description: meta["description"] ?? "",
      created_at: meta["created_at"] ?? null,
      updated_at: meta["updated_at"] ?? null,
    });
  }
  return connections;
}

export function get_connection(name: string): Record<string, unknown> | null {
  const meta = kbConnection(name);
  if (meta === null || meta["type"] !== SUBAGENT_KB_TYPE) return null;
  return { name, ...meta };
}

/** Name validation mirrors the Python manager's register_subagent_connection. */
const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function create_connection(
  name: string,
  agent_kind: string,
  cwd = "",
): Record<string, unknown> {
  const safe = name.trim();
  if (!safe || !SAFE_NAME_RE.test(safe)) {
    throw new Error("Connection name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$");
  }
  if (agent_kind === "partner" || get_backend(agent_kind) === null) {
    throw new Error(`Unknown agent kind: ${agent_kind}`);
  }
  if (kbConnection(safe) !== null) {
    throw new Error(`A knowledge base named ${safe} already exists`);
  }
  const now = Date.now() / 1000;
  const meta: Record<string, unknown> = {
    type: SUBAGENT_KB_TYPE,
    name: safe,
    agent_kind,
    cwd: cwd.trim(),
    description: "",
    created_at: now,
    updated_at: now,
    partner_id: "",
  };
  saveKbConnection(safe, meta);
  return { status: "connected", name: safe, agent_kind, cwd: meta["cwd"], partner_id: "" };
}

export function delete_connection(name: string): boolean {
  return deleteKbConnection(name);
}
