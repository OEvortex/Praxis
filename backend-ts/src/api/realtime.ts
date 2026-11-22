/**
 * REST + SSE transport for turns and legacy feature channels.
 *
 * There is no ACP / JSON-RPC layer: command bodies are the frontend's native
 * protocol objects, and outbound frames are the raw event objects the frontend's
 * `parseTurnEvent` expects. The endpoints are:
 *
 * * ``POST /api/realtime/commands`` — one turn command, or a legacy channel
 *   message when ``?channel=<name>`` is present.
 * * ``GET /api/realtime/events?client_id=<id>`` — ``text/event-stream`` carrying
 *   the client's outbound frames as named SSE events.
 *
 * Each client gets its own controller and event queue, so events are scoped to
 * the client that issued the command.
 *
 * NOTE: the original implementation is SSE-only (no WebSocket endpoint); the `ws`
 * dependency is not needed here. The channel/subscription logic
 * (judge/books/mastery/progress channels, seq-based event replay, post-done
 * grace forwarding) is ported faithfully below.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";

import { TurnEventQueue } from "../agent/runtime.js";
import type { AgentRuntime, TurnHandle } from "../agent/runtime.js";
import type { SessionStore } from "../store/session_store.js";
import type { Dict } from "../shared/types.js";

// -- constants -----------------------------------------------------------------

const HEARTBEAT_SECONDS = 15;
// How long a pump keeps forwarding after ``done`` while the runtime finishes
// post-turn work (the generated chat title). The browser client holds its socket
// for 15s after done for exactly this reason, so stay just inside it.
const POST_DONE_GRACE_SECONDS = 12.0;
const CLIENT_IDLE_SECONDS = 15 * 60;
const SWEEP_SECONDS = 60;
const MAX_QUEUE = 2000;
const MAX_PUMP_QUEUE = 1000;

// -- async queue (asyncio.Queue port for the client outbound buffer) -------------

class QueueClosedError extends Error {
  constructor() {
    super("QueueClosed");
    this.name = "QueueClosed";
  }
}

/**
 * Bounded async queue for a client's outbound SSE frames.
 * ``putDropOldest`` mirrors ``emit``'s drop-oldest-on-full behaviour; the
 * ``getWithTimeout`` helper emulates ``asyncio.wait_for(queue.get(), t)``
 * without leaving an orphaned waiter that could swallow a frame.
 */
export class AsyncQueue<T = Dict> {
  private items: T[] = [];
  private waiters: Array<{ res: (v: T) => void; rej: (e: unknown) => void }> = [];
  private closedFlag = false;

  constructor(readonly maxSize: number = Number.POSITIVE_INFINITY) {}

  /** put_nowait with drop-oldest-on-full (ClientSession.emit semantics). */
  putDropOldest(value: T): void {
    if (this.closedFlag) return;
    if (this.items.length >= this.maxSize && this.waiters.length === 0) {
      this.items.shift();
    }
    this.deliver(value);
  }

  private deliver(value: T): void {
    const w = this.waiters.shift();
    if (w) w.res(value);
    else this.items.push(value);
  }

  get(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    if (this.closedFlag) return Promise.reject(new QueueClosedError());
    return new Promise<T>((res, rej) => this.waiters.push({ res, rej }));
  }

  /**
   * ``asyncio.wait_for(queue.get(), timeout)``: resolves ``null`` on timeout or
   * close WITHOUT consuming a frame — the waiter is removed so a later ``put``
   * cannot be swallowed by an orphaned getter.
   */
  getWithTimeout(ms: number): Promise<T | null> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    if (this.closedFlag) return Promise.resolve(null);
    return new Promise<T | null>((resolve) => {
      let done = false;
      const waiter = {
        res: (v: T) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(v);
        },
        rej: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(null);
        },
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      this.waiters.push(waiter);
    });
  }

  getNowait(): T | undefined {
    return this.items.shift();
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Wake all pending getters with QueueClosedError (task cancellation). */
  close(): void {
    this.closedFlag = true;
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w.rej(new QueueClosedError());
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -- outbound protocol helpers -------------------------------------------------

function commandAck(
  command: Dict,
  turnId: string,
  accepted: boolean,
  errorCode?: string | null,
  message?: string | null,
): Dict {
  const event: Dict = {
    type: "command_ack",
    protocol_version: "2.0",
    command_id: String(command.command_id ?? ""),
    command_type: String(command.type ?? ""),
    accepted,
    turn_id: turnId,
  };
  if (errorCode) event.error_code = errorCode;
  if (message) event.message = message;
  return event;
}

function eventToUpdate(event: Dict): Dict | null {
  /** Turn event -> the `session_update` mirror frame used by the UI. */
  const etype = event.type;
  if (etype === "content") {
    return {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: String(event.content ?? "") },
    };
  }
  if (etype === "thinking") {
    return {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: String(event.content ?? "") },
    };
  }
  if (etype === "tool_call") {
    const meta = (event.metadata as Dict | undefined) ?? {};
    return {
      sessionUpdate: "tool_call",
      toolCallId: String(meta.tool_call_id ?? event.turn_id ?? ""),
      title: String(meta.tool_name ?? "tool"),
      kind: "other",
      status: "pending",
      rawInput: meta.arguments,
    };
  }
  if (etype === "tool_result") {
    const meta = (event.metadata as Dict | undefined) ?? {};
    return {
      sessionUpdate: "tool_call_update",
      toolCallId: String(meta.tool_call_id ?? ""),
      status: meta.is_error ? "failed" : "completed",
      rawOutput: { output: String(event.content ?? "").slice(0, 4000) },
    };
  }
  if (etype === "result") {
    const meta = (event.metadata as Dict | undefined) ?? {};
    const usage = (meta.usage as Dict | undefined) ?? {};
    if (Object.keys(usage).length > 0) {
      const budget =
        ((meta.metadata as Dict | undefined)?.context_budget as Dict | undefined) ?? {};
      return {
        sessionUpdate: "usage_update",
        used: usage.total_tokens ?? usage.input_tokens,
        size: budget.window ?? usage.context_window,
      };
    }
  }
  return null;
}

/** One outbound protocol frame -> SSE parts (event name, optional id, data). */
function toSseParts(frame: Dict): { event: string; id?: string; data: string } {
  let event = "turn_event";
  let eventId: string | undefined;
  if (frame.type === "session_update") {
    event = "session_update";
  } else if (frame.type === "legacy_event") {
    event = "legacy_event";
  } else {
    const seq = frame.seq;
    if (typeof seq === "number" && Number.isInteger(seq)) {
      eventId = `${String(frame.turn_id ?? "")}:${seq}`;
    }
  }
  return { event, id: eventId, data: JSON.stringify(frame) };
}

function frame(event: string, payload: Dict): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

// -- per-client controller ------------------------------------------------------

const CLOSED: unique symbol = Symbol("client_closed");
type Closed = typeof CLOSED;

/** One browser client: command dispatcher plus its outbound event queue. */
export class ClientSession {
  readonly id: string;
  readonly hub: RealtimeHub;
  readonly queue = new AsyncQueue<Dict>(MAX_QUEUE);
  lastSeen = performance.now();
  private tasks = new Set<Promise<unknown>>();
  // Turns this client already has a live pump for. Every subscribe used
  // to stack another follower queue, so a reconnecting/resuming client
  // multiplied its own event copies until the SSE queue overflowed and
  // the client saw permanent seq gaps — which triggered more resumes.
  private following = new Set<string>();
  private closeResolve!: (v: Closed) => void;
  private readonly closedPromise: Promise<Closed>;

  constructor(hub: RealtimeHub, clientId: string) {
    this.hub = hub;
    this.id = clientId;
    this.closedPromise = new Promise<Closed>((res) => {
      this.closeResolve = res;
    });
  }

  async emit(frameObj: Dict): Promise<void> {
    // Never wedge a turn on a slow/stale SSE reader: drop the oldest
    // frame. The client's seq-based replay closes any resulting gap.
    this.queue.putDropOldest(frameObj);
  }

  async ack(
    command: Dict,
    turnId: string,
    accepted: boolean,
    errorCode?: string | null,
    message?: string | null,
  ): Promise<void> {
    await this.emit(commandAck(command, turnId, accepted, errorCode, message));
  }

  private spawn(promise: Promise<unknown>): void {
    const tracked = promise
      .catch(() => {
        /* pump errors must not take down the client */
      })
      .finally(() => {
        this.tasks.delete(tracked);
      });
    this.tasks.add(tracked);
  }

  private followOnce(
    handle: TurnHandle,
    pump: (h: TurnHandle) => Promise<void>,
  ): void {
    /** Start ``pump`` for ``handle`` unless this client already follows it. */
    if (this.following.has(handle.turn_id)) return;
    this.following.add(handle.turn_id);
    this.spawn(pump(handle));
  }

  // -- command dispatch --------------------------------------------------------

  async handle(command: Dict, channel = ""): Promise<{ accepted: boolean }> {
    if (channel) {
      return this.handleChannel(channel, command);
    }

    const ctype = command.type;
    if (ctype === "start_turn" || ctype === "message") {
      await this.startTurn(command);
    } else if (ctype === "cancel_turn") {
      await this.cancelTurn(command);
    } else if (ctype === "regenerate") {
      await this.regenerate(command);
    } else if (ctype === "subscribe_turn" || ctype === "resume_from") {
      await this.subscribeTurn(command);
    } else if (ctype === "subscribe_session") {
      await this.subscribeSession(command);
    } else if (ctype === "unsubscribe") {
      await this.ack(command, "", true);
    } else if (ctype === "check_active_turn") {
      await this.checkActive(command);
      await this.ack(command, "", true);
    } else if (ctype === "ping") {
      await this.emit({ type: "pong", protocol_version: "2.0" });
    } else if (ctype === "submit_user_reply" || ctype === "user_input") {
      await this.submitReply(command);
    }
    return { accepted: true };
  }

  private async startTurn(command: Dict): Promise<void> {
    const { handle, session_event: sessionEvent, error } =
      await this.hub.runtime.start_turn(command as Record<string, any>);
    if (error || handle === null) {
      await this.ack(command, "", false, "start_turn_rejected", error || "failed to start turn");
      return;
    }
    if (sessionEvent !== null) {
      await this.hub.runtime._emit(handle, sessionEvent);
      await this.emit(sessionEvent);
    }
    await this.ack(command, handle.turn_id, true);
    this.followOnce(handle, (h) => this.pumpRaw(h));
  }

  private async cancelTurn(command: Dict): Promise<void> {
    const turnId = String(command.turn_id ?? "");
    const handle = this.hub.runtime.get_turn(turnId);
    const accepted = handle !== null && handle.status === "running";
    if (accepted && handle) handle.cancel.set();
    await this.ack(
      command,
      turnId,
      accepted,
      accepted ? null : "turn_not_running",
      accepted ? null : "No running turn with that id.",
    );
  }

  private async regenerate(command: Dict): Promise<void> {
    const sessionId = String(command.session_id ?? "");
    const session = this.hub.store.get(sessionId);
    if (session === null) {
      await this.emit({
        type: "protocol_error",
        protocol_version: "2.0",
        error_code: "session_not_found",
        message: "session not found",
        retryable: false,
      });
      return;
    }
    const lastInput = session.last_input;
    if (!lastInput) {
      await this.emit({
        type: "protocol_error",
        protocol_version: "2.0",
        error_code: "nothing_to_regenerate",
        message: "nothing to regenerate",
        retryable: false,
      });
      return;
    }
    const vtxItems = (session.vtx_items as Dict[] | undefined) ?? [];
    while (vtxItems.length > 0 && (vtxItems[vtxItems.length - 1] as Dict).role !== "user") {
      vtxItems.pop();
    }
    if (vtxItems.length > 0) vtxItems.pop();
    session.vtx_items = vtxItems;
    this.hub.store.save(session);
    await this.startTurn({
      type: "start_turn",
      protocol_version: "2.0",
      content: lastInput,
      session_id: sessionId,
      regenerate: true,
    });
    await this.ack(command, sessionId, true);
  }

  private async subscribeTurn(command: Dict): Promise<void> {
    const turnId = String(command.turn_id ?? "");
    // ``resume_from`` carries the cursor as ``seq``; ``subscribe_turn``
    // uses ``after_seq``. Reading only one made every resume replay the
    // whole turn history.
    const afterSeq = Number(command.after_seq ?? command.seq ?? 0) || 0;
    if (!turnId) {
      await this.emit({
        type: "protocol_error",
        protocol_version: "2.0",
        error_code: "invalid_params",
        message: "turn_id required",
        retryable: false,
      });
      return;
    }
    for (const event of this.hub.runtime.turn_events_after(turnId, afterSeq)) {
      await this.emit(event);
    }
    const handle = this.hub.runtime.get_turn(turnId);
    if (handle !== null && handle.status === "running") {
      this.followOnce(handle, (h) => this.followTurn(h));
    }
    await this.ack(command, turnId, true);
  }

  private async subscribeSession(command: Dict): Promise<void> {
    const sessionId = String(command.session_id ?? "");
    const afterSeq = Number(command.after_seq ?? 0) || 0;
    if (!sessionId) {
      await this.emit({
        type: "protocol_error",
        protocol_version: "2.0",
        error_code: "invalid_params",
        message: "session_id required",
        retryable: false,
      });
      return;
    }
    const handle = this.hub.runtime.active_turn_for_session(sessionId);
    if (handle === null) {
      await this.emit({ type: "active_turn_info", protocol_version: "2.0", status: "none" });
      await this.ack(command, "", true);
      return;
    }
    for (const event of this.hub.runtime.turn_events_after(handle.turn_id, afterSeq)) {
      await this.emit(event);
    }
    if (handle.status === "running") {
      this.followOnce(handle, (h) => this.followTurn(h));
    }
    await this.ack(command, handle.turn_id, true);
  }

  private async checkActive(command: Dict): Promise<void> {
    const sessionId = String(command.session_id ?? "");
    const handle = this.hub.runtime.active_turn_for_session(sessionId);
    if (handle === null) {
      await this.emit({ type: "active_turn_info", protocol_version: "2.0", status: "none" });
    } else {
      await this.emit({
        type: "active_turn_info",
        protocol_version: "2.0",
        turn_id: handle.turn_id,
        status: "running",
      });
    }
  }

  private async submitReply(command: Dict): Promise<void> {
    const turnId = String(command.turn_id ?? "");
    const answers = ((command.answers as unknown[] | undefined) ?? []).filter(
      (a): a is Dict => typeof a === "object" && a !== null && !Array.isArray(a),
    );
    const text = String(command.text ?? "");
    const accepted = await this.hub.runtime.resolve_ask_user(turnId, text, answers);
    await this.ack(
      command,
      turnId,
      accepted,
      accepted ? null : "no_pending_question",
      accepted ? null : "No question is waiting on this turn.",
    );
  }

  // -- event pumps -------------------------------------------------------------

  /** Next subscriber-queue event, or CLOSED when the client goes away. */
  private nextEvent(queue: TurnEventQueue): Promise<Dict | Closed> {
    return Promise.race([queue.get() as Promise<Dict>, this.closedPromise]);
  }

  /**
   * Keep forwarding frames the runtime settles *after* ``done``.
   *
   * The conversation title is generated in the background once the turn is
   * done, so the client cannot be told about it before ``done`` without
   * blocking the turn. Instead of closing the moment ``done`` is seen, wait
   * on the handle's ``settled`` event — set when the title attempt finished,
   * or when there was nothing to do — and forward anything that arrives
   * meanwhile. Bounded, so a hung title endpoint cannot pin an event stream
   * open forever.
   */
  private async forwardUntilSettled(handle: TurnHandle, queue: TurnEventQueue): Promise<void> {
    const settled = handle.settled;
    if (settled.is_set()) return;
    const deadline = performance.now() + POST_DONE_GRACE_SECONDS * 1000;

    // Single pending get re-armed only after a frame is consumed, mirroring
    // the asyncio.wait({getter, settler}, FIRST_COMPLETED) loop. A frame that
    // resolves concurrently with the winning signal is flushed below.
    let got: Dict | undefined;
    let pending = queue.get().then((v) => {
      got = v as Dict;
      return v;
    });
    while (!settled.is_set()) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const winner = await Promise.race([
        pending.then(() => "frame" as const),
        settled.wait().then(() => "settled" as const),
        this.closedPromise.then(() => "closed" as const),
        sleep(remaining).then(() => "timeout" as const),
      ]);
      if (winner !== "frame") break;
      if (got !== undefined) {
        const v = got;
        got = undefined;
        await this.emit(v);
      }
      pending = queue.get().then((v2) => {
        got = v2 as Dict;
        return v2;
      });
    }
    // A frame resolving at the same tick as settled/timeout still goes out
    await Promise.resolve();
    if (got !== undefined) {
      const v = got;
      got = undefined;
      await this.emit(v);
    }
    // Anything already handed to the queue before the signal still goes out.
    while (!queue.empty) {
      const v = (await queue.get()) as Dict;
      await this.emit(v);
    }
  }

  private async pumpRaw(handle: TurnHandle): Promise<void> {
    /** Forward a turn's events (plus session/update mirrors) until done. */
    const queue = new TurnEventQueue(MAX_PUMP_QUEUE);
    handle.subscribers.add(queue);
    try {
      // A fast (often cached) turn can emit its whole sequence before
      // this coroutine subscribes. Replay what already happened; the
      // client de-dupes by seq, so overlap with live frames is harmless.
      for (const event of [...handle.events]) {
        await this.emit(event as Dict);
      }
      while (true) {
        const event = await this.nextEvent(queue);
        if (event === CLOSED) return;
        await this.emit(event);
        const upd = eventToUpdate(event);
        if (upd !== null) {
          await this.emit({
            type: "session_update",
            session_id: handle.session_id,
            update: upd,
          });
        }
        if (event.type === "done") {
          await this.forwardUntilSettled(handle, queue);
          return;
        }
      }
    } finally {
      handle.subscribers.delete(queue);
      this.following.delete(handle.turn_id);
    }
  }

  private async followTurn(handle: TurnHandle): Promise<void> {
    /** Forward a running turn's raw events to a late subscriber. */
    const queue = new TurnEventQueue(MAX_PUMP_QUEUE);
    handle.subscribers.add(queue);
    try {
      while (true) {
        const event = await this.nextEvent(queue);
        if (event === CLOSED) return;
        await this.emit(event);
        if (event.type === "done") {
          await this.forwardUntilSettled(handle, queue);
          return;
        }
      }
    } finally {
      handle.subscribers.delete(queue);
      this.following.delete(handle.turn_id);
    }
  }

  // -- legacy feature channels ---------------------------------------------------

  private async handleChannel(channel: string, message: Dict): Promise<{ accepted: boolean }> {
    if (channel.includes("judge")) {
      await this.emit({ type: "started" });
      try {
        // Port of `from ..agent.quiz import judge_answer`.
        const { judge_answer } = await import("../agent/quiz.js");
        const text = await judge_answer(message as Record<string, unknown>);
        // Stream in small chunks like the old WS judge did (120 code points).
        const chars = Array.from(text);
        for (let start = 0; start < chars.length; start += 120) {
          await this.emit({ type: "text", content: chars.slice(start, start + 120).join("") });
        }
        await this.emit({ type: "done" });
      } catch (exc) {
        await this.emit({
          type: "error",
          content: `AI judge failed: ${exc instanceof Error ? exc.message : String(exc)}`,
        });
      }
    } else if (channel.includes("books")) {
      const { handleBooksChannel } = await import("./books.js");
      return handleBooksChannel({ emit: (frame) => this.emit(frame) }, this.id, message);
    } else if (channel.includes("mastery") || channel.includes("progress")) {
      await this.emit({ type: "subscribed", revision: 0 });
    } else {
      await this.emit({ type: "ack" });
    }
    return { accepted: true };
  }

  async close(): Promise<void> {
    this.queue.close();
    try {
      const { releaseBooksChannel } = await import("./books.js");
      releaseBooksChannel(this.id);
    } catch { /* books channel optional */ }
    // Release every pump blocked on ``nextEvent`` (asyncio task.cancel()).
    this.closeResolve(CLOSED);
    this.tasks.clear();
  }
}

// -- hub ------------------------------------------------------------------------

/** Registry of live client sessions, shared by the REST routes. */
export class RealtimeHub {
  readonly store: SessionStore;
  readonly runtime: AgentRuntime;
  private clients = new Map<string, ClientSession>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor({ store, runtime }: { store: SessionStore; runtime: AgentRuntime }) {
    this.store = store;
    this.runtime = runtime;
  }

  start(): void {
    if (this.sweeper === null) {
      this.sweeper = setInterval(() => {
        void this.sweep();
      }, SWEEP_SECONDS * 1000);
      // Don't keep the process alive for the sweeper alone.
      this.sweeper.unref?.();
    }
  }

  async stop(): Promise<void> {
    if (this.sweeper !== null) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const clientId of [...this.clients.keys()]) {
      await this.release(clientId);
    }
  }

  async get(clientId: string): Promise<ClientSession> {
    let client = this.clients.get(clientId);
    if (client === undefined) {
      client = new ClientSession(this, clientId);
      this.clients.set(clientId, client);
    }
    client.lastSeen = performance.now();
    return client;
  }

  async release(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (client !== undefined) {
      this.clients.delete(clientId);
      await client.close();
    }
  }

  /**
   * Push a frame to every connected browser client.
   *
   * Used for detached work (a notebook sub-agent finishing long after its
   * parent turn ended) that has no live turn pump to write into.
   */
  async broadcast(frameObj: Dict): Promise<void> {
    for (const client of [...this.clients.values()]) {
      await client.emit(frameObj);
    }
  }

  private async sweep(): Promise<void> {
    const now = performance.now();
    const stale = [...this.clients.entries()]
      .filter(([, client]) => now - client.lastSeen > CLIENT_IDLE_SECONDS * 1000)
      .map(([cid]) => cid);
    for (const clientId of stale) {
      await this.release(clientId);
    }
  }
}

// -- routes ----------------------------------------------------------------------

export const realtimeRouter = new Hono();

interface AppStateLike {
  realtime?: RealtimeHub;
  [key: string]: unknown;
}

let cachedHub: RealtimeHub | null = null;

/**
 * ``appState.realtime`` exported by main.ts; resolved lazily to avoid a
 * static import cycle (main.ts imports this router). Mirrors handlers.ts.
 */
async function hubFor(): Promise<RealtimeHub> {
  if (cachedHub) return cachedHub;
  try {
    const mod = (await import("../main.js")) as unknown as { appState?: AppStateLike };
    if (mod?.appState?.realtime) {
      cachedHub = mod.appState.realtime;
      return cachedHub;
    }
  } catch {
    // main.ts may not be importable in isolation (tests, tooling).
  }
  throw new HTTPException(500, { message: "RealtimeHub not configured" });
}

realtimeRouter.post("/api/realtime/commands", async (c) => {
  /** Accept one turn command or legacy channel message over HTTP. */
  const clientId = c.req.query("client_id") || randomUUID().replace(/-/g, "");
  const channel = c.req.query("channel") || "";
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HTTPException(400, { message: "Command must be a JSON object" });
  }

  const client = await (await hubFor()).get(clientId);
  return c.json(await client.handle(body as Dict, channel));
});

realtimeRouter.get("/api/realtime/events", async (c) => {
  /** Deliver the client's outbound frames as a named-event SSE stream. */
  const clientId = c.req.query("client_id") || randomUUID().replace(/-/g, "");
  const client = await (await hubFor()).get(clientId);

  let cancelled = false;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          cancelled = true;
        }
      };
      push(frame("ready", { client_id: clientId }));
      let lastBeat = performance.now();
      try {
        while (!cancelled && !client.queue.closed) {
          // 1s poll so we can heartbeat; getWithTimeout never orphans a
          // getter (asyncio.wait_for semantics).
          const frameObj = await client.queue.getWithTimeout(1000);
          if (frameObj === null) {
            const now = performance.now();
            if ((now - lastBeat) / 1000 >= HEARTBEAT_SECONDS) {
              push(": ping\n\n");
              lastBeat = now;
            }
            continue;
          }
          client.lastSeen = performance.now();
          const parts = toSseParts(frameObj);
          let out = `event: ${parts.event}\n`;
          if (parts.id) out += `id: ${parts.id}\n`;
          out += `data: ${parts.data}\n\n`;
          push(out);
        }
      } finally {
        // Keep the client registered: EventSource reconnects with the same
        // id, and an idle sweep reclaims clients that never come back.
        client.lastSeen = performance.now();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });

  return c.body(body, 200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
});

realtimeRouter.delete("/api/realtime/clients/:client_id", async (c) => {
  await (await hubFor()).release(c.req.param("client_id"));
  return c.json({ closed: true });
});

