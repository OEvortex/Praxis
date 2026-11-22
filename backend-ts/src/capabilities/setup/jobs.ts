// long-running setup work
// started from chat.
//
// Upstream's jobs install document-parsing engines / download model weights;
// Praxis has no such engines, so the job registry here covers the setup
// checks that actually exist on this backend: verifying the TTS chain works
// (which engine speaks) and checking ffmpeg (needed to join audio). The
// action/engine shape is kept so the tool surface mirrors upstream.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings } from "../../config.js";
import { speak, VOICE } from "../../agent/video_lesson/narration.js";

const execFileAsync = promisify(execFile);

export interface JobOutcome {
  ok: boolean;
  action: string;
  engine: string;
  state: string;
  message: string;
  lines: string[];
  still_running: boolean;
}

function toDict(o: JobOutcome): Record<string, unknown> {
  return {
    ok: o.ok,
    action: o.action,
    engine: o.engine,
    state: o.state,
    message: o.message,
    log_tail: o.lines.slice(-20),
    still_running: o.still_running,
  };
}

export { toDict as jobOutcomeDict };

export interface AvailableJob {
  action: string;
  engine: string;
  label: string;
  detail: string;
  runnable: boolean;
  not_runnable_because?: string;
}

/** Describe every setup job that could be started right now. */
export function availableJobs(): AvailableJob[] {
  return [
    {
      action: "probe_tts",
      engine: "tts",
      label: "Verify the text-to-speech engine",
      detail:
        "Speaks a short sample through the configured TTS chain (msedge-tts, " +
        "then system TTS) and reports which engine answered. Seconds, not minutes.",
      runnable: true,
    },
    {
      action: "check_ffmpeg",
      engine: "ffmpeg",
      label: "Check ffmpeg",
      detail:
        "Verifies ffmpeg is on PATH — required to join mixed-format audio " +
        "for audio overviews. Read-only check.",
      runnable: true,
    },
    {
      action: "install_engine",
      engine: "parsing",
      label: "Install a document-parsing engine",
      detail:
        "Praxis parses documents with its built-in extractors; there are no " +
        "optional parsing engines to install.",
      runnable: false,
      not_runnable_because: "No optional parsing engines exist on this backend.",
    },
    {
      action: "download_models",
      engine: "parsing",
      label: "Download model weights",
      detail: "No local model weights are used by this backend.",
      runnable: false,
      not_runnable_because: "No downloadable model weights exist on this backend.",
    },
  ];
}

async function probeTts(settings: Settings): Promise<JobOutcome> {
  void settings;
  const lines: string[] = [];
  try {
    const clip = await speak("This is a voice check for the audio overview feature.", VOICE);
    if (!clip.audio?.length) {
      return {
        ok: false,
        action: "probe_tts",
        engine: "tts",
        state: "failed",
        message: "A TTS engine ran but returned no audio.",
        lines,
        still_running: false,
      };
    }
    lines.push(`engine=${clip.engine ?? "unknown"} mime=${clip.mime ?? "?"} bytes=${clip.audio.length}`);
    return {
      ok: true,
      action: "probe_tts",
      engine: "tts",
      state: "done",
      message: `Speech works via ${clip.engine ?? "an unknown engine"} (${clip.audio.length} bytes).`,
      lines,
      still_running: false,
    };
  } catch (exc) {
    return {
      ok: false,
      action: "probe_tts",
      engine: "tts",
      state: "failed",
      message: `No TTS engine produced audio: ${exc instanceof Error ? exc.message : String(exc)}`,
      lines,
      still_running: false,
    };
  }
}

async function checkFfmpeg(): Promise<JobOutcome> {
  const lines: string[] = [];
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"], { timeout: 10_000 });
    const first = String(stdout).split("\n")[0] ?? "";
    lines.push(first.trim());
    return {
      ok: true,
      action: "check_ffmpeg",
      engine: "ffmpeg",
      state: "done",
      message: `ffmpeg found: ${first.trim()}`,
      lines,
      still_running: false,
    };
  } catch (exc) {
    return {
      ok: false,
      action: "check_ffmpeg",
      engine: "ffmpeg",
      state: "failed",
      message:
        "ffmpeg was not found on PATH. Install it to enable joined audio " +
        `output for audio overviews. (${exc instanceof Error ? exc.message : String(exc)})`,
      lines,
      still_running: false,
    };
  }
}

export async function runJob(
  settings: Settings,
  action: string,
  engine: string,
): Promise<JobOutcome> {
  const normalized = String(action ?? "").trim().toLowerCase();
  const engineId = String(engine ?? "").trim().toLowerCase();

  const job = availableJobs().find(
    (j) => j.action === normalized && (!engineId || j.engine === engineId || engineId === j.engine),
  );
  if (normalized === "probe_tts") return probeTts(settings);
  if (normalized === "check_ffmpeg") return checkFfmpeg();
  if (job && !job.runnable) {
    return {
      ok: false,
      action: normalized,
      engine: engineId,
      state: "failed",
      message: job.not_runnable_because ?? `The '${engineId}' job cannot run.`,
      lines: [],
      still_running: false,
    };
  }
  return {
    ok: false,
    action: normalized,
    engine: engineId,
    state: "failed",
    message: `Unknown setup job '${action}'. Call inspect_setup for jobs_available.`,
    lines: [],
    still_running: false,
  };
}
