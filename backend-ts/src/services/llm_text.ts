// one-shot text generation for
// features that are not chat turns (Co-Writer AI edits, etc.). Resolves the
// same provider/model the chat turn would use and calls the provider wire
// protocol directly, streaming deltas when the caller wants them.
//
// Depends on src/provider-config.ts (port of app/provider_config.py) —
// `resolve_runtime_model` mirrors provider_config.resolve_runtime_model.
import { resolve_runtime_model } from "../provider-config.js";
import type { Settings } from "../config.js";
import { stripInlineReasoning } from "./inline_thinking.js";

const ANTHROPIC = "anthropic";
const RESPONSES = "openai-responses";

export function cleanThinkingTags(text: string): string {
  /** Drop inline reasoning blocks some models still emit in their text. */
  return stripInlineReasoning(text ?? "");
}

export interface ResolvedModel {
  provider?: string;
  model?: string;
  api_key?: string | null;
  base_url?: string | null;
  [k: string]: unknown;
}

export function resolve(settings: Settings, llmSelection?: Record<string, unknown> | null): ResolvedModel {
  const resolved = resolve_runtime_model(
    settings,
    llmSelection ? { llm_selection: llmSelection } : {},
  ) as ResolvedModel;
  if (!resolved.model) {
    throw new Error("No model configured — pick one in Settings → LLM");
  }
  return resolved;
}

function endpoint(baseUrl: string | null | undefined, suffix: string): string {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("This model has no base URL configured");
  if (!base.toLowerCase().startsWith("http://") && !base.toLowerCase().startsWith("https://")) {
    throw new Error(`Unsupported base URL: ${base}`);
  }
  return `${base}/${suffix.replace(/^\/+/, "")}`;
}

function anthropicBody(model: string, system: string, prompt: string, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  };
  if (system) body.system = system;
  if (stream) body.stream = true;
  return body;
}

function openaiBody(model: string, system: string, prompt: string, stream: boolean): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const body: Record<string, unknown> = { model, messages };
  if (stream) body.stream = true;
  return body;
}

/** Yield text deltas from the configured model. */
export async function* streamText(
  settings: Settings,
  args: {
    system: string;
    prompt: string;
    llm_selection?: Record<string, unknown> | null;
  },
): AsyncGenerator<string> {
  const resolved = resolve(settings, args.llm_selection);
  const provider = String(resolved.provider ?? "");
  const model = String(resolved.model ?? "");
  const key = resolved.api_key ? String(resolved.api_key) : "";

  let url: string;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;

  if (provider === ANTHROPIC) {
    url = endpoint(resolved.base_url, "messages");
    headers["anthropic-version"] = "2023-06-01";
    if (key) headers["x-api-key"] = key;
    body = anthropicBody(model, args.system, args.prompt, true);
  } else if (provider === RESPONSES) {
    url = endpoint(resolved.base_url, "responses");
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = { ...openaiBody(model, args.system, args.prompt, true), stream: true };
    body.input = [
      ...(args.system ? [{ role: "system", content: args.system }] : []),
      { role: "user", content: args.prompt },
    ];
    delete body.messages;
  } else {
    url = endpoint(resolved.base_url, "chat/completions");
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = openaiBody(model, args.system, args.prompt, true);
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body) {
    const detail = response.body
      ? (await response.text()).slice(0, 800)
      : `HTTP ${response.status}`;
    throw new Error(`${model} rejected the request (${response.status}): ${detail}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        continue;
      }
      const delta = deltaText(event, provider);
      if (delta) yield delta;
    }
  }
  // Flush a trailing line without a newline terminator.
  const tail = buffer.replace(/\r$/, "");
  if (tail.startsWith("data:")) {
    const payload = tail.slice(5).trim();
    if (payload && payload !== "[DONE]") {
      try {
        const event = JSON.parse(payload) as Record<string, unknown>;
        const delta = deltaText(event, provider);
        if (delta) yield delta;
      } catch { /* ignore */ }
    }
  }
}

function deltaText(event: Record<string, unknown>, provider: string): string {
  if (provider === ANTHROPIC) {
    if (event.type === "content_block_delta") {
      const delta = (event.delta ?? {}) as Record<string, unknown>;
      return String(delta.text ?? "");
    }
    return "";
  }
  if (provider === RESPONSES) {
    if (event.type === "response.output_text.delta" || event.type === "response.refusal.delta") {
      return String(event.delta ?? "");
    }
    return "";
  }
  const choices = (event.choices ?? []) as Array<Record<string, unknown>>;
  if (!choices.length) return "";
  const piece = (choices[0].delta ?? choices[0].message ?? {}) as Record<string, unknown>;
  const content = piece.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
      .map((part) => String(part.text ?? ""))
      .join("");
  }
  return "";
}

export async function completeText(
  settings: Settings,
  args: {
    system: string;
    prompt: string;
    llm_selection?: Record<string, unknown> | null;
  },
): Promise<string> {
  const chunks: string[] = [];
  for await (const delta of streamText(settings, args)) {
    chunks.push(delta);
  }
  return cleanThinkingTags(chunks.join(""));
}

// snake_case aliases mirroring the Python module surface.
export const clean_thinking_tags = cleanThinkingTags;
export const stream_text = streamText;
export const complete_text = completeText;
