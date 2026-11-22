// End-to-end agent turn test: boot the Hono app, seed a provider connection,
// open the SSE stream, POST start_turn, and verify streamed assistant text,
// tool dispatch and session persistence.
//
// Run:  PRAXIS_DATA_DIR=/tmp/dt-agent-test npx tsx scripts/agent_turn_test.mjs

import { serve } from "@hono/node-server";

process.env.PRAXIS_DATA_DIR = "/tmp/dt-agent-test";
process.env.DATA_DIR = "/tmp/dt-agent-test";
process.env.PORT = "0";
process.env.PRAXIS_TITLE_API_URL = "off";

// The env-provided OPENAI_BASE_URL (127.0.0.1:8099) is a dead local proxy, so
// we point the "openai" preset connection at the working OpenAI-compatible
// router instead. Key comes from the opencode config's wusrouter entry.
const LLM_BASE_URL = process.env.TEST_LLM_BASE_URL || "https://wusrouter.com/v1";
const LLM_API_KEY = process.env.TEST_LLM_API_KEY;
const LLM_MODEL = process.env.TEST_LLM_MODEL || "wr/deepseek-v4.1-flash:free";

const { createApp, shutdown, appState } = await import("../src/main.ts");
const providerConfig = await import("../src/provider-config.ts");
const { get_settings } = await import("../src/config.ts");

const settings = get_settings();

// Seed the catalog: one connection bound to provider "openai" so the preset
// branch of resolve_runtime_model picks up our base_url/api_key.
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
console.log(`seeded connection -> ${LLM_BASE_URL} model=${LLM_MODEL}`);

const app = await createApp();
const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => server.once("listening", r));
const addr = server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;
const base = `http://127.0.0.1:${port}`;
console.log(`app listening on ${base}\n`);

const clientId = "test-client-1";

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

// give the stream a moment to register the client
await new Promise((r) => setTimeout(r, 300));

// --- start a turn ------------------------------------------------------------
const cmdRes = await fetch(
  `${base}/api/realtime/commands?client_id=${clientId}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "start_turn",
      protocol_version: "2.0",
      command_id: "cmd-1",
      content: "Reply with exactly the word PONG and nothing else.",
      llm_selection: { profile_id: "openai", model_id: LLM_MODEL },
    }),
  },
);
const cmdBody = await cmdRes.json().catch(() => null);
console.log("command response:", cmdRes.status, JSON.stringify(cmdBody));

// wait for done event (or timeout)
const deadline = Date.now() + 180000;
let doneEvent = null;
while (Date.now() < deadline) {
  doneEvent = events.find((e) => e.type === "done");
  if (doneEvent) break;
  const errEv = events.find((e) => e.type === "error");
  if (errEv) {
    // keep waiting a little for done, but note it
  }
  await new Promise((r) => setTimeout(r, 500));
}

const contentText = events
  .filter((e) => e.type === "content")
  .map((e) => e.content ?? "")
  .join("");
const toolCalls = events.filter((e) => e.type === "tool_call");
const toolResults = events.filter((e) => e.type === "tool_result");
const errors = events.filter((e) => e.type === "error");

console.log("\n--- turn summary ---");
console.log("events:", events.length);
console.log("content chars:", contentText.length);
console.log("content text:", JSON.stringify(contentText.slice(0, 300)));
console.log("tool_calls:", toolCalls.length, "tool_results:", toolResults.length);
console.log("errors:", errors.map((e) => e.content ?? e.message ?? e).slice(0, 5));
console.log("done:", JSON.stringify(doneEvent?.metadata ?? doneEvent ?? null));

// --- verify session persistence ----------------------------------------------
const sessionId = doneEvent?.metadata?.session_id ?? events.find((e) => e.type === "session")?.metadata?.session_id;
let persisted = null;
if (sessionId) {
  const r = await fetch(`${base}/api/sessions/${sessionId}`);
  persisted = await r.json().catch(() => null);
  const msgs = persisted?.messages ?? persisted?.session?.messages ?? [];
  console.log("\nsession:", sessionId, "status:", persisted?.status ?? persisted?.session?.status);
  console.log("messages:", msgs.map((m) => `${m.role}:${String(m.content ?? "").slice(0, 60)}`));
}

// --- second turn: tool dispatch + session history ----------------------------
if (sessionId) {
  const before = events.length;
  const cmd2 = await fetch(
    `${base}/api/realtime/commands?client_id=${clientId}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "start_turn",
        protocol_version: "2.0",
        command_id: "cmd-2",
        session_id: sessionId,
        content:
          "Use the question_bank tool with action \"list\" to check saved questions, then tell me in one sentence whether any are saved.",
        llm_selection: { profile_id: "openai", model_id: LLM_MODEL },
      }),
    },
  );
  console.log("\ncommand2 response:", cmd2.status, JSON.stringify(await cmd2.json().catch(() => null)));

  const deadline2 = Date.now() + 240000;
  while (Date.now() < deadline2) {
    const dones = events.slice(before).filter((e) => e.type === "done");
    if (dones.length) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const turn2 = events.slice(before);
  const t2content = turn2.filter((e) => e.type === "content").map((e) => e.content ?? "").join("");
  console.log("\n--- turn 2 summary ---");
  console.log("events:", turn2.length);
  console.log("content:", JSON.stringify(t2content.slice(0, 400)));
  console.log("tool_calls:", turn2.filter((e) => e.type === "tool_call").map((e) => e.metadata?.tool_name ?? e.content));
  console.log("tool_results:", turn2.filter((e) => e.type === "tool_result").length);
  console.log("errors:", turn2.filter((e) => e.type === "error").map((e) => e.content).slice(0, 3));
  console.log("done:", JSON.stringify(turn2.find((e) => e.type === "done")?.metadata ?? null));

  const r2 = await fetch(`${base}/api/sessions/${sessionId}`);
  const p2 = await r2.json().catch(() => null);
  const msgs2 = p2?.messages ?? p2?.session?.messages ?? [];
  console.log("\npersisted messages:", msgs2.map((m) => `${m.role}:${String(m.content ?? "").slice(0, 60)}`));
}

await sseRes.body.cancel().catch(() => {});
await shutdown().catch(() => {});
server.close();
process.exit(0);
