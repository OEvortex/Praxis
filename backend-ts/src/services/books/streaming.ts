// per-book event buses.
//
// One long-lived event stream per book, owned by the process. Events carry
// the upstream wire shape: {type, source, stage, content, metadata, seq,
// timestamp}. ``source`` is always "book_engine".

export const SOURCE = "book_engine";

export const STAGE_IDEATION = "ideation";
export const STAGE_EXPLORATION = "exploration";
export const STAGE_SYNTHESIS = "synthesis";
export const STAGE_CRITIQUE = "critique";
export const STAGE_OVERVIEW = "overview";
export const STAGE_SPINE = "spine";
export const STAGE_PAGE_PLAN = "page_plan";
export const STAGE_COMPILATION = "compilation";
export const STAGE_BLOCK = "block";
export const STAGE_INTERACTION = "interaction";

export interface BookEvent {
  type: string;
  source: string;
  stage: string;
  content: string;
  metadata: Record<string, unknown>;
  seq: number;
  timestamp: number;
}

type Subscriber = {
  queue: BookEvent[];
  waiters: Array<() => void>;
  closed: boolean;
};

const BOOK_EVENT_HISTORY_LIMIT = 400;

/** Minimal StreamBus port: emit + subscribe(after_seq) with replay. */
export class StreamBus {
  private history: BookEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private _latestSeq = 0;
  private _closed = false;

  get latest_seq(): number {
    return this._latestSeq;
  }

  get closed(): boolean {
    return this._closed;
  }

  async emit(partial: {
    type: string;
    stage?: string;
    content?: string;
    metadata?: Record<string, unknown>;
    source?: string;
  }): Promise<BookEvent> {
    if (this._closed) {
      // Mirror upstream: emit() silently no-ops once the bus is closed.
      return {
        type: partial.type,
        source: partial.source ?? SOURCE,
        stage: partial.stage ?? "",
        content: partial.content ?? "",
        metadata: partial.metadata ?? {},
        seq: this._latestSeq,
        timestamp: Date.now() / 1000,
      };
    }
    const event: BookEvent = {
      type: partial.type,
      source: partial.source ?? SOURCE,
      stage: partial.stage ?? "",
      content: partial.content ?? "",
      metadata: partial.metadata ?? {},
      seq: ++this._latestSeq,
      timestamp: Date.now() / 1000,
    };
    this.history.push(event);
    if (this.history.length > BOOK_EVENT_HISTORY_LIMIT) {
      this.history.splice(0, this.history.length - BOOK_EVENT_HISTORY_LIMIT);
    }
    for (const sub of [...this.subscribers]) {
      sub.queue.push(event);
      for (const wake of sub.waiters.splice(0)) wake();
    }
    return event;
  }

  /**
   * Async-iterator-style subscription: yields events with seq > after_seq,
   * replaying retained history first. Returns a handle with ``next()``.
   */
  subscribe(after_seq = 0): {
    next: () => Promise<BookEvent | null>;
    close: () => void;
  } {
    const sub: Subscriber = { queue: [], waiters: [], closed: false };
    // Replay retained history first (events with seq > after_seq).
    for (const event of this.history) {
      if (event.seq > after_seq) sub.queue.push(event);
    }
    this.subscribers.add(sub);
    return {
      next: async (): Promise<BookEvent | null> => {
        for (;;) {
          if (sub.queue.length) return sub.queue.shift()!;
          if (sub.closed || this._closed) return null;
          await new Promise<void>((resolve) => sub.waiters.push(resolve));
        }
      },
      close: () => {
        sub.closed = true;
        this.subscribers.delete(sub);
        for (const wake of sub.waiters.splice(0)) wake();
      },
    };
  }

  mark_closed(): void {
    this._closed = true;
    for (const sub of [...this.subscribers]) {
      sub.closed = true;
      for (const wake of sub.waiters.splice(0)) wake();
    }
    this.subscribers.clear();
  }
}

/** High-level helpers around a StreamBus for the BookEngine. */
export class BookStream {
  constructor(public readonly bus: StreamBus) {}

  async content(text: string, stage = "", metadata?: Record<string, unknown>): Promise<void> {
    await this.bus.emit({ type: "content", stage, content: text, metadata });
  }

  async thinking(text: string, stage = "", metadata?: Record<string, unknown>): Promise<void> {
    await this.bus.emit({ type: "thinking", stage, content: text, metadata });
  }

  async progress(
    message: string,
    opts: { current?: number; total?: number; stage?: string; metadata?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.bus.emit({
      type: "progress",
      stage: opts.stage ?? "",
      content: message,
      metadata: { current: opts.current ?? 0, total: opts.total ?? 0, ...(opts.metadata ?? {}) },
    });
  }

  async result(data: Record<string, unknown>, metadata?: Record<string, unknown>): Promise<void> {
    await this.bus.emit({ type: "result", content: "", metadata: { ...data, ...(metadata ?? {}) } });
  }

  async error(message: string, stage = "", metadata?: Record<string, unknown>): Promise<void> {
    await this.bus.emit({ type: "error", stage, content: message, metadata });
  }

  /** Custom 'book' progress event; frontend distinguishes by metadata.kind. */
  async book_event(kind: string, data: Record<string, unknown>, stage = ""): Promise<void> {
    await this.bus.emit({
      type: "progress",
      stage,
      content: kind,
      metadata: { kind, ...data },
    });
  }
}

// ── event hub: one bus per book, process-wide ──────────────────────────────

const _buses = new Map<string, StreamBus>();

export function get_book_bus(book_id: string): StreamBus {
  let bus = _buses.get(book_id);
  if (!bus) {
    bus = new StreamBus();
    _buses.set(book_id, bus);
  }
  return bus;
}

export function get_book_stream(book_id: string): BookStream {
  return new BookStream(get_book_bus(book_id));
}

export function close_book_bus(book_id: string): void {
  const bus = _buses.get(book_id);
  if (bus) {
    _buses.delete(book_id);
    bus.mark_closed();
  }
}

/** Serialize a bus event to the upstream WS payload shape. */
export function serialize_event(event: BookEvent): Record<string, unknown> {
  return {
    type: event.type,
    source: event.source,
    stage: event.stage,
    content: event.content,
    metadata: event.metadata ?? {},
    seq: event.seq,
    timestamp: event.timestamp,
  };
}
