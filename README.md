# Praxis

An agent-native AI learning companion. Praxis is a self-hosted workspace where a tutor agent teaches through conversation — chat, guided mastery paths, generated books, immersive reading, quizzes, spaced-repetition practice, notebooks, a personal knowledge base, calendar, and scheduled automations — all wired to the model providers and tools you configure.

## Repository layout

This is a monorepo with two deployables:

```
backend-ts/   TypeScript API server — Hono on Node, tsx in dev, SQLite storage
web/          React 19 + Vite frontend — bun for dev, custom app router
```

### `backend-ts/`

- **Runtime** — [Hono](https://hono.dev) + `@hono/node-server`, run with `tsx watch` in development (`npm run dev`), compiled with `tsc` for production (`npm run build` / `npm start`).
- **API** — REST under `/api/*` plus a unified WebSocket endpoint at `/ws` (turn streaming, session replay, quiz/mastery live channels, partners).
- **Agent** — a local agent loop in `src/agent/` with tutor tools: web search/fetch, arXiv paper search, knowledge-base retrieval, durable memory, notebook pages, learning/mastery tracking, quiz generation and grading, Remotion video lessons, workspace file ops, the question bank, cron reminders, and spaced-repetition reviews.
- **Capabilities** — higher-level pipelines under `src/capabilities/` (books, reading, question, explore-context, video lessons, audio overview).
- **Providers** — a built-in catalog of 60+ providers (`src/provider-catalog.json`) with model discovery, connections, profiles, and per-model limits resolved from vendored [models.dev](https://models.dev) metadata (`src/model-metadata.json`, refreshed by `scripts/refresh-model-metadata.mjs`).
- **Persistence** — a single WAL-mode SQLite database at `data/praxis.sqlite3` (`kv`, `sessions`, `messages`, `turns`, `kb_meta`/`kb_docs`/`kb_chunks`, `ext_items`, calendar, cron, and more), plus file storage under `data/workspace`.
- **Tests** — `npm test` (vitest).

### `web/`

- **Stack** — React 19, Vite 8, Tailwind, TypeScript. Routing is a small custom router (`shared/router/`) over the `(workspace)`/`(utility)`/`(settings)` route groups in `app/`.
- **Real-time** — turn and channel traffic flows over the `/ws` WebSocket and REST+SSE fallbacks; `features/chat/transport/` holds the protocol client.
- **Surfaces** — chat, learning (books, mastery paths, practice, immersive reading), knowledge bases, notebooks/Co-Writer, memory, calendar, question bank, partners & agents, workspaces, OpenUI generative-UI widgets, and a full settings console.
- **Dev** — `bun run dev` starts Vite on `http://localhost:5173` and proxies `/api`, `/files`, and `/ws` to the backend.
- **Checks** — `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:node`, `bun run build`.

## Quick start

You need [Bun](https://bun.sh) for the frontend and Node.js 20+ for the backend.

```bash
# Terminal 1 — backend API (http://127.0.0.1:8001)
cd backend-ts
npm install
npm run dev

# Terminal 2 — frontend (http://localhost:5173)
cd web
bun install
bun run dev
```

Open `http://localhost:5173`. On first run, connect a model provider and pick a chat model under **Settings → Providers** and **Settings → Language models** — everything else (knowledge bases, search, voice, task models) is optional.

Health check: `curl http://127.0.0.1:8001/health/live` → `{"status":"ok"}`.

### Production

```bash
cd backend-ts && npm run build && npm start   # serves the API on :8001
cd web && bun run build && bun run preview    # static frontend
```

Environment overrides: `BACKEND_PORT` (default `8001`), `DT_DATA_DIR` / data directory resolution in `backend-ts/src/config.ts`.

## Features at a glance

- **Chat** — streaming turns over WebSocket, attachments, quotes, voice input and per-workspace conversations. The slash-free composer actions (Explain, Solve, Practice, Plan, Research) both prefill a starter prompt and select a real tutor mode with its own server-side playbook; the same modes are available from the Mode selector.
- **Learning** — AI-authored books with editable chapter spines, mastery paths with agreed outlines and per-point mastery, a question bank with spaced-repetition reviews, and immersive reading with a side tutor.
- **Knowledge** — personal knowledge bases with local LlamaIndex retrieval and Tencent IMA libraries, plus connectors for Obsidian, folders, GitHub, and web sources.
- **Notes** — revision-checked Markdown pages (Co-Writer) with AI edits, suggestions, threads, backlinks, and flashcard export.
- **Agent tools** — the tutor can search the web and papers, query your KBs, remember durable facts, keep a journal, schedule reminders, and run spaced repetition — no coding-agent tools are exposed.
- **Workspaces** — named workspaces with their own folders, instructions, and assigned skills/MCP/knowledge resources.
- **Providers** — 60+ built-in provider presets, connection management, live model discovery, and models.dev-derived context/output limits.

## Development

```bash
# backend
cd backend-ts
npm run typecheck   # tsc --noEmit
npm test            # vitest

# frontend
cd web
bun run typecheck
bun run lint        # oxlint
bun run test:unit   # vitest
bun run test:node   # node test runner
bun run check       # contracts + architecture + typecheck + tests + lint + build + perf budgets
```

API contracts are generated from the backend OpenAPI schema (`web/contracts/`); `bun run contracts:check` verifies they are in sync.

### Consolidated agent tools

The chat agent sees **21 tools**, not ~77. Related tools are registered as one `action`-dispatched tool (`agent/merged_tools.ts`, factory in `agent/merged_tools_factory.ts`): `obsidian`, `ima`, `marginnote`, `setup`, `subagent`, `propose`, `generate`, `solve`, `reading`, `mastery`, `notes`, `sources`. The original tool objects remain the implementation, so capability mode gating, server-injected params and result markers are unchanged. `npm test` asserts the consolidated surface and that hidden params are forwarded.

### Response format: Markdown vs. OpenUI

The chat renders two kinds of answer with one renderer pipeline: plain Markdown prose for short/factual/LaTeX/safety answers, and OpenUI Lang programs when an interface does work prose cannot (a tool, stepper, form, comparison chart/table, stateful checklist, game, or diagram). The shared prompt lives in `web/lib/openui/prompt-options.ts`; regenerate the generated prompts and the backend spec with `cd web && npm run openui:prompt`. Never restore a "your entire response must be UI / no markdown" instruction — that makes the model wrap every answer in components.

The per-turn renderer choice is logged in the `result` event as `metadata.metadata.renderer` (`markdown` | `ui`). To catch regressions where the model reaches for UI too often, run the false-trigger eval:

```bash
cd backend-ts
npx tsx scripts/eval-visual-triggers.ts          # offline fixture/policy check
npx tsx scripts/eval-visual-triggers.ts --live   # run the fixtures against the configured model
npx tsx scripts/eval-visual-triggers.ts --live --limit 4
```

Fixtures live in `backend-ts/tests/fixtures/visual-triggers.json` and are also asserted by `npm test`.

## License

See repository for license details.
