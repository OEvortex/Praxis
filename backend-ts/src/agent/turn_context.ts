/**
 * Per-turn context available to tools that must know who is asking.
 *
 * Port of ``backend/app/agent/turn_context.py``.
 *
 * Tools are plain functions, so the session, workspace and bound notebook page
 * of the running turn are published in context variables instead of being passed
 * as tool arguments (the model must never choose them). ``AgentRuntime.start_turn``
 * sets them before it creates the turn task.
 *
 * Python ``contextvars.ContextVar`` is emulated with ``AsyncLocalStorage`` +
 * ``enterWith``: ``set`` returns a token and ``reset`` restores the previous
 * value. Because ``enterWith`` swaps the store for the *current* async context
 * only, async resources created earlier (e.g. a previous turn's task) keep their
 * own values — matching ContextVar's copy-on-write semantics closely enough for
 * the turn/task structure Praxis uses.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export class ContextVar<T> {
  private readonly als = new AsyncLocalStorage<T>();
  constructor(private readonly defaultValue: T) {}

  get(): T {
    const v = this.als.getStore();
    return v === undefined ? this.defaultValue : v;
  }

  /** Set the value in the current async context; returns a reset token. */
  set(value: T): { prev: T } {
    const prev = this.get();
    this.als.enterWith(value);
    return { prev };
  }

  reset(token: { prev: T }): void {
    this.als.enterWith(token.prev);
  }
}

export const current_session_id = new ContextVar<string>("");
export const current_workspace_id = new ContextVar<string>("");
export const current_note_document_id = new ContextVar<string>("");
export const current_note_block_id = new ContextVar<string>("");
export const current_note_generation_kind = new ContextVar<string>("");

export function set_turn_context(session_id: string, workspace_id: string): void {
  current_session_id.set(session_id || "");
  current_workspace_id.set(workspace_id || "");
}

export function set_note_context(
  note_document_id: string,
  block_id = "",
  generation_kind = "",
): void {
  /** Bind the turn to a notebook page (and optionally one block on it). */
  current_note_document_id.set(note_document_id || "");
  current_note_block_id.set(block_id || "");
  current_note_generation_kind.set(generation_kind || "");
}

/** ``(session_id, workspace_id)`` of the running turn; both may be empty. */
export function turn_context(): [string, string] {
  return [current_session_id.get(), current_workspace_id.get()];
}

/** ``(page_id, block_id, generation_kind)``; empty when not a note thread. */
export function note_context(): [string, string, string] {
  return [
    current_note_document_id.get(),
    current_note_block_id.get(),
    current_note_generation_kind.get(),
  ];
}
