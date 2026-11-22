// Consult runner for subagent_ext — spawns a connected agent CLI
// non-interactively, streams its output as events, and returns the final
// answer. This is the piece upstream's ``SubagentBackend.consult`` provides
// that ``src/api/subagents.ts`` only approximates for its NDJSON endpoint.
//
// Backend registry, per-backend ``BackendConfig`` and detection all come from
// ``services/platform/subagents.ts`` (the port of upstream
// services/subagent/{registry,config}). The argv construction below mirrors
// ``buildConsultArgs`` in ``src/api/subagents.ts`` — kept local because that
// helper is not exported and src/api is out of scope for edits.
//
// Deliberate simplifications vs upstream (documented, not bugs):
//   * Session resume is implemented only where the CLI exposes a stable flag
//     (claude_code ``--resume``; codex ``exec resume``). Other backends ignore
//     ``sessionId`` — TODO(verify) per-backend resume flags.
//   * claude_code runs with ``--output-format json`` so the session id and
//     clean final text can be recovered; other backends return their stdout
//     tail as the answer (same as the api endpoint).
//   * Partner / partner_group / hermes_remote / acp backends are TODO — they
//     need protocol code upstream keeps in dedicated modules.

import { spawn } from "node:child_process";
import type { BackendConfig } from "../../services/platform/subagents.js";

export interface SubagentEvent {
  kind: string;
  text: string;
}

export type OnEvent = (event: SubagentEvent) => void | Promise<void>;

export interface ConsultResult {
  final_text: string;
  session_id: string | null;
  success: boolean;
  error: string | null;
  event_count: number;
}

/**
 * Build the one-shot consult argv for a local CLI backend.
 * Mirrors ``buildConsultArgs`` in src/api/subagents.ts, extended with the
 * session-resume and JSON-output variants this runner needs.
 */
export function buildConsultArgs(
  kind: string,
  cfg: BackendConfig,
  question: string,
  sessionId: string | null,
): string[] | null {
  const extra = [...cfg.extra_args];
  const modelArgs = cfg.model ? modelFlag(kind, cfg.model) : [];
  switch (kind) {
    case "claude_code": {
      const args = [
        "-p", question,
        "--output-format", "json",
        ...(cfg.model ? ["--model", cfg.model] : []),
        ...(cfg.effort ? ["--effort", cfg.effort] : []),
        ...(cfg.permission_mode ? ["--permission-mode", cfg.permission_mode] : []),
        ...(cfg.system_prompt ? ["--append-system-prompt", cfg.system_prompt] : []),
        ...extra,
      ];
      if (sessionId) args.push("--resume", sessionId);
      return ["claude", ...args];
    }
    case "codex": {
      if (sessionId) {
        return [
          "codex", "exec", "resume", sessionId, question,
          ...(cfg.model ? ["-m", cfg.model] : []),
          "--sandbox", cfg.sandbox || "workspace-write",
          ...extra,
        ];
      }
      return [
        "codex", "exec", question,
        ...(cfg.model ? ["-m", cfg.model] : []),
        "--sandbox", cfg.sandbox || "workspace-write",
        ...(cfg.network_access ? ["--config", "sandbox_workspace_write.network_access=true"] : []),
        ...(cfg.ephemeral ? ["--ephemeral"] : []),
        ...extra,
      ];
    }
    case "grok":
      return ["grok", "-p", question, ...modelArgs, ...extra];
    case "antigravity":
      return ["agy", "-p", question, ...extra];
    case "kimi":
      return ["kimi", "-p", question, ...(cfg.auto_approve ? ["--yolo"] : []), ...extra];
    case "opencode":
      return ["opencode", "run", question, ...extra];
    case "mimo":
      return ["mimo", "run", question, ...extra];
    case "hermes":
      return ["hermes", "-p", question, ...(cfg.auto_approve ? ["--yolo"] : []), ...extra];
    case "openclaw":
      return ["openclaw", "run", question, ...extra];
    case "deepseek_harness":
      return ["dsh", "run", question, ...extra];
    default:
      return null;
  }
}

function modelFlag(kind: string, model: string): string[] {
  // Only grok's argv in the api version took --model explicitly; others embed
  // it via their own flags above. Kept for parity.
  void kind;
  return model ? ["--model", model] : [];
}

function parseFinal(stdout: string, kind: string): { final_text: string; session_id: string | null } {
  if (kind === "claude_code") {
    const trimmed = stdout.trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const data = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
        const result = typeof data["result"] === "string" ? (data["result"] as string) : "";
        const sessionId =
          typeof data["session_id"] === "string" && data["session_id"]
            ? (data["session_id"] as string)
            : null;
        const isError = data["is_error"] === true || data["subtype"] === "error";
        return {
          final_text:
            isError && !result
              ? `Claude Code error: ${JSON.stringify(data).slice(0, 500)}`
              : result,
          session_id: sessionId,
        };
      } catch {
        /* fall through to raw text */
      }
    }
  }
  // Generic: last non-empty lines are the answer (same heuristic as the api
  // endpoint's streamed "text" channel).
  const lines = stdout.trimEnd().split("\n").map((l) => l.trimEnd());
  return { final_text: lines.slice(-40).join("\n").trim(), session_id: null };
}

/**
 * Put one question to the backend CLI and stream every output line as an
 * event. Waits unconditionally for process exit — only its own exit (clean
 * or error) ends the consult, mirroring upstream ``SubagentBackend.consult``.
 */
export async function consultBackend(
  kind: string,
  question: string,
  opts: {
    onEvent?: OnEvent;
    cwd?: string | null;
    sessionId?: string | null;
    config: BackendConfig;
    timeoutSeconds?: number;
  },
): Promise<ConsultResult> {
  const cfg = opts.config;
  const timeoutMs = Math.max(
    10,
    opts.timeoutSeconds ?? cfg.idle_timeout_seconds ?? 600,
  ) * 1000;
  const sessionId = opts.sessionId ?? null;

  const argv = buildConsultArgs(kind, cfg, question, sessionId);
  const result: ConsultResult = {
    final_text: "",
    session_id: null,
    success: false,
    error: null,
    event_count: 0,
  };

  const emit = async (kindName: string, text: string): Promise<void> => {
    if (!text || opts.onEvent === undefined) return;
    result.event_count += 1;
    await opts.onEvent({ kind: kindName, text });
  };

  await emit("question", question);

  if (argv === null) {
    result.error = `No consult command for backend ${JSON.stringify(kind)}`;
    await emit("error", result.error);
    return result;
  }

  const [command, ...args] = argv;
  const child = spawn(command, args, {
    cwd: opts.cwd || undefined,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let outBuf = "";
  let errBuf = "";
  const flush = (buf: string): [string, string[]] => {
    const lines = buf.split("\n");
    const rest = lines.pop() ?? "";
    return [rest, lines.map((l) => l.replace(/\r$/, ""))];
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    const combined = outBuf + text;
    const [rest, lines] = flush(combined);
    outBuf = rest;
    for (const line of lines) void emit("text", line);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    const combined = errBuf + text;
    const [rest, lines] = flush(combined);
    errBuf = rest;
    for (const line of lines) void emit("log", line);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }>(
    (resolvePromise) => {
      let settled = false;
      const done = (v: { code: number | null; signal: NodeJS.Signals | null; spawnError: string | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(v);
      };
      const timer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        done({ code: null, signal: "SIGKILL", spawnError: null });
      }, timeoutMs);
      child.on("error", (exc) => {
        done({ code: null, signal: null, spawnError: exc.message });
      });
      child.on("close", (code, signal) => {
        done({ code, signal, spawnError: null });
      });
    },
  );

  if (outBuf.trim()) void emit("text", outBuf);
  if (errBuf.trim()) void emit("log", errBuf);

  if (exit.spawnError !== null) {
    result.error = `failed to launch ${command}: ${exit.spawnError}`;
    await emit("error", result.error);
    return result;
  }
  if (exit.signal === "SIGKILL") {
    result.error = `subagent timed out after ${Math.round(timeoutMs / 1000)}s`;
    await emit("error", result.error);
    return result;
  }

  const parsed = parseFinal(stdout, kind);
  result.final_text = parsed.final_text;
  result.session_id = parsed.session_id;
  result.success = exit.code === 0 && parsed.final_text.trim().length > 0;
  if (!result.success && result.error === null) {
    result.error =
      exit.code !== 0
        ? `${command} exited with code ${exit.code}: ${stderr.trim().slice(-500) || "no stderr"}`
        : "the agent produced no final answer text";
  }
  if (result.error !== null) await emit("error", result.error);
  return result;
}
