// Port of deeptutor/agents/notebook/summarize_agent.py — generates concise
// summaries for notebook records (favorites).
//
// Prompts live under deeptutor/agents/notebook/prompts/{en,zh}/summarize_agent.yaml
// upstream; inlined here verbatim so the summarizer follows the same bilingual
// convention and never hard-codes prompt strings at the call site.

import { get_settings } from "../../config.js";
import { cleanThinkingTags, streamText } from "../../services/llm_text.js";
import type { Dict } from "../../shared/types.js";

function clipText(value: unknown, limit: number): string {
  /** Trim prose to `limit` characters, saying so when anything was cut. */
  const text = String(value ?? "").trim();
  if ([...text].length <= limit) return text;
  return [...text].slice(0, limit).join("").replace(/\s+$/, "") + "\n...[truncated]";
}

interface SummarizePrompts {
  system: string;
  user_template: string;
  record_hints: Dict;
}

const PROMPTS: Record<"en" | "zh", SummarizePrompts> = {
  en: {
    system: `You are DeepTutor's notebook summary agent. Compress a saved record into a
concise, retrieval-friendly summary for future reuse. Focus on topic, key
conclusions, use cases, and why this record matters. Output only the summary
text with no heading or bullets.`,
    user_template: `Record type: {record_type}
Type hint: {record_hint}
Title: {title}
User input:
{user_query}

Saved content:
{output}

Metadata: {metadata}

Write an 80-180 word summary. Focus on the topic, key information, current
completion state, and what makes this record useful for future reuse.`,
    record_hints: {
      chat: "A full chat transcript; focus on the question, conclusion, and next actions.",
      tutorbot: "A conversation with a Partner (a named AI assistant); focus on what was asked, the Partner's conclusion, and any next actions.",
      guided_learning: "A guided learning record; focus on topic, knowledge structure, and partial/final output.",
      co_writer: "A Co-Writer markdown draft authored by the user; focus on the document's topic, structure, current completion state, and what makes it worth revisiting.",
      default: "Summarize the most reusable information in this record.",
    },
  },
  zh: {
    system: `你是 DeepTutor 的 notebook summary agent。请把一条待保存内容提炼成简洁、可检索、
面向未来复用的摘要。摘要必须突出主题、关键结论、适用场景和保存价值。
只输出摘要正文，不要加标题、前缀或项目符号。`,
    user_template: `记录类型：{record_type}
类型提示：{record_hint}
标题：{title}
用户输入：
{user_query}

保存内容：
{output}

元数据：{metadata}

请输出 80-180 字的中文摘要。要求：
1. 优先概括知识主题与关键信息；
2. 如果内容是草稿或中间过程，要说明当前完成度；
3. 如果内容适合后续复用，要点明可复用角度。`,
    record_hints: {
      chat: "一段完整聊天历史，重点提炼问题、结论与后续行动。",
      tutorbot: "一段与 Partner（具名 AI 助手）的对话，重点提炼提出的问题、Partner 给出的结论与后续行动。",
      guided_learning: "一段引导式学习记录，重点提炼学习主题、知识点结构与阶段性产出。",
      co_writer: "一份用户在 Co-Writer 中撰写的 Markdown 草稿，重点提炼文档主题、结构骨架、当前完成度，以及后续值得回顾的部分。",
      default: "请总结此记录中最值得复用的信息。",
    },
  },
};

function formatTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) =>
    key in values ? values[key] : `{${key}}`,
  );
}

export class NotebookSummarizeAgent {
  language: "en" | "zh";
  private prompts: SummarizePrompts;

  constructor(language = "en") {
    this.language = String(language || "en").toLowerCase().startsWith("zh")
      ? "zh"
      : "en";
    this.prompts = PROMPTS[this.language];
  }

  async summarize(opts: {
    title: string;
    record_type: string;
    user_query: string;
    output: string;
    metadata?: Dict | null;
  }): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this.stream_summary(opts)) {
      if (chunk) chunks.push(chunk);
    }
    return cleanThinkingTags(chunks.join("")).trim();
  }

  async *stream_summary(opts: {
    title: string;
    record_type: string;
    user_query: string;
    output: string;
    metadata?: Dict | null;
  }): AsyncGenerator<string> {
    const prompt = this._build_user_prompt(opts);
    const settings = get_settings();
    for await (const chunk of streamText(settings, {
      system: this.prompts.system.trim(),
      prompt,
    })) {
      if (chunk) yield chunk;
    }
  }

  private _build_user_prompt(opts: {
    title: string;
    record_type: string;
    user_query: string;
    output: string;
    metadata?: Dict | null;
  }): string {
    const clipped_query = clipText(opts.user_query, 1200) || "(empty)";
    const clipped_output = clipText(opts.output, 6000) || "(empty)";
    const clipped_metadata =
      clipText(String(opts.metadata ?? {}), 1000) || "(none)";
    const hints = this.prompts.record_hints;
    const hint =
      typeof hints[opts.record_type] === "string"
        ? String(hints[opts.record_type])
        : String(hints["default"] ?? "");
    return formatTemplate(this.prompts.user_template.trim(), {
      record_type: opts.record_type,
      record_hint: hint,
      title: opts.title || "(untitled)",
      user_query: clipped_query,
      output: clipped_output,
      metadata: clipped_metadata,
    });
  }
}
