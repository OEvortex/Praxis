// the four tools through
// which the agent configures this Praxis install:
//
//   inspect_setup     — read the install: current values, options, gaps, jobs
//   apply_setting     — commit one whitelisted setting (runtime overrides)
//   request_credential— hand secret entry back to the settings page
//   run_setup_job     — run a setup check (TTS probe, ffmpeg check)
//
// Like upstream, the tools are generic: they walk the spec rows in ./spec.js
// rather than hardcoding per-setting logic.

import { get_settings, type Settings } from "../../config.js";
import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import { applySetting } from "./apply.js";
import { availableJobs, jobOutcomeDict, runJob } from "./jobs.js";
import { settingSpecs, setupGaps } from "./spec.js";

export const SETUP_TOOL_NAMES = [
  "inspect_setup",
  "apply_setting",
  "request_credential",
  "run_setup_job",
] as const;

// Services whose configuration involves a secret → settings surface that owns
// the provider form (Praxis provider catalog services).
const CREDENTIAL_ROUTES: Record<string, { settings_path: string; label: string }> = {
  llm: { settings_path: "/settings", label: "chat model provider" },
  embedding: { settings_path: "/settings", label: "embedding model provider" },
  search: { settings_path: "/settings", label: "web search provider" },
  tts: { settings_path: "/settings", label: "text-to-speech provider" },
  stt: { settings_path: "/settings", label: "speech-to-text provider" },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function safeRead(spec: ReturnType<typeof settingSpecs>[number], settings: Settings): string {
  try {
    return spec.read(settings);
  } catch (exc) {
    return `error: ${exc instanceof Error ? exc.message : String(exc)}`;
  }
}

// --- inspect_setup ------------------------------------------------------------

export interface InspectSetupParams { area?: string }
export const inspectSetupParamsSchema: ToolParamsSchema = {
  type: "object",
  properties: {
    area: {
      type: "string",
      description:
        "Optional filter: 'general' (workspace, data dirs), 'models' (chat " +
        "model selection), 'runtime' (turns cap, title API). Omit for everything.",
      enum: ["general", "models", "runtime"],
      default: "",
    },
  },
};

export class InspectSetupTool extends BaseTool<InspectSetupParams> {
  name = "inspect_setup";
  toolIcon = "🩺";
  params = inspectSetupParamsSchema;
  mutating = false;
  description =
    "Read Praxis's own configuration: every setting you can change, its " +
    "current value, the other values it accepts, what changing it costs, " +
    "plus anything missing from this install and any setup jobs available. " +
    "Call this FIRST — before offering the user any configuration change — " +
    "so what you offer matches what this machine actually has.";

  async execute(p: InspectSetupParams, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const area = String(p.area ?? "").trim().toLowerCase();
    const rows = settingSpecs(area).map((spec) => {
      const current = safeRead(spec, settings);
      let currentLabel = current || "not set";
      try {
        const choices = spec.choices?.(settings) ?? [];
        const match = choices.find((c) => c.value === current);
        if (match) currentLabel = match.label;
      } catch {
        /* keep raw value */
      }
      let options: unknown[] = [];
      try {
        options = (spec.choices?.(settings) ?? []).map((c) => ({
          value: c.value,
          label: c.label,
          description: c.description,
        }));
      } catch {
        options = [];
      }
      return {
        key: spec.key,
        label: spec.label,
        area: spec.area,
        summary: spec.summary,
        writable: spec.writable,
        not_writable_because: spec.notWritableBecause ?? null,
        current,
        current_label: currentLabel,
        options,
      };
    });

    const jobs = availableJobs().map((job) => ({
      action: job.action,
      engine: job.engine,
      label: job.label,
      detail: job.detail,
      runnable: job.runnable,
      not_runnable_because: job.not_runnable_because ?? null,
    }));

    const payload = {
      settings: rows,
      gaps: setupGaps(settings),
      jobs_available: jobs,
    };
    return ok(JSON.stringify(payload));
  }
}

// --- apply_setting ------------------------------------------------------------

export interface ApplySettingParams { key: string; value: string }
export const applySettingParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["key", "value"],
  properties: {
    key: { type: "string", description: "Setting key exactly as reported by inspect_setup." },
    value: {
      type: "string",
      description: "One of that setting's option values (not its label).",
    },
  },
};

export class ApplySettingTool extends BaseTool<ApplySettingParams> {
  name = "apply_setting";
  toolIcon = "⚙️";
  params = applySettingParamsSchema;
  mutating = true;
  description =
    "Change one Praxis setting. The value must be one of the options " +
    "inspect_setup reported for that key. Confirm with the user before " +
    "calling this, then report the returned effect — runtime overrides take " +
    "effect immediately. To undo, call again with the returned 'previous'.";

  async execute(p: ApplySettingParams, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const key = String(p.key ?? "").trim();
    const value = String(p.value ?? "").trim();
    if (!key || !value) return fail("apply_setting needs both 'key' and 'value'.");
    const outcome = applySetting(settings, key, value);
    if (!outcome.ok) {
      return { success: false, result: JSON.stringify(outcome) };
    }
    return ok(JSON.stringify(outcome));
  }
}

// --- request_credential ---------------------------------------------------------

export interface RequestCredentialParams { service: string; reason?: string }
export const requestCredentialParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["service"],
  properties: {
    service: {
      type: "string",
      description: "Which provider needs credentials.",
      enum: ["llm", "embedding", "search", "tts", "stt"],
    },
    reason: {
      type: "string",
      description: "One line explaining to the user why this is needed.",
      default: "",
    },
  },
};

export class RequestCredentialTool extends BaseTool<RequestCredentialParams> {
  name = "request_credential";
  toolIcon = "🔑";
  params = requestCredentialParamsSchema;
  mutating = false;
  description =
    "Use when a change needs an API key, token or password. You must NEVER " +
    "ask the user to type a secret into the chat and must never handle one " +
    "yourself: this tells the user to open the settings page, where the " +
    "value is entered directly. Call it, tell the user what to do there, " +
    "and continue once they say they are done.";

  async execute(p: RequestCredentialParams, _ctx?: Ctx): Promise<ToolResult> {
    const service = String(p.service ?? "").trim().toLowerCase();
    const route = CREDENTIAL_ROUTES[service];
    if (!route) {
      return fail(
        `Unknown service '${service}'. Expected one of: ${Object.keys(CREDENTIAL_ROUTES).join(", ")}.`,
      );
    }
    const payload = {
      service,
      label: route.label,
      settings_path: route.settings_path,
      reason: String(p.reason ?? "").trim(),
      status: "handed_off",
      note:
        "Secrets are never entered through chat. Ask the user to open the " +
        "settings page and configure the provider there.",
    };
    return ok(JSON.stringify(payload));
  }
}

// --- run_setup_job ---------------------------------------------------------------

export interface RunSetupJobParams { action: string; engine?: string }
export const runSetupJobParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      description: "What to run.",
      enum: ["probe_tts", "check_ffmpeg", "install_engine", "download_models"],
    },
    engine: {
      type: "string",
      description: "Job engine id exactly as reported by inspect_setup.",
      default: "",
    },
  },
};

export class RunSetupJobTool extends BaseTool<RunSetupJobParams> {
  name = "run_setup_job";
  toolIcon = "🛠️";
  params = runSetupJobParamsSchema;
  mutating = true;
  description =
    "Run a setup job: 'probe_tts' verifies the text-to-speech engine and " +
    "reports which one answered; 'check_ffmpeg' verifies ffmpeg is on PATH. " +
    "Only jobs inspect_setup listed under 'jobs_available' can be run.";

  async execute(p: RunSetupJobParams, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const action = String(p.action ?? "").trim();
    const engine = String(p.engine ?? "").trim();
    if (!action) return fail("run_setup_job needs an 'action'.");
    const outcome = await runJob(settings, action, engine);
    const payload = jobOutcomeDict(outcome);
    if (!outcome.ok) {
      return { success: false, result: JSON.stringify(payload) };
    }
    return ok(JSON.stringify(payload));
  }
}

export const SETUP_TOOLS = [
  new InspectSetupTool(),
  new ApplySettingTool(),
  new RequestCredentialTool(),
  new RunSetupJobTool(),
];

export const SETUP_TOOL_TYPES = [
  InspectSetupTool,
  ApplySettingTool,
  RequestCredentialTool,
  RunSetupJobTool,
];

export { isRecord as _isRecord };
