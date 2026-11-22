"use client";

import "@openuidev/react-ui/styles/index.css";

import { Renderer, type ActionEvent } from "@openuidev/react-lang";
import { useEffect, useMemo, useState } from "react";
import { ThemeProvider } from "@openuidev/intelligent-ui-library";
import AssistantResponse from "@/components/common/AssistantResponse";
import { handleOpenUIAction } from "@/lib/openui/actions";
import { library } from "@/lib/openui/library";
import { extractOpenUILang, isPlainProse, toOpenUIProgram } from "@/lib/openui/lang";
import { contentLang } from "@/lib/content-lang";
import { resolveTheme, getStoredThemePreference, subscribeToThemeChanges } from "@/lib/theme";

/**
 * Renders an assistant turn written in OpenUI Lang as live components inside
 * the main chat, instead of Markdown. The model is instructed to emit UI
 * programs (see backend/app/agent/prompt.py), which stream into msg.content.
 *
 * Every answer goes through here. A reply that begins with a sentence of prose
 * before `root = …` is split so the program still renders (and the prose is
 * shown above it), a reply with no program at all is rendered as a `Markdown`
 * node, and a program the parser cannot accept falls back to the same node — so
 * a malformed turn reads as text rather than as nothing.
 */
export default function OpenUIMessage({
  content,
  isStreaming = false,
  language,
  onSendFollowUp,
}: {
  content: string;
  isStreaming?: boolean;
  /** The language this turn ran in, so `:lang()` CJK font stacks follow it. */
  language?: string;
  /** Sends the `continue_conversation` action as a normal user turn. */
  onSendFollowUp?: (text: string) => void | Promise<void>;
}) {
  useEffect(() => {
    const update = () => {
      const resolved = resolveTheme(getStoredThemePreference());
      document.documentElement.setAttribute(
        "data-openui-theme",
        resolved === "dark" || resolved === "glass" ? "dark" : "light",
      );
    };
    update();
    return subscribeToThemeChanges(update);
  }, []);

  const resolved = resolveTheme(getStoredThemePreference());
  const mode = resolved === "dark" || resolved === "glass" ? "dark" : "light";

  const extraction = useMemo(() => extractOpenUILang(content), [content]);
  const program = useMemo(() => toOpenUIProgram(content), [content]);
  const preambleProgram = useMemo(
    () => (extraction.preamble ? `root = Markdown(${JSON.stringify(extraction.preamble)})` : null),
    [extraction.preamble],
  );

  // A program the parser rejected, once streaming has finished. While the turn
  // is still streaming, parse errors are expected (statements arrive in
  // fragments) and must not swap the renderer out from under the reader.
  // Recorded against the program it failed for, so a new reply clears it.
  const [rejectedProgram, setRejectedProgram] = useState<string | null>(null);
  const unrenderable = rejectedProgram === program && !isStreaming;
  const effectiveProgram = unrenderable
    ? `root = Markdown(${JSON.stringify(content)})`
    : program;

  const onAction = (event: ActionEvent) => {
    handleOpenUIAction(event, onSendFollowUp);
  };

  const onError = (errors: { code?: string }[]) => {
    if (isStreaming) return;
    if (errors.some((error) => error?.code === "parse-failed")) setRejectedProgram(program);
  };

  // A reply with no OpenUI program is plain Markdown. OpenUI's own `Markdown`
  // node renders headings at body-text size, which reads as raw text; the app's
  // prose renderer gives it the full heading/list/code/math styling instead.
  // Keep real programs on the OpenUI path (including prose preambles).
  if (isPlainProse(content)) {
    return (
      <AssistantResponse
        content={content}
        isStreaming={isStreaming}
        language={language}
      />
    );
  }

  return (
    <ThemeProvider mode={mode}>
      <div
        role="article"
        aria-live="polite"
        aria-atomic="false"
        lang={contentLang(language)}
        className="openui-message"
      >
        {preambleProgram && !unrenderable ? (
          <Renderer
            response={preambleProgram}
            library={library}
            isStreaming={false}
            onAction={onAction}
          />
        ) : null}
        <Renderer
          key={unrenderable ? "fallback" : "program"}
          response={effectiveProgram}
          library={library}
          isStreaming={isStreaming && !unrenderable}
          onAction={onAction}
          onError={onError}
        />
      </div>
    </ThemeProvider>
  );
}
