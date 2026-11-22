// Port of backend/app/services/title_gen.py — short chat-title generation via
// a chatjimmy.ai-compatible endpoint. Kept well under the client's post-`done`
// socket hold: the title is pushed as a late `session_meta` frame, so a slow
// endpoint must give up while the stream that carries the frame is still open.
import { get_settings } from "../config.js";
import type { Settings } from "../config.js";

const TIMEOUT_MS = 6000;
const CONNECT_TIMEOUT_MS = 4000;
const MODEL = "llama3.1-8B";
const MAX_TITLE_CHARS = 80;

const STATS_TAIL = /<\|stats\|>[\s\S]*/;
const WRAPPER_QUOTES = /^[\s"'`“”]+|[\s"'`“”.]+$/g;

function titleApiUrl(settings: Settings): string {
  // Settings.title_api_url: env PRAXIS_TITLE_API_URL, default chatjimmy.
  const v = settings.title_api_url;
  if (typeof v === "string" && v.trim()) return v.trim();
  return (process.env.PRAXIS_TITLE_API_URL ?? "https://chatjimmy.ai/api/chat").trim();
}

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
  const url = titleApiUrl(resolved);
  if (!url || ["off", "none", "disabled"].includes(url.toLowerCase())) {
    return null;
  }
  const user = (userText ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 2000);
  if (!user) return null;
  const assistant = (assistantText ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 1000);

  let prompt =
    "Write a short title (3-8 words) for this conversation. " +
    "Reply with only the title — no quotes, no punctuation at the end.\n\n" +
    `User: ${user}\n`;
  if (assistant) prompt += `Assistant: ${assistant}\n`;

  const body = {
    messages: [{ role: "user", content: prompt }],
    chatOptions: { selectedModel: MODEL, systemPrompt: "", topK: 8 },
    attachment: null,
  };
  const headers = {
    "content-type": "application/json",
    origin: "https://chatjimmy.ai",
    referer: "https://chatjimmy.ai/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Praxis/0.1",
  };
  try {
    // AbortSignal.timeout covers the whole request; connect timeout is not
    // separately controllable with fetch — the 6s cap is the effective bound.
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`title endpoint returned HTTP ${response.status}`);
    }
    const title = cleanTitle(await response.text());
    return title || null;
  } catch (exc) {
    console.warn("title generation failed:", exc);
    return null;
  }
}

export const generateTitle = generate_title;
