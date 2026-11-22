// Remotion runtime for
// video lessons: install once, compile per lesson, wrap in a page.
//
// The model writes `Lesson.tsx` against the shipped kit (`remotion/kit.tsx`).
// `build.mjs` compiles it with esbuild, renders sample frames in a WebAssembly
// JavaScript sandbox, and bundles it with `@remotion/player`. The page this
// module writes is self-contained: the learner's browser plays the composition
// live, so no video file is ever encoded on the server.

import { spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { get_settings } from "../../config.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const ASSETS_DIR = resolve(MODULE_DIR, "remotion");
export const KIT_FILES = ["kit.tsx", "voice.ts"] as const;
const BUILD_TIMEOUT_S = 600;
const INSTALL_TIMEOUT_S = 900;
const RENDER_TIMEOUT_S = 180;

let installLock: Promise<void> = Promise.resolve();
function withInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = installLock.then(fn, fn);
  installLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export class VideoLessonRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoLessonRuntimeError";
  }
}

export interface ExecResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export interface BuildResult {
  ok: boolean;
  stage: string;
  errors: string[];
  frames: Record<string, unknown>[];
}

export function runtimeDir(): string {
  /** Where the npm packages live; `PRAXIS_REMOTION_RUNTIME` overrides the default. */
  const override = (process.env.PRAXIS_REMOTION_RUNTIME ?? "").trim();
  if (override) return resolve(override.replace(/^~(?=$|\/)/, homedir()));
  return join(get_settings().data_dir, "runtime", "remotion");
}

function which(name: string): string | null {
  const pathEnv = process.env.PATH ?? "";
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

function nodeBin(): string {
  const node = which("node");
  if (!node) {
    throw new VideoLessonRuntimeError(
      "Video lessons need Node.js 22+ on the server (the `node` command was not found).",
    );
  }
  return node;
}

function installed(root: string): boolean {
  const manifest = JSON.parse(
    readFileSync(join(ASSETS_DIR, "package.json"), "utf-8"),
  ) as { dependencies?: Record<string, string> };
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    const pkg = join(root, "node_modules", name, "package.json");
    if (!existsSync(pkg)) return false;
    try {
      const meta = JSON.parse(readFileSync(pkg, "utf-8")) as { version?: string };
      if (meta.version !== version) return false;
    } catch {
      return false;
    }
  }
  return true;
}

interface RunToolOptions {
  timeout: number;
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Run the trusted compiler with bounded output and a hard wall-clock deadline.
 *
 * Model code itself runs inside WebAssembly (see `build.mjs`), never in the
 * host JavaScript context. This subprocess owns only the compiler and the
 * Wasm interpreter.
 */
function runTool(argv: string[], opts: RunToolOptions): Promise<ExecResult> {
  const { timeout, cwd, env, signal } = opts;
  const childEnv = { ...process.env, ...(env ?? {}) } as Record<string, string>;
  return new Promise<ExecResult>((resolvePromise) => {
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (exc) {
      resolvePromise({
        ok: false,
        exitCode: -1,
        stdout: "",
        stderr: "",
        error: `could not start ${argv[0]}: ${exc}`,
      });
      return;
    }

    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise(result);
    };

    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "aborted", timedOut: true });
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, exitCode: -1, stdout: "", stderr: "", error: "", timedOut: true });
    }, timeout * 1000);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf-8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf-8")));
    child.on("error", (exc) => {
      finish({ ok: false, exitCode: -1, stdout, stderr, error: `could not start ${argv[0]}: ${exc}` });
    });
    child.on("close", (code) => {
      const exitCode = code ?? -1;
      finish({ ok: exitCode === 0, exitCode, stdout, stderr });
    });
  });
}

function requireSuccess(result: ExecResult, action: string): void {
  if (!result.ok || result.exitCode !== 0) {
    let detail = result.error || result.stderr || result.stdout;
    if (result.timedOut) detail = "timed out";
    throw new VideoLessonRuntimeError(`${action} failed: ${String(detail).slice(-1500)}`);
  }
}

export async function ensureRuntime(signal?: AbortSignal): Promise<string> {
  /** Prepare the pinned npm toolchain; never fall back to host execution. */
  nodeBin();
  const root = runtimeDir();
  return withInstallLock(async () => {
    if (!installed(root)) {
      const npm = which("npm");
      if (!npm) {
        throw new VideoLessonRuntimeError(
          "Video lessons need npm to install Remotion.",
        );
      }
      mkdirSync(root, { recursive: true });
      for (const name of ["package.json", "package-lock.json"]) {
        copyFileSync(join(ASSETS_DIR, name), join(root, name));
      }
      const result = await runTool(
        [npm, "ci", "--no-audit", "--no-fund", "--omit=dev"],
        { timeout: INSTALL_TIMEOUT_S, cwd: root, signal },
      );
      requireSuccess(result, "Installing Remotion");
      if (!installed(root)) {
        throw new VideoLessonRuntimeError(
          "Installed Remotion packages do not match the manifest.",
        );
      }
    }
    return root;
  });
}

export function prepareWorkdir(
  workDir: string,
  code: string,
  voice?: string | null,
): string {
  /**
   * Write the lesson next to a fresh copy of the kit and return the lesson path.
   *
   * `voice` is the generated `voice.ts` module; without it the kit's empty
   * default is used, so captions render silently.
   */
  mkdirSync(workDir, { recursive: true });
  for (const name of KIT_FILES) {
    copyFileSync(join(ASSETS_DIR, name), join(workDir, name));
  }
  if (voice != null) {
    writeFileSync(join(workDir, "voice.ts"), voice, "utf-8");
  }
  const lesson = join(workDir, "Lesson.tsx");
  writeFileSync(lesson, code, "utf-8");
  return lesson;
}

export async function buildLesson(
  lesson: string,
  bundle: string,
  signal?: AbortSignal,
): Promise<BuildResult> {
  /** Compile the lesson and validate it through the deployment-independent JS sandbox. */
  const root = await ensureRuntime(signal);
  const result = await runTool(
    [nodeBin(), join(ASSETS_DIR, "build.mjs"), lesson, bundle],
    {
      timeout: BUILD_TIMEOUT_S,
      env: {
        PRAXIS_REMOTION_RUNTIME: root,
        PRAXIS_RENDER_TIMEOUT_MS: String(RENDER_TIMEOUT_S * 1000),
      },
      signal,
    },
  );
  if (result.timedOut) {
    return {
      ok: false,
      stage: "timeout",
      errors: [`build did not finish within ${BUILD_TIMEOUT_S}s`],
      frames: [],
    };
  }
  const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(lines[lines.length - 1] ?? "") as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      stage: "build",
      errors: [(result.error || result.stderr || "no output").slice(-1500)],
      frames: [],
    };
  }
  return {
    ok: Boolean(data.ok) && result.ok && result.exitCode === 0,
    stage: String(data.stage ?? ""),
    errors: Array.isArray(data.errors) ? data.errors.map(String) : [],
    frames: Array.isArray(data.frames)
      ? (data.frames as Record<string, unknown>[])
      : [],
  };
}

const PAGE = `<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Lora:ital,wght@0,400;0,500;0,600;1,500&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box }
html, body { margin: 0; background: #fdfcf9 }
#player { width: 100%; max-width: 1280px; margin: 0 auto }
</style>
</head>
<body>
<div id="player"></div>
<script>{bundle}</script>
</body>
</html>
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

export function writePage(bundle: string, page: string, title: string): string {
  /** Wrap the compiled player in a self-contained page served under /files. */
  const script = readFileSync(bundle, "utf-8").replace(/<\/script/gi, "<\\/script");
  mkdirSync(dirname(page), { recursive: true });
  const html = PAGE.replace("{lang}", "en")
    .replace("{title}", escapeHtml(title))
    .replace("{bundle}", script);
  writeFileSync(page, html, "utf-8");
  return page;
}

