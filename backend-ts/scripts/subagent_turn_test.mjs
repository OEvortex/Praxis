// End-to-end SUBAGENT test: boot the Hono app, seed a provider connection,
// open the SSE stream, and drive a turn that makes the main agent call the
// `notebook` tool. The tool dispatches the Co-writer sub-agent (nb_* tools)
// through src/agent/subagent.ts — either synchronously (background=false) or
// via the background task manager (default). We then verify:
//
//   * the parent turn completes and streams a `notebook` tool_call/result,
//   * subagent progress events (subagent_start / tool_start / subagent_end …)
//     are recorded on the turn (replayed via subscribe_turn) and/or streamed
//     live as `progress` frames,
//   * the background completion broadcast (`metadata.notebook_completed`)
//     arrives on the SSE stream,
//   * notebook documents were actually created (GET /api/documents),
//   * the completion report was injected into the session as a user message.
//
// Run:  npx tsx scripts/subagent_turn_test.mjs
// Env:  TEST_LLM_BASE_URL / TEST_LLM_API_KEY / TEST_LLM_MODEL override the
//       provider (defaults match scripts/agent_turn_test.mjs).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";

const DATA_DIR = mkdtempSync(join(tmpdir(), "dt-subagent-test-"));
process.env.PRAXIS_DATA_DIR = DATA_DIR;
process.env.DATA_DIR = DATA_DIR;
process.env.PORT = "0";
process.env.PRAXIS_TITLE_API_URL = "off";
process.env.PRAXIS_WORKSPACE_DIR = join(DATA_DIR, "workspace");

const LLM_BASE_URL = process.env.TEST_LLM_BASE_URL || "https://wusrouter.com/v1";
const LLM_API_KEY =
  process.env.TEST_LLM_API_KEY ||
  "sk-ws-218bc9ecf8376cf4ad2a7015a3b1704083cb566a6b32a13fb620f683ee0de39d";
const LLM_MODEL = process.env.TEST_LLM_MODEL || "wr/deepseek-v4.1-flash:free";

const { createApp, shutdown, appState } = await import("../src/main.ts");
const providerConfig = await import("../src/provider-config.ts");
const { get_settings } = await import("../src/config.ts");
const { getBackgroundTaskManager } = await import("../src/agent/subagent.ts");

const settings = get_settings();

// Seed the catalog: one connection bound to provider "openai" so the preset
// branch of resolve_runtime_model picks up our base_url/api_key. ALSO persist
// the selection — the sub-agent resolves its model via
// resolve_runtime_model(settings, null), which only sees the *saved*
// selection, never the per-command llm_selection.
const catalog = providerConfig.load_catalog(settings);
catalog.connections = [
  ...(Array.isArray(catalog.connections) ? catalog.connections : []),
  {
    id: "conn-test-llm",
    provider: "openai",
    base_url: LLM_BASE_URL,
    api_key: LLM_API_KEY,
    api_format: "openai_chat",
  },
];
providerConfig.save_catalog(settings, catalog);
providerConfig.set_selection(settings, {
  profile_id: "openai",
  model_id: LLM_MODEL,
});
console.log(`data dir: ${DATA_DIR}`);
console.log(`seeded connection -> ${LLM_BASE_URL} model=${LLM_MODEL}`);

const app = await createApp();
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`app listening on ${base}\n`);

const clientId = "subagent-test-client";

// --- open SSE stream ---------------------------------------------------------
const sseRes = await fetch(`${base}/api/realtime/events?client_id=${clientId}`);
if (!sseRes.ok || !sseRes.body) {
  console.error("FAIL: SSE stream did not open", sseRes.status);
  process.exit(1);
}
const events = [];
const sseDone = (async () => {
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let currentEvent = "message";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let data = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
        else if (line.startsWith("data:")) data = line.slice(5).trim();
      }
      if (data) {
        try {
          events.push({ sse: currentEvent, ...JSON.parse(data) });
        } catch {
          /* heartbeat comments etc. */
        }
      }
    }
  }
})();

await new Promise((r) => setTimeout(r, 300));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cmdSeq = 0;

async function startTurn(content, sessionId = null) {
  cmdSeq += 1;
  const body = {
    type: "start_turn",
    protocol_version: "2.0",
    command_id: `cmd-${cmdSeq}`,
    content,
    llm_selection: { profile_id: "openai", model_id: LLM_MODEL },
  };
  if (sessionId) body.session_id = sessionId;
  const res = await fetch(`${base}/api/realtime/commands?client_id=${clientId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function waitForDone(sinceIndex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = events.slice(sinceIndex).find((e) => e.type === "done");
    if (done) return done;
    await sleep(500);
  }
  return null;
}

function notebookToolEvents(slice) {
  return slice.filter(
    (e) =>
      (e.type === "tool_call" || e.type === "tool_result") &&
      (e.metadata?.tool_name === "notebook" ||
        e.metadata?.tool === "notebook" ||
        String(e.content ?? "") === "notebook" ||
        String(e.content ?? "").includes("NOTEBOOK_TASK")),
  );
}

// Baseline BEFORE any turn: the writer may create pages while the parent
// turn is still streaming, so a post-turn snapshot would already count them.
const docsBaselineRes = await fetch(`${base}/api/documents`);
const docsBaseline = await docsBaselineRes.json().catch(() => ({ documents: [] }));
const beforeCount = (docsBaseline.documents ?? []).length;
console.log("documents before:", beforeCount);

// --- phase 1: get the main agent to call the `notebook` tool ------------------
const PROMPTS = [
  "Please build me a short study notebook about photosynthesis — 2 or 3 pages with a quiz at the end. Use your notebook tool to build it.",
  "Make me notes on the water cycle for my biology class. Create a notebook with a couple of pages — use the notebook tool.",
  "I need a revision notebook on the French Revolution with a timeline page and a quiz page. Build it now using the notebook tool.",
];

let turnEvents = [];
let doneEvent = null;
let notebookFired = false;
let sessionId = null;
let turnId = null;
let usedPrompt = "";

for (const prompt of PROMPTS) {
  const before = events.length;
  console.log(`\n>>> sending turn: ${prompt.slice(0, 90)}…`);
  const ack = await startTurn(prompt);
  console.log("command response:", ack.status, JSON.stringify(ack.body));
  doneEvent = await waitForDone(before, 240000);
  turnEvents = events.slice(before);
  const toolNames = turnEvents
    .filter((e) => e.type === "tool_call")
    .map((e) => e.metadata?.tool_name ?? e.metadata?.tool ?? e.content);
  console.log("turn done:", doneEvent ? "yes" : "TIMEOUT", "| tools:", JSON.stringify(toolNames));
  sessionId = doneEvent?.metadata?.session_id ?? turnEvents.find((e) => e.type === "session")?.metadata?.session_id ?? sessionId;
  turnId = doneEvent?.turn_id ?? turnEvents.find((e) => e.turn_id)?.turn_id ?? turnId;
  notebookFired = notebookToolEvents(turnEvents).length > 0;
  usedPrompt = prompt;
  if (notebookFired) break;
  if (!doneEvent) break; // provider trouble — don't burn more attempts
}

const contentText = turnEvents.filter((e) => e.type === "content").map((e) => e.content ?? "").join("");
const errors = turnEvents.filter((e) => e.type === "error");
console.log("\n--- parent turn summary ---");
console.log("session:", sessionId, "turn:", turnId);
console.log("content:", JSON.stringify(contentText.slice(0, 300)));
console.log("errors:", errors.map((e) => String(e.content ?? e.message ?? "")).slice(0, 5));

if (!notebookFired) {
  console.log("\nRESULT: FAIL — model never called the `notebook` tool (or turn failed).");
  console.log("Prompt tried:", JSON.stringify(usedPrompt));
  await sseRes.body.cancel().catch(() => {});
  await shutdown().catch(() => {});
  server.close();
  process.exit(2);
}

const nbTool = notebookToolEvents(turnEvents);
console.log("notebook tool events:", nbTool.map((e) => `${e.type}:${e.metadata?.tool_call_id ?? ""}`).join(", "));
const taskInfo =
  nbTool.map((e) => e.metadata?.tool_metadata?.notebook_task ?? e.metadata?.notebook_task).find(Boolean) ?? null;
console.log("notebook_task marker:", JSON.stringify(taskInfo));

// Live progress frames observed so far (only possible if the tool ran
// synchronously, i.e. background=false — the parent turn is still open).
const liveProgress = events.filter(
  (e) => e.type === "progress" && e.metadata?.notebook_progress,
);
console.log("live notebook progress frames during turn:", liveProgress.length);

// --- phase 2: wait for the sub-agent -----------------------------------------
// Background mode: the parent turn is already done; the Co-writer runs in the
// background task manager and finishes with a broadcast `notebook_completed`
// frame. Poll the in-process manager + the documents API + SSE.
// A synchronous run (background=false) finishes inside the parent turn, so by
// now its completion frame is already broadcast and no bg task exists — skip
// the wait entirely. A bg run leaves a NOTEBOOK_TASK marker on the tool result.
const launchedBg = turnEvents.some(
  (e) =>
    String(e.content ?? "").includes("NOTEBOOK_TASK") ||
    e.metadata?.tool_metadata?.notebook_task ||
    e.metadata?.notebook_task,
);
const bgDeadline = Date.now() + 10 * 60 * 1000; // writer can take minutes
let completionFrames = [];
let bgTasks = [];
let docsAfter = null;

const scanCompletions = () => {
  for (const e of events) {
    const nc = e.metadata?.notebook_completed;
    if (nc && !completionFrames.some((f) => f.metadata?.notebook_completed?.task_id === nc.task_id)) {
      completionFrames.push(e);
    }
  }
};
scanCompletions(); // a sync run's frame may already be here

while (launchedBg && Date.now() < bgDeadline) {
  scanCompletions();
  bgTasks = getBackgroundTaskManager()
    .list()
    .filter((t) => t.subagent_type === "co-writer");
  const anyRunning = bgTasks.some((t) => !t.status || t.status === "running");
  // Done when every launched writer settled, or a completion frame arrived and
  // no writer is still running.
  if (bgTasks.length > 0 && !anyRunning) break;
  if (completionFrames.length > 0 && !anyRunning) break;
  await sleep(2000);
}
// Give doc writes / broadcasts a moment to settle after the last task ends.
await sleep(3000);

// Final document poll (a few retries — writes may land just after the frame).
for (let i = 0; i < 15; i++) {
  docsAfter = await (await fetch(`${base}/api/documents`)).json().catch(() => null);
  const n = (docsAfter?.documents ?? []).length;
  if (n > beforeCount) break;
  await sleep(2000);
}
const docs = docsAfter?.documents ?? [];
console.log("\n--- sub-agent summary ---");
console.log("background tasks:", JSON.stringify(bgTasks.map((t) => ({ task_id: t.task_id, status: t.status, error: t.error ?? null }))));
console.log("completion frames:", completionFrames.length);
for (const f of completionFrames) {
  const nc = f.metadata?.notebook_completed ?? {};
  console.log(`  - ${nc.task_id} | ${nc.label} | ${nc.status}${nc.error ? ` | err=${String(nc.error).slice(0, 120)}` : ""}`);
}
console.log("documents now:", docs.length, "(was", beforeCount + ")");
for (const d of docs.slice(0, 20)) {
  console.log(`  - ${d.id} | ${d.title} | parent=${d.parent_id ?? "-"}`);
}

// --- phase 3: replay the finished turn's recorded events ----------------------
// subscribe_turn replays the persisted turn log — this is where post-done
// subagent progress events (recorded via runtime._emit) should appear.
let progressKinds = [];
if (turnId) {
  const replayBefore = events.length;
  await fetch(`${base}/api/realtime/commands?client_id=${clientId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "subscribe_turn",
      protocol_version: "2.0",
      command_id: "cmd-replay",
      turn_id: turnId,
      after_seq: 0,
    }),
  });
  await sleep(3000);
  const replayed = events.slice(replayBefore).filter((e) => e.turn_id === turnId);
  progressKinds = replayed
    .filter((e) => e.type === "progress" && e.metadata?.notebook_progress)
    .map((e) => e.metadata.notebook_progress.kind);
  const kindCounts = {};
  for (const k of progressKinds) kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  console.log("\nreplayed turn events:", replayed.length);
  console.log("notebook progress kinds:", JSON.stringify(kindCounts));
  const subEnd = replayed.find(
    (e) => e.type === "progress" && e.metadata?.notebook_progress?.kind === "subagent_end",
  );
  if (subEnd) {
    console.log("subagent_end tool_counts:", JSON.stringify(subEnd.metadata.notebook_progress.tool_counts));
  }
}

// --- phase 4: session persistence ---------------------------------------------
if (sessionId) {
  const r = await fetch(`${base}/api/sessions/${sessionId}`);
  const p = await r.json().catch(() => null);
  const msgs = p?.messages ?? p?.session?.messages ?? [];
  const injected = msgs.filter((m) => String(m.content ?? "").includes("background-task-completion"));
  console.log("\nsession messages:", msgs.length, "| completion injections:", injected.length);
  for (const m of injected.slice(0, 2)) {
    console.log("  injected:", String(m.content).slice(0, 200));
  }
}

// --- verdict ------------------------------------------------------------------
const docsCreated = docs.length > beforeCount;
const subagentRan = bgTasks.length > 0 || progressKinds.length > 0 || completionFrames.length > 0;
console.log("\n================ SUBAGENT TURN TEST ================");
console.log("prompt that worked:", JSON.stringify(usedPrompt.slice(0, 80)));
console.log("notebook tool called by main agent: ", notebookFired ? "YES" : "NO");
console.log("subagent ran (bg task/progress/completion):", subagentRan ? "YES" : "NO");
console.log("completion broadcast received:           ", completionFrames.length > 0 ? `YES (${completionFrames.length})` : "no");
console.log("notebook pages created:                  ", docsCreated ? `YES (${docs.length - beforeCount} new)` : "NO");
console.log("=====================================================");

await sseRes.body.cancel().catch(() => {});
await shutdown().catch(() => {});
server.close();
process.exit(docsCreated && subagentRan ? 0 : 1);
