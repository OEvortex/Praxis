/**
 * Which renderer a finished answer will use.
 *
 * Mirrors the web app's `hasOpenUILang` / `isPlainProse` decision so turn
 * telemetry can measure how often the model reaches for generated UI. A plain
 * prose answer uses the app's Markdown renderer; anything containing a program
 * (including `root = Markdown("...")`) uses the OpenUI renderer.
 */

export type RendererKind = "markdown" | "ui";

const OPENUI_FENCE = /```[ \t]*(?:openui-lang|ogui-[a-z]+|openui)/i;
const ROOT_ASSIGNMENT = /\broot\s*=\s*[A-Za-z_$][\w$]*\s*\(/;
const STATEMENT_LINE = /^\s*(?:\$?[A-Za-z_][\w$]*)\s*=/;

export function classifyRenderer(content: unknown): RendererKind {
  const text = String(content ?? "");
  if (!text.trim()) return "markdown";
  if (OPENUI_FENCE.test(text)) return "ui";
  if (ROOT_ASSIGNMENT.test(text)) return "ui";
  if (text.split("\n").some((line) => STATEMENT_LINE.test(line))) return "ui";
  return "markdown";
}
