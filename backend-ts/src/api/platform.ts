// Port of the remaining upstream routers: plugins.py, mcp_settings.py,
// skills.py, space_cli_apps.py, space_mcp.py, capabilities_settings.py,
// tools.py, agent_config.py.
//
// Wire-up: mount BEFORE handlersRouter — its /api/settings/* catch-all and
// stub routes would otherwise shadow these.

import { Hono } from "hono";
import type { Context } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";

import { get_settings, type Settings } from "../config.js";
import * as misc from "../services/platform/misc.js";
import * as mcp from "../services/platform/mcp.js";
import { SkillService, SkillError, get_skill_service } from "../services/platform/skills.js";

export const platformRouter = new Hono();

function httpError(c: Context, status: number, detail: unknown) {
  return c.json({ detail }, status as never);
}

async function body(c: Context): Promise<Record<string, any>> {
  try {
    const data: unknown = await c.req.json();
    return data !== null && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

function qStr(c: Context, name: string, fallback = ""): string {
  return c.req.query(name) ?? fallback;
}
function qInt(c: Context, name: string, fallback: number): number {
  const n = Number.parseInt(c.req.query(name) ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}
function isRecord(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ==========================================================================
// agent_config.py — GET /api/agents, /api/agents/{type}
// ==========================================================================

platformRouter.get("/api/agents", (c) => c.json(misc.AGENT_REGISTRY));
platformRouter.get("/api/agents/:agent_type", (c) => {
  const t = c.req.param("agent_type");
  const entry = misc.AGENT_REGISTRY[t];
  if (!entry) return c.json({ error: `Agent type '${t}' not found` });
  return c.json(entry);
});

// ==========================================================================
// capabilities_settings.py — GET/PUT /api/capabilities/settings
// ==========================================================================
// GET /api/capabilities/registered deliberately lives in handlers.ts: it
// serves the chat + tutor-mode descriptors the Mode tray is built from. This
// router must not shadow it with a different capability ID set.

platformRouter.get("/api/capabilities/settings", (c) => {
  return c.json(misc.capabilities_settings_dict());
});

platformRouter.put("/api/capabilities/settings", async (c) => {
  const b = await body(c);
  return c.json(misc.save_capabilities_settings(b));
});

// ==========================================================================
// tools.py — GET /api/tools (full builtin tool listing)
// ==========================================================================

platformRouter.get("/api/tools", async (c) => {
  // Enumerate the real builtin tools registered by the agent runtime.
  const { builtinTools } = await import("../services/platform/tools.js");
  const enabledOptional = new Set(misc.get_enabled_optional_tools());
  const tools = builtinTools().map((t) => {
    const toggleable = misc.USER_TOGGLEABLE_TOOLS.has(t.name);
    const comingSoon = Boolean(t.coming_soon);
    let enabled = comingSoon ? false : toggleable ? enabledOptional.has(t.name) : true;
    return {
      name: t.name,
      description: t.description,
      description_i18n: {},
      parameters: t.parameters ?? [],
      hints: { en: t.hints ?? {} },
      aliases: t.aliases ?? [],
      toggleable,
      enabled,
      coming_soon: comingSoon,
      capability: t.capability ?? null,
      available: t.available !== false,
      unavailable_reason: t.unavailable_reason ?? null,
    };
  });
  return c.json({ tools, enabled_optional_tools: [...enabledOptional].sort() });
});

// ==========================================================================
// mcp_settings.py — /api/settings/mcp (deployment-global registry)
// ==========================================================================

function validateServers(config: mcp.McpConfig): void {
  for (const [name, cfg] of Object.entries(config.servers)) {
    const transport = mcp.resolved_type(cfg);
    if (transport === null) {
      throw new Error(`Server ${name} needs a command or url`);
    }
    if (transport === "sse" || transport === "streamableHttp") {
      const [ok, error] = mcp.validate_mcp_url(cfg.url);
      if (!ok) throw new Error(`${name}: ${error}`);
    }
  }
}

function mcpStatus(): Record<string, unknown> {
  // No live connection manager in the TS port; report configured state.
  const config = mcp.load_mcp_config();
  const servers: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(config.servers)) {
    servers[name] = {
      transport: mcp.resolved_type(cfg),
      enabled: cfg.enabled !== false,
      tools: 0,
      status: cfg.enabled === false ? "disabled" : "configured",
    };
  }
  return { servers };
}

platformRouter.get("/api/settings/mcp", async (c) => {
  const config = mcp.load_mcp_config();
  return c.json({
    servers: config.servers,
    status: mcpStatus(),
  });
});

platformRouter.put("/api/settings/mcp", async (c) => {
  const b = await body(c);
  const serversRaw = isRecord(b["servers"]) ? b["servers"] : {};
  const servers: Record<string, mcp.McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(serversRaw)) {
    servers[name] = mcp.coerce_server_config(cfg);
  }
  const config = { servers };
  try {
    mcp.validate_server_names(servers);
    validateServers(config);
  } catch (exc) {
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  }
  mcp.save_mcp_config(config);
  return c.json({ status: mcpStatus() });
});

platformRouter.put("/api/settings/mcp/servers/:name", async (c) => {
  const name = c.req.param("name") ?? "";
  const b = await body(c);
  const cfg = mcp.coerce_server_config(b);
  const config = mcp.load_mcp_config();
  const servers = { ...config.servers, [name]: cfg };
  try {
    mcp.validate_server_names(servers);
    validateServers({ servers: { [name]: cfg } });
  } catch (exc) {
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  }
  const updated = { servers };
  mcp.save_mcp_config(updated);
  return c.json({ servers: updated.servers, status: mcpStatus() });
});

platformRouter.delete("/api/settings/mcp/servers/:name", (c) => {
  const name = c.req.param("name") ?? "";
  const config = mcp.load_mcp_config();
  const servers = Object.fromEntries(Object.entries(config.servers).filter(([k]) => k !== name));
  const updated = { servers };
  mcp.save_mcp_config(updated);
  return c.json({ servers: updated.servers, status: mcpStatus() });
});

platformRouter.post("/api/settings/mcp/test", async (c) => {
  const b = await body(c);
  const cfg = mcp.coerce_server_config(b);
  const transport = mcp.resolved_type(cfg);
  if (transport === null) {
    return httpError(c, 400, "Configure a command or URL before testing.");
  }
  if (transport === "sse" || transport === "streamableHttp") {
    const [ok, error] = await mcp.validate_mcp_url_async(cfg.url);
    if (!ok) return httpError(c, 400, error);
  }
  const result = await mcp.probe_server(cfg);
  return c.json(result);
});

// ==========================================================================
// skills.py — /api/skills
// ==========================================================================

function skillErrorStatus(exc: unknown): number {
  if (exc instanceof SkillError) {
    switch (exc.code) {
      case "not_found": return 404;
      case "exists": case "tag_exists": return 409;
      case "read_only": return 403;
      case "invalid_name": case "invalid_tag": case "invalid_path": case "file_not_found": return 400;
      default: return 400;
    }
  }
  return 500;
}

platformRouter.get("/api/skills/tags/list", (c) => {
  return c.json({ tags: get_skill_service().list_tags() });
});

platformRouter.post("/api/skills/tags/create", async (c) => {
  const b = await body(c);
  try {
    const tag = get_skill_service().create_tag(String(b["name"] ?? ""));
    return c.json({ name: tag });
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.put("/api/skills/tags/:tag", async (c) => {
  const b = await body(c);
  try {
    const tag = get_skill_service().rename_tag(c.req.param("tag") ?? "", String(b["rename_to"] ?? ""));
    return c.json({ name: tag });
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.delete("/api/skills/tags/:tag", (c) => {
  const tag = c.req.param("tag") ?? "";
  try {
    get_skill_service().delete_tag(tag);
    return c.json({ status: "deleted", name: tag });
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.get("/api/skills/list", (c) => {
  return c.json({ skills: get_skill_service().list_skills() });
});

// Hub browse — proxy the ClawHub-shaped provider (eduhub/clawhub).
platformRouter.get("/api/skills/hub/catalog", async (c) => {
  const hub = qStr(c, "hub", "eduhub");
  const q = qStr(c, "q");
  const limit = Math.min(Math.max(qInt(c, "limit", 50), 1), 100);
  const base = hub === "eduhub" ? "https://eduhub.deeptutor.info/api/v1" : "https://clawhub.ai/api/v1";
  const webOrigin = base.replace(/\/api\/.*$/, "");
  try {
    const url = q.trim()
      ? `${base}/search?q=${encodeURIComponent(q)}&limit=${limit}`
      : `${base}/skills?limit=${limit}&sort=createdAt`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return httpError(c, 502, `${hub}: HTTP ${res.status}`);
    const payload = (await res.json()) as unknown;
    const rows = Array.isArray(payload)
      ? payload
      : isRecord(payload)
        ? (payload["results"] ?? payload["skills"] ?? payload["items"] ?? [])
        : [];
    const skills = (Array.isArray(rows) ? rows : [])
      .filter(isRecord)
      .map((row) => ({
        slug: String(row["slug"] ?? ""),
        name: String(row["displayName"] ?? row["name"] ?? row["slug"] ?? ""),
        summary: String(row["summary"] ?? row["description"] ?? ""),
        version: String(row["version"] ?? ""),
        downloads: Number(row["downloads"] ?? row["downloadCount"] ?? 0) || 0,
        stars: Number(row["stars"] ?? row["starCount"] ?? 0) || 0,
        owner: String(row["owner"] ?? ""),
      }))
      .filter((s) => s.slug || s.name);
    return c.json({ hub, web_url: webOrigin, skills });
  } catch (exc) {
    return httpError(c, 502, exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.get("/api/skills/hub/detail", async (c) => {
  const slug = qStr(c, "slug");
  const hub = qStr(c, "hub", "eduhub");
  if (!slug) return httpError(c, 400, "slug is required");
  const base = hub === "eduhub" ? "https://eduhub.deeptutor.info/api/v1" : "https://clawhub.ai/api/v1";
  const webOrigin = base.replace(/\/api\/.*$/, "");
  try {
    const res = await fetch(`${base}/skills/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return httpError(c, 502, `${hub}: HTTP ${res.status}`);
    const payload = (await res.json()) as Record<string, any>;
    const skill = isRecord(payload["skill"]) ? payload["skill"] : payload;
    const dist = isRecord(payload["distTags"]) ? payload["distTags"] : {};
    const keywords = Array.isArray(skill["keywords"]) ? skill["keywords"] : Array.isArray(skill["tags"]) ? skill["tags"] : [];
    return c.json({
      slug,
      name: String(skill["displayName"] ?? skill["name"] ?? slug),
      summary: String(skill["summary"] ?? ""),
      version: String(dist["latest"] ?? skill["version"] ?? ""),
      content: String(skill["description"] ?? ""),
      tags: keywords.map(String),
      web_url: `${webOrigin}/skills/${slug}`,
    });
  } catch (exc) {
    return httpError(c, 502, exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.get("/api/skills/:name", (c) => {
  const name = c.req.param("name") ?? "";
  try {
    return c.json(get_skill_service().get_detail(name));
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.post("/api/skills/create", async (c) => {
  const b = await body(c);
  try {
    const info = get_skill_service().create(
      String(b["name"] ?? ""),
      String(b["description"] ?? ""),
      String(b["content"] ?? ""),
      Array.isArray(b["tags"]) ? b["tags"].map(String) : [],
    );
    return c.json(info);
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.post("/api/skills/install", async (c) => {
  // Hub install requires zip extraction + verdict pipeline (upstream
  // install_from_hub). The TS port fetches the package metadata but cannot
  // safely unpack arbitrary archives without a zip dependency — fail closed.
  const b = await body(c);
  const ref = String(b["ref"] ?? "").trim();
  if (!ref) return httpError(c, 400, "ref is required");
  return httpError(c, 501, "Hub skill install is not yet supported by the TS backend (zip extraction pending).");
});

platformRouter.put("/api/skills/:name", async (c) => {
  const name = c.req.param("name") ?? "";
  const b = await body(c);
  try {
    const info = get_skill_service().update(name, {
      description: b["description"] ?? null,
      content: b["content"] ?? null,
      rename_to: b["rename_to"] ?? null,
      tags: Array.isArray(b["tags"]) ? b["tags"].map(String) : null,
    });
    return c.json(info);
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.delete("/api/skills/:name", (c) => {
  const name = c.req.param("name") ?? "";
  try {
    get_skill_service().delete(name);
    return c.json({ status: "deleted", name });
  } catch (exc) {
    return httpError(c, skillErrorStatus(exc), exc instanceof Error ? exc.message : String(exc));
  }
});

// ==========================================================================
// space_cli_apps.py — /api/space/cli-apps
// ==========================================================================

const CLI_OWNER = "local";

function cliAppRow(app: misc.InstalledApp, granted: Set<string> | null, disabled: Set<string>): Record<string, unknown> {
  const entry = misc.get_cli_entry(app.id);
  const isGranted = granted === null || granted.has(app.id);
  return {
    id: app.id,
    display_name: entry?.display_name ?? app.id,
    description: entry?.description ?? "",
    category: entry?.category ?? "",
    tool_name: `${misc.TOOL_PREFIX}${app.id}`,
    entry_point: app.entry_point,
    runtime: app.runtime,
    installed_at: app.installed_at,
    version: app.version,
    pin: app.pin,
    trust: entry?.trust ?? "third-party",
    granted: isGranted,
    enabled: isGranted && !disabled.has(app.id),
    in_catalog: entry !== null,
  };
}

function cliCatalogRow(entry: misc.CliAppEntry, installed: Record<string, misc.InstalledApp>): Record<string, unknown> {
  return {
    id: entry.id,
    display_name: entry.display_name,
    description: entry.description,
    category: entry.category,
    origin: entry.origin,
    trust: entry.trust,
    requires: entry.requires,
    homepage: entry.homepage,
    source_url: entry.source_url,
    entry_point: entry.entry_point,
    runtime: entry.runtime,
    install_kind: entry.install_kind,
    install_target: entry.install_target,
    installable: entry.installable,
    pinned: entry.pinned,
    unsupported_reason: entry.unsupported_reason,
    install_notes: entry.install_notes,
    installed: entry.id in installed,
  };
}

async function listCliApps(): Promise<Record<string, unknown>> {
  const installed = misc.load_installed();
  const disabled = misc.disabled_apps(CLI_OWNER);
  // Single-user deployment: all installed apps are granted (no per-account
  // grant whitelist in the TS port).
  const rows = Object.keys(installed).sort().map((id) => cliAppRow(installed[id], null, disabled));
  return {
    apps: rows,
    access: { unrestricted: true, exec_denied: false },
    catalog_pin: misc.catalog_pin(),
  };
}

platformRouter.get("/api/space/cli-apps/apps", async (c) => c.json(await listCliApps()));

platformRouter.put("/api/space/cli-apps/apps/:app_id/enabled", async (c) => {
  const appId = c.req.param("app_id") ?? "";
  const b = await body(c);
  const installed = misc.load_installed();
  if (!(appId in installed)) {
    return httpError(c, 404, `CLI app not installed: ${appId}`);
  }
  misc.set_app_enabled(CLI_OWNER, appId, Boolean(b["enabled"]));
  return c.json(await listCliApps());
});

platformRouter.get("/api/space/cli-apps/catalog", (c) => {
  const installed = misc.load_installed();
  const page = misc.search_cli_catalog({
    q: qStr(c, "q"),
    category: qStr(c, "category"),
    installable_only: c.req.query("installable_only") !== "false",
    cursor: qStr(c, "cursor"),
    limit: qInt(c, "limit", 24),
  });
  return c.json({
    entries: page.entries.map((e) => cliCatalogRow(e, installed)),
    next_cursor: page.next_cursor,
    total: page.total,
    categories: misc.cli_category_counts({ q: qStr(c, "q"), installable_only: c.req.query("installable_only") !== "false" }),
    catalog_pin: misc.catalog_pin(),
  });
});

platformRouter.post("/api/space/cli-apps/catalog/:app_id/install", async (c) => {
  const appId = c.req.param("app_id") ?? "";
  const entry = misc.get_cli_entry(appId);
  if (!entry) return httpError(c, 404, `CLI app not in catalog: ${appId}`);
  if (!entry.installable) {
    return httpError(c, 400, {
      code: "cli.install_failed",
      message: entry.unsupported_reason || "This app cannot be installed automatically.",
      log: "",
    });
  }
  // The upstream installer runs a third-party setup in the app container.
  // The TS port records the install and reports the entry point; actually
  // executing package-manager installs is a deployment concern (TODO).
  const installed = misc.load_installed();
  installed[appId] = {
    id: appId,
    entry_point: entry.entry_point,
    runtime: entry.runtime,
    installed_at: Date.now() / 1000,
    version: "",
    pin: misc.catalog_pin(),
  };
  misc.save_installed(installed);
  const state = await listCliApps();
  state["log"] = `Recorded install of ${appId} (entry_point=${entry.entry_point}); runtime provisioning is deployment-managed.`;
  return c.json(state);
});

platformRouter.delete("/api/space/cli-apps/apps/:app_id", async (c) => {
  const appId = c.req.param("app_id") ?? "";
  const installed = misc.load_installed();
  delete installed[appId];
  misc.save_installed(installed);
  misc.set_app_enabled(CLI_OWNER, appId, true); // clear preference residue
  return c.json(await listCliApps());
});

// ==========================================================================
// space_mcp.py — /api/space/mcp (per-user remote MCP servers)
// ==========================================================================

const MCP_OWNER = mcp.OWNER_ID;

function catalogRow(entry: mcp.McpCatalogEntry, installed: Record<string, mcp.McpServerConfig>): Record<string, unknown> {
  const installedAs = Object.entries(installed)
    .filter(([name, cfg]) => cfg.catalog_entry === entry.id || (!cfg.catalog_entry && name === entry.id))
    .map(([name]) => name)
    .sort();
  return {
    id: entry.id,
    display_name: entry.display_name,
    description_i18n: entry.description_i18n,
    category: entry.category,
    tier: entry.tier,
    transport: entry.transport,
    homepage: entry.homepage,
    docs_url: entry.docs_url,
    requires_i18n: entry.requires_i18n,
    logo_url: entry.logo_url,
    trust: entry.trust,
    self_service: entry.self_service,
    installed: installedAs.length > 0,
    installed_as: installedAs,
    fields: entry.fields.map((f) => ({
      key: f.key,
      label_i18n: f.label_i18n,
      secret: f.secret,
      required: f.required,
      placeholder: f.placeholder,
    })),
  };
}

async function listUserServers(): Promise<Record<string, unknown>> {
  const { config, rejected } = mcp.load_user_mcp_config(MCP_OWNER);
  const shared = mcp.load_mcp_config();
  const configuredSecrets: Record<string, string[]> = {};
  for (const name of Object.keys(config.servers)) {
    configuredSecrets[name] = [...mcp.configured_fields(MCP_OWNER, name)].sort();
  }
  const oauth: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(config.servers)) {
    if (cfg.auth === "oauth") oauth[name] = { required: true, authorized: false };
  }
  return {
    servers: config.servers,
    status: { servers: {} },
    configured_secrets: configuredSecrets,
    oauth,
    rejected,
    deployment: { servers: Object.keys(shared.servers).sort(), status: { servers: {} } },
    limits: { max_servers: 8 },
  };
}

platformRouter.get("/api/space/mcp/servers", async (c) => c.json(await listUserServers()));

platformRouter.put("/api/space/mcp/servers/:name", async (c) => {
  const name = c.req.param("name") ?? "";
  const b = await body(c);
  const cfg = mcp.coerce_server_config(b["config"]);
  const secrets = isRecord(b["secrets"]) ? (b["secrets"] as Record<string, string>) : {};
  try {
    mcp.assert_name_available(name, new Set(Object.keys(mcp.load_mcp_config().servers)));
    // Extract credentials: header/env literal values become secret refs.
    const data = JSON.parse(JSON.stringify(cfg)) as Record<string, any>;
    const extracted: Record<string, string> = { ...secrets };
    for (const section of ["headers", "env"] as const) {
      const values = isRecord(data[section]) ? data[section] : {};
      for (const [key, value] of Object.entries(values)) {
        if (typeof value !== "string" || !value) continue;
        if (/^\$\{secret:[^/}]+\/[^}]+\}$/.test(value)) continue;
        const field = `${section === "headers" ? "header" : "env"}.${key}`;
        extracted[field] = value;
        values[key] = mcp.secret_reference(name, field);
      }
    }
    const finalCfg = mcp.coerce_server_config(data);
    mcp.save_user_server(MCP_OWNER, name, finalCfg);
    if (Object.keys(extracted).length) mcp.store_secrets(MCP_OWNER, name, extracted);
  } catch (exc) {
    if (exc instanceof mcp.UserMcpError) {
      return httpError(c, 400, { code: exc.code, message: exc.message });
    }
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  }
  return c.json(await listUserServers());
});

platformRouter.delete("/api/space/mcp/servers/:name", async (c) => {
  const name = c.req.param("name") ?? "";
  mcp.delete_user_server(MCP_OWNER, name);
  mcp.delete_secrets(MCP_OWNER, name);
  return c.json(await listUserServers());
});

platformRouter.post("/api/space/mcp/servers/:name/test", async (c) => {
  const name = c.req.param("name") ?? "";
  const b = await body(c);
  const cfg = mcp.coerce_server_config(b["config"]);
  const resolved = mcp.resolve_references(MCP_OWNER, cfg) as mcp.McpServerConfig;
  const result = await mcp.probe_server(resolved, { owner: MCP_OWNER, server_name: name });
  return c.json(result);
});

platformRouter.post("/api/space/mcp/servers/:name/authorize", async (c) => {
  const name = c.req.param("name") ?? "";
  const { config } = mcp.load_user_mcp_config(MCP_OWNER);
  const cfg = config.servers[name];
  if (!cfg) return httpError(c, 404, `MCP server not found: ${name}`);
  if (cfg.auth !== "oauth") {
    return httpError(c, 400, { code: "mcp.not_oauth", message: "This server does not use OAuth." });
  }
  // OAuth consent flow is not implemented in the TS port.
  return httpError(c, 501, "OAuth authorization is not yet supported by the TS backend.");
});

platformRouter.get("/api/space/mcp/oauth/callback", (c) => {
  return c.html(`<!doctype html><meta charset="utf-8"><title>Authorization</title><p>OAuth callback is not supported by the TS backend.</p>`, 501);
});

platformRouter.get("/api/space/mcp/catalog", (c) => {
  const { config } = mcp.load_user_mcp_config(MCP_OWNER);
  const page = mcp.search_catalog({
    q: qStr(c, "q"),
    category: qStr(c, "category"),
    tier: qStr(c, "tier"),
    cursor: qStr(c, "cursor"),
    limit: qInt(c, "limit", 30),
    self_service_only: true,
  });
  return c.json({
    entries: page.entries.map((e) => catalogRow(e, config.servers)),
    next_cursor: page.next_cursor,
    total: page.total,
    categories: mcp.category_counts({ q: qStr(c, "q"), tier: qStr(c, "tier"), self_service_only: true }),
  });
});

platformRouter.post("/api/space/mcp/catalog/:entry_id/install", async (c) => {
  const entryId = c.req.param("entry_id") ?? "";
  const b = await body(c);
  const entry = mcp.get_catalog_entry(entryId);
  if (!entry) return httpError(c, 404, `MCP catalog entry not found: ${entryId}`);
  if (!entry.self_service) {
    return httpError(c, 403, { code: "mcp.entry_admin_only", message: "This catalog entry is administrator-only." });
  }
  const name = String(b["name"] ?? "").trim() || entry.id;
  const secrets = isRecord(b["secrets"]) ? (b["secrets"] as Record<string, string>) : {};
  let built: mcp.BuiltServer;
  try {
    built = mcp.build_server_config(entry, secrets);
    mcp.assert_name_available(name, new Set(Object.keys(mcp.load_mcp_config().servers)));
    mcp.save_user_server(MCP_OWNER, name, built.config);
  } catch (exc) {
    if (exc instanceof mcp.UserMcpError) {
      return httpError(c, 400, { code: exc.code, message: exc.message });
    }
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  }
  if (Object.keys(built.secret_values).length) {
    mcp.store_secrets(MCP_OWNER, name, built.secret_values);
  }
  return c.json(await listUserServers());
});

// ==========================================================================
// plugins.py — /api/plugins (registry introspection + managed route dispatch)
// ==========================================================================

const PLUGIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";

function managedRecords(): misc.PluginRecord[] {
  return misc.list_plugins().filter(
    (r) => r.status === "enabled" && r.distribution === "managed" && r.manifest && r.installation,
  );
}

function extensionsPayload(records: misc.PluginRecord[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const record of records) {
    if (!record.manifest) continue;
    const extensions = (record.manifest.extensions ?? []).map((ext) => {
      const payload: Record<string, unknown> = { ...ext };
      if (ext.type === "frontend_page" && ext.manifest) {
        payload["entry_url"] = `/api/plugins/${record.id}/pages/${ext.id}/`;
      }
      return payload;
    });
    out.push({ id: record.id, name: record.name, version: record.version, extensions });
  }
  return out;
}

function normalizePluginPath(value: string): string | null {
  if (!value || value.includes("\0") || value.includes("%") || value.includes("\\")) return null;
  return "/" + value.trim().replace(/^\/+|\/+$/g, "");
}

function findRoute(pluginId: string, pluginPath: string) {
  const normalized = normalizePluginPath(pluginPath);
  if (normalized === null) return null;
  for (const record of managedRecords()) {
    if (record.id !== pluginId || !record.manifest || !record.installation) continue;
    for (const ext of record.manifest.extensions ?? []) {
      if (ext.type === "http_route" && ext.path === normalized) {
        return { record, extension: ext, installation: record.installation };
      }
    }
  }
  return null;
}

function findFrontendPage(pluginId: string, extensionId: string) {
  for (const record of managedRecords()) {
    if (record.id !== pluginId || !record.manifest || !record.installation) continue;
    const pkgPath = record.installation.package_path;
    if (!pkgPath) continue;
    for (const ext of record.manifest.extensions ?? []) {
      if (ext.type === "frontend_page" && ext.id === extensionId) {
        return { record, extension: ext, installation: record.installation, packagePath: pkgPath };
      }
    }
  }
  return null;
}

platformRouter.get("/api/plugins/extensions", (c) => {
  return c.json({ plugins: extensionsPayload(managedRecords()) });
});

platformRouter.get("/api/plugins/catalog", (c) => {
  // No vendored plugin catalog in the TS port.
  return c.json({ entries: [] });
});

platformRouter.get("/api/plugins/state", (c) => {
  return c.json({ plugins: misc.list_plugins() });
});

platformRouter.get("/api/plugins/:plugin_id/info", (c) => {
  const record = misc.get_plugin(c.req.param("plugin_id") ?? "");
  if (!record) return httpError(c, 404, "Plugin not found");
  return c.json(record);
});

platformRouter.post("/api/plugins/:plugin_id/approve", async (c) => {
  const pluginId = c.req.param("plugin_id") ?? "";
  const b = await body(c);
  const record = misc.get_plugin(pluginId);
  if (!record) return httpError(c, 404, "Plugin not found");
  if (record.snapshot_digest && b["snapshot_digest"] !== record.snapshot_digest) {
    return httpError(c, 409, "Snapshot digest mismatch");
  }
  record.status = "enabled";
  misc.save_plugin(record);
  return c.json(record);
});

platformRouter.post("/api/plugins/:plugin_id/enable", (c) => {
  const pluginId = c.req.param("plugin_id") ?? "";
  try {
    return c.json(misc.set_plugin_enabled(pluginId, true));
  } catch (exc) {
    return httpError(c, 409, exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.post("/api/plugins/:plugin_id/disable", (c) => {
  const pluginId = c.req.param("plugin_id") ?? "";
  try {
    return c.json(misc.set_plugin_enabled(pluginId, false));
  } catch (exc) {
    return httpError(c, 409, exc instanceof Error ? exc.message : String(exc));
  }
});

platformRouter.post("/api/plugins/:plugin_id/install", async (c) => {
  // Catalog install requires the distribution/lifecycle pipeline; the TS
  // port records intent only when the package is already on disk.
  const pluginId = c.req.param("plugin_id") ?? "";
  const b = await body(c);
  void b;
  const record = misc.get_plugin(pluginId);
  if (!record) return httpError(c, 404, "Plugin not found");
  return httpError(c, 501, "Plugin install is not yet supported by the TS backend.");
});

platformRouter.post("/api/plugins/:plugin_id/rollback", (c) => {
  return httpError(c, 501, "Plugin rollback is not yet supported by the TS backend.");
});

platformRouter.delete("/api/plugins/:plugin_id/installation", (c) => {
  const pluginId = c.req.param("plugin_id") ?? "";
  const record = misc.get_plugin(pluginId);
  if (!record) return httpError(c, 404, "Plugin not found");
  record.installation = null;
  record.status = "disabled";
  misc.save_plugin(record);
  return c.json({ id: pluginId, action: "uninstalled" });
});

// Frontend pages: serve files from the plugin package directory.
platformRouter.get("/api/plugins/:plugin_id/pages/:extension_id/", (c) => {
  const matched = findFrontendPage(c.req.param("plugin_id") ?? "", c.req.param("extension_id") ?? "");
  if (!matched) return httpError(c, 404, "Plugin page not found");
  const ext = matched.extension;
  if (!ext.manifest) return httpError(c, 404, "Plugin page not found");
  const pkg = resolve(matched.packagePath);
  const manifestPath = resolve(pkg, String(ext.manifest));
  if (!manifestPath.startsWith(pkg + sep) || !existsSync(manifestPath)) {
    return httpError(c, 404, "Plugin page not found");
  }
  try {
    const pageManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { entry?: string };
    const entry = String(pageManifest.entry ?? "index.html");
    const filePath = resolve(pkg, entry);
    if (!filePath.startsWith(pkg + sep) || !existsSync(filePath)) {
      return httpError(c, 404, "Plugin page not found");
    }
    const html = readFileSync(filePath, "utf8");
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": PLUGIN_CSP,
      "X-Content-Type-Options": "nosniff",
    });
  } catch {
    return httpError(c, 404, "Plugin page not found");
  }
});

platformRouter.get("/api/plugins/:plugin_id/pages/:extension_id", (c) => {
  // Redirect to the trailing-slash URL like upstream.
  const url = new URL(c.req.url);
  return c.redirect(url.pathname + "/", 307);
});

platformRouter.get("/api/plugins/:plugin_id/pages/:extension_id/assets/*", (c) => {
  const matched = findFrontendPage(c.req.param("plugin_id") ?? "", c.req.param("extension_id") ?? "");
  if (!matched) return httpError(c, 404, "Plugin page not found");
  const pkg = resolve(matched.packagePath);
  const asset = c.req.path.split(`/pages/${c.req.param("extension_id")}/assets/`)[1] ?? "";
  const filePath = resolve(pkg, asset);
  if (!filePath.startsWith(pkg + sep) || !existsSync(filePath)) {
    return httpError(c, 404, "Plugin asset not found");
  }
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css",
    json: "application/json", png: "image/png", jpg: "image/jpeg", svg: "image/svg+xml",
    woff2: "font/woff2", map: "application/json",
  };
  return c.body(readFileSync(filePath), 200, {
    "Content-Type": types[ext] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "Content-Security-Policy": PLUGIN_CSP,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
});

// Managed http_route dispatch: plugin packages may ship a route.mjs handler.
for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) {
  platformRouter.on(method, "/api/plugins/:plugin_id/:plugin_path{.+}", async (c) => {
    const pluginId = c.req.param("plugin_id") ?? "";
    const pluginPath = "/" + (c.req.param("plugin_path") ?? "").replace(/^\/+/, "");
    const matched = findRoute(pluginId, pluginPath);
    if (!matched) return httpError(c, 404, "Plugin route not found");
    const ext = matched.extension;
    const allowed = Array.isArray(ext.methods) && ext.methods.length ? ext.methods : ["GET"];
    if (!allowed.includes(c.req.method)) {
      return c.json({ detail: "Method not allowed" }, 405, { Allow: allowed.join(", ") } as never);
    }
    const pkgPath = matched.installation.package_path;
    if (!pkgPath) return httpError(c, 500, "Plugin route failed");
    const handlerPath = resolve(pkgPath, "route.mjs");
    if (!handlerPath.startsWith(resolve(pkgPath) + sep) || !existsSync(handlerPath)) {
      return httpError(c, 501, "Plugin route handler not implemented in TS backend.");
    }
    try {
      const mod = (await import(handlerPath)) as { default?: (req: unknown) => Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }> };
      if (typeof mod.default !== "function") return httpError(c, 500, "Plugin route failed");
      const bodyText = await c.req.text().catch(() => "");
      let jsonBody: unknown = null;
      if (bodyText) {
        try { jsonBody = JSON.parse(bodyText); } catch {
          return httpError(c, 400, "Request body must be JSON");
        }
      }
      const result = await mod.default({
        method: c.req.method,
        path: ext.path ?? pluginPath,
        query: c.req.query(),
        body: jsonBody,
        headers: c.req.header(),
      });
      const status = Number(result?.status ?? 200);
      const headers = result?.headers ?? {};
      if (status === 204) return c.body(null, 204, headers as never);
      return c.json(result?.body ?? {}, status as never, headers as never);
    } catch {
      return httpError(c, 500, "Plugin route failed");
    }
  });
}
