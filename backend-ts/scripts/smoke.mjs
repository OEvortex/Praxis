// Smoke test: boot the Hono app via createApp() on an ephemeral port and
// exercise the main REST surfaces.
//
// Run:  PRAXIS_DATA_DIR=/tmp/dt-smoke-data npx tsx scripts/smoke.mjs
// (env vars are also set inside the script before importing src/main.ts)

import { serve } from "@hono/node-server";

// Isolate all persisted state BEFORE src/config.ts / shared/settings.ts load.
process.env.PRAXIS_DATA_DIR = "/tmp/dt-smoke-data";
process.env.DATA_DIR = "/tmp/dt-smoke-data";
process.env.PORT = "0";

const { createApp, shutdown } = await import("../src/main.ts");

const results = [];
function report(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(opts.timeout ?? 15000),
    ...opts,
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

async function main() {
  const app = await createApp();
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  console.log(`smoke: app listening on ${base}\n`);

  // 1. Health
  try {
    const r = await get(base, "/health");
    report("GET /health", r.status === 200 && r.body?.status === "ok", `status=${r.status}`);
  } catch (e) {
    report("GET /health", false, String(e));
  }

  // 2. Sessions list
  try {
    const r = await get(base, "/api/sessions");
    const n = Array.isArray(r.body?.sessions) ? r.body.sessions.length : -1;
    report("GET /api/sessions", r.status === 200 && n >= 0, `status=${r.status} sessions=${n}`);
  } catch (e) {
    report("GET /api/sessions", false, String(e));
  }

  // 3. Session create — sessions are created by a realtime start_turn command
  //    (there is no POST /api/sessions; this matches the original behaviour).
  let createdSessionId = null;
  try {
    const r = await get(base, "/api/realtime/commands?client_id=smoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "start_turn", content: "smoke test turn" }),
    });
    const accepted = r.body?.accepted === true || r.status === 200;
    // The session id is delivered over SSE; find it via the sessions list.
    await new Promise((r2) => setTimeout(r2, 500));
    const list = await get(base, "/api/sessions");
    const sessions = list.body?.sessions ?? [];
    createdSessionId = sessions[0]?.id ?? sessions[0]?.session_id ?? null;
    report(
      "session create (realtime start_turn)",
      accepted && sessions.length > 0,
      `cmd_status=${r.status} sessions=${sessions.length}`,
    );
  } catch (e) {
    report("session create (realtime start_turn)", false, String(e));
  }

  // 3b. GET the created session if we found one
  if (createdSessionId) {
    try {
      const r = await get(base, `/api/sessions/${createdSessionId}`);
      report("GET /api/sessions/:id", r.status === 200, `status=${r.status}`);
    } catch (e) {
      report("GET /api/sessions/:id", false, String(e));
    }
  }

  // 4. Documents list
  try {
    const r = await get(base, "/api/documents");
    report("GET /api/documents", r.status === 200, `status=${r.status}`);
  } catch (e) {
    report("GET /api/documents", false, String(e));
  }

  // 5. Calendar calendars list
  try {
    const r = await get(base, "/api/calendar/calendars");
    report("GET /api/calendar/calendars", r.status === 200, `status=${r.status}`);
  } catch (e) {
    report("GET /api/calendar/calendars", false, String(e));
  }

  // 6. Cron jobs list
  try {
    const r = await get(base, "/api/cron/jobs");
    report("GET /api/cron/jobs", r.status === 200, `status=${r.status}`);
  } catch (e) {
    report("GET /api/cron/jobs", false, String(e));
  }

  // 7. Reviews due
  try {
    const r = await get(base, "/api/reviews/due");
    report("GET /api/reviews/due", r.status === 200, `status=${r.status}`);
  } catch (e) {
    report("GET /api/reviews/due", false, String(e));
  }

  // 8. OpenUI wiki lookup — hits Wikipedia; tolerate network failure.
  try {
    const r = await get(base, "/api/openui/wiki?title=Python%20(programming%20language)", {
      timeout: 20000,
    });
    const ok = r.status === 200;
    report(
      "GET /api/openui/wiki",
      ok,
      ok ? "status=200" : `status=${r.status} (network-dependent, tolerated)`,
    );
    if (!ok) results[results.length - 1].tolerated = true;
  } catch (e) {
    report("GET /api/openui/wiki", false, `network error tolerated: ${String(e).slice(0, 120)}`);
    results[results.length - 1].tolerated = true;
  }

  // 9. Realtime command — simple ping shape.
  try {
    const r = await get(base, "/api/realtime/commands?client_id=smoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "ping" }),
    });
    report("POST /api/realtime/commands (ping)", r.status === 200, `status=${r.status}`);
  } catch (e) {
    report("POST /api/realtime/commands (ping)", false, String(e));
  }

  server.close();
  await shutdown().catch(() => {});

  const hardFails = results.filter((r) => !r.ok && !r.tolerated);
  const tolerated = results.filter((r) => r.tolerated);
  console.log(`\n${results.length - hardFails.length - tolerated.length}/${results.length} hard checks passed; ${tolerated.length} tolerated`);
  process.exit(hardFails.length ? 1 : 0);
}

main().catch((err) => {
  console.error("smoke harness error:", err);
  process.exit(2);
});
