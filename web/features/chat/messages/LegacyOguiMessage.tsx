"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import OpenUIMessage from "@/features/chat/messages/OpenUIMessage";
import {
  buildLegacyOguiDocument,
  legacyOguiInitialHeight,
  parseLegacyOgui,
  type LegacyOguiColorScheme,
  type LegacyOguiWidget,
} from "@/lib/openui/legacy-ogui";
import {
  getStoredThemePreference,
  resolveTheme,
  subscribeToThemeChanges,
  type Theme,
} from "@/lib/theme";

function colorSchemeForTheme(theme: Theme): LegacyOguiColorScheme {
  return theme === "dark" || theme === "glass" ? "dark" : "light";
}

/**
 * One stored widget, in its own sandbox.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the document an
 * opaque origin: the script the model wrote can drive its own DOM and load the
 * libraries it asked for, but cannot read this page, its cookies or its storage.
 */
function LegacyOguiFrame({ widget }: { widget: LegacyOguiWidget }) {
  
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [theme, setTheme] = useState<Theme>(() =>
    resolveTheme(getStoredThemePreference()),
  );
  const [height, setHeight] = useState(() => legacyOguiInitialHeight(widget));

  useEffect(() => subscribeToThemeChanges(setTheme), []);

  const srcdoc = useMemo(
    () => buildLegacyOguiDocument(widget, colorSchemeForTheme(theme)),
    [widget, theme],
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.srcdoc = srcdoc;
  }, [srcdoc]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { type?: string; height?: number };
      if (!data || typeof data !== "object" || data.type !== "ogui:height") return;
      if (typeof data.height !== "number" || !Number.isFinite(data.height)) return;
      setHeight(Math.min(2400, Math.max(240, Math.ceil(data.height) + 4)));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <figure className="my-3 w-full">
      <iframe
        ref={iframeRef}
        title={"Interactive"}
        sandbox="allow-scripts allow-popups"
        loading="lazy"
        className="w-full rounded-xl border border-[var(--border)] bg-[var(--card)]"
        style={{ height }}
      />
    </figure>
  );
}

/**
 * A reply written in the retired `ogui-*` format, rendered as what it built.
 *
 * Turns from that period are still in every transcript, and drawn by the
 * Markdown path they were a wall of JSON, CSS, HTML and JavaScript. The prose
 * around the bundle is ordinary reply text, so it goes through the same OpenUI
 * path (`Markdown`) the rest of the chat uses, and each widget sits between the
 * paragraphs where the model placed it.
 */
export default function LegacyOguiMessage({
  content,
  language,
  isStreaming = false,
  onSendFollowUp,
}: {
  content: string;
  language?: string;
  isStreaming?: boolean;
  onSendFollowUp?: (text: string) => void | Promise<void>;
}) {
  const parts = useMemo(() => parseLegacyOgui(content), [content]);
  const hasWidget = parts.some((part) => part.kind === "widget");

  // Mid-stream the fence is still being written, so a bundle can parse as
  // prose only. Let the Markdown path hold the turn until it closes rather
  // than dropping the script the reader is watching arrive.
  if (!hasWidget) {
    return (
      <OpenUIMessage
        content={content}
        isStreaming={isStreaming}
        language={language}
        onSendFollowUp={onSendFollowUp}
      />
    );
  }

  return (
    <div className="flex flex-col">
      {parts.map((part, index) =>
        part.kind === "text" ? (
          <OpenUIMessage
            key={`text-${index}`}
            content={part.text}
            language={language}
            onSendFollowUp={onSendFollowUp}
          />
        ) : (
          <LegacyOguiFrame key={`widget-${index}`} widget={part.widget} />
        ),
      )}
    </div>
  );
}
