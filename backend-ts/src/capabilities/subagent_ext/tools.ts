// Port of deeptutor/capabilities/subagent/tools.py — the ``consult_subagent``
// tool: the seam between the chat loop and a live external agent CLI.
//
// What upstream's generic subagent capability adds beyond
// ``src/agent/subagent.ts`` (the internal nested-run dispatcher used by the
// notebook/video subagents):
//   * delegation to EXTERNAL agent CLIs (Claude Code, Codex, Grok, Kimi,
//     opencode, ...) rather than an in-process LocalAgentRuntime;
//   * a per-turn consult budget ("max rounds") enforced tool-side;
//   * cross-consult session resume — successive consults continue the same
//     backend session, persisted across turns (sessions.ts);
//   * live streaming of the agent's native events via ``ctx.emit`` under the
//     ``subagent_event`` trace kind (same contract as upstream's event_sink).
//
// Backend registry, per-backend config and detection come from
// ``services/platform/subagents.ts``; connection ("which agent, which cwd")
// resolution mirrors upstream's KB-binding: an optional ``agent`` param names
// a ``type: subagent`` connection, else the first connection wins, else the
// first detectable CLI backend is used with the workspace dir.

import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { get_settings } from "../../config.js";
import {
  backend_config,
  detect_all,
  get_backend,
  list_backend_kinds,
  list_connections,
  load_subagent_settings,
  save_subagent_settings,
  settings_to_dict,
  type BackendConfig,
} from "../../services/platform/subagents.js";
import { consultBackend, type ConsultResult } from "./runner.js";
import { getSession, rememberSession, sessionKey } from "./sessions.js";

// Single trace kind for every streamed subagent event; the fine-grained
// channel (text / log / question / error) rides in the payload — same
// contract as upstream's ``subagent_event`` trace.
const TRACE_KIND = "subagent_event";

// Default instruction injected (Claude Code --append-system-prompt) so a
// consulted agent behaves like a delegate — port of upstream
// ``_DEFAULT_CONSULT_INSTRUCTION`` / ``_effective_config``.
const DEFAULT_CONSULT_INSTRUCTION =
  "You are being consulted programmatically by DeepTutor on the user's behalf, " +
  "not in an interactive terminal. Answer the question directly, concisely, and " +
  "self-contained. Do not ask the user follow-up questions or wait for input; " +
  "if something is ambiguous, state your assumption and proceed.";

function effectiveConfig(cfg: BackendConfig): BackendConfig {
  if (cfg.system_prompt.trim()) return cfg;
  return { ...cfg, system_prompt: DEFAULT_CONSULT_INSTRUCTION };
}

// ---------------------------------------------------------------------------
// Per-turn consult state (upstream context.extension("subagent")["session"])
// ---------------------------------------------------------------------------

interface ConsultState {
  count: number;
  session_id: string | null;
  /** Seeded once per turn from the cross-turn registry. */
  seeded: boolean;
}

// Keyed by chat session id; entries are small and overwritten per turn.
const _TURN_STATES = new Map<string, ConsultState>();

function turnState(sessionId: string): ConsultState {
  const key = sessionId || "default";
  let state = _TURN_STATES.get(key);
  if (state === undefined) {
    state = { count: 0, session_id: null, seeded: false };
    _TURN_STATES.set(key, state);
  }
  return state;
}

/** Test hook — drop all turn state. */
export function clearConsultStates(): void {
  _TURN_STATES.clear();
}

// ---------------------------------------------------------------------------
// Connection / backend resolution
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  kind: string;
  name: string;
  cwd: string;
}

/** Local-CLI kinds the runner can build argv for (runner.ts buildConsultArgs). */
const RUNNABLE_KINDS = new Set([
  "claude_code",
  "codex",
  "grok",
  "antigravity",
  "kimi",
  "opencode",
  "mimo",
  "hermes",
  "openclaw",
  "deepseek_harness",
]);

function resolveTarget(agentParam: string): ResolvedTarget | { error: string } {
  const connections = list_connections();
  let conn: Record<string, unknown> | null = null;
  if (agentParam) {
    conn = connections.find((c) => String(c["name"] ?? "") === agentParam) ?? null;
    if (conn === null) {
      return {
        error: `No connected subagent named ${JSON.stringify(agentParam)}. ` +
          `Connected: ${connections.map((c) => String(c["name"])).join(", ") || "none"}.`,
      };
    }
  } else if (connections.length > 0) {
    conn = connections[0];
  }

  if (conn !== null) {
    const kind = String(conn["agent_kind"] ?? "").trim();
    if (!kind) return { error: "The selected subagent connection has no agent_kind." };
    if (!RUNNABLE_KINDS.has(kind)) {
      return {
        error:
          `Backend ${JSON.stringify(kind)} is not supported by the TS consult ` +
          "runner yet (partner/remote/ACP backends are TODO).",
      };
    }
    return {
      kind,
      name: String(conn["name"] ?? kind),
      cwd: String(conn["cwd"] ?? "").trim(),
    };
  }

  // No connection: fall back to the first runnable+detected backend kind is
  // resolved asynchronously by the caller — return a marker.
  return { kind: "", name: "", cwd: "" };
}

// ---------------------------------------------------------------------------
// consult_subagent
// ---------------------------------------------------------------------------

export interface ConsultSubagentParams {
  question?: string;
  agent?: string;
}
export const consultSubagentParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["question"],
  properties: {
    question: {
      type: "string",
      description:
        "The question or task to put to the agent. Be specific and " +
        "self-contained; the agent keeps context across your consults this " +
        "turn, so each one can build on the last.",
    },
    agent: {
      type: "string",
      description:
        "Optional name of a connected subagent (from subagent_backends). " +
        "Defaults to the first connection, or auto-detected CLI.",
    },
  },
};

const CONSULT_DESCRIPTION =
  "Ask the connected external agent (a local agent CLI on the user's " +
  "machine — Claude Code, Codex, Grok CLI, Kimi CLI, opencode, MiMo Code, " +
  "Hermes Agent, OpenClaw, or DeepSeek Harness — or one of their partners) " +
  "a focused question and get its answer. A local agent runs on the user's " +
  "machine with access to their files and tools; a partner answers with its " +
  "own persona, library and skills. Either way its full step-by-step run is " +
  "shown to the user live. Use it to delegate work it is better placed to do " +
  "— inspecting a codebase, running commands, reproducing a bug, or drawing " +
  "on a partner's dedicated knowledge. You may consult it more than once to " +
  "drill down, but you have a limited number of consults this turn (the " +
  "result tells you how many remain). When you have enough, stop calling " +
  "this tool and answer the user yourself in your own voice — never " +
  "impersonate the agent.";

export class ConsultSubagentTool extends BaseTool<ConsultSubagentParams> {
  name = "consult_subagent";
  toolIcon = "🤝";
  params = consultSubagentParamsSchema;
  mutating = true;
  description = CONSULT_DESCRIPTION;

  async execute(p: ConsultSubagentParams, ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const subSettings = load_subagent_settings(settings);
    const question = String(p.question ?? "").trim();
    if (!question) {
      return fail("consult_subagent needs a non-empty 'question'.");
    }

    const sessionId = String(ctx?.sessionId ?? "");
    const state = turnState(sessionId);
    const budget = subSettings.consult_budget;

    // Resolve the consult target (connection or auto-detected backend).
    const resolved = resolveTarget(String(p.agent ?? "").trim());
    if ("error" in resolved) return fail(resolved.error);

    let target: ResolvedTarget;
    if (resolved.kind) {
      target = resolved;
    } else {
      // No connection: pick the first detectable runnable backend.
      const detected = await detect_all();
      const kind = detected
        .filter((d) => d.available && RUNNABLE_KINDS.has(d.kind) && get_backend(d.kind) !== null)
        .map((d) => d.kind)[0];
      if (!kind) {
        return fail(
          "No subagent is connected and no supported agent CLI was detected " +
            "on this machine. Connect one via the subagents settings or " +
            "install a supported CLI (claude, codex, grok, kimi, opencode, ...).",
        );
      }
      target = { kind, name: kind, cwd: "" };
    }

    const name = target.name || target.kind;
    if (state.count >= budget) {
      return fail(
        `[Consult budget reached: you have already asked ${name} ${budget} ` +
          "time(s) this turn — the maximum. Do not call consult_subagent " +
          "again. Answer the user now with what you have gathered.]",
      );
    }

    state.count += 1;
    const consultIndex = state.count;

    // Seed the backend session id once per turn from the cross-turn registry
    // (upstream augment_kwargs + sessions.get_session).
    if (!state.seeded) {
      state.seeded = true;
      if (!state.session_id && sessionId) {
        state.session_id = getSession(settings, sessionKey(sessionId, target.kind));
      }
    }

    const emitEvent = async (
      channel: string,
      text: string,
      extra?: Record<string, unknown>,
    ): Promise<void> => {
      if (!ctx?.emit || !text) return;
      try {
        await ctx.emit({
          type: TRACE_KIND,
          channel,
          text,
          subagent_kind: target.kind,
          subagent_name: name,
          consult_index: consultIndex,
          ...(extra ?? {}),
        });
      } catch {
        /* progress must never fail the consult */
      }
    };

    const backendCfg = effectiveConfig(backend_config(subSettings, target.kind));
    const cwd = target.cwd || String(settings.workspace_dir ?? "");

    let result: ConsultResult;
    try {
      result = await consultBackend(target.kind, question, {
        onEvent: async (ev) => {
          await emitEvent(ev.kind, ev.text);
        },
        cwd,
        sessionId: state.session_id,
        config: backendCfg,
      });
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      await emitEvent("error", msg);
      return fail(`The subagent run failed: ${msg}`);
    }

    if (result.session_id) {
      state.session_id = result.session_id;
      if (sessionId) {
        rememberSession(settings, sessionKey(sessionId, target.kind), result.session_id, {
          kind: target.kind,
          cwd,
        });
      }
    }

    const remaining = Math.max(0, budget - consultIndex);
    const metadata = {
      subagent_kind: target.kind,
      consult_index: consultIndex,
      consult_remaining: remaining,
      event_count: result.event_count,
    };

    if (!result.final_text) {
      const detail = result.error || "the agent produced no final answer text";
      await emitEvent("error", detail);
      return { success: false, result: `[The agent returned no answer: ${detail}]`, ...metadata };
    }

    const budgetNote =
      remaining > 0
        ? `\n\n[${remaining} consult(s) left with ${name} this turn.]`
        : `\n\n[No consults left with ${name} — answer the user now.]`;
    return {
      success: result.success,
      result: result.final_text + budgetNote,
      ...metadata,
    };
  }
}
export const consult_subagent = new ConsultSubagentTool();

// ---------------------------------------------------------------------------
// subagent_backends — connections + detection listing (read-only)
// ---------------------------------------------------------------------------

export interface SubagentBackendsParams { _unused?: never }
export const subagentBackendsParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {},
};

export class SubagentBackendsTool extends BaseTool<SubagentBackendsParams> {
  name = "subagent_backends";
  toolIcon = "🧭";
  params = subagentBackendsParamsSchema;
  mutating = false;
  description =
    "List the connected subagents and the agent CLIs detected on this " +
    "machine, plus the configured consult budget. Use before consult_subagent " +
    "to pick a working 'agent'.";

  async execute(): Promise<ToolResult> {
    const settings = get_settings();
    const subSettings = load_subagent_settings(settings);
    const detected = await detect_all();
    const byKind = new Map(detected.map((d) => [d.kind, d]));
    return ok(
      JSON.stringify({
        consult_budget: subSettings.consult_budget,
        connections: list_connections(),
        backends: list_backend_kinds().map((kind) => {
          const spec = get_backend(kind);
          const det = byKind.get(kind);
          return {
            kind,
            display_name: spec?.display_name ?? kind,
            cli_command: spec?.cli_command ?? "",
            available: det?.available ?? false,
            version: det?.version ?? "",
            detail: det?.detail ?? "",
          };
        }),
      }),
    );
  }
}
export const subagent_backends = new SubagentBackendsTool();

// ---------------------------------------------------------------------------
// subagent_configure — persist the consult budget (shared subagent settings)
// ---------------------------------------------------------------------------

export interface SubagentConfigureParams { consult_budget?: number }
export const subagentConfigureParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    consult_budget: {
      type: "integer",
      description: "Max consult_subagent calls per turn (clamped 1–12, default 5).",
    },
  },
};

export class SubagentConfigureTool extends BaseTool<SubagentConfigureParams> {
  name = "subagent_configure";
  toolIcon = "⚙️";
  params = subagentConfigureParamsSchema;
  mutating = true;
  description =
    "Configure the subagent consult budget — the maximum number of times " +
    "consult_subagent may be called per turn. Persisted in local settings " +
    "(shared with the subagents settings API).";

  async execute(p: SubagentConfigureParams): Promise<ToolResult> {
    const settings = get_settings();
    const subSettings = load_subagent_settings(settings);
    if (p.consult_budget !== undefined) {
      const n = Number(p.consult_budget);
      if (!Number.isFinite(n)) {
        return fail("consult_budget must be a number.");
      }
      subSettings.consult_budget = Math.max(1, Math.min(12, Math.trunc(n)));
      save_subagent_settings(subSettings, settings);
    }
    return ok(JSON.stringify({ settings: settings_to_dict(subSettings) }));
  }
}
export const subagent_configure = new SubagentConfigureTool();

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const SUBAGENT_EXT_TOOL_NAMES = [
  "consult_subagent",
  "subagent_backends",
  "subagent_configure",
] as const;

export const SUBAGENT_EXT_TOOLS = [
  consult_subagent,
  subagent_backends,
  subagent_configure,
];
