"use client";

import { useMemo } from "react";

import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import type { StreamEvent } from "@/features/chat/model/protocol";
import {
  mergeGeneratedFiles,
  unlinkedGeneratedFiles,
} from "@/components/common/InlineFileCard";
import HyperframesPlayer from "@/components/chat/preview/HyperframesPlayer";
import { HYPERFRAMES_MIME } from "@/components/chat/preview/previewerFor";
import { apiUrl } from "@/shared/api/client";
import { docIconFor } from "@/lib/doc-attachments";
import { activeWorkspaceId } from "@/lib/workspace-scope";
import { GeneratedOutputFileActions, supportsGeneratedOutputActions } from "@/components/chat/GeneratedOutputFileActions";

export function imageSrcForAttachment(attachment: MessageAttachment): string | null {
  if (attachment.url) {
    if (
      attachment.url.startsWith("http") ||
      attachment.url.startsWith("blob:") ||
      attachment.url.startsWith("data:")
    ) {
      return attachment.url;
    }
    return apiUrl(attachment.url);
  }

  const base64 = attachment.base64?.trim();
  if (!base64) return null;
  if (base64.startsWith("data:")) return base64;
  return `data:${attachment.mime_type || "image/png"};base64,${base64}`;
}

/** Format a byte count for a file card subtitle (e.g. "14 KB"). */
export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** "Praxis_Introduction.pdf" → "Praxis Introduction" — the card title
 * reads like a document name; the extension already shows in the subtitle. */
export function humanizeFilename(filename: string): string {
  const stem = filename.replace(/\.[A-Za-z0-9]{1,8}$/, "");
  return (
    stem
      .replace(/[_-]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim() || filename
  );
}

/**
 * Files the assistant produced this turn (exec/code/media artifacts),
 * rendered as openable cards under the message — click to open in the Viewer
 * side panel, same path as user uploads. Sources: persisted ``generated``
 * attachments on the message (durable) merged with artifacts from streamed
 * tool_result events (live, while the turn is still running), deduped by URL.
 *
 * An image the reply already embeds with ``![](...)`` is drawn there, so its
 * card is left out; showing both reads as the figure appearing twice.
 */
export function GeneratedFileCards({
  attachments,
  events,
  content,
  onOpen,
}: {
  attachments: MessageAttachment[];
  events?: StreamEvent[];
  /** The reply text, used to tell which images are already shown inline. */
  content?: string;
  onOpen?: (attachment: MessageAttachment) => void;
}) {
  
  const files = useMemo(() => {
    const merged = mergeGeneratedFiles(attachments, events);
    if (!content) return merged;
    const unlinked = new Set(unlinkedGeneratedFiles(content, merged, { imagesOnly: true }));
    return merged.filter(
      (file) => !file.mime_type?.startsWith("image/") || unlinked.has(file),
    );
  }, [attachments, events, content]);
  if (!files.length) return null;
  return (
    <div className="mt-3 flex flex-col gap-2">
      {files.map((a, i) => {
        const filename = a.filename || "File";
        const key = a.workspace_item_id || a.id || a.url || `gen-${i}`;
        const mime = a.mime_type || "";
        const mediaSrc = imageSrcForAttachment(a);
        const caption = a.caption?.trim() || "";

        // Generated media renders inline; other MIME types use a file card.
        if (mime.startsWith("image/") && mediaSrc) {
          return (
            <div key={key} className="w-full max-w-[min(520px,90%)]">
              <button
                type="button"
                onClick={onOpen ? () => onOpen(a) : undefined}
                className="group block w-full overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] text-left shadow-sm transition hover:border-[var(--border)]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={mediaSrc}
                  alt={filename}
                  loading="lazy"
                  className="block max-h-[360px] w-full bg-[var(--background)] object-contain"
                />
                <span className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--foreground)]">
                      {a.title || humanizeFilename(filename)}
                    </span>
                    {caption ? (
                      <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                        {caption}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--muted-foreground)] transition group-hover:text-[var(--foreground)]">
                    {"Open"}
                  </span>
                </span>
              </button>
              {supportsGeneratedOutputActions(a) ? (
                <GeneratedOutputFileActions url={a.url || ""} />
              ) : null}
            </div>
          );
        }

        // Agent video lessons are HyperFrames compositions — embed the
        // interactive player directly in the message, same slot as <video>.
        const isHyperframes =
          mime === HYPERFRAMES_MIME ||
          (/\.html$/i.test(filename) && /\/videos\//.test(a.url || ""));
        if (isHyperframes && mediaSrc) {
          return (
            <div
              key={key}
              className="w-full max-w-[min(680px,90%)] overflow-hidden rounded-xl border border-[var(--border)] bg-black shadow-sm"
            >
              <HyperframesPlayer
                src={mediaSrc}
                className="block aspect-video w-full"
              />
              <button
                type="button"
                onClick={onOpen ? () => onOpen(a) : undefined}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-[var(--muted)]/30"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--foreground)]">
                    {a.title || humanizeFilename(filename)}
                  </span>
                  {caption ? (
                    <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                      {caption}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                  {"Open"}
                </span>
              </button>
              {supportsGeneratedOutputActions(a) ? (
                <GeneratedOutputFileActions url={a.url || ""} />
              ) : null}
            </div>
          );
        }

        if (mime.startsWith("video/") && mediaSrc) {
          return (
            <div
              key={key}
              className="w-full max-w-[min(520px,90%)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-sm"
            >
              <video
                src={mediaSrc}
                controls
                preload="metadata"
                className="block max-h-[360px] w-full bg-black"
              />
              <button
                type="button"
                onClick={onOpen ? () => onOpen(a) : undefined}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition hover:bg-[var(--muted)]/30"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[var(--foreground)]">
                    {a.title || humanizeFilename(filename)}
                  </span>
                  {caption ? (
                    <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                      {caption}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">
                  {"Open"}
                </span>
              </button>
              {supportsGeneratedOutputActions(a) ? (
                <GeneratedOutputFileActions url={a.url || ""} />
              ) : null}
            </div>
          );
        }

        const spec = docIconFor(filename);
        const Icon = spec.Icon;
        const size = formatFileSize(a.size_bytes);
        return (
          <div key={key} className="w-full max-w-[min(520px,90%)]">
            <button
              type="button"
              onClick={onOpen ? () => onOpen(a) : undefined}
              className="group flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5 text-left shadow-sm transition hover:border-[var(--border)] hover:bg-[var(--muted)]/30"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--background)]">
                <Icon className={`h-[18px] w-[18px] ${spec.tint}`} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">
                  {a.title || humanizeFilename(filename)}
                </span>
                <span className="block text-[11px] text-[var(--muted-foreground)]">
                  {caption || spec.label}
                  {size ? ` · ${size}` : ""}
                </span>
              </span>
              <span className="shrink-0 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--foreground)] transition group-hover:bg-[var(--muted)]/40">
                {"Open"}
              </span>
            </button>
            {supportsGeneratedOutputActions(a) ? (
              <GeneratedOutputFileActions url={a.url || ""} />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The reply body renderer, for every turn that shows model output.
 *
 * OpenUI Lang is the format the tutor writes today. Transcripts from before it
 * still hold the retired `ogui-*` bundles, and those are a different shape
 * altogether: OpenUI Lang cannot parse them, so the Markdown fallback drew
 * their JSON, CSS, HTML and JavaScript as fenced code — the map, quiz or
 * slider a stored turn built arrived as a wall of source. A bundle is
 * reassembled into the widget it described instead, and everything else takes
 * the OpenUI path unchanged.
 */
