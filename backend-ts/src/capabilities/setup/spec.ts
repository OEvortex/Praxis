// Port of deeptutor/services/config/settings_spec.py +
// capabilities/setup/binding.py (setup_gaps) — the spec rows the setup tools
// walk, and the "what is this install missing" report.
//
// Upstream walks a generic settings_spec registry; Praxis settings are
// env-driven with a small whitelisted runtime-override file
// (config.ts OVERRIDABLE_SETTINGS). The spec rows below expose exactly the
// settings apply_setting may change, plus read-only rows that report the
// state the model needs before offering anything.

import { existsSync, statSync } from "node:fs";
import type { Settings } from "../../config.js";
import { get_selection } from "../../provider-config.js";

export type SetupArea = "general" | "models" | "runtime";

export interface SettingOption {
  value: string;
  label: string;
  description: string;
}

export interface SettingSpec {
  key: string;
  label: string;
  area: SetupArea;
  summary: string;
  /** Whether apply_setting may write this row. */
  writable: boolean;
  notWritableBecause?: string;
  read(settings: Settings): string;
  choices?(settings: Settings): SettingOption[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// --- rows -------------------------------------------------------------------

const SPECS: SettingSpec[] = [
  {
    key: "workspace.dir",
    label: "Workspace directory",
    area: "general",
    summary:
      "Directory the file tools (read_file/write_file/…) are jailed to. " +
      "Changing it moves where the agent reads and writes files.",
    writable: true,
    read: (s) => s.workspace_dir,
    choices: (s) => [
      {
        value: s.workspace_dir,
        label: "Current directory",
        description: s.workspace_dir,
      },
    ],
  },
  {
    key: "runtime.max_turns",
    label: "Max agent turns per message",
    area: "runtime",
    summary:
      "Cap on agentic model turns per user turn. Higher allows longer " +
      "tasks but costs more tokens.",
    writable: true,
    read: (s) => String(s.max_turns),
    choices: () => [
      { value: "10", label: "10 turns", description: "Shorter, cheaper tasks." },
      { value: "25", label: "25 turns (default)", description: "Balanced." },
      { value: "50", label: "50 turns", description: "Long agentic tasks." },
    ],
  },
  {
    key: "titles.api_url",
    label: "Chat-title API",
    area: "runtime",
    summary:
      "Endpoint used to generate conversation titles. Set to 'off' to keep " +
      "truncated-first-message titles.",
    writable: true,
    read: (s) => s.title_api_url,
    choices: (s) => [
      { value: s.title_api_url, label: "Current endpoint", description: s.title_api_url },
      { value: "off", label: "Off", description: "Disable title generation." },
    ],
  },
  {
    key: "models.llm_selection",
    label: "Chat model",
    area: "models",
    summary:
      "The model provider/profile used for chat turns. Credentials and " +
      "model choice are managed on the settings page — the agent cannot " +
      "enter API keys or pick models from chat.",
    writable: false,
    notWritableBecause:
      "Model and credential changes happen on the settings page (use request_credential to hand off).",
    read: (s) => {
      try {
        const sel = get_selection(s);
        if (!isRecord(sel)) return "not set";
        const profile = String(sel["profile_id"] ?? "");
        const model = String(sel["model_id"] ?? "");
        return [profile, model].filter(Boolean).join(" / ") || "not set";
      } catch {
        return "not set";
      }
    },
  },
  {
    key: "data.dirs",
    label: "Data directories",
    area: "general",
    summary:
      "Where Praxis persists state (SQLite, sessions, files). Read-only — " +
      "set via PRAXIS_DATA_DIR before startup.",
    writable: false,
    notWritableBecause: "Set PRAXIS_DATA_DIR in the environment before starting.",
    read: (s) => `${s.data_dir} (db: ${s.sessions_db})`,
  },
];

export function settingSpecs(area?: string): SettingSpec[] {
  const wanted = String(area ?? "").trim().toLowerCase();
  if (!wanted) return SPECS;
  return SPECS.filter((spec) => spec.area === wanted);
}

export function findSpec(key: string): SettingSpec | null {
  return SPECS.find((spec) => spec.key === key) ?? null;
}

// --- gaps (binding.py setup_gaps port) --------------------------------------

export interface SetupGap {
  key: string;
  area: string;
  summary: string;
  remedy: string;
  blocking: boolean;
}

function dirExists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Capabilities the current configuration cannot deliver. Advisory only. */
export function setupGaps(settings: Settings): SetupGap[] {
  const gaps: SetupGap[] = [];

  // No chat model selected → nothing works.
  try {
    const sel = get_selection(settings);
    const hasModel =
      isRecord(sel) &&
      (Boolean(String(sel["profile_id"] ?? "")) || Boolean(String(sel["model_id"] ?? "")));
    if (!hasModel) {
      gaps.push({
        key: "models.llm_selection",
        area: "models",
        summary: "No chat model is selected.",
        remedy:
          "The assistant cannot answer until a model provider is configured on the settings page.",
        blocking: true,
      });
    }
  } catch {
    gaps.push({
      key: "models.llm_selection",
      area: "models",
      summary: "The model selection could not be read.",
      remedy: "Check the provider catalog on the settings page.",
      blocking: true,
    });
  }

  if (!dirExists(settings.workspace_dir)) {
    gaps.push({
      key: "workspace.dir",
      area: "general",
      summary: `The workspace directory does not exist: ${settings.workspace_dir}`,
      remedy: "Create it, or point workspace.dir at an existing directory.",
      blocking: false,
    });
  }
  if (!dirExists(settings.files_dir)) {
    gaps.push({
      key: "data.dirs",
      area: "general",
      summary: `The files directory does not exist yet: ${settings.files_dir}`,
      remedy: "It is created on first use; no action needed unless file outputs fail.",
      blocking: false,
    });
  }
  if (settings.title_api_url && settings.title_api_url !== "off" && !settings.title_api_url.startsWith("http")) {
    gaps.push({
      key: "titles.api_url",
      area: "runtime",
      summary: "The title API URL is not a valid http(s) endpoint.",
      remedy: "Set titles.api_url to a valid endpoint or 'off'.",
      blocking: false,
    });
  }
  return gaps;
}

// --- intent detection (binding.py port) --------------------------------------

const ACTION_PATTERN =
  /(设置|设定|配置|设好|设成|切换|切成|切到|换成|换到|换个|换掉|改成|改为|改用|调整|调成|启用|开启|安装|下载|装上|配一下|连上)|\b(configure|configuration|set ?up|setup|switch|change|enable|install|download|settings?)\b/i;

const OBJECT_PATTERN =
  /(语言|界面|主题|皮肤|模型|嵌入|向量|解析引擎|解析器|引擎|搜索引擎|搜索服务|联网搜索|偏好设置|设置项|工作区|目录)|\b(language|theme|model|embedding|parser|parsing|engine|web search|search provider|provider|preferences?|workspace|directory)\b/i;

const DIRECT_PATTERN =
  /(帮我配置|帮我设置|自己配置|配置一下|设置一下|初始化配置)|\b(configure praxis|set ?up praxis|setup wizard)\b/i;

export function messageSignalsSetup(message: string): boolean {
  const text = String(message ?? "");
  if (!text.trim()) return false;
  if (DIRECT_PATTERN.test(text)) return true;
  return ACTION_PATTERN.test(text) && OBJECT_PATTERN.test(text);
}
