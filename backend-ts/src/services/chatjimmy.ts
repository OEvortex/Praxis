// Shared client for the chatjimmy.ai-compatible completion endpoint.
//
// The small "background" calls (conversation titles, composer hints) use a
// single hardcoded model on this endpoint rather than the user's configured
// chat model. Titles have used this path already; hints join it so both stay
// fast and independent of whatever provider the conversation runs on.
import type { Settings } from "../config.js";

/** Model requested from the chatjimmy endpoint for every background call. */
const CHATJIMMY_MODEL = "llama3.1-8B";
const CHATJIMMY_TIMEOUT_MS = 6000;

const DEFAULT_CHATJIMMY_URL = "https://chatjimmy.ai/api/chat";
const OFF_VALUES = ["off", "none", "disabled"];

/**
 * Endpoint from settings (`PRAXIS_TITLE_API_URL`), defaulting to chatjimmy.
 *
 * `defaultWhenOff` lets composer hints ignore the title-specific "off" value:
 * titles are disabled by that setting, hints by their own `ask_hint_enabled`
 * toggle — one switch must not silently switch off the other feature.
 */
function chatjimmyApiUrl(settings: Settings, defaultWhenOff = false): string {
  const v = settings.title_api_url;
  const configured = typeof v === "string" ? v.trim() : "";
  if (configured && !(defaultWhenOff && OFF_VALUES.includes(configured.toLowerCase()))) {
    return configured;
  }
  const fallback = (process.env.PRAXIS_TITLE_API_URL ?? DEFAULT_CHATJIMMY_URL).trim();
  if (defaultWhenOff && OFF_VALUES.includes(fallback.toLowerCase())) return DEFAULT_CHATJIMMY_URL;
  return fallback;
}

/** False when the endpoint is blank or explicitly disabled. */
export function chatjimmyEnabled(settings: Settings): boolean {
  const url = chatjimmyApiUrl(settings);
  return Boolean(url) && !OFF_VALUES.includes(url.toLowerCase());
}

/**
 * One-shot completion on the hardcoded chatjimmy model.
 * Returns null when disabled, the endpoint fails, or the request times out.
 */
export async function chatjimmyComplete(
  settings: Settings,
  args: {
    system?: string;
    prompt: string;
    timeoutMs?: number;
    /** Composer hints keep working when the title toggle is "off". */
    defaultWhenOff?: boolean;
  },
): Promise<string | null> {
  const url = chatjimmyApiUrl(settings, args.defaultWhenOff);
  if (!url || OFF_VALUES.includes(url.toLowerCase())) return null;

  const body = {
    messages: [{ role: "user", content: args.prompt }],
    chatOptions: {
      selectedModel: CHATJIMMY_MODEL,
      systemPrompt: args.system ?? "",
      topK: 8,
    },
    attachment: null,
  };
  const headers = {
    "content-type": "application/json",
    origin: "https://chatjimmy.ai",
    referer: "https://chatjimmy.ai/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Praxis/0.1",
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(args.timeoutMs ?? CHATJIMMY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`chatjimmy endpoint returned HTTP ${response.status}`);
    }
    return (await response.text()) ?? "";
  } catch (exc) {
    console.warn("chatjimmy completion failed:", exc);
    return null;
  }
}
