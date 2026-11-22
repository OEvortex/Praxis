//
// Notebook analysis agent — ported from
// reff/deeptutor/agents/notebook/analysis_agent.py.
//
// A three-stage grounding pipeline (thinking → acting → observing) that
// turns a small catalog of saved notebook records into a compact context
// note for the main capability. The `notebook_lookup` emission is a
// trace-only pseudo-tool, exactly as upstream: it is never registered in
// the tool registry.

import { get_settings, type Settings } from "../../config.js";
import { cleanThinkingTags, streamText } from "../../services/llm_text.js";
import type { Dict } from "../../shared/types.js";

export type NotebookEvent = {
  type: string;
  source: string;
  stage?: string;
  content?: string;
  metadata?: Dict;
};

export type NotebookEventSink = (event: NotebookEvent) => void | Promise<void>;

interface StagePrompts {
  system: string;
  user_template: string;
}

interface AnalysisPrompts {
  thinking: StagePrompts;
  acting: StagePrompts;
  observing: StagePrompts;
}

const MAX_SELECTED_RECORDS = 5;
const CATALOG_CLIP = 400;
const DETAIL_CLIP = 2500;

const EN: AnalysisPrompts = {
  thinking: {
    system:
      "You are the notebook thinking stage. Review the user question and " +
      "notebook summaries, then reason about which saved records matter " +
      "most. Output internal reasoning only, not the final answer.",
    user_template:
      "User question:\n{user_question}\n\nAvailable notebook summaries:\n{catalog}\n\n" +
      "Reason about which saved records matter most and which ones likely " +
      "require full detail.",
  },
  acting: {
    system:
      'You are the notebook acting stage. Output JSON only: {"selected_record_ids": [up to 5 ids]}. ' +
      "Choose the records most useful for the current question.",
    user_template:
      "User question:\n{user_question}\n\n[Thinking]\n{thinking_text}\n\n" +
      "Available records:\n{catalog}\n\n" +
      "Return only the ids of the records whose full details should be inspected, up to 5.",
  },
  observing: {
    system:
      "You are the notebook observing stage. Synthesize the user question, " +
      "the prior reasoning, and the selected record details into a compact " +
      "context note for the main capability. Distinguish confirmed facts, " +
      "reusable material, and uncertainties.",
    user_template:
      "User question:\n{user_question}\n\n[Thinking]\n{thinking_text}\n\n" +
      "[Detailed Records]\n{detailed_blocks}\n\n" +
      "Produce the notebook analysis output that will be injected into the " +
      "main capability. Include directly relevant history, reusable " +
      "conclusions or drafts, and any caveats.",
  },
};

const ZH: AnalysisPrompts = {
  thinking: {
    system:
      "你是笔记本的 thinking 阶段。阅读用户问题和笔记本摘要，推理哪些保存的记录最重要。" +
      "只输出内部推理，不要输出最终答案。",
    user_template:
      "用户问题：\n{user_question}\n\n可用的笔记本摘要：\n{catalog}\n\n" +
      "推理哪些保存的记录最重要、哪些可能需要完整内容。",
  },
  acting: {
    system:
      '你是笔记本的 acting 阶段。只输出 JSON：{"selected_record_ids": [最多 5 个 id]}。' +
      "选择对当前问题最有用的记录。",
    user_template:
      "用户问题：\n{user_question}\n\n[思考]\n{thinking_text}\n\n" +
      "可用记录：\n{catalog}\n\n只输出需要查看完整内容的记录 id，最多 5 个。",
  },
  observing: {
    system:
      "你是笔记本的 observing 阶段。把用户问题、之前的推理和所选记录详情综合成" +
      "给主能力的紧凑上下文说明。区分已确认事实、可复用材料和不确定之处。",
    user_template:
      "用户问题：\n{user_question}\n\n[思考]\n{thinking_text}\n\n" +
      "[详细记录]\n{detailed_blocks}\n\n" +
      "输出将注入主能力的笔记分析结果，包含直接相关的历史、可复用的结论或草稿，以及注意事项。",
  },
};

function formatTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key) =>
    key in values ? values[key] : `{${key}}`,
  );
}

function clip(value: unknown, limit: number): string {
  const text = String(value ?? "").trim();
  if (text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+$/, "") + "\n...[truncated]";
}

function parseSelection(raw: string): string[] {
  let parsed: unknown = raw;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const ids = (parsed as Dict)["selected_record_ids"];
  if (!Array.isArray(ids)) return [];
  return ids.map(String).filter(Boolean);
}

export class NotebookAnalysisAgent {
  private readonly prompts: AnalysisPrompts;
  private readonly settings: Settings;

  constructor(
    language = "en",
    settings: Settings = get_settings(),
  ) {
    this.prompts = String(language ?? "en").toLowerCase().startsWith("zh")
      ? ZH
      : EN;
    this.settings = settings;
  }

  /** Run all three stages and return the observation injected into the turn. */
  async analyze(
    userQuestion: string,
    records: Dict[],
    emit?: NotebookEventSink,
  ): Promise<string> {
    const thinking = await this.stage(
      "thinking",
      "notebook_thinking",
      "reasoning",
      userQuestion,
      "",
      records,
      emit,
    );

    const actingText = await this.stage(
      "acting",
      "notebook_acting",
      "planning",
      userQuestion,
      thinking,
      records,
      emit,
    );

    const wanted = parseSelection(actingText).slice(0, MAX_SELECTED_RECORDS);
    const byId = new Map(records.map((r) => [String(r["id"] ?? ""), r]));
    const selected: Dict[] = [];
    const seen = new Set<string>();
    for (const id of wanted) {
      const record = byId.get(id);
      if (record && !seen.has(id)) {
        seen.add(id);
        selected.push(record);
      }
    }
    if (!selected.length) {
      for (const record of records.slice(0, MAX_SELECTED_RECORDS)) {
        selected.push(record);
      }
    }

    if (emit) {
      await emit({
        type: "tool_call",
        source: "notebook_analysis",
        stage: "notebook_acting",
        content: "notebook_lookup",
        metadata: {
          args: { selected_record_ids: selected.map((r) => String(r["id"] ?? "")) },
        },
      });
      await emit({
        type: "tool_result",
        source: "notebook_analysis",
        stage: "notebook_acting",
        content: this.toolResultText(selected),
      });
    }

    return this.stage(
      "observing",
      "notebook_observing",
      "observation",
      userQuestion,
      thinking,
      selected,
      emit,
    );
  }

  private async stage(
    stage: keyof AnalysisPrompts,
    stageName: string,
    traceKind: string,
    userQuestion: string,
    thinkingText: string,
    records: Dict[],
    emit?: NotebookEventSink,
  ): Promise<string> {
    const prompt = this.prompts[stage];
    const values: Record<string, string> = {
      user_question: clip(userQuestion, 6000),
      thinking_text: thinkingText,
      catalog: this.catalog(records),
      detailed_blocks: this.details(records),
    };
    if (emit) {
      await emit({
        type: "stage_start",
        source: "notebook_analysis",
        stage: stageName,
        metadata: { trace_kind: traceKind },
      });
    }
    let text = "";
    for await (const delta of streamText(this.settings, {
      system: prompt.system,
      prompt: formatTemplate(prompt.user_template, values),
    })) {
      if (!delta) continue;
      text += delta;
      if (emit && stage !== "acting") {
        await emit({
          type: stage === "thinking" ? "thinking" : "observation",
          source: "notebook_analysis",
          stage: stageName,
          content: delta,
          metadata: { trace_kind: traceKind },
        });
      }
    }
    if (emit) {
      await emit({
        type: "stage_end",
        source: "notebook_analysis",
        stage: stageName,
        metadata: { trace_kind: traceKind },
      });
    }
    return cleanThinkingTags(text).trim();
  }

  private catalog(records: Dict[]): string {
    return records
      .map((r) => {
        const notebook = String(r["notebook_name"] ?? r["notebook_id"] ?? "");
        return (
          `id=${String(r["id"] ?? "")} | notebook=${notebook} | ` +
          `type=${String(r["type"] ?? "")} | title=${clip(r["title"], CATALOG_CLIP)} | ` +
          `summary=${clip(r["summary"], CATALOG_CLIP)}`
        );
      })
      .join("\n");
  }

  private details(records: Dict[]): string {
    return records
      .map((r) =>
        [
          `Record ID: ${String(r["id"] ?? "")}`,
          `Notebook: ${String(r["notebook_name"] ?? r["notebook_id"] ?? "")}`,
          `Title: ${String(r["title"] ?? "")}`,
          `Summary: ${String(r["summary"] ?? "")}`,
          `Content: ${clip(r["output"], DETAIL_CLIP)}`,
        ].join("\n"),
      )
      .join("\n\n");
  }

  private toolResultText(records: Dict[]): string {
    return records
      .map(
        (r) =>
          `id=${String(r["id"] ?? "")} title=${clip(r["title"], CATALOG_CLIP)}\n` +
          clip(r["output"], DETAIL_CLIP),
      )
      .join("\n\n");
  }
}

export const notebookAnalysisAgent = (language = "en"): NotebookAnalysisAgent =>
  new NotebookAnalysisAgent(language);
