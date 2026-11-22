// Hono app: REST API + SSE transport.
//
// Turn commands and legacy feature-channel messages are handled by the plain
// REST controller in ./api/realtime.js, which streams frames to the browser
// over GET /api/realtime/events.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { AgentRuntime } from "./agent/runtime.js";
import { agentConfigRouter } from "./api/agent_config.js";
import { authRouter } from "./api/auth.js";
import { booksRouter } from "./api/books.js";
import { calendarRouter } from "./api/calendar.js";
import { coWriterRouter } from "./api/co_writer.js";
import { cronRouter } from "./api/cron.js";
import { documentsRouter } from "./api/documents.js";
import { filesRouter } from "./api/files.js";
import { handlersRouter } from "./api/handlers.js";
import { knowledgeConnectorsRouter } from "./api/knowledge_connectors.js";
import { knowledgeIndexingRouter } from "./api/knowledge_indexing.js";
import { knowledgeRagRouter } from "./api/knowledge_rag.js";
import { learningJournalRouter } from "./api/learning_journal.js";
import { marginnoteRouter } from "./api/marginnote.js";
import { masteryRouter } from "./api/mastery.js";
import { mediaRouter } from "./api/media.js";
import { memoryRouter } from "./api/memory.js";
import { miscRouter } from "./api/misc.js";
import { openuiRouter } from "./api/openui.js";
import { partnersFullRouter } from "./api/partners_full.js";
import { platformRouter } from "./api/platform.js";
import { questionNotebookRouter, quizRouter } from "./api/quiz.js";
import { readingRouter } from "./api/reading.js";
import { RealtimeHub, realtimeRouter } from "./api/realtime.js";
import { sessionsExtRouter } from "./api/sessions_ext.js";
import { settingsFullRouter } from "./api/settings_full.js";
import { subagentsRouter } from "./api/subagents.js";
import { systemExtRouter } from "./api/system_ext.js";
import { videoLearningRouter, videoLearningSettingsRouter } from "./api/video_learning.js";
import { workspaceExtRouter } from "./api/workspace_ext.js";
import { get_settings as getSettings } from "./config.js";
import { KnowledgeBaseStore } from "./store/kb_store.js";
import { SessionStore } from "./store/session_store.js";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const settings = getSettings();
mkdirSync(settings.data_dir, { recursive: true });
// workspaceDir/filesDir equivalents — derived from dataDir like config.py.
const state = {
  settings,
  store: null as unknown as SessionStore,
  runtime: null as unknown as AgentRuntime,
  kb: null as unknown as KnowledgeBaseStore,
  realtime: null as unknown as RealtimeHub,
};

export async function createApp(): Promise<Hono> {
  state.store = new SessionStore(settings);
  state.runtime = new AgentRuntime(settings, state.store);
  state.kb = new KnowledgeBaseStore(settings);
  state.realtime = new RealtimeHub({ store: state.store, runtime: state.runtime });

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["*"], allowHeaders: ["*"] }));

  // Lifespan equivalent: startup hooks.
  state.realtime.start();
  // Notebook writer progress/completion needs to reach the browser even when
  // the parent turn has already ended (the usual case for a background job).
  const notebookEvents = await import("./agent/notebook_agent/events.js");
  notebookEvents.setBroadcast(state.realtime.broadcast.bind(state.realtime));
  notebookEvents.setRuntime(state.runtime);
  // Notes saved by older versions lived outside the notebook store. Bring
  // them into Co-Writer on boot so they are visible without a tool call.
  const { sync_legacy_notes } = await import("./services/documents/notes.js");
  sync_legacy_notes();
  // Scheduled reminders run through the app's agent runtime; the cron
  // scheduler owns its own loop and stops with the server.
  const { setRuntime: setCronRuntime } = await import("./services/cron/executor.js");
  const { startCron, stopCron } = await import("./services/cron/module_service.js");
  setCronRuntime(state.runtime as never);
  await startCron();
  // Web-source auto-sync scheduler (upstream start_web_source_sync_scheduler).
  const { startWebSourceScheduler } = await import("./services/kb_connectors/web_source.js");
  startWebSourceScheduler(settings);

  app.get("/health", (c) => c.json({ status: "ok" }));
  // api/main.py app-level routes.
  app.get("/", (c) => c.json({ status: "ok", service: "deeptutor-ts" }));
  app.get("/health/live", (c) => c.json({ status: "ok" }));
  app.get("/health/ready", (c) => c.json({ status: "ok" }));

  // Upstream-faithful routers mount BEFORE handlersRouter: handlers.ts still
  // carries early stub routes for some of these paths, and Hono is
  // first-match-wins, so the real implementations must be registered first.
  app.route("/", sessionsExtRouter);
  app.route("/", subagentsRouter);
  app.route("/", platformRouter);
  app.route("/", knowledgeConnectorsRouter);
  app.route("/", knowledgeIndexingRouter);
  app.route("/", knowledgeRagRouter);
  app.route("/", settingsFullRouter);
  app.route("/api", partnersFullRouter);
  app.route("/api/auth", authRouter);
  app.route("/", agentConfigRouter);
  app.route("/", booksRouter);
  app.route("/api/reading", readingRouter);
  app.route("/api/mastery-paths", masteryRouter);
  app.route("/", coWriterRouter);
  app.route("/api/memory", memoryRouter);
  app.route("/", systemExtRouter);
  app.route("/", mediaRouter);
  app.route("/", miscRouter);
  app.route("/", questionNotebookRouter);
  app.route("/", quizRouter);
  app.route("/", videoLearningRouter);
  app.route("/", videoLearningSettingsRouter);
  app.route("/", marginnoteRouter);
  app.route("/", learningJournalRouter);
  app.route("/", workspaceExtRouter);

  app.route("/", handlersRouter);
  app.route("/", calendarRouter);
  app.route("/", documentsRouter);
  app.route("/", cronRouter);
  app.route("/", filesRouter);
  app.route("/", openuiRouter);
  app.route("/", realtimeRouter);

  // Expose state for tests/tools.
  (app as unknown as { state: typeof state }).state = state;

  const originalFetch = app.fetch.bind(app);
  app.fetch = (async (req: Request, env?: unknown, ctx?: unknown) => {
    try {
      return await originalFetch(req, env as never, ctx as never);
    } finally {
      // NOTE: shutdown hooks (stopCron, realtime.stop) run on process signals.
    }
  }) as typeof app.fetch;

  return app;
}

export { state as appState };

export async function shutdown(): Promise<void> {
  try {
    const { stopCron } = await import("./services/cron/module_service.js");
    await stopCron();
  } catch { /* cron may not have started */ }
  try {
    await state.realtime?.stop();
  } catch { /* ignore */ }
}

// Entry point when run directly: `tsx src/main.ts` / `node dist/main.js`
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = await createApp();
  const port = Number(process.env.PORT ?? (settings as { port?: number }).port ?? 8001);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`Praxis TS backend listening on http://127.0.0.1:${info.port}`);
  });
  // Unified WebSocket endpoints — /ws plus quiz/mastery WS paths
  // (see src/api/ws_dispatch.ts for the full route table).
  const { attachAllWs } = await import("./api/ws_dispatch.js");
  attachAllWs(server as never, { settings });
  const bye = () => { void shutdown().finally(() => process.exit(0)); };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
