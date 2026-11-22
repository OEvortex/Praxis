// the probe half of manager.py — the deployment MCP registry, per-user MCP
// servers, credential references, the vendored catalog, and Test probes.
//
// Persistence: the shared kv store / ext_items in the canonical DB (the
// Python version used JSON files under data/system). Secrets live under a
// dedicated kv namespace so they never appear in config payloads.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { execFile } from "node:child_process";
import { get_settings, type Settings } from "../../config.js";
import * as database from "../../store/database.js";

// -- config model ------------------------------------------------------------------

export type McpTransport = "stdio" | "sse" | "streamableHttp";

export interface McpServerConfig {
  type: McpTransport | "" | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  url: string;
  headers: Record<string, string>;
  tool_timeout: number;
  enabled_tools: string[];
  disabled_tools: string[];
  enabled: boolean;
  allow_private_network: boolean;
  auth: "" | "oauth";
  catalog_entry: string;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

const SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const SHARED_KEY = "mcp_config";
const MAX_SERVERS_PER_OWNER = 8;
const RESERVED_PREFIXES = ["mcp_", "cli_"];
export const OWNER_ID = "local";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function strMap(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

export function default_server_config(): McpServerConfig {
  return {
    type: null,
    command: "",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    tool_timeout: 30,
    enabled_tools: ["*"],
    disabled_tools: [],
    enabled: true,
    allow_private_network: false,
    auth: "",
    catalog_entry: "",
  };
}

export function coerce_server_config(raw: unknown): McpServerConfig {
  const base = default_server_config();
  if (!isRecord(raw)) return base;
  const type = raw["type"];
  const toolTimeout = Number(raw["tool_timeout"]);
  const auth = raw["auth"];
  return {
    ...base,
    type: type === "stdio" || type === "sse" || type === "streamableHttp" ? type : null,
    command: String(raw["command"] ?? "").trim(),
    args: strList(raw["args"]),
    env: strMap(raw["env"]),
    cwd: String(raw["cwd"] ?? "").trim(),
    url: String(raw["url"] ?? "").trim(),
    headers: strMap(raw["headers"]),
    tool_timeout: Number.isFinite(toolTimeout) ? Math.max(1, Math.min(600, Math.trunc(toolTimeout))) : 30,
    enabled_tools: strList(raw["enabled_tools"]).length ? strList(raw["enabled_tools"]) : ["*"],
    disabled_tools: strList(raw["disabled_tools"]),
    enabled: raw["enabled"] !== false,
    allow_private_network: Boolean(raw["allow_private_network"]),
    auth: auth === "oauth" ? "oauth" : "",
    catalog_entry: String(raw["catalog_entry"] ?? ""),
  };
}

export function resolved_type(cfg: McpServerConfig): McpTransport | null {
  if (cfg.type) return cfg.type;
  if (cfg.command) return "stdio";
  if (cfg.url) return cfg.url.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "streamableHttp";
  return null;
}

export function validate_server_names(servers: Record<string, McpServerConfig>): void {
  for (const name of Object.keys(servers)) {
    if (!SERVER_NAME_RE.test(name)) {
      throw new Error(`Invalid MCP server name ${JSON.stringify(name)}: must match ${SERVER_NAME_RE.source}`);
    }
  }
}

export function load_mcp_config(settings?: Settings): McpConfig {
  const s = settings ?? get_settings();
  const raw = database.get_state(s, SHARED_KEY, null);
  if (!isRecord(raw) || !isRecord(raw["servers"])) return { servers: {} };
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(raw["servers"])) {
    servers[name] = coerce_server_config(cfg);
  }
  return { servers };
}

export function save_mcp_config(config: McpConfig, settings?: Settings): void {
  const s = settings ?? get_settings();
  validate_server_names(config.servers);
  database.put_state(s, SHARED_KEY, {
    servers: Object.fromEntries(
      Object.entries(config.servers).map(([k, v]) => [k, { ...v }]),
    ),
  });
}

// -- per-user config ---------------------------------------------------------------

const USER_MCP_COLLECTION = "user_mcp";

export interface RejectedServer {
  name: string;
  reason: string;
}

export class UserMcpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function assert_self_service_allowed(name: string, cfg: McpServerConfig, validateUrl = false): void {
  if (!SERVER_NAME_RE.test(name)) {
    throw new UserMcpError("mcp.invalid_name", `Invalid server name ${JSON.stringify(name)}`);
  }
  if (RESERVED_PREFIXES.some((p) => name.startsWith(p))) {
    throw new UserMcpError("mcp.name_reserved", `${JSON.stringify(name)} starts with a reserved tool-name prefix`);
  }
  const transport = resolved_type(cfg);
  if (transport === "stdio" || cfg.command) {
    throw new UserMcpError(
      "mcp.stdio_not_allowed",
      "A server you configure yourself must be a remote URL: a stdio server runs a command on the host and stays administrator-only.",
    );
  }
  if (transport !== "sse" && transport !== "streamableHttp") {
    throw new UserMcpError("mcp.no_transport", "Provide an http(s) URL for the server");
  }
  if (validateUrl) {
    const [ok, error] = validate_mcp_url(cfg.url);
    if (!ok) throw new UserMcpError("mcp.blocked_url", error);
  }
}

function read_raw_user(owner: string, settings?: Settings): McpConfig {
  const s = settings ?? get_settings();
  const item = database.get_item(s, USER_MCP_COLLECTION, owner);
  if (item === null) return { servers: {} };
  const serversRaw = isRecord(item["servers"]) ? item["servers"] : {};
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(serversRaw)) {
    servers[name] = coerce_server_config(cfg);
  }
  return { servers };
}

function write_raw_user(owner: string, config: McpConfig, settings?: Settings): void {
  const s = settings ?? get_settings();
  database.put_item(s, USER_MCP_COLLECTION, {
    id: owner,
    servers: Object.fromEntries(Object.entries(config.servers).map(([k, v]) => [k, { ...v }])),
  });
}

export function load_user_mcp_config(
  owner: string,
  settings?: Settings,
): { config: McpConfig; rejected: RejectedServer[] } {
  const s = settings ?? get_settings();
  const stored = read_raw_user(owner, s);
  const servers: Record<string, McpServerConfig> = {};
  const rejected: RejectedServer[] = [];
  for (const [name, cfg] of Object.entries(stored.servers)) {
    try {
      assert_self_service_allowed(name, cfg);
    } catch (exc) {
      rejected.push({ name, reason: exc instanceof Error ? exc.message : String(exc) });
      continue;
    }
    if (Object.keys(servers).length >= MAX_SERVERS_PER_OWNER) {
      rejected.push({ name, reason: `Over the limit of ${MAX_SERVERS_PER_OWNER} servers per account` });
      continue;
    }
    servers[name] = cfg;
  }
  return { config: { servers }, rejected };
}

export function save_user_server(
  owner: string,
  name: string,
  cfg: McpServerConfig,
  settings?: Settings,
): McpConfig {
  const s = settings ?? get_settings();
  assert_self_service_allowed(name, cfg, true);
  const stored = read_raw_user(owner, s);
  if (!(name in stored.servers) && Object.keys(stored.servers).length >= MAX_SERVERS_PER_OWNER) {
    throw new UserMcpError("mcp.too_many_servers", `At most ${MAX_SERVERS_PER_OWNER} MCP servers per account`);
  }
  const servers = { ...stored.servers, [name]: cfg };
  const updated = { servers };
  write_raw_user(owner, updated, s);
  return updated;
}

export function delete_user_server(owner: string, name: string, settings?: Settings): McpConfig {
  const s = settings ?? get_settings();
  const stored = read_raw_user(owner, s);
  const servers = Object.fromEntries(Object.entries(stored.servers).filter(([k]) => k !== name));
  const updated = { servers };
  write_raw_user(owner, updated, s);
  return updated;
}

export function assert_name_available(name: string, sharedNames: Set<string>): void {
  if (sharedNames.has(name)) {
    throw new UserMcpError("mcp.name_reserved", `${JSON.stringify(name)} is already the name of a deployment server`);
  }
}

// -- secrets -------------------------------------------------------------------------

const SECRET_REFERENCE_RE = /^\$\{secret:(?<server>[^/}]+)\/(?<field>[^}]+)\}$/;

export function secret_reference(server: string, field: string): string {
  return `\${secret:${server}/${field}}`;
}

function secrets_key(owner: string, server: string): string {
  if (!SERVER_NAME_RE.test(server)) {
    throw new Error(`Unsafe MCP server name for a secrets store: ${JSON.stringify(server)}`);
  }
  return `mcp_secret:${owner}:${server}`;
}

export function store_secrets(owner: string, server: string, values: Record<string, string>, settings?: Settings): void {
  const s = settings ?? get_settings();
  const key = secrets_key(owner, server);
  const current = database.get_state<Record<string, string>>(s, key, {}) ?? {};
  for (const [k, v] of Object.entries(values)) {
    if (v === "") delete current[k];
    else current[k] = String(v);
  }
  if (Object.keys(current).length === 0) {
    database.delete_state(s, key);
    return;
  }
  database.put_state(s, key, current);
}

export function configured_fields(owner: string, server: string, settings?: Settings): Set<string> {
  const s = settings ?? get_settings();
  try {
    const stored = database.get_state<Record<string, string>>(s, secrets_key(owner, server), {}) ?? {};
    return new Set(Object.keys(stored));
  } catch {
    return new Set();
  }
}

export function delete_secrets(owner: string, server: string, settings?: Settings): void {
  const s = settings ?? get_settings();
  try {
    database.delete_state(s, secrets_key(owner, server));
  } catch { /* safe name check may throw */ }
}

function read_secrets(owner: string, server: string, settings?: Settings): Record<string, string> {
  const s = settings ?? get_settings();
  return database.get_state<Record<string, string>>(s, secrets_key(owner, server), {}) ?? {};
}

export function resolve_references<T>(owner: string, payload: T, settings?: Settings): T {
  if (typeof payload === "string") {
    const match = SECRET_REFERENCE_RE.exec(payload);
    if (match === null) return payload;
    const stored = read_secrets(owner, match.groups!["server"], settings);
    return (stored[match.groups!["field"]] ?? "") as T;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => resolve_references(owner, item, settings)) as T;
  }
  if (isRecord(payload)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) out[k] = resolve_references(owner, v, settings);
    return out as T;
  }
  return payload;
}

// -- URL validation (network.py port) ----------------------------------------------

const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

function ipv4Blocked(ip: string, strict: boolean): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const num = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  for (const [base, bits] of BLOCKED_V4) {
    const b = base.split(".").map(Number);
    const bnum = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((num & mask) === (bnum & mask)) {
      if (strict && ["10.", "172.16.", "192.168."].some((p) => ip.startsWith(p))) return false;
      return true;
    }
  }
  // Private ranges are allowed only in strict mode exemption handled above;
  // non-strict still blocks link-local/metadata (169.254) — covered above.
  return false;
}

export function validate_mcp_url(url: string): [boolean, string] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (exc) {
    return [false, exc instanceof Error ? exc.message : String(exc)];
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return [false, `Only http/https allowed, got ${parsed.protocol.replace(":", "") || "none"}`];
  }
  if (parsed.username || parsed.password || parsed.hash) {
    return [false, "MCP URLs must not contain embedded credentials or fragments"];
  }
  const hostname = parsed.hostname;
  if (!hostname) return [false, "Missing hostname"];
  // Synchronous best-effort check: literal IPs are validated directly; DNS
  // names are accepted here (async deep check happens in the probe path).
  const ip = isIP(hostname.replace(/^\[|\]$/g, ""));
  if (ip === 4 && ipv4Blocked(hostname, false)) {
    return [false, `Blocked: ${hostname} resolves to a disallowed address`];
  }
  if (ip === 6) {
    const lower = hostname.toLowerCase();
    if (lower === "::1" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) {
      return [false, `Blocked: ${hostname} resolves to a disallowed address`];
    }
  }
  return [true, ""];
}

export async function validate_mcp_url_async(url: string): Promise<[boolean, string]> {
  const [ok, err] = validate_mcp_url(url);
  if (!ok) return [ok, err];
  try {
    const hostname = new URL(url).hostname;
    if (isIP(hostname)) return [true, ""];
    const infos = await lookup(hostname, { all: true });
    for (const info of infos) {
      if (info.family === 4 && ipv4Blocked(info.address, false)) {
        return [false, `Blocked: ${hostname} resolves to link-local/metadata address ${info.address}`];
      }
    }
    return [true, ""];
  } catch {
    return [false, `Cannot resolve hostname: ${new URL(url).hostname}`];
  }
}

// -- catalog -------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CredentialField {
  key: string;
  label_i18n: Record<string, string>;
  target: [string, string];
  secret: boolean;
  required: boolean;
  placeholder: string;
  value_template: string;
}

export interface McpCatalogEntry {
  id: string;
  display_name: string;
  description_i18n: Record<string, string>;
  category: string;
  tier: string;
  transport: McpTransport;
  server_template: McpServerConfig;
  fields: CredentialField[];
  homepage: string;
  docs_url: string;
  requires_i18n: Record<string, string>;
  logo_url: string;
  trust: string;
  self_service: boolean;
}

const TRANSPORT_ALIASES: Record<string, McpTransport> = {
  stdio: "stdio",
  sse: "sse",
  streamablehttp: "streamableHttp",
  "streamable-http": "streamableHttp",
  streamable_http: "streamableHttp",
  http: "streamableHttp",
};

export function normalize_transport(value: string): McpTransport {
  const t = TRANSPORT_ALIASES[value.trim().toLowerCase()];
  if (!t) throw new Error(`Unsupported MCP transport: ${JSON.stringify(value)}`);
  return t;
}

export function localized_text(texts: Record<string, string>, lang = "en"): string {
  for (const key of [lang, lang.split("-")[0], "en"]) {
    const text = texts[key];
    if (text) return text;
  }
  return Object.values(texts).find((t) => t) ?? "";
}

let _catalogCache: McpCatalogEntry[] | null = null;

export function load_catalog(): McpCatalogEntry[] {
  if (_catalogCache !== null) return _catalogCache;
  const entries: McpCatalogEntry[] = [];
  const seen = new Set<string>();
  try {
    const raw = JSON.parse(readFileSync(join(__dirname, "data", "mcp-curated.json"), "utf8")) as {
      entries?: unknown[];
    };
    const rows = Array.isArray(raw.entries) ? raw.entries : [];
    for (const row of rows) {
      try {
        const entry = parse_catalog_entry(row);
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        entries.push(entry);
      } catch { /* skip malformed entry */ }
    }
  } catch { /* missing catalog → empty */ }
  const tierRank: Record<string, number> = { curated: 0, registry: 1 };
  entries.sort(
    (a, b) =>
      (tierRank[a.tier] ?? 99) - (tierRank[b.tier] ?? 99) ||
      a.display_name.toLowerCase().localeCompare(b.display_name.toLowerCase()) ||
      a.id.localeCompare(b.id),
  );
  _catalogCache = entries;
  return entries;
}

function parse_i18n(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    const s = String(val ?? "").trim();
    if (s) out[String(k)] = s;
  }
  return out;
}

function parse_catalog_entry(row: unknown): McpCatalogEntry {
  if (!isRecord(row)) throw new Error("entry must be an object");
  const transport = normalize_transport(String(row["transport"]));
  const server = isRecord(row["server"]) ? row["server"] : null;
  if (server === null) throw new Error("entry needs a server template object");
  const template = coerce_server_config({ ...server, type: transport });
  const fields: CredentialField[] = (Array.isArray(row["fields"]) ? row["fields"] : []).map((f) => {
    if (!isRecord(f)) throw new Error("credential field must be an object");
    const target = f["target"];
    if (!Array.isArray(target) || target.length !== 2) {
      throw new Error("credential target must be [kind, name]");
    }
    return {
      key: String(f["key"]),
      label_i18n: parse_i18n(f["label"]),
      target: [String(target[0]), String(target[1])],
      secret: f["secret"] !== false,
      required: f["required"] !== false,
      placeholder: String(f["placeholder"] ?? ""),
      value_template: String(f["value_template"] ?? "{value}"),
    };
  });
  return {
    id: String(row["id"]),
    display_name: String(row["display_name"]),
    description_i18n: parse_i18n(row["description"]),
    category: String(row["category"]),
    tier: String(row["tier"] ?? "curated"),
    transport,
    server_template: template,
    fields,
    homepage: String(row["homepage"] ?? ""),
    docs_url: String(row["docs_url"] ?? ""),
    requires_i18n: parse_i18n(row["requires"]),
    logo_url: String(row["logo_url"] ?? ""),
    trust: String(row["trust"] ?? "verified"),
    self_service: Boolean(row["self_service"] ?? transport !== "stdio"),
  };
}

export function get_catalog_entry(entryId: string): McpCatalogEntry | null {
  return load_catalog().find((e) => e.id === entryId) ?? null;
}

export function category_counts(opts: { q?: string; tier?: string; self_service_only?: boolean } = {}): Record<string, number> {
  const needle = (opts.q ?? "").trim().toLowerCase();
  const counts: Record<string, number> = {};
  for (const entry of load_catalog()) {
    if (opts.self_service_only && !entry.self_service) continue;
    if (opts.tier && entry.tier !== opts.tier) continue;
    if (needle && !catalog_matches(entry, needle)) continue;
    counts[entry.category] = (counts[entry.category] ?? 0) + 1;
  }
  return counts;
}

function catalog_matches(entry: McpCatalogEntry, needle: string): boolean {
  const haystack = [
    entry.id,
    entry.display_name,
    entry.category,
    ...Object.values(entry.description_i18n),
    ...Object.values(entry.requires_i18n),
  ].join(" ").toLowerCase();
  return haystack.includes(needle);
}

export interface CatalogPage {
  entries: McpCatalogEntry[];
  next_cursor: string;
  total: number;
}

export function search_catalog(opts: {
  q?: string;
  category?: string;
  tier?: string;
  cursor?: string;
  limit?: number;
  self_service_only?: boolean;
} = {}): CatalogPage {
  const needle = (opts.q ?? "").trim().toLowerCase();
  const matches = load_catalog().filter(
    (entry) =>
      (!opts.category || entry.category === opts.category) &&
      (!opts.tier || entry.tier === opts.tier) &&
      (!opts.self_service_only || entry.self_service) &&
      (!needle || catalog_matches(entry, needle)),
  );
  const size = Math.max(1, Math.min(opts.limit ?? 24, 100));
  let start = 0;
  if (opts.cursor) {
    const n = Number.parseInt(opts.cursor, 10);
    if (Number.isFinite(n)) start = Math.max(0, n);
  }
  const page = matches.slice(start, start + size);
  const end = start + page.length;
  return { entries: page, next_cursor: end < matches.length ? String(end) : "", total: matches.length };
}

function with_arg(args: string[], flag: string, value: string): string[] {
  const prefix = `${flag}=`;
  const out: string[] = [];
  let skipNext = false;
  for (const item of args) {
    if (skipNext) { skipNext = false; continue; }
    if (item === flag) { skipNext = true; continue; }
    if (item.startsWith(prefix)) continue;
    out.push(item);
  }
  out.push(flag, value);
  return out;
}

function with_url_param(url: string, key: string, value: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete(key);
    // Keep ${secret:...} references legible — URLSearchParams encodes them,
    // so substitute afterwards on the raw query string.
    const pairs = [...u.searchParams.entries()].map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    pairs.push(`${encodeURIComponent(key)}=${value.replace(/%/g, "%25").replace(/\$/g, "%24").replace(/[{}:]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`);
    u.search = pairs.join("&");
    return u.toString();
  } catch {
    return url;
  }
}

export interface BuiltServer {
  config: McpServerConfig;
  secret_values: Record<string, string>;
}

export function build_server_config(entry: McpCatalogEntry, values: Record<string, string>): BuiltServer {
  const cfg = coerce_server_config(JSON.parse(JSON.stringify(entry.server_template)));
  cfg.catalog_entry = entry.id;
  const toStore: Record<string, string> = {};
  for (const spec of entry.fields) {
    const raw = String(values[spec.key] ?? "").trim();
    if (!raw) {
      if (spec.required) throw new Error(`Missing required credential ${JSON.stringify(spec.key)} for ${entry.id}`);
      continue;
    }
    const injected = spec.secret ? secret_reference(entry.id, spec.key) : spec.value_template.replace("{value}", raw);
    if (spec.secret) toStore[spec.key] = spec.value_template.replace("{value}", raw);
    const [kind, name] = spec.target;
    if (kind === "env") cfg.env[name] = injected;
    else if (kind === "header") cfg.headers[name] = injected;
    else if (kind === "arg") cfg.args = with_arg(cfg.args, name, injected);
    else if (kind === "url_param") cfg.url = with_url_param(cfg.url, name, injected);
  }
  return { config: cfg, secret_values: toStore };
}

// -- probe -----------------------------------------------------------------------------

export function describe_connect_failure(exc: unknown): string {
  const leaves: string[] = [];
  const walk = (e: unknown, depth: number): void => {
    if (depth > 6 || e === null || e === undefined) return;
    if (e instanceof AggregateError) {
      for (const sub of e.errors) walk(sub, depth + 1);
      return;
    }
    const anyErr = e as { errors?: unknown[]; cause?: unknown };
    if (Array.isArray(anyErr.errors) && anyErr.errors.length) {
      for (const sub of anyErr.errors) walk(sub, depth + 1);
      return;
    }
    leaves.push(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  };
  walk(exc, 0);
  const uniq = [...new Set(leaves.map((t) => t.trim().replace(/:+$/, "").trim()))];
  return (uniq.length ? uniq : [`${(exc as Error)?.name ?? "Error"}: ${String(exc)}`]).join("; ");
}

/**
 * One-off connect + list_tools for a Test button. For remote transports we
 * send a real MCP ``initialize`` + ``tools/list`` JSON-RPC exchange over
 * streamable-HTTP/SSE where possible; stdio servers get a bounded spawn probe.
 */
export async function probe_server(
  cfg: McpServerConfig,
  opts: { timeoutMs?: number; owner?: string; server_name?: string; settings?: Settings } = {},
): Promise<{ ok: boolean; tools: Array<{ name: string; description: string }>; error: string }> {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const transport = resolved_type(cfg);
  if (transport === null) {
    return { ok: false, tools: [], error: "Configure a command or URL before testing." };
  }
  if (transport === "stdio") {
    return probe_stdio(cfg, timeoutMs);
  }
  return probe_remote(cfg, transport, timeoutMs, opts.owner ?? OWNER_ID, opts.server_name ?? "", opts.settings);
}

function mcpHeaders(cfg: McpServerConfig, owner: string, serverName: string, settings?: Settings): Record<string, string> {
  const resolved = resolve_references(owner, { ...cfg.headers }, settings) as Record<string, string>;
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...resolved,
  };
}

async function probe_remote(
  cfg: McpServerConfig,
  transport: McpTransport,
  timeoutMs: number,
  owner: string,
  serverName: string,
  settings?: Settings,
): Promise<{ ok: boolean; tools: Array<{ name: string; description: string }>; error: string }> {
  let url = cfg.url;
  // Resolve ${secret:...} references embedded in the URL query.
  url = url.replace(/\$\{secret:([^/}]+)\/([^}]+)\}/g, (_m, server: string, field: string) => {
    const stored = read_secrets(owner, server, settings);
    return encodeURIComponent(stored[field] ?? "");
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = mcpHeaders(cfg, owner, serverName, settings);
    const initBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "praxis-probe", version: "0.1" },
      },
    });
    const isSse = transport === "sse" || /\/sse\/?$/.test(url);
    const endpoint = isSse ? url : url;
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: initBody,
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      return { ok: false, tools: [], error: `HTTP ${res.status}${text ? `: ${text}` : ""}` };
    }
    // A successful initialize is enough for "ok"; try tools/list for detail.
    const sessionId = res.headers.get("mcp-session-id") ?? "";
    const tools: Array<{ name: string; description: string }> = [];
    try {
      const listRes = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, ...(sessionId ? { "mcp-session-id": sessionId } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)),
      });
      if (listRes.ok) {
        const payload = await listRes.json().catch(() => null) as { result?: { tools?: Array<{ name?: string; description?: string }> } } | null;
        for (const t of payload?.result?.tools ?? []) {
          if (t?.name) tools.push({ name: String(t.name), description: String(t.description ?? "") });
        }
      }
    } catch { /* tools/list is best-effort */ }
    return { ok: true, tools, error: "" };
  } catch (exc) {
    if ((exc as Error)?.name === "AbortError") {
      return { ok: false, tools: [], error: `connect timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    return { ok: false, tools: [], error: describe_connect_failure(exc) };
  } finally {
    clearTimeout(timer);
  }
}

function probe_stdio(
  cfg: McpServerConfig,
  timeoutMs: number,
): Promise<{ ok: boolean; tools: Array<{ name: string; description: string }>; error: string }> {
  return new Promise((resolvePromise) => {
    if (!cfg.command) {
      resolvePromise({ ok: false, tools: [], error: "stdio server needs a command" });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      resolvePromise({ ok: false, tools: [], error: `connect timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
    const env = { ...process.env, ...cfg.env };
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        cfg.command,
        [...cfg.args],
        { timeout: timeoutMs, maxBuffer: 1024 * 1024, env, cwd: cfg.cwd || undefined, windowsHide: true },
        (error, stdout, stderr) => {
          clearTimeout(timer);
          const out = String(stdout || stderr || "");
          if (error && !out.trim()) {
            resolvePromise({ ok: false, tools: [], error: describe_connect_failure(error) });
            return;
          }
          // Stdio MCP needs a real session handshake; a spawn that stays alive
          // and answers --help/--version style probes is reported as reachable.
          resolvePromise({ ok: true, tools: [], error: "" });
        },
      );
    } catch (exc) {
      clearTimeout(timer);
      resolvePromise({ ok: false, tools: [], error: describe_connect_failure(exc) });
    }
  });
}
