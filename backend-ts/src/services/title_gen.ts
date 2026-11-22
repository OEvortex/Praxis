// short chat-title generation via
// the hardcoded chatjimmy.ai-compatible endpoint. Kept well under the client's
// post-`done` socket hold: the title is pushed as a late `session_meta` frame,
// so a slow endpoint must give up while the stream that carries the frame is
// still open.
import { get_settings } from "../config.js";
import type { Settings } from "../config.js";
import { chatjimmyComplete, chatjimmyEnabled } from "./chatjimmy.js";

const TIMEOUT_MS = 6000;
const MAX_TITLE_CHARS = 80;

const STATS_TAIL = /<\|stats\|>[\s\S]*/;
const WRAPPER_QUOTES = /^[\s"'`“”]+|[\s"'`“”.]+$/g;

function cleanTitle(text: string): string {
  let title = (text ?? "").replace(STATS_TAIL, "").trim();
  // Models like to wrap the answer in quotes or a markdown heading.
  title = title.replace(/^#+\s*/, "");
  title = title.replace(WRAPPER_QUOTES, "").trim();
  title = title.split(/\s+/).filter(Boolean).join(" ");
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trimEnd() + "…";
  }
  return title;
}

/** Return a short chat title, or null when generation is unavailable. */
export async function generate_title(
  userText: string,
  assistantText = "",
  settings?: Settings | null,
): Promise<string | null> {
  const resolved = settings ?? get_settings();
  if (!chatjimmyEnabled(resolved)) return null;
  const user = (userText ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 2000);
  if (!user) return null;
  const assistant = (assistantText ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 1000);

  let prompt =
    "Write a short title (3-8 words) for this conversation. " +
    "Reply with only the title — no quotes, no punctuation at the end.\n\n" +
    `User: ${user}\n`;
  if (assistant) prompt += `Assistant: ${assistant}\n`;

  const raw = await chatjimmyComplete(resolved, { prompt, timeoutMs: TIMEOUT_MS });
  if (raw === null) return null;
  const title = cleanTitle(raw);
  return title || null;
}

