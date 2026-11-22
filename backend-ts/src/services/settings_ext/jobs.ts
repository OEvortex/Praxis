import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

export interface JobStatus {
  state: "idle" | "running" | "done" | "failed" | "cancelled";
  kind: string;
  engine: string;
  lines: string[];
  next_cursor: number;
  message: string;
}

class BackgroundJobManager {
  private state: JobStatus["state"] = "idle";
  private kind = "";
  private engine = "";
  private lines: string[] = [];
  private base = 0;
  private message = "";
  private proc: ChildProcess | null = null;
  private cancelRequested = false;

  status(cursor = 0): JobStatus {
    const start = Math.max(Math.trunc(cursor) - this.base, 0);
    return { state: this.state, kind: this.kind, engine: this.engine, lines: this.lines.slice(start), next_cursor: this.base + this.lines.length, message: this.message };
  }
  cancel(): { ok: boolean; message: string } {
    if (this.state !== "running" || !this.proc) return { ok: false, message: "No job is running." };
    this.cancelRequested = true;
    this.proc.kill("SIGTERM");
    return { ok: true, message: "" };
  }
  start(kind: "install" | "models", engine: string, cmd: string[], env: NodeJS.ProcessEnv = {}): { ok: boolean; message: string } {
    if (this.state === "running") return { ok: false, message: `A ${this.kind || "job"} is already running (${this.engine}).` };
    let proc: ChildProcess;
    try {
      proc = spawn(cmd[0], cmd.slice(1), { env: { ...process.env, ...env, PYTHONUTF8: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (exc) {
      this.state = "failed"; this.kind = kind; this.engine = engine; this.message = `Failed to launch: ${exc}`;
      return { ok: false, message: this.message };
    }
    this.state = "running"; this.kind = kind; this.engine = engine;
    this.lines = []; this.base = 0; this.message = ""; this.proc = proc; this.cancelRequested = false;
    const append = (chunk: Buffer | string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (!text) continue;
        this.lines.push(text.slice(0, 300));
        if (this.lines.length > 2000) { this.lines.splice(0, this.lines.length - 2000); this.base += 1; }
      }
    };
    proc.stdout?.on("data", append); proc.stderr?.on("data", append);
    proc.on("error", (err) => { this.state = "failed"; this.message = String(err); this.proc = null; });
    proc.on("close", (code) => {
      this.state = this.cancelRequested ? "cancelled" : code === 0 ? "done" : "failed";
      this.message = this.cancelRequested ? "Cancelled." : code === 0 ? "Finished." : `Exited with code ${code}.`;
      this.proc = null;
    });
    return { ok: true, message: "" };
  }
}
export const backgroundJobManager = new BackgroundJobManager();

export function which(name: string): string | null {
  const paths = (process.env.PATH ?? "").split(delimiter);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of paths) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      try { if (existsSync(p) && statSync(p).isFile()) return p; } catch { /* continue */ }
    }
  }
  return null;
}
export function pythonAvailable(): boolean {
  const exe = process.env.PRAXIS_PYTHON || "python";
  const probe = spawnSync(exe, ["-c", "import sys; print(sys.version)"], { timeout: 3000, encoding: "utf8" });
  return probe.status === 0;
}
export function pythonImport(moduleName: string): boolean {
  if (!pythonAvailable()) return false;
  const exe = process.env.PRAXIS_PYTHON || "python";
  const probe = spawnSync(exe, ["-c", `import ${moduleName}`], { timeout: 8000, encoding: "utf8" });
  return probe.status === 0;
}
export function mineruCliProbe(configuredPath = ""): { found: boolean; command: string; path: string; source: "configured" | "path" } {
  const configured = configuredPath.trim();
  if (configured) {
    const candidate = configured.startsWith("~") ? configured.replace(/^~/, process.env.HOME ?? "") : configured;
    const found = existsSync(candidate) && statSync(candidate).isFile();
    return { found, command: candidate.split(/[\\/]/).pop() ?? candidate, path: candidate, source: "configured" };
  }
  for (const command of ["mineru", "magic-pdf"]) {
    const path = which(command);
    if (path) return { found: true, command, path, source: "path" };
  }
  return { found: false, command: "", path: "", source: "path" };
}
export function resolveMineruDownloader(localCliPath = ""): { found: boolean; path: string } {
  const probe = mineruCliProbe(localCliPath);
  const candidates: string[] = [];
  if (probe.found && probe.path) candidates.push(join(dirname(probe.path), "mineru-models-download"));
  const onPath = which("mineru-models-download");
  if (onPath) candidates.push(onPath);
  for (const candidate of candidates) if (existsSync(candidate)) return { found: true, path: candidate };
  return { found: false, path: candidates[0] ?? "" };
}
export function resolveDoclingDownloader(): string[] | null {
  const found = which("docling-tools");
  return found ? [found, "models", "download"] : null;
}
