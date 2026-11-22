// Port of consolidator/modes/_runtime.py — shared prompt loading, LLM calls,
// doc load/write + undo checkpoints.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Settings } from "../../../config.js";
import { get_settings } from "../../../config.js";
import {
  cleanThinkingTags,
  completeText,
  streamText,
} from "../../llm_text.js";
import {
  parse as parseDoc,
  serialize,
  newDocument,
  type Document,
} from "../document.js";
import {
  load_focus_meta,
  load_prompt,
  slot_focus,
  surface_focus,
} from "./prompts.js";
import { push_undo_checkpoint, type Run } from "./runs.js";
import type { Dict } from "../../../shared/types.js";

export type OnEvent = (event: Dict) => Promise<void> | void;

// Per-run context threaded through every mode (replaces upstream's
// activate_llm_selection ContextVar + get_llm_config() global).
export interface RunContext {
  settings: Settings;
  llm_selection?: Dict | null;
  run?: Run | null;
  signal?: AbortSignal | null;
}

export function make_context(
  opts: { llm_selection?: Dict | null; run?: Run | null; signal?: AbortSignal | null } = {},
): RunContext {
  return {
    settings: get_settings(),
    llm_selection: opts.llm_selection ?? null,
    run: opts.run ?? null,
    signal: opts.signal ?? null,
  };
}

export { load_prompt, load_focus_meta, surface_focus, slot_focus };

export function lang_code(language: string): string {
  return (language || "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export async function emit(onEvent: OnEvent | null | undefined, event: Dict): Promise<void> {
  if (!onEvent) return;
  try {
    await onEvent(event);
  } catch {
    // consumer errors must not kill the run
  }
}

function throwIfCancelled(ctx?: RunContext | null): void {
  if (ctx?.signal?.aborted) {
    const err = new Error("cancelled");
    err.name = "AbortError";
    throw err;
  }
}

export async function call_llm(
  args: {
    system_prompt: string;
    user_prompt: string;
    temperature?: number;
    max_tokens?: number;
    on_event?: OnEvent | null;
    turn?: number | null;
    chunk_index?: number | null;
    label?: string | null;
  },
  ctx?: RunContext | null,
): Promise<string> {
  const settings = ctx?.settings ?? get_settings();
  const llmSelection = ctx?.llm_selection ?? null;
  let modelLabel: string | null = null;
  try {
    const { resolve_runtime_model } = await import("../../../provider-config.js");
    const resolved = resolve_runtime_model(settings, {
      llm_selection: llmSelection ?? undefined,
    }) as Dict;
    modelLabel = resolved?.model ? String(resolved.model) : null;
  } catch {
    modelLabel = null;
  }

  const onEvent = args.on_event;
  if (onEvent) {
    await emit(onEvent, {
      stage: "llm_io_start",
      turn: args.turn ?? null,
      chunk_index: args.chunk_index ?? null,
      label: args.label ?? null,
      system_prompt: args.system_prompt,
      user_prompt: args.user_prompt,
      model: modelLabel,
    });
  }

  const responseParts: string[] = [];
  let inThinkBlock = false;
  try {
    for await (const delta of streamText(settings, {
      system: args.system_prompt,
      prompt: args.user_prompt,
      llm_selection: llmSelection,
    })) {
      throwIfCancelled(ctx);
      if (!delta) continue;
      responseParts.push(delta);
      const [visible, stillIn] = stripThinkingDelta(delta, inThinkBlock);
      inThinkBlock = stillIn;
      if (onEvent && visible) {
        await emit(onEvent, {
          stage: "llm_io_delta",
          turn: args.turn ?? null,
          chunk_index: args.chunk_index ?? null,
          label: args.label ?? null,
          delta: visible,
          model: modelLabel,
        });
      }
    }
    const response = cleanThinkingTags(responseParts.join(""));
    if (onEvent) {
      await emit(onEvent, {
        stage: "llm_io_end",
        turn: args.turn ?? null,
        chunk_index: args.chunk_index ?? null,
        label: args.label ?? null,
        response,
        error: null,
        model: modelLabel,
      });
    }
    return response;
  } catch (exc) {
    // Streaming unsupported on some providers → non-streaming fallback.
    try {
      const response = cleanThinkingTags(
        await completeText(settings, {
          system: args.system_prompt,
          prompt: args.user_prompt,
          llm_selection: llmSelection,
        }),
      );
      if (onEvent) {
        await emit(onEvent, {
          stage: "llm_io_delta",
          turn: args.turn ?? null,
          chunk_index: args.chunk_index ?? null,
          label: args.label ?? null,
          delta: response,
          model: modelLabel,
        });
        await emit(onEvent, {
          stage: "llm_io_end",
          turn: args.turn ?? null,
          chunk_index: args.chunk_index ?? null,
          label: args.label ?? null,
          response,
          error: null,
          model: modelLabel,
        });
      }
      return response;
    } catch (fallbackExc) {
      if (onEvent) {
        await emit(onEvent, {
          stage: "llm_io_end",
          turn: args.turn ?? null,
          chunk_index: args.chunk_index ?? null,
          label: args.label ?? null,
          response: "",
          error: String(fallbackExc),
          model: modelLabel,
        });
      }
      return "";
    }
  }
}

export function load_doc(path: string, opts: { default_title: string }): Document {
  if (!existsSync(path)) return newDocument(opts.default_title);
  try {
    return parseDoc(readFileSync(path, "utf-8"));
  } catch {
    return newDocument(opts.default_title);
  }
}

export function atomic_write_text(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, "utf-8");
  renameSync(tmp, path);
}

export async function write_doc_atomic(path: string, doc: Document): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  atomic_write_text(path, serialize(doc));
}

export async function write_doc_checkpoint(
  path: string,
  doc: Document,
  opts: {
    layer: string;
    key: string;
    on_event?: OnEvent | null;
    turn?: number | null;
    label?: string | null;
    action?: string;
  },
  ctx?: RunContext | null,
): Promise<number> {
  const existed = existsSync(path);
  const previous = existed ? readFileSync(path, "utf-8") : "";
  await write_doc_atomic(path, doc);
  const undoDepth = push_undo_checkpoint({
    layer: opts.layer,
    key: opts.key,
    path,
    existed,
    previous_content: previous,
    action: opts.action ?? "write",
    turn: opts.turn ?? null,
    label: opts.label ?? null,
    run: ctx?.run ?? null,
  });
  await emit(opts.on_event, {
    stage: "doc_updated",
    layer: opts.layer,
    key: opts.key,
    turn: opts.turn ?? null,
    label: opts.label ?? null,
    action: opts.action ?? "write",
    undo_depth: undoDepth,
  });
  return undoDepth;
}

function stripThinkingDelta(delta: string, inBlock: boolean): [string, boolean] {
  const out: string[] = [];
  let text = delta;
  while (text) {
    const lower = text.toLowerCase();
    if (inBlock) {
      let closeAt = lower.indexOf("</think>");
      let closeLen = "</think>".length;
      const altClose = lower.indexOf("</thinking>");
      if (altClose !== -1 && (closeAt === -1 || altClose < closeAt)) {
        closeAt = altClose;
        closeLen = "</thinking>".length;
      }
      if (closeAt === -1) return [out.join(""), true];
      text = text.slice(closeAt + closeLen);
      inBlock = false;
      continue;
    }
    let openAt = lower.indexOf("<think>");
    let openLen = "<think>".length;
    const altOpen = lower.indexOf("<thinking>");
    if (altOpen !== -1 && (openAt === -1 || altOpen < openAt)) {
      openAt = altOpen;
      openLen = "<thinking>".length;
    }
    if (openAt === -1) {
      out.push(text);
      break;
    }
    out.push(text.slice(0, openAt));
    text = text.slice(openAt + openLen);
    inBlock = true;
  }
  return [out.join(""), inBlock];
}

export function today_iso(): string {
  return new Date().toISOString().slice(0, 10);
}

// silence unused-import lint for join
void join;
