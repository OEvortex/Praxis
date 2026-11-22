// Shared client for the chatjimmy.ai-compatible completion endpoint.
//
// The small "background" calls (conversation titles, composer hints) use a
// single hardcoded model on this endpoint rather than the user's configured
// chat model. Titles have used this path already; hints join it so both stay
// fast and independent of whatever provider the conversation runs on.
import type { Settings } from "../config.js";

/** Model requested from the chatjimmy endpoint for every background call. */
export const CHATJIMMY_MODEL = "llama3.1-8B";
export const CHATJIMMY_TIMEOUT_MS = 6000;

const OFF_VALUES = ["off", "none", "disabled"];

/** Endpoint from settings (`PRAXIS_TITLE_API_URL`), defaulting to chatjimmy. */
export function chatjimmyApiUrl(settings: Settings): string {
  const v = settings.title_api_url;
  if (typeof v === "string" && v.trim()) return v.trim();
  return (process.env.PRAXIS_TITLE_API_URL ?? "https://chatjimmy.ai/api/chat").trim();
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
  },
): Promise<string | null> {
  const url = chatjimmyApiUrl(settings);
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
