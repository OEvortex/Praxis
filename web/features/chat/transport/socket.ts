import { sseSocketFactory, type SseSocketLike } from "@/lib/sse-socket";

export interface SocketMessageEvent {
  data: unknown;
}

export interface TurnSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketMessageEvent) => void,
  ): void;
}

export type TurnSocketFactory = (url: string) => TurnSocket;

export const SOCKET_CONNECTING = 0;
export const SOCKET_OPEN = 1;

/**
 * Turn transport over REST + SSE. It exposes the small socket surface
 * TurnRuntimeClient needs; commands are POSTed and frames arrive on the SSE
 * stream, so all protocol builders/parsers and reconnection logic stay intact.
 */
export function browserSocketFactory(url: string): TurnSocket {
  return new SseTurnSocket(url);
}

/** Adapts the `on*` handlers of the shared SSE socket to `addEventListener`. */
class SseTurnSocket implements TurnSocket {
  private listeners: Record<
    "open" | "message" | "close" | "error",
    Array<(event: SocketMessageEvent) => void>
  > = { open: [], message: [], close: [], error: [] };

  private readonly socket: SseSocketLike;

  constructor(url: string) {
    this.socket = sseSocketFactory(url);
    this.socket.onopen = () => this.emit("open", { data: undefined });
    this.socket.onmessage = (event) => this.emit("message", { data: event.data });
    this.socket.onclose = () => this.emit("close", { data: undefined });
    this.socket.onerror = (error) => this.emit("error", { data: error });
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(): void {
    this.socket.close();
  }

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: SocketMessageEvent) => void,
  ): void {
    this.listeners[type].push(listener);
  }

  private emit(
    type: "open" | "message" | "close" | "error",
    event: SocketMessageEvent,
  ): void {
    for (const listener of this.listeners[type]) listener(event);
  }
}
