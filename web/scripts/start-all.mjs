#!/usr/bin/env node
/**
 * `bun start` — build, then serve Vite preview + FastAPI backend.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT ?? "3000";
const HOST = "127.0.0.1";
const BASE = `http://${HOST}:${PORT}`;
const VITE_BIN = path.join(WEB_DIR, "node_modules", "vite", "bin", "vite.js");
const BACKEND_DIR = path.join(WEB_DIR, "..", "backend");
const PYTHON = process.platform === "win32"
  ? path.join(BACKEND_DIR, ".venv", "Scripts", "python.exe")
  : path.join(BACKEND_DIR, ".venv", "bin", "python");

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: WEB_DIR, stdio: "inherit", env: process.env });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForServer(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch("http://127.0.0.1:8001/health");
      if (res.ok) {
        const page = await fetch(`${BASE}/chat`).catch(() => null);
        if (page && page.ok) return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

const buildCode = await run(process.execPath, ["./scripts/build.mjs"]);
if (buildCode !== 0) {
  console.error("[start-all] build failed");
  process.exit(buildCode);
}

const backend = spawn(PYTHON, ["-m", "uvicorn", "app.main:app",
  "--host", "127.0.0.1", "--port", "8001"], {
  cwd: BACKEND_DIR,
  stdio: "inherit",
  env: { ...process.env, PYTHONPATH: BACKEND_DIR },
});
backend.on("exit", (code) => {
  if (code && !shuttingDown) console.error(`[start-all] backend exited ${code}`);
});

const server = spawn(process.execPath, [VITE_BIN, "preview", "--port", PORT, "--host", HOST], {
  cwd: WEB_DIR,
  stdio: "inherit",
  env: process.env,
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.kill("SIGTERM");
  server.kill("SIGTERM");
}
server.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
backend.on("exit", () => {});
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

waitForServer()
  .then((ok) => {
    if (ok) console.log("[start-all] production frontend + backend agent ready");
    else console.warn("[start-all] server did not come up in time");
  })
  .catch(() => {});
