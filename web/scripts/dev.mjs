#!/usr/bin/env node
/**
 * Dev-server entrypoint that pins the V8 heap ceiling of the Vite dev process.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEAP_CEILING_MB = 4096;
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_BIN = path.join(WEB_DIR, "node_modules", "vite", "bin", "vite.js");

/** Memory this process may actually use, in MB — cgroup limit included. */
function memoryBudgetMB() {
  let bytes = os.totalmem();
  try {
    const limit = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim());
    if (Number.isFinite(limit) && limit > 0) bytes = Math.min(bytes, limit);
  } catch {
    // No cgroup v2 limit (macOS, Windows, unconstrained container).
  }
  return Math.floor(bytes / 1024 / 1024);
}

const inherited = process.env.NODE_OPTIONS ?? "";
const nodeOptions = /--max[-_]old[-_]space[-_]size/.test(inherited)
  ? inherited
  : `${inherited} --max-old-space-size=${Math.min(
      HEAP_CEILING_MB,
      Math.floor(memoryBudgetMB() * 0.5),
    )}`.trim();

const child = spawn(process.execPath, [VITE_BIN, ...process.argv.slice(2)], {
  cwd: WEB_DIR,
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
