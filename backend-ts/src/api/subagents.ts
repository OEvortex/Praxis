// subagent detection, backend
// options/sync, pointer-KB connections, and consult settings.
//
// Wire-up: mount BEFORE handlersRouter (its /api/subagents/* stubs would
// otherwise shadow these routes).

import { Hono } from "hono";
import type { Context } from "hono";

import {
  backend_config,
  create_connection,
  delete_connection,
  detect_all,
  get_backend,
  list_backend_kinds,
  list_connections,
  load_subagent_settings,
  save_subagent_settings,
  settings_from_dict,
  settings_to_dict,
  type BackendConfig,
} from "../services/platform/subagents.js";

export const subagentsRouter = new Hono();

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

// -- detection / options ---------------------------------------------------------

subagentsRouter.get("/api/subagents/detect", async (c) => {
  const detections = await detect_all();
  return c.json({ backends: detections });
});

const EFFORTS_LOW_HIGH = ["low", "medium", "high"];
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS = ["low", "medium", "high", "xhigh"];
const OPENCODE_EFFORTS = ["low", "medium", "high"];
const HERMES_EFFORTS = ["low", "medium", "high"];

function freeTextOptions(kind: string, displayName: string, available: boolean, detail = ""): Record<string, unknown> {
  return {
    kind,
    display_name: displayName,
    available,
    version: "",
    default_model: "",
    models: [],
    efforts: [],
    allow_custom_model: true,
    synced_at: "",
    detail,
  };
}

async function backendOptionsFor(kind: string): Promise<Record<string, unknown> | null> {
  const spec = get_backend(kind);
  if (spec === null) return null;
  const detections = await detect_all();
  const detected = detections.find((d) => d.kind === kind) ?? null;
  const available = detected?.available ?? false;
  const version = detected?.version ?? "";
  const detail = detected?.detail ?? "";

  switch (kind) {
    case "claude_code": {
      // Claude Code exposes no machine-readable catalog; offer known aliases
      // plus free-text (upstream scrapes the /model TUI — TODO: port
      // claude_models.ts cache if needed).
      const models = [
        { slug: "sonnet", display_name: "Sonnet (default)", default_effort: "", efforts: CLAUDE_EFFORTS },
        { slug: "opus", display_name: "Opus", default_effort: "", efforts: CLAUDE_EFFORTS },
        { slug: "haiku", display_name: "Haiku", default_effort: "", efforts: CLAUDE_EFFORTS },
      ];
      return {
        kind, display_name: spec.display_name, available, version,
        default_model: "", models, efforts: CLAUDE_EFFORTS,
        allow_custom_model: true, synced_at: "", detail,
      };
    }
    case "codex": {
      const models = [
        { slug: "gpt-5.1-codex-max", display_name: "GPT-5.1 Codex Max", default_effort: "medium", efforts: CODEX_EFFORTS },
        { slug: "gpt-5.1-codex-mini", display_name: "GPT-5.1 Codex Mini", default_effort: "medium", efforts: CODEX_EFFORTS },
        { slug: "gpt-5-codex", display_name: "GPT-5 Codex", default_effort: "medium", efforts: CODEX_EFFORTS },
      ];
      return {
        kind, display_name: spec.display_name, available, version,
        default_model: "", models, efforts: CODEX_EFFORTS,
        allow_custom_model: true, synced_at: "", detail,
      };
    }
    case "grok":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: EFFORTS_LOW_HIGH };
    case "antigravity":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: EFFORTS_LOW_HIGH };
    case "kimi":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: EFFORTS_LOW_HIGH };
    case "opencode":
    case "mimo":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: OPENCODE_EFFORTS };
    case "hermes":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: HERMES_EFFORTS };
    case "hermes_remote": {
      const cfg = backend_config(load_subagent_settings(), kind);
      const ok = Boolean(cfg.base_url.trim());
      return {
        ...freeTextOptions(kind, spec.display_name, ok, ok ? "" : "no base_url configured"),
        efforts: HERMES_EFFORTS,
      };
    }
    case "openclaw":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: EFFORTS_LOW_HIGH };
    case "deepseek_harness":
      return { ...freeTextOptions(kind, spec.display_name, available, detail), efforts: EFFORTS_LOW_HIGH };
    case "acp":
      return freeTextOptions(kind, spec.display_name, available, detail);
    default:
      return null;
  }
}

subagentsRouter.get("/api/subagents/backends/options", async (c) => {
  const options = await Promise.all(list_backend_kinds().map((k) => backendOptionsFor(k)));
  return c.json({ backends: options.filter(Boolean) });
});

subagentsRouter.post("/api/subagents/backends/:kind/sync", async (c) => {
  const kind = c.req.param("kind") ?? "";
  const spec = get_backend(kind);
  if (spec === null || !spec.local_cli) {
    return httpError(c, 400, `Unknown agent kind: ${JSON.stringify(kind)}`);
  }
  const options = await backendOptionsFor(kind);
  if (options === null) return httpError(c, 400, `Unknown agent kind: ${JSON.stringify(kind)}`);
  return c.json(options);
});

// -- connections --------------------------------------------------------------------

subagentsRouter.get("/api/subagents/connections", (c) => {
  return c.json({ connections: list_connections() });
});

subagentsRouter.post("/api/subagents/connections", async (c) => {
  const b = await body(c);
  const name = String(b["name"] ?? "").trim();
  const agentKind = String(b["agent_kind"] ?? "").trim();
  const cwd = String(b["cwd"] ?? "");
  if (!name || !agentKind) {
    return httpError(c, 400, "Both name and agent_kind are required.");
  }
  if (agentKind === "partner" || !list_backend_kinds().includes(agentKind)) {
    return httpError(c, 400, `Unknown agent kind: ${JSON.stringify(agentKind)}`);
  }
  const spec = get_backend(agentKind);
  let resolvedCwd = "";
  const rawCwd = cwd.trim();
  if (rawCwd && spec !== null && spec.local_cli) {
    // assert_path_allowed equivalent: must be an existing absolute path.
    const { isAbsolute, resolve } = await import("node:path");
    const { existsSync, statSync } = await import("node:fs");
    const candidate = resolve(rawCwd);
    if (!isAbsolute(rawCwd) || !existsSync(candidate) || !statSync(candidate).isDirectory()) {
      return httpError(c, 400, `cwd is not an accessible directory: ${rawCwd}`);
    }
    resolvedCwd = candidate;
  }
  try {
    const result = create_connection(name, agentKind, resolvedCwd);
    return c.json(result);
  } catch (exc) {
    return httpError(c, 400, exc instanceof Error ? exc.message : String(exc));
  }
});

subagentsRouter.delete("/api/subagents/connections/:name", (c) => {
  const name = c.req.param("name") ?? "";
  if (!delete_connection(name)) {
    return httpError(c, 404, `No connected subagent named ${JSON.stringify(name)}.`);
  }
  return c.json({ status: "disconnected", name });
});

// -- direct message streaming (NDJSON) ----------------------------------------------

subagentsRouter.post("/api/subagents/connections/:name/message", async (c) => {
  const name = c.req.param("name") ?? "";
  const b = await body(c);
  const message = String(b["message"] ?? "").trim();
  if (!message) return httpError(c, 400, "A non-empty 'message' is required.");
  const conn = list_connections().find((x) => x["name"] === name);
  if (!conn) return httpError(c, 404, `No connected subagent named ${JSON.stringify(name)}.`);
  const kind = String(conn["agent_kind"] ?? "");
  const cwd = String(conn["cwd"] ?? "");
  const spec = get_backend(kind);
  if (spec === null) return httpError(c, 400, `Unknown agent kind: ${JSON.stringify(kind)}`);

  // Stream NDJSON lines: user echo, then consult events, then done.
  const encoder = new TextEncoder();
  const ndjson = (obj: Record<string, unknown>) => encoder.encode(JSON.stringify(obj) + "\n");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (obj: Record<string, unknown>) => {
        try { controller.enqueue(ndjson(obj)); } catch { /* closed */ }
      };
      push({ channel: "user_question", text: message });
      try {
        // Real consult: spawn the backend CLI non-interactively and stream
        // its output as text events. This is the same trust model as the
        // Python consult() path (bypassPermissions / dontAsk defaults).
        const { spawn } = await import("node:child_process");
        const cfg: BackendConfig = backend_config(load_subagent_settings(), kind);
        const args = buildConsultArgs(kind, cfg, message, cwd);
        if (args === null) {
          push({ channel: "error", text: `No consult command for backend ${kind}` });
          push({ done: true, success: false, session_id: "" });
          controller.close();
          return;
        }
        await new Promise<void>((resolvePromise) => {
          const child = spawn(args[0], args.slice(1), {
            cwd: cwd || undefined,
            env: { ...process.env },
            stdio: ["ignore", "pipe", "pipe"],
          });
          let buf = "";
          const flush = () => {
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              const text = line.trim();
              if (text) push({ channel: "text", text });
            }
          };
          child.stdout.on("data", (d) => { buf += String(d); flush(); });
          child.stderr.on("data", () => { /* merged below via exit */ });
          const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch { /* gone */ }
          }, Math.max(10, cfg.idle_timeout_seconds) * 1000);
          child.on("close", (code) => {
            clearTimeout(timer);
            flush();
            if (buf.trim()) push({ channel: "text", text: buf.trim() });
            push({ done: true, success: code === 0, session_id: "" });
            try { controller.close(); } catch { /* closed */ }
            resolvePromise();
          });
          child.on("error", (err) => {
            clearTimeout(timer);
            push({ channel: "error", text: err.message });
            push({ done: true, success: false, session_id: "" });
            try { controller.close(); } catch { /* closed */ }
            resolvePromise();
          });
        });
      } catch (exc) {
        push({ channel: "error", text: exc instanceof Error ? exc.message : String(exc) });
        push({ done: true, success: false, session_id: "" });
        try { controller.close(); } catch { /* closed */ }
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
});

/** Build the one-shot consult argv for a local CLI backend (best-effort port
 * of each backend's consult command construction). */
function buildConsultArgs(kind: string, cfg: BackendConfig, message: string, cwd: string): string[] | null {
  const extra = [...cfg.extra_args];
  switch (kind) {
    case "claude_code":
      return [
        "claude", "-p", message,
        ...(cfg.model ? ["--model", cfg.model] : []),
        ...(cfg.effort ? ["--effort", cfg.effort] : []),
        ...(cfg.permission_mode ? ["--permission-mode", cfg.permission_mode] : []),
        ...(cfg.system_prompt ? ["--append-system-prompt", cfg.system_prompt] : []),
        ...extra,
      ];
    case "codex":
      return [
        "codex", "exec", message,
        ...(cfg.model ? ["-m", cfg.model] : []),
        "--sandbox", cfg.sandbox || "workspace-write",
        ...(cfg.approval ? [] : []),
        ...(cfg.network_access ? ["--config", "sandbox_workspace_write.network_access=true"] : []),
        ...(cfg.ephemeral ? ["--ephemeral"] : []),
        ...extra,
      ];
    case "grok":
      return ["grok", "-p", message, ...(cfg.model ? ["--model", cfg.model] : []), ...extra];
    case "antigravity":
      return ["agy", "-p", message, ...extra];
    case "kimi":
      return ["kimi", "-p", message, ...(cfg.auto_approve ? ["--yolo"] : []), ...extra];
    case "opencode":
      return ["opencode", "run", message, ...extra];
    case "mimo":
      return ["mimo", "run", message, ...extra];
    case "hermes":
      return ["hermes", "-p", message, ...(cfg.auto_approve ? ["--yolo"] : []), ...extra];
    case "openclaw":
      return ["openclaw", "run", message, ...extra];
    case "deepseek_harness":
      return ["dsh", "run", message, ...extra];
    default:
      return null;
  }
}

// -- settings -------------------------------------------------------------------------

subagentsRouter.get("/api/subagents/settings", (c) => {
  return c.json(settings_to_dict(load_subagent_settings()));
});

subagentsRouter.put("/api/subagents/settings", async (c) => {
  const b = await body(c);
  const merged = settings_to_dict(load_subagent_settings()) as Record<string, any>;
  if (b["consult_budget"] !== undefined && b["consult_budget"] !== null) {
    merged["consult_budget"] = Number(b["consult_budget"]);
  }
  if (isRecord(b["backends"])) {
    const backends = { ...(merged["backends"] ?? {}) } as Record<string, any>;
    for (const [kind, cfg] of Object.entries(b["backends"] as Record<string, any>)) {
      backends[String(kind)] = { ...(backends[String(kind)] ?? {}), ...(isRecord(cfg) ? cfg : {}) };
    }
    merged["backends"] = backends;
  }
  const settingsObj = settings_from_dict(merged);
  save_subagent_settings(settingsObj);
  return c.json(settings_to_dict(settingsObj));
});

function isRecord(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
