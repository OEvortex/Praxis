// Port of deeptutor/capabilities/handoff/capability.py — hand the turn over:
// a partner or a connected agent answers it, not the tutor.
//
// TS port notes / TODOs:
//  - Upstream forwards a partner's own stream events and relays a connected
//    agent's subagent-channel events. The TS backend has no partner manager
//    or subagent backend services yet, so ``run_partner`` / ``run_subagent``
//    are injectable hooks (TODO(partner-backend)); the stream writer, relay
//    and session-key plumbing are ported faithfully.
//  - ``_stage_images`` depends on the subagent tools' staging helper, which
//    is not ported; image forwarding is a TODO.

import { randomBytes } from "node:crypto";
import type { Dict } from "../../shared/types.js";

export const SOURCE = "handoff";
export const STAGE = "responding";

// The partner's own turn frames: its stages would nest inside ours, and its
// result and done would end our turn early. Everything else is its work.
const PARTNER_DROPPED = new Set([
  "stage_start",
  "stage_end",
  "result",
  "done",
  "session",
]);

// Instruction for an agent answering in the learner's conversation, when the
// user has not written their own. The consult default tells the agent it is
// being questioned by the tutor; here it is talking to the user.
export const HANDOFF_INSTRUCTION =
  "You are answering the user directly inside their conversation, " +
  "not in an interactive terminal. Your reply is shown to them as the answer. " +
  "Work the request through, then answer clearly and completely. Do not wait " +
  "for input; if something is ambiguous, state your assumption and proceed.";

export class HandoffError extends Error {
  error_code = "handoff_failed";
  retryable = true;
}

/** ``"partner:<id>"`` / ``"subagent:<connection>"`` → ``[kind, id]``. */
export function parse_answer_by(value: string | null | undefined): [string, string] | null {
  const idx = String(value ?? "").indexOf(":");
  if (idx === -1) return null;
  const kind = String(value ?? "").slice(0, idx);
  const target = String(value ?? "").slice(idx + 1).trim();
  if ((kind === "partner" || kind === "subagent") && target) return [kind, target];
  return null;
}

function _delegate(kind: string, target_id: string, name: string, look: Dict = {}): Dict {
  /** Who answers, as the transcript shows them. */
  const card: Dict = { kind, id: target_id, name: name || target_id };
  for (const [key, value] of Object.entries(look)) {
    if (value) card[key] = String(value);
  }
  return card;
}

function _delegate_meta(delegate: Dict): Dict {
  const meta: Dict = {};
  for (const [key, value] of Object.entries(delegate)) {
    meta[`delegate_${key}`] = value;
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Stream surface (minimal duck-typed port of upstream StreamBus usage)
// ---------------------------------------------------------------------------

export interface HandoffStream {
  stage?: (name: string, opts?: Dict) => Promise<unknown> | unknown;
  progress?: (text: string, opts?: Dict) => Promise<unknown> | unknown;
  content?: (delta: string, opts?: Dict) => Promise<unknown> | unknown;
  thinking?: (delta: string, opts?: Dict) => Promise<unknown> | unknown;
  tool_call?: (name: string, args: Dict, opts?: Dict) => Promise<unknown> | unknown;
  tool_result?: (name: string, body: string, opts?: Dict) => Promise<unknown> | unknown;
  error?: (text: string, opts?: Dict) => Promise<unknown> | unknown;
  emit?: (event: Dict) => Promise<unknown> | unknown;
}

function _trace_meta(call_id: string, delegate: Dict, extra: Dict = {}): Dict {
  return {
    call_id,
    phase: STAGE,
    label: String(delegate["name"] ?? ""),
    call_kind: "agent_loop_round",
    trace_id: call_id,
    trace_role: "response",
    trace_group: "stage",
    ..._delegate_meta(delegate),
    ...extra,
  };
}

/** Writes a delegate's run as rounds and tool rows on the turn's stream. */
export class HandoffWriter {
  round_id = "";
  rounds = 0;
  wrote = false;
  answer: string[] = [];

  constructor(
    public stream: HandoffStream,
    public delegate: Dict,
  ) {}

  private _meta(call_id: string, extra: Dict = {}): Dict {
    return _trace_meta(call_id, this.delegate, extra);
  }

  private async _open(): Promise<string> {
    if (!this.round_id) {
      this.rounds += 1;
      this.round_id = `handoff-${randomBytes(5).toString("hex")}`;
      await this.stream.progress?.(String(this.delegate["name"] ?? ""), {
        source: SOURCE,
        stage: STAGE,
        metadata: this._meta(this.round_id, {
          trace_kind: "call_status",
          call_state: "running",
        }),
      });
    }
    return this.round_id;
  }

  async close(role: string): Promise<void> {
    if (!this.round_id) return;
    const callId = this.round_id;
    this.round_id = "";
    await this.stream.progress?.(String(this.delegate["name"] ?? ""), {
      source: SOURCE,
      stage: STAGE,
      metadata: this._meta(callId, {
        trace_kind: "call_status",
        call_state: "complete",
        call_role: role,
        answer_visible: true,
      }),
    });
  }

  async text(delta: string): Promise<void> {
    if (!delta) return;
    const callId = await this._open();
    this.wrote = true;
    this.answer.push(delta);
    await this.stream.content?.(delta, {
      source: SOURCE,
      stage: STAGE,
      metadata: this._meta(callId),
    });
  }

  async thinking(delta: string): Promise<void> {
    if (!delta.trim()) return;
    const callId = await this._open();
    await this.stream.thinking?.(delta, {
      source: SOURCE,
      stage: STAGE,
      metadata: this._meta(callId),
    });
  }

  async tool(call_id: string, name: string, args: Dict): Promise<void> {
    await this.close("narration");
    const meta: Dict = {
      call_id,
      phase: STAGE,
      label: name,
      call_kind: "tool_planning",
      trace_id: call_id,
      trace_role: "tool",
      trace_group: "tool_call",
      tool_name: name,
      tool_call_id: call_id,
      ..._delegate_meta(this.delegate),
    };
    await this.stream.tool_call?.(name, args, {
      source: SOURCE,
      stage: STAGE,
      metadata: meta,
    });
    await this.stream.progress?.(name, {
      source: SOURCE,
      stage: STAGE,
      metadata: { ...meta, trace_kind: "call_status", call_state: "running" },
    });
  }

  async tool_result(call_id: string, name: string, body: string): Promise<void> {
    const meta: Dict = {
      call_id,
      phase: STAGE,
      label: name,
      call_kind: "tool_planning",
      trace_id: call_id,
      trace_role: "tool",
      trace_group: "tool_call",
      tool_name: name,
      tool_call_id: call_id,
    };
    await this.stream.tool_result?.(name, body, {
      source: SOURCE,
      stage: STAGE,
      metadata: meta,
    });
    await this.stream.progress?.(name, {
      source: SOURCE,
      stage: STAGE,
      metadata: { ...meta, trace_kind: "call_status", call_state: "complete" },
    });
  }
}

// ---------------------------------------------------------------------------
// Subagent-channel relay
// ---------------------------------------------------------------------------

const EVENT_TEXT = "text";
const EVENT_REASONING = "reasoning";
const EVENT_TOOL = "tool";
const EVENT_TOOL_RESULT = "tool_result";
const EVENT_ERROR = "error";

/** Turns subagent channel events into rounds and tool rows. */
export class AgentRelay {
  seen = new Map<string, string>();
  open_tools: [string, string][] = [];
  tool_names = new Map<string, string>();
  blocks = 0;

  constructor(public writer: HandoffWriter) {}

  async handle(event: { kind?: string; text?: string; meta?: Dict | null }): Promise<void> {
    const text = String(event.text ?? "");
    const kind = String(event.kind ?? "");
    const merge = String(event.meta?.["merge_id"] ?? "");
    if (kind === EVENT_TEXT || kind === EVENT_REASONING) {
      const delta = this._delta(merge ? `${kind}:${merge}` : "", text);
      if (kind === EVENT_TEXT) await this.writer.text(delta);
      else await this.writer.thinking(delta);
    } else if (kind === EVENT_TOOL && text.trim()) {
      if (merge && this.open_tools.some(([key]) => key === merge)) return;
      const trimmed = text.trim();
      const sp = trimmed.indexOf(" ");
      const name = (sp === -1 ? trimmed : trimmed.slice(0, sp)).replace(/:$/, "") || "tool";
      const rest = sp === -1 ? "" : trimmed.slice(sp + 1).trim();
      const callId = `handoff-tool-${randomBytes(5).toString("hex")}`;
      this.open_tools.push([merge || callId, callId]);
      this.tool_names.set(callId, name);
      await this.writer.tool(callId, name, rest ? { input: rest } : {});
    } else if (kind === EVENT_TOOL_RESULT) {
      if (!this.open_tools.length) return;
      const [, callId] = this.open_tools.shift()!;
      await this.writer.tool_result(callId, this.tool_names.get(callId) ?? "tool", text);
      this.tool_names.delete(callId);
    } else if (kind === EVENT_ERROR && text.trim()) {
      await this.writer.stream.error?.(text.trim(), {
        source: SOURCE,
        stage: STAGE,
        metadata: _delegate_meta(this.writer.delegate),
      });
    }
  }

  private _delta(key: string, running: string): string {
    if (!key) {
      this.blocks += 1;
      key = `block:${this.blocks}`;
    }
    const previous = this.seen.get(key);
    this.seen.set(key, running);
    if (previous === undefined) {
      // A new block after earlier writing starts a new paragraph.
      return (this.writer.wrote && running ? "\n\n" : "") + running;
    }
    if (running.startsWith(previous)) return running.slice(previous.length);
    return "";
  }

  async flush(): Promise<void> {
    while (this.open_tools.length) {
      const [, callId] = this.open_tools.shift()!;
      await this.writer.tool_result(callId, this.tool_names.get(callId) ?? "tool", "");
      this.tool_names.delete(callId);
    }
  }
}

// ---------------------------------------------------------------------------
// Session keys (upstream services.subagent.sessions)
// ---------------------------------------------------------------------------

/** Cross-turn registry key for this conversation + connection. */
export function session_key(chat_session_id: string, connection: string): string {
  return `${chat_session_id}:${connection}`;
}

const _SESSIONS = new Map<string, string>();

export function remember_session(key: string, session_id: string): void {
  _SESSIONS.set(key, session_id);
}

export function get_session(key: string): string | null {
  return _SESSIONS.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// Delegate targets — injectable backends (TODO: partner/subagent services)
// ---------------------------------------------------------------------------

export interface PartnerDelegateResult {
  writer: HandoffWriter;
  reply: string;
}

export interface SubagentDelegateResult {
  writer: HandoffWriter;
  reply: string;
}

export interface HandoffContext {
  session_id?: string;
  user_message?: string;
  attachments?: Dict[];
  metadata?: Dict | null;
  runtime?: { answer_by?: string | null };
}

let _partner_runner:
  | ((ctx: HandoffContext, stream: HandoffStream, partner_id: string, writer: HandoffWriter) => Promise<string>)
  | null = null;
let _subagent_runner:
  | ((ctx: HandoffContext, stream: HandoffStream, connection: string, writer: HandoffWriter) => Promise<string>)
  | null = null;

export function set_partner_runner(
  fn: NonNullable<typeof _partner_runner>,
): void {
  _partner_runner = fn;
}

export function set_subagent_runner(
  fn: NonNullable<typeof _subagent_runner>,
): void {
  _subagent_runner = fn;
}

/**
 * Run a handoff turn: parse the target, run the delegate, and return the
 * reply plus the writer (whose ``answer`` holds the streamed text).
 */
export async function run_handoff(
  context: HandoffContext,
  stream: HandoffStream,
): Promise<{ reply: string; delegate: Dict; writer: HandoffWriter }> {
  const target = parse_answer_by(context.runtime?.answer_by);
  if (target === null) {
    throw new HandoffError(
      `Nobody to hand this turn to: ${JSON.stringify(context.runtime?.answer_by ?? null)}`,
    );
  }
  const [kind, targetId] = target;
  let writer: HandoffWriter;
  let reply: string;
  await stream.stage?.(STAGE, { source: SOURCE });
  if (kind === "partner") {
    // TODO(partner-backend): resolve the partner card and run its chat loop,
    // forwarding events through _relay_partner once a partner manager exists.
    if (!_partner_runner) {
      throw new HandoffError(
        `Partner handoff is not wired in this backend yet ('${targetId}').`,
      );
    }
    writer = new HandoffWriter(stream, _delegate("partner", targetId, targetId));
    reply = await _partner_runner(context, stream, targetId, writer);
  } else {
    if (!_subagent_runner) {
      throw new HandoffError(
        `Connected-agent handoff is not wired in this backend yet ('${targetId}').`,
      );
    }
    writer = new HandoffWriter(stream, _delegate("subagent", targetId, targetId));
    reply = await _subagent_runner(context, stream, targetId, writer);
  }
  if (reply && !writer.wrote) {
    // Nothing streamed as text (a degenerate run): the reply is still the
    // answer, so it is written as the finishing round.
    await writer.text(reply);
  }
  await writer.close("finish");
  return { reply: reply || writer.answer.join(""), delegate: writer.delegate, writer };
}
