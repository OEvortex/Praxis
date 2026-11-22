// Port of deeptutor/capabilities/reading/media_notes.py — the embedded-image
// note that read_material appends to its result.
//
// A row in media.json is {name, locator, mime, bytes} and may carry an
// optional "caption" written at ingestion by a vision model. The caption is
// the only way a text model learns what an embedded figure shows when the
// image itself is not attached to the turn.

import type { MaterialStore } from "./store.js";

// One caption is a short English sentence; anything longer is runaway output,
// so it is clipped before it reaches the model's context.
export const CAPTION_CHAR_LIMIT = 300;
// The note is supporting evidence, not the answer: a media-heavy material must
// not crowd out the text the model was actually asked to read.
export const MAX_NOTE_LINES = 20;

function flatten(text: string): string {
  /** Collapse whitespace so a caption cannot forge extra list lines. */
  return (text ?? "").split(/\s+/).filter(Boolean).join(" ");
}

function clip(s: string, limit: number): string {
  const chars = [...s];
  return chars.length <= limit ? s : chars.slice(0, limit - 1).join("") + "…";
}

function renderImage(name: string, caption: string): string {
  if (!caption) return name;
  return `${name} — ${clip(flatten(caption), CAPTION_CHAR_LIMIT)}`;
}

/** List the embedded images that live in the units just read. */
export function renderMediaNote(
  store: MaterialStore,
  materialId: string,
  unit: string,
  locators: number[],
): string {
  let rows: Record<string, unknown>[];
  try {
    rows = store.mediaItems(materialId);
  } catch {
    return "";
  }
  const wanted = new Set(locators);
  const byLocator = new Map<number, [string, string][]>();
  for (const row of rows) {
    const locator = Number(row["locator"] ?? 0);
    if (!Number.isFinite(locator)) continue;
    const name = String(row["name"] ?? "");
    if (wanted.has(locator) && name) {
      const caption = String(row["caption"] ?? "").trim();
      const list = byLocator.get(locator) ?? [];
      list.push([name, caption]);
      byLocator.set(locator, list);
    }
  }
  if (!byLocator.size) return "";
  const entries = [...byLocator.entries()].sort((a, b) => a[0] - b[0]);
  const shown = entries.slice(0, MAX_NOTE_LINES);
  const omitted = entries.slice(MAX_NOTE_LINES);
  const lines = shown.map(
    ([locator, images]) =>
      `- ${unit} ${locator}: ` + images.map(([name, caption]) => renderImage(name, caption)).join(", "),
  );
  if (omitted.length) {
    const dropped = omitted.reduce((n, [, images]) => n + images.length, 0);
    lines.push(`(${dropped} more images omitted)`);
  }
  return (
    "\n\nEmbedded images in the units above (shown in the reader pane; " +
    "image parts attached to this conversation's messages are these " +
    "figures):\n" + lines.join("\n")
  );
}

export const render_media_note = renderMediaNote;
