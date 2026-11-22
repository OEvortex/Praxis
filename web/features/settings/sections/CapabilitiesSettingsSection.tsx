"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";


import { apiFetch, apiUrl } from "@/shared/api/client";
import { EXTENSION_ENDPOINTS } from "@/lib/settings-extensions";
import {
  SettingRow,
  SettingSection,
  SettingsPageHeader,
  ToggleRow,
} from "@/components/settings/shared";
import { useSettings } from "@/features/settings/store/SettingsStore";

// ── Shape mirrors praxis/services/config/capabilities_settings.py ──────

interface SimpleLLMBlock {
  temperature: number;
  max_tokens: number;
}

interface ChatBlock {
  temperature: number;
  max_rounds: number;
  stage_budgets: {
    exploring: number;
    responding: number;
  };
}

interface ResearchExtras {
  researching: {
    note_agent_mode: string;
    tool_timeout: number;
    tool_max_retries: number;
    paper_search_years_limit: number;
  };
}

interface QuestionExtras {
  exploring: {
    max_iterations: number;
    tool_summarizer: {
      enabled: boolean;
      max_tokens: number;
    };
  };
}

interface SolveExtras {
  max_rounds: number;
  max_replans: number;
}

interface CapabilitiesSettingsDTO {
  chat: ChatBlock;
  solve: SimpleLLMBlock & SolveExtras;
  research: SimpleLLMBlock & ResearchExtras;
  question: SimpleLLMBlock & QuestionExtras;
  co_writer: SimpleLLMBlock;
  vision_solver: SimpleLLMBlock;
  math_animator: SimpleLLMBlock;
  visualize: SimpleLLMBlock;
}

function isValidCapabilitiesDTO(
  value: unknown,
): value is CapabilitiesSettingsDTO {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const chat = v.chat as Record<string, unknown> | undefined;
  const solve = v.solve as Record<string, unknown> | undefined;
  return (
    !!chat &&
    typeof chat.temperature === "number" &&
    typeof chat.max_rounds === "number" &&
    !!chat.stage_budgets &&
    !!solve &&
    typeof solve.max_rounds === "number" &&
    typeof solve.max_replans === "number" &&
    !!v.research &&
    !!v.question &&
    !!v.visualize
  );
}

export default function CapabilitiesSettingsPage() {
  
  const { registerExtension, pendingExtensionPayload, draftRevision } =
    useSettings();
  const [settings, setSettings] = useState<CapabilitiesSettingsDTO | null>(
    null,
  );
  const [serverSnapshot, setServerSnapshot] =
    useState<CapabilitiesSettingsDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch(apiUrl(EXTENSION_ENDPOINTS.capabilities));
      if (!res.ok) {
        setLoadError(
          `Failed to load capability settings (HTTP ${res.status}). Make sure the backend is running the latest build — the /api/capabilities/settings endpoint was added in this release.`,
        );
        return;
      }
      const data: unknown = await res.json();
      if (!isValidCapabilitiesDTO(data)) {
        setLoadError(
          "The backend returned an unexpected payload for /api/capabilities/settings. Restart the backend to pick up the latest schema.",
        );
        return;
      }
      const pending = pendingExtensionPayload("capabilities") as
        | CapabilitiesSettingsDTO
        | undefined;
      setSettings(pending ?? data);
      setServerSnapshot(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof Error
          ? err.message
          : "Failed to load capability settings.",
      );
    }
  }, [pendingExtensionPayload]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
    // Re-read when a draft is discarded so the page drops its stale copy.
  }, [draftRevision, load]);

  const dirty =
    !!settings &&
    !!serverSnapshot &&
    JSON.stringify(settings) !== JSON.stringify(serverSnapshot);

  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const save = useCallback(async () => {
    const current = settingsRef.current;
    if (!current) return;
    const res = await apiFetch(apiUrl(EXTENSION_ENDPOINTS.capabilities), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    });
    if (!res.ok) {
      throw new Error(
        `Failed to save capability settings (HTTP ${res.status})`,
      );
    }
    const data: unknown = await res.json();
    if (!isValidCapabilitiesDTO(data)) {
      throw new Error("Backend returned an unexpected payload after save.");
    }
    setSettings(data);
    setServerSnapshot(data);
  }, []);

  useEffect(() => {
    registerExtension("capabilities", { dirty, save, payload: settings });
    return () => registerExtension("capabilities", null);
  }, [dirty, save, settings, registerExtension]);

  function patchChat<K extends keyof ChatBlock>(key: K, value: ChatBlock[K]) {
    if (!settings) return;
    setSettings({ ...settings, chat: { ...settings.chat, [key]: value } });
  }

  function patchStageBudget(
    stage: keyof ChatBlock["stage_budgets"],
    value: number,
  ) {
    if (!settings) return;
    setSettings({
      ...settings,
      chat: {
        ...settings.chat,
        stage_budgets: { ...settings.chat.stage_budgets, [stage]: value },
      },
    });
  }

  function patchSimple(
    cap:
      | "solve"
      | "co_writer"
      | "vision_solver"
      | "math_animator"
      | "visualize",
    value: Partial<SimpleLLMBlock>,
  ) {
    if (!settings) return;
    setSettings({ ...settings, [cap]: { ...settings[cap], ...value } });
  }

  function patchSolveExtras(value: Partial<SolveExtras>) {
    if (!settings) return;
    setSettings({ ...settings, solve: { ...settings.solve, ...value } });
  }

  function patchResearch(value: Partial<SimpleLLMBlock>) {
    if (!settings) return;
    setSettings({ ...settings, research: { ...settings.research, ...value } });
  }

  function patchResearching(value: Partial<ResearchExtras["researching"]>) {
    if (!settings) return;
    setSettings({
      ...settings,
      research: {
        ...settings.research,
        researching: { ...settings.research.researching, ...value },
      },
    });
  }

  function patchQuestion(value: Partial<SimpleLLMBlock>) {
    if (!settings) return;
    setSettings({ ...settings, question: { ...settings.question, ...value } });
  }

  function patchExploring(value: Partial<QuestionExtras["exploring"]>) {
    if (!settings) return;
    setSettings({
      ...settings,
      question: {
        ...settings.question,
        exploring: { ...settings.question.exploring, ...value },
      },
    });
  }

  function patchExploringSummarizer(
    value: Partial<QuestionExtras["exploring"]["tool_summarizer"]>,
  ) {
    if (!settings) return;
    setSettings({
      ...settings,
      question: {
        ...settings.question,
        exploring: {
          ...settings.question.exploring,
          tool_summarizer: {
            ...settings.question.exploring.tool_summarizer,
            ...value,
          },
        },
      },
    });
  }

  if (loadError) {
    return (
      <div className="grid h-[60vh] place-items-center px-6">
        <div className="max-w-xl rounded-lg border border-[var(--border)] bg-[var(--background)] p-4 text-[13px] text-[var(--muted-foreground)]">
          <div className="mb-2 font-medium text-[var(--foreground)]">
            {"Couldn't load capability settings"}
          </div>
          <div>{loadError}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-md border border-[var(--border)] bg-[var(--card)] px-3 py-1 text-[12px] hover:bg-[var(--muted)]"
          >
            {"Retry"}
          </button>
        </div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="grid h-[60vh] place-items-center text-[13px] text-[var(--muted-foreground)]">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <div data-tour="tour-capabilities">
      <SettingsPageHeader
        title={"Capabilities"}
        description={"Per-capability LLM parameters and runtime knobs."}
      />

      <SettingSection
        title={"Chat"}
        description={"Exploring agent loop followed by a respond stage. Stage budgets cap max_tokens per LLM round."}
      >
        <NumberRow
          label={"Temperature"}
          help={"Sampling temperature shared across every chat stage."}
          value={settings.chat.temperature}
          onChange={(n) => patchChat("temperature", n)}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max rounds"}
          help={"Hard cap on exploring-loop LLM rounds per turn. A round without tool calls ends the loop early."}
          value={settings.chat.max_rounds}
          onChange={(n) => patchChat("max_rounds", n)}
          min={1}
          max={50}
        />
        <NumberRow
          label={"Exploring (max tokens)"}
          help={"Budget per exploring-loop round (notes + tool calls)."}
          value={settings.chat.stage_budgets.exploring}
          onChange={(n) => patchStageBudget("exploring", n)}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={"Responding (max tokens)"}
          help={"Budget for the final user-facing response."}
          value={settings.chat.stage_budgets.responding}
          onChange={(n) => patchStageBudget("responding", n)}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={"Solve"}
        description={"Deep solve runs as one agent loop with a plan / finish-step / replan spine."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.solve.temperature}
          onChange={(n) => patchSimple("solve", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          value={settings.solve.max_tokens}
          onChange={(n) => patchSimple("solve", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={"Max rounds"}
          help={"Total LLM-round budget for one solve turn (plan, tool calls and finishing all count)."}
          value={settings.solve.max_rounds}
          onChange={(n) => patchSolveExtras({ max_rounds: n })}
          min={1}
          max={50}
        />
        <NumberRow
          label={"Max replans"}
          help={"How many times the planner may revise the plan within one turn."}
          value={settings.solve.max_replans}
          onChange={(n) => patchSolveExtras({ max_replans: n })}
          min={0}
          max={10}
        />
      </SettingSection>

      <SettingSection
        title={"Question"}
        description={"Deep question (quiz) generation pipeline."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.question.temperature}
          onChange={(n) => patchQuestion({ temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          value={settings.question.max_tokens}
          onChange={(n) => patchQuestion({ max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={"Explore max iterations"}
          help={"Cap on the explore loop before planning."}
          value={settings.question.exploring.max_iterations}
          onChange={(n) => patchExploring({ max_iterations: n })}
          min={1}
          max={50}
        />
        <ToggleRow
          label={"Tool summarizer enabled"}
          help={"Summarize long tool outputs to keep the prompt budget low."}
          value={settings.question.exploring.tool_summarizer.enabled}
          onChange={(v) => patchExploringSummarizer({ enabled: v })}
        />
        <NumberRow
          label={"Tool summarizer (max tokens)"}
          value={settings.question.exploring.tool_summarizer.max_tokens}
          onChange={(n) => patchExploringSummarizer({ max_tokens: n })}
          min={128}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={"Research"}
        description={"Deep research pipeline. Iteration count is controlled per request via the depth selector (quick / standard / deep / manual) in the chat input, not here."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.research.temperature}
          onChange={(n) => patchResearch({ temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          value={settings.research.max_tokens}
          onChange={(n) => patchResearch({ max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
        <NumberRow
          label={"Tool timeout (s)"}
          help={"Per-tool wall-clock timeout for the researching phase."}
          value={settings.research.researching.tool_timeout}
          onChange={(n) => patchResearching({ tool_timeout: n })}
          min={1}
          max={600}
        />
        <NumberRow
          label={"Tool max retries"}
          value={settings.research.researching.tool_max_retries}
          onChange={(n) => patchResearching({ tool_max_retries: n })}
          min={0}
          max={10}
        />
        <NumberRow
          label={"Paper search years limit"}
          help={"How far back paper search will scan."}
          value={settings.research.researching.paper_search_years_limit}
          onChange={(n) => patchResearching({ paper_search_years_limit: n })}
          min={1}
          max={50}
        />
      </SettingSection>

      <SettingSection
        title={"Math animator"}
        description={"Manim animation / image generation pipeline."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.math_animator.temperature}
          onChange={(n) => patchSimple("math_animator", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          value={settings.math_animator.max_tokens}
          onChange={(n) => patchSimple("math_animator", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={"Visualize"}
        description={"SVG / chart / diagram generation loop."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.visualize.temperature}
          onChange={(n) => patchSimple("visualize", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          help={"A reasoning model can spend most of this on internal reasoning; raise it if a canvas comes back empty."}
          value={settings.visualize.max_tokens}
          onChange={(n) => patchSimple("visualize", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>

      <SettingSection
        title={"Co-writer"}
        description={"Selection edit / inline rewrite agent."}
      >
        <NumberRow
          label={"Temperature"}
          value={settings.co_writer.temperature}
          onChange={(n) => patchSimple("co_writer", { temperature: n })}
          min={0}
          max={2}
          step={0.05}
          isFloat
        />
        <NumberRow
          label={"Max tokens"}
          value={settings.co_writer.max_tokens}
          onChange={(n) => patchSimple("co_writer", { max_tokens: n })}
          min={256}
          max={200000}
          step={100}
        />
      </SettingSection>
    </div>
  );
}

// ── Field components (mirrors memory page) ─────────────────────────────

interface NumberRowProps {
  label: string;
  help?: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  isFloat?: boolean;
}

function NumberRow({
  label,
  help,
  value,
  onChange,
  min,
  max,
  step = 1,
  isFloat = false,
}: NumberRowProps) {
  return (
    <SettingRow
      title={label}
      description={help}
      control={
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "") return;
            const n = isFloat ? parseFloat(raw) : parseInt(raw, 10);
            if (!Number.isNaN(n)) onChange(n);
          }}
          className="w-28 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-right text-[12px] outline-none focus:border-[var(--primary)]"
        />
      }
    />
  );
}


