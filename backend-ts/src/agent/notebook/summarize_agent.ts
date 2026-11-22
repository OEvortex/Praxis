// generates concise
// summaries for notebook records (favorites).
//
// Prompts live under deeptutor/agents/notebook/prompts/en/summarize_agent.yaml
// upstream; inlined here verbatim so the summarizer never hard-codes prompt
// strings at the call site.

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

const PROMPTS: Record<"en", SummarizePrompts> = {
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
  language: "en";
  private prompts: SummarizePrompts;

  constructor(language = "en") {
    this.language = "en";
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
