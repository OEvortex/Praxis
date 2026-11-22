/**
 * Reader-facing text for a stored turn.
 *
 * A transcript preview is not a renderer: it shows the first lines of a reply
 * so a reader can recognise the conversation, and the two machine formats the
 * tutor has written are the worst possible thing to show there. An OpenUI Lang
 * program is assignments (`root = Col([...])`), and the older `ogui-*` bundle is
 * five fenced blocks of JSON, CSS, HTML and JavaScript — either one fills the
 * preview with source and hides the sentence the reader wrote.
 *
 * So the code is removed and the prose the reply carried around it is what is
 * left. A turn that is *only* code has nothing to preview, and the caller shows
 * a short label in its place.
 */

import { extractOpenUILang } from "./lang";
import { hasLegacyOgui, stripLegacyOgui } from "./legacy-ogui";

/** Fenced blocks that belong to a machine format, never to the reader. */
const MACHINE_FENCE =
  /```(?:ogui-[a-z]+|openui-lang|openui)[ \t]*\r?\n[\s\S]*?```/gi;

export function previewProse(content: string | null | undefined): string {
  const source = String(content ?? "");
  if (!source.trim()) return "";

  // A legacy bundle keeps its prose outside the fences; parse it properly so
  // the text between two widgets stays in the order it was written.
  const withoutBundles = hasLegacyOgui(source)
    ? stripLegacyOgui(source)
    : source.replace(MACHINE_FENCE, "\n");

  // A bare (unfenced) program can still be in there. Its preamble is the
  // sentence the model wrote before the program, which is exactly what a
  // preview wants.
  const extraction = extractOpenUILang(withoutBundles);
  const prose = extraction.found
    ? [extraction.preamble, extraction.trailing].filter(Boolean).join("\n\n")
    : withoutBundles;

  return prose.replace(MACHINE_FENCE, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
