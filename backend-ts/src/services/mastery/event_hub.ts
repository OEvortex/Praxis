// Port of deeptutor/learning/event_hub.py — in-process wake-up channel for
// durable mastery topic events. SQLite (the store) remains the replay
// authority; this hub only tells subscribers a topic changed.

export interface TopicSignal {
  path_id: string;
  revision: number;
  reason: string;
  sequence: number;
}

export class TopicSubscription {
  readonly path_id: string;
  readonly scope: string;
  // Newest-signal-wins queue, mirroring asyncio.Queue(maxsize=1).
  private pending: TopicSignal | null = null;
  private waiters: Array<(signal: TopicSignal) => void> = [];
  private closedFlag = false;
  private readonly hub: MasteryTopicEventHub;

  constructor(hub: MasteryTopicEventHub, path_id: string, scope: string) {
    this.hub = hub;
    this.path_id = path_id;
    this.scope = scope;
    this.hub._add(this);
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  /** Wait for the next topic signal (resolves with the latest pending one). */
  get(): Promise<TopicSignal> {
    if (this.pending !== null) {
      const signal = this.pending;
      this.pending = null;
      return Promise.resolve(signal);
    }
    if (this.closedFlag) return Promise.reject(new Error("subscription closed"));
    return new Promise<TopicSignal>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Non-blocking delivery used by the hub. */
  _deliver(signal: TopicSignal): void {
    if (this.closedFlag) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(signal);
      return;
    }
    this.pending = signal;
  }

  close(): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.hub._remove(this);
  }
}

export class MasteryTopicEventHub {
  private subscriptions = new Map<string, Set<TopicSubscription>>();
  private sequence = 0;

  private static key(scope: string, pathId: string): string {
    return `${scope || "default"}${pathId}`;
  }

  subscribe(pathId: string, scope = "default"): TopicSubscription {
    return new TopicSubscription(this, String(pathId), String(scope || "default"));
  }

  _add(subscription: TopicSubscription): void {
    const key = MasteryTopicEventHub.key(subscription.scope, subscription.path_id);
    let group = this.subscriptions.get(key);
    if (!group) {
      group = new Set();
      this.subscriptions.set(key, group);
    }
    group.add(subscription);
  }

  _remove(subscription: TopicSubscription): void {
    const key = MasteryTopicEventHub.key(subscription.scope, subscription.path_id);
    const group = this.subscriptions.get(key);
    if (!group) return;
    group.delete(subscription);
    if (!group.size) this.subscriptions.delete(key);
  }

  publish(
    pathId: string,
    revision: number,
    reason = "topic.changed",
    scope = "default",
  ): void {
    this.sequence += 1;
    const signal: TopicSignal = {
      path_id: String(pathId),
      revision: Math.max(0, Math.trunc(Number(revision) || 0)),
      reason: String(reason || "topic.changed"),
      sequence: this.sequence,
    };
    const group = this.subscriptions.get(
      MasteryTopicEventHub.key(scope, signal.path_id),
    );
    if (!group) return;
    for (const subscription of [...group]) {
      subscription._deliver(signal);
    }
  }
}

export const masteryTopicEventHub = new MasteryTopicEventHub();

export function publishTopicSignal(
  pathId: string,
  revision: number,
  reason = "topic.changed",
  scope = "default",
): void {
  masteryTopicEventHub.publish(pathId, revision, reason, scope);
}
