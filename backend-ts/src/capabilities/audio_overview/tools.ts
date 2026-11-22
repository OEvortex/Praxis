// Agent tool for the audio_overview capability — generates a two-voice
// podcast-style overview of a topic or knowledge base and publishes the
// audio + transcript under files_dir (served at /files/audio_overviews/...).
//
// Port of deeptutor/capabilities/audio_overview/{capability,pipeline}.py as
// a chat tool rather than a turn capability: upstream ran as an exclusive
// turn; here it is a single tool call that does retrieve → script → TTS →
// publish.

import { get_settings } from "../../config.js";
import { BaseTool, type Ctx, type ToolParamsSchema } from "../../shared/vtx.js";
import { ok, fail, type ToolResult } from "../../shared/types.js";
import {
  AudioOverviewError,
  generateAudioOverview,
} from "./pipeline.js";

export interface AudioOverviewParams {
  topic: string;
  kb_name?: string;
  context?: string;
  target_minutes?: number;
  language?: string;
  host_voice?: string;
  expert_voice?: string;
}

export const audioOverviewParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["topic"],
  properties: {
    topic: {
      type: "string",
      description: "What the overview should cover (a question or subject).",
    },
    kb_name: {
      type: "string",
      description:
        "Optional knowledge base to ground the script in (local KB store). " +
        "Omit and pass 'context' for free-form source material.",
      default: "",
    },
    context: {
      type: "string",
      description:
        "Optional source text to ground the script when no kb_name is given.",
      default: "",
    },
    target_minutes: {
      type: "integer",
      description: "Target duration in minutes (1-15, default 5).",
      default: 5,
    },
    language: {
      type: "string",
      description: "Script + voice language, e.g. 'en' or 'zh' (default 'en').",
      default: "en",
    },
    host_voice: {
      type: "string",
      description: "Optional TTS voice for the host (default en-US-AvaNeural).",
      default: "",
    },
    expert_voice: {
      type: "string",
      description: "Optional TTS voice for the expert.",
      default: "",
    },
  },
};

export class AudioOverviewTool extends BaseTool<AudioOverviewParams> {
  name = "audio_overview";
  toolIcon = "🎙️";
  params = audioOverviewParamsSchema;
  mutating = true;
  description =
    "Generate an audio overview (two-voice podcast) of a topic. The script is " +
    "written by the LLM — grounded in a knowledge base (kb_name) or supplied " +
    "context text — then spoken with the configured TTS engine. Returns URLs " +
    "to the audio file and transcript. Takes a minute or more; use when the " +
    "user asks for a podcast, audio summary, or listenable overview.";

  async execute(p: AudioOverviewParams, _ctx?: Ctx): Promise<ToolResult> {
    const settings = get_settings();
    const topic = String(p.topic ?? "").trim();
    if (!topic) return fail("audio_overview needs a 'topic'.");
    const minutes = Math.min(Math.max(Number(p.target_minutes) || 5, 1), 15);
    try {
      const result = await generateAudioOverview({
        settings,
        topic,
        kbName: String(p.kb_name ?? ""),
        contextText: String(p.context ?? ""),
        targetMinutes: minutes,
        language: String(p.language ?? "en") || "en",
        hostVoice: String(p.host_voice ?? "") || undefined,
        expertVoice: String(p.expert_voice ?? "") || undefined,
      });
      return ok(
        `Audio overview ready: "${result.title}".\n` +
          `Audio: ${result.audio_url}\n` +
          `Transcript: ${result.transcript_url}\n` +
          `Engine: ${result.engine ?? "unknown"}\n` +
          `Segments: ${result.segments.length}, citations: ${result.citations.length}`,
      );
    } catch (exc) {
      if (exc instanceof AudioOverviewError) return fail(exc.message);
      return fail(
        `audio_overview failed: ${exc instanceof Error ? exc.message : String(exc)}`,
      );
    }
  }
}

export const audio_overview = new AudioOverviewTool();
export const AUDIO_OVERVIEW_TOOLS = [audio_overview];
export const AUDIO_OVERVIEW_TOOL_TYPES = [AudioOverviewTool];
