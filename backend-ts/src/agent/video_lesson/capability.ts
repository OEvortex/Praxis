// video lesson
// orchestration: write a Remotion scene, validate it, narrate it, and publish
// a self-contained player page under /files.
//
// The main agent only supplies the learner's request. A dedicated writer
// sub-agent produces one JSON metadata block and one Lesson.tsx; this module
// compiles it with the pinned Remotion toolchain, checks sample frames (and an
// optional browser layout probe), and emits the page the chat's
// VideoLessonViewer plays.

import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { get_settings } from "../../config.js";
import { loadInstructions, parseDraft, type LessonDraft } from "./lesson_writer.js";
import { narrate, voiceModule, type Clip } from "./narration.js";
import {
  buildLesson,
  ensureRuntime,
  prepareWorkdir,
  writePage,
  type BuildResult,
} from "./runtime.js";
import { checkLayout, sampleFrames } from "./layout_check.js";
import * as subagent from "../subagent.js";

const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// vtx SDK bridge
//
// TODO(verify): the Python module lazily imports `vtx.agent.dispatcher`
// (`get_context`) and `vtx.agent.tools.task` (`SubagentSpec`,
// `resolve_subagent_runner`). The vtx SDK is Python-only — see the stub
// `SubagentSpec` in src/shared/vtx.ts. Until a TS dispatcher lands, these
// helpers isolate the seam so the rest of the port stays faithful.
// ---------------------------------------------------------------------------

export interface DispatcherContext {
  progressCallback?: ((toolCallId: string, event: Record<string, unknown>) => void) | null;
  [k: string]: unknown;
}

export interface SubagentResult {
  finalText: string;
  error?: string | null;
  [k: string]: unknown;
}

export interface SubagentRunnerArgs {
  parentCtx: DispatcherContext;
  spec: Record<string, unknown>;
  prompt: string;
  cancelEvent?: AbortSignal | null;
  modelOverride?: string | null;
  progressCallback?: DispatcherContext["progressCallback"];
  toolCallId: string;
  label: string;
}

export type SubagentRunner = (args: SubagentRunnerArgs) => Promise<SubagentResult>;

/** Port of `vtx.agent.dispatcher.get_context`. */
export function getDispatcherContext(): DispatcherContext | null {
  // Implemented in src/agent/subagent.ts — derives the context from the
  // active turn (notebook_agent/events.ts ALS) + the saved model selection.
  return subagent.getDispatcherContext() as DispatcherContext | null;
}

/** Port of `vtx.agent.tools.task.resolve_subagent_runner`. */
export function resolveSubagentRunner(): SubagentRunner {
  // Real runner in src/agent/subagent.ts (LocalAgentRuntime-backed loop).
  return subagent.resolve_subagent_runner() as SubagentRunner;
}

// ---------------------------------------------------------------------------

function slugFor(title: string): string {
  const s =
    (title || "video")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "video";
  return `${s}-${randomUUID().replace(/-/g, "").slice(0, 6)}`;
}

function filesRoot(): string {
  return resolve(join(get_settings().data_dir, "files"));
}

function workspaceRoot(): string {
  const root = resolve(
    (process.env.PRAXIS_WORKSPACE_DIR ?? "./data/workspace").replace(
      /^~(?=$|\/)/,
      homedir(),
    ),
  );
  return join(root, "videos");
}

function publish(slug: string, page: string, draft: LessonDraft, bundle: string): string {
  /** Copy the page to /files and keep an editable source copy in the workspace. */
  const served = join(filesRoot(), "videos", slug);
  mkdirSync(served, { recursive: true });
  copyFileSync(page, join(served, "lesson.html"));

  const proj = join(workspaceRoot(), slug);
  const src = join(proj, "src");
  mkdirSync(src, { recursive: true });
  copyFileSync(page, join(src, "lesson.html"));
  copyFileSync(bundle, join(src, "player.js"));
  writeFileSync(join(src, "Lesson.tsx"), draft.code, "utf-8");
  writeFileSync(
    join(src, "meta.json"),
    JSON.stringify(
      {
        title: draft.title,
        summary: draft.summary,
        narration: draft.narration.map((n) => ({ id: n.id, text: n.text })),
      },
      null,
      2,
    ),
    "utf-8",
  );
  if (draft.title) {
    writeFileSync(join(proj, "title.txt"), draft.title, "utf-8");
  }
  return `videos/${slug}/lesson.html`;
}

async function layoutFeedback(
  page: string,
  frames: Record<string, unknown>[],
): Promise<string | null> {
  /** Advisory browser collision check; never fails the lesson on its own. */
  try {
    const total =
      Math.max(...frames.map((f) => Number(f.frame ?? 0) || 0), 0) + 1;
    const issues = await checkLayout(page, sampleFrames(total));
    if (!issues || issues.length === 0) return null;
    return (
      "Layout problems in the 1920x1080 frame:\n" + issues.slice(0, 14).join("\n")
    );
  } catch {
    return null; // the probe is optional
  }
}

interface Good {
  draft: LessonDraft;
  bundle: string;
  page: string;
  frames: Record<string, unknown>[];
}

export async function createLesson(
  query: string,
  title = "",
): Promise<Record<string, unknown>> {
  /**
   * Build a video lesson and return the metadata the frontend player needs.
   *
   * Raises an `Error` with a user-facing `Video ...` prefix on failure.
   */
  const ctx = getDispatcherContext();
  if (ctx === null) {
    throw new Error("Video sub-agent failed: dispatcher context not initialized.");
  }

  const instructions = loadInstructions();
  const spec: Record<string, unknown> = {
    name: "video-lesson-writer",
    description: "Writes a Remotion lesson scene for the learner's question",
    instructions,
    instructions_mode: "replace",
    tools_allow: ["__none__"],
    tools_deny: [],
    max_turns: 4,
  };
  const label = (title || query || "Video lesson").trim().slice(0, 48);
  const slug = slugFor(title || query);
  const work = join(workspaceRoot(), slug);
  const sourceDir = join(work, "source");
  const artifactsDir = join(work, "artifacts");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });

  // Start the npm install while the first LLM call is in flight. The AbortSignal
  // mirrors Python's task cancellation in the `finally` below.
  const runtimeAbort = new AbortController();
  const runtimeReady = ensureRuntime(runtimeAbort.signal);
  // Avoid an unhandled rejection while the install is still in flight; the
  // `finally` below awaits the same promise.
  void runtimeReady.catch(() => undefined);
  const voiceCache = new Map<string, Clip>();
  let attempts = 0;
  let feedback = "";
  let good: Good | null = null;
  const basePrompt =
    "Write a Remotion video lesson (one ```json block and one complete " +
    "```tsx Lesson.tsx block) for this learner request:\n\n" +
    query.trim();
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      attempts = attempt;
      let prompt = basePrompt;
      if (feedback) {
        prompt += "\n\nThe host's check failed:\n" + feedback.slice(0, 6000);
        prompt +=
          "\nFix exactly these issues and output both complete code blocks again.";
      }
      let result: SubagentResult;
      try {
        result = await resolveSubagentRunner()({
          parentCtx: ctx,
          spec,
          prompt,
          cancelEvent: null,
          modelOverride: null,
          progressCallback: ctx.progressCallback ?? null,
          toolCallId: `video_lesson_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          label,
        });
      } catch (exc) {
        throw new Error(`Video sub-agent failed: ${exc}`);
      }
      if (result.error && !result.finalText) {
        throw new Error(`Video sub-agent failed: ${result.error}`);
      }

      let draft: LessonDraft;
      try {
        draft = parseDraft(result.finalText ?? "");
      } catch (exc) {
        feedback = `Writer output rejected: ${exc}`;
        continue;
      }
      if (!draft.title) {
        draft.title = title || label;
      }

      const clips = await narrate(draft.narration, voiceCache);
      const lessonPath = prepareWorkdir(
        sourceDir,
        draft.code,
        voiceModule(clips),
      );
      const bundle = join(sourceDir, "player.js");
      const build: BuildResult = await buildLesson(
        lessonPath,
        bundle,
        runtimeAbort.signal,
      );
      if (!build.ok) {
        const detail =
          build.errors.join("; ") || build.stage || "unknown compile error";
        feedback = `Remotion ${build.stage} failed: ${detail.slice(0, 3000)}`;
        continue;
      }

      const page = join(artifactsDir, "lesson.html");
      writePage(bundle, page, draft.title);
      good = { draft, bundle, page, frames: build.frames };

      const layout = await layoutFeedback(page, build.frames);
      if (layout && attempt < MAX_ATTEMPTS) {
        feedback = layout;
        continue;
      }
      if (layout) {
        // last attempt: accept the compiling lesson with the warning
        draft.summary = `${draft.summary} ${layout.slice(0, 400)}`.trim();
      }
      break;
    }
  } finally {
    runtimeAbort.abort();
    await runtimeReady.catch(() => undefined);
  }

  if (good === null) {
    throw new Error(
      `Video render failed: the writer could not produce a valid lesson ` +
        `after ${attempts} attempts. ${feedback.slice(0, 600)}`,
    );
  }

  const { draft, bundle, page, frames } = good;
  const rel = publish(slug, page, draft, bundle);
  const totalFrames = Math.max(...frames.map((f) => Number(f.frame ?? 0) || 0), 0) + 1;
  const seconds = Math.round(totalFrames / 30);
  return {
    rel,
    title: draft.title,
    summary: draft.summary || `Video lesson ready: ${draft.title}`,
    code: draft.code,
    duration_seconds: seconds,
    attempts,
  };
}
