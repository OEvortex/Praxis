// the ``view_figure``
// tool: read one stored figure through a vision model, as text.
//
// The chat turn only carries the images on the page the user has open, so any
// other figure is invisible to a text model. This tool resolves the named
// image on disk, asks a vision model about it, and returns the *text* — the
// only channel a tool result has.
//
// TS port note: upstream used ``get_llm_client().complete(image_data=...)``.
// llm_text.ts only exposes text completion, so the vision call is implemented
// here against the same ``resolve()`` provider config: Anthropic gets an
// image content block, OpenAI-compatible providers get an ``image_url`` data
// URI. Providers we cannot speak to multimodally fall back to the caption.

import { readFileSync, statSync } from "node:fs";
import { get_settings } from "../../config.js";
import { resolve as resolveModel } from "../../services/llm_text.js";
import { BaseTool, type ToolParamsSchema } from "../../shared/vtx.js";
import { fail, type ToolResult } from "../../shared/types.js";
import type { Dict } from "../../shared/types.js";
import { materialStore } from "./store.js";
import { bindMaterial, resolveBinding } from "./mode.js";

// A missing-name failure lists the figures the model could have asked for,
// capped so a media-heavy material does not answer one typo with a wall of
// file names.
const FIGURE_NAME_LIST_LIMIT = 20;
/** Maximum accepted image size. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
/** Mirrors image_description_limits() default timeout. */
const VISION_TIMEOUT_MS = 60_000;

const FIGURE_SYSTEM_PROMPT =
  "You describe figures for a reader who cannot see them. You state only " +
  "what is visibly present and you never guess at intent.";

const DEFAULT_FIGURE_QUESTION =
  "Describe this image completely: the text in it, any formulas, and the " +
  "structure and labelling of any figure.";

export interface ViewFigureParams {
  name?: string;
  question?: string;
  /** Server-injected binding (never shown to the model). */
  _material_id?: string;
  _reading_workspace_id?: string;
  _reading_binding?: Dict;
}

export const viewFigureParamsSchema: ToolParamsSchema = {
  type: "object",
  required: ["name"],
  properties: {
    name: {
      type: "string",
      description:
        "The figure's file name, e.g. 'image-05.png', exactly as it appears " +
        "in the image list returned by read_material.",
    },
    question: {
      type: "string",
      description:
        "What you want to know about the figure. If omitted, a full " +
        "description is produced.",
    },
  },
};

function guessMime(name: string, declared: string): string {
  if (declared) return declared;
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  };
  return map[ext] ?? "application/octet-stream";
}

/** One non-streaming multimodal completion against the resolved provider. */
async function completeWithImage(args: {
  question: string;
  system: string;
  imageBase64: string;
  mime: string;
  filename: string;
}): Promise<string> {
  const settings = get_settings();
  const resolved = resolveModel(settings) as {
    provider?: string;
    model?: string;
    api_key?: string | null;
    base_url?: string | null;
  };
  const provider = String(resolved.provider ?? "");
  const model = String(resolved.model ?? "");
  const key = resolved.api_key ? String(resolved.api_key) : "";
  const base = String(resolved.base_url ?? "").trim().replace(/\/+$/, "");
  if (!base || !/^https?:\/\//i.test(base)) {
    throw new Error("This model has no usable base URL configured");
  }

  let url: string;
  let headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: Record<string, unknown>;

  const dataUri = `data:${args.mime};base64,${args.imageBase64}`;
  if (provider === "anthropic") {
    url = `${base}/messages`;
    headers = { ...headers, "anthropic-version": "2023-06-01" };
    if (key) headers["x-api-key"] = key;
    body = {
      model,
      max_tokens: 2048,
      system: args.system,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: args.mime, data: args.imageBase64 },
            },
            { type: "text", text: args.question },
          ],
        },
      ],
    };
  } else if (provider === "openai-responses") {
    url = `${base}/responses`;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model,
      input: [
        { role: "system", content: args.system },
        {
          role: "user",
          content: [
            { type: "input_text", text: args.question },
            { type: "input_image", image_url: dataUri },
          ],
        },
      ],
    };
  } else {
    // OpenAI-compatible chat completions (also the generic fallback).
    url = `${base}/chat/completions`;
    if (key) headers["Authorization"] = `Bearer ${key}`;
    body = {
      model,
      messages: [
        { role: "system", content: args.system },
        {
          role: "user",
          content: [
            { type: "text", text: args.question },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`${model} rejected the vision request (${response.status}): ${detail}`);
  }
  const event = (await response.json()) as Record<string, unknown>;

  if (provider === "anthropic") {
    const content = event["content"];
    if (Array.isArray(content)) {
      return content
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .map((part) => String(part["text"] ?? ""))
        .join("")
        .trim();
    }
    return "";
  }
  if (provider === "openai-responses") {
    // output_text convenience field, else walk output items.
    const direct = event["output_text"];
    if (typeof direct === "string") return direct.trim();
    const output = event["output"];
    if (Array.isArray(output)) {
      const texts: string[] = [];
      for (const item of output) {
        if (!item || typeof item !== "object") continue;
        const content = (item as Record<string, unknown>)["content"];
        if (!Array.isArray(content)) continue;
        for (const part of content) {
          if (part && typeof part === "object") {
            const text = (part as Record<string, unknown>)["text"];
            if (typeof text === "string") texts.push(text);
          }
        }
      }
      return texts.join("").trim();
    }
    return "";
  }
  const choices = event["choices"] as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
  const content = message?.["content"];
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
      .map((part) => String(part["text"] ?? ""))
      .join("")
      .trim();
  }
  return "";
}

export class ViewFigureTool extends BaseTool<ViewFigureParams> {
  name = "view_figure";
  toolIcon = "🖼️";
  mutating = false;
  description =
    "Look at the pixels of a single figure in the document the user is " +
    "reading and answer a question about it. Use it when the body text and " +
    "the image list's caption are not enough to tell what the figure " +
    "actually shows; if the caption already answers, do not call it.";
  params = viewFigureParamsSchema;

  async execute(p: ViewFigureParams): Promise<ToolResult> {
    try {
      return await this.run(p);
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      if (message.startsWith("No reading material")) return fail(message);
      // Engine errors become readable tool failures, never turn deaths.
      return fail(`view_figure failed: ${message}`);
    }
  }

  private async run(p: ViewFigureParams): Promise<ToolResult> {
    const store = materialStore;
    const materialId = bindMaterial(resolveBinding(p as unknown as Dict));
    const name = String(p.name ?? "").trim();
    if (!name) {
      return fail("view_figure needs a figure name, e.g. 'image-05.png'.");
    }

    const rows = store.mediaItems(materialId);
    const row = rows.find((item) => String(item["name"] ?? "") === name);
    if (!row) {
      const available = rows.map((item) => String(item["name"] ?? ""));
      let listed = available.slice(0, FIGURE_NAME_LIST_LIMIT).join(", ");
      if (available.length > FIGURE_NAME_LIST_LIMIT) {
        listed += ` … (${available.length} images in total)`;
      }
      return fail(
        `No figure named “${name}” in this document. Available figures: ${listed || "none"}.`,
      );
    }

    const caption = String(row["caption"] ?? "").trim();
    const locator = Number(row["locator"]);
    const manifest = store.manifest(materialId);
    if (!Number.isInteger(locator) || locator < 1 || locator > manifest.unit_count) {
      return fail(`The image “${name}” has no valid document locator.`);
    }
    const source = {
      type: "reading",
      material_id: materialId,
      material_revision: manifest.revision,
      title: manifest.filename,
      page: locator,
    };
    const metadata: Dict = {
      material_id: materialId,
      material_revision: manifest.revision,
      image: name,
      locator,
      caption,
    };

    const path = store.mediaPath(materialId, name);
    if (!path) {
      return fail(
        `The image “${name}” on ${manifest.unit} ${locator} is missing on disk and cannot be viewed.`,
      );
    }
    const size = statSync(path).size;
    if (size > MAX_IMAGE_BYTES) {
      return fail(
        `The image “${name}” is ${size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit for a single vision call, so it cannot be viewed.`,
      );
    }

    const question = String(p.question ?? "").trim() || DEFAULT_FIGURE_QUESTION;

    // Vision availability: resolve() throws when no model is configured, and
    // some providers cannot take images at all — either way, hand back the
    // caption and say plainly that the pixels were not read.
    let visionError = "";
    try {
      const data = readFileSync(path);
      const mime = guessMime(name, String(row["mime"] ?? ""));
      const answer = await completeWithImage({
        question,
        system: FIGURE_SYSTEM_PROMPT,
        imageBase64: data.toString("base64"),
        mime,
        filename: name,
      });
      const text = answer.trim();
      if (!text) {
        return fail(
          `The vision model returned nothing for “${name}”. The caption on record is: ${caption || "(none)"}`,
        );
      }
      return {
        success: true,
        result: `${manifest.unit} ${locator} (${name}): ${text}`,
        metadata,
        sources: [source],
      };
    } catch (exc) {
      visionError = exc instanceof Error ? exc.message : String(exc);
    }

    let content =
      `${manifest.unit} ${locator}: Vision parsing is unavailable for this model, ` +
      `so “${name}” could not be read (${visionError}).`;
    if (caption) content += `\nCaption on record: ${caption}`;
    return { success: true, result: content, metadata, sources: [source] };
  }
}

export const view_figure = new ViewFigureTool();
export const viewFigureTool = ViewFigureTool;
