// run a due cron job for its
// owner (a Praxis chat session). The AgentRuntime is Python-only; it is
// injected via setRuntime() and accessed through a minimal structural
// interface mirroring the attributes the Python code touches.
import type { CronJob } from "./service.js";
import { record as recordReport } from "./reports.js";

const TURN_TIMEOUT_SECONDS = 300;
const POLL_SECONDS = 0.25;

/** Minimal slice of AgentRuntime used by the cron executor. */
export interface CronAgentRuntime {
  _store: {
    get(sessionId: string): { messages?: Array<Record<string, unknown>> } | null | undefined;
  };
  startTurn(payload: {
    content: string;
    session_id: string;
    capability: string;
    workspace_id?: string;
  }): Promise<[unknown, unknown, string | null]>;
}

interface TurnHandle {
  status: string;
}

// The real runtime exposes more; we only need `status` off the handle.
function asHandle(value: unknown): TurnHandle {
  return value as TurnHandle;
}

class RuntimeRegistry {
  static runtime: CronAgentRuntime | null = null;
}

export function setRuntime(runtime: CronAgentRuntime | null): void {
  RuntimeRegistry.runtime = runtime;
}

export function reminderPrompt(job: CronJob): string {
  return (
    "The scheduled time has arrived. Deliver this reminder to the user now, " +
    "as a brief and natural message in their language. Speak directly to them; " +
    "do not narrate scheduler status or mention internal job ids. Answer in " +
    "plain conversational text — do not emit UI, Remotion or OpenUI code.\n\n" +
    `Reminder: ${job.message}`
  );
}

function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Returns `[status, error]` — status is ok/error/skipped. */
export async function executeJob(job: CronJob): Promise<[string, string | null]> {
  if (job.owner.kind !== "chat") {
    return ["skipped", `unsupported owner kind '${job.owner.kind}'`];
  }

  const runtime = RuntimeRegistry.runtime;
  if (!runtime) {
    return ["error", "agent runtime is not available"];
  }

  const sessionId = (job.owner.session_id ?? "").trim();
  if (!sessionId) {
    // A plain reminder: nothing to ask the model, so the report buffer is the
    // delivery channel (toast + notification).
    recordReport({ job_id: job.id, name: job.name, text: job.message, status: "ok" });
    return ["ok", null];
  }
  if (runtime._store.get(sessionId) == null) {
    return ["skipped", "session no longer exists"];
  }

  const prompt = reminderPrompt(job);
  const before = ((runtime._store.get(sessionId) ?? {}).messages ?? []).length;
  const [handleRaw, _sessionEvent, error] = await runtime.startTurn({
    content: prompt,
    session_id: sessionId,
    capability: "chat",
    workspace_id: job.owner.workspace_id,
  });
  if (handleRaw == null) {
    return ["error", error || "could not start the turn"];
  }
  const handle = asHandle(handleRaw);

  const polls = Math.floor(TURN_TIMEOUT_SECONDS / POLL_SECONDS);
  let i = 0;
  for (; i < polls; i++) {
    if (handle.status !== "running") break;
    await sleepSeconds(POLL_SECONDS);
  }
  if (i >= polls && handle.status === "running") {
    return ["error", "turn did not finish in time"];
  }

  // The assistant row is appended just before the handle flips status; read
  // again briefly so a reminder that ran to completion is not missed.
  for (let j = 0; j < 20; j++) {
    const session = runtime._store.get(sessionId) ?? {};
    const messages = (session.messages ?? []).slice(before);
    const answer = messages
      .filter(
        (message) =>
          message.role === "assistant" && String(message.content ?? "").trim(),
      )
      .map((message) => String(message.content ?? ""))[0] ?? "";
    if (answer) {
      recordReport({ job_id: job.id, name: job.name, text: answer, status: "ok" });
      return ["ok", null];
    }
    if (handle.status !== "running" && handle.status !== "completed" && handle.status !== "done") {
      break;
    }
    await sleepSeconds(POLL_SECONDS);
  }

  // A completed turn with no captured text still delivered whatever the model
  // said; anything else is a genuine failure worth surfacing.
  if (handle.status === "completed" || handle.status === "done") {
    recordReport({ job_id: job.id, name: job.name, text: job.message, status: "ok" });
    return ["ok", null];
  }
  return ["error", `turn finished with status '${handle.status}'`];
}
