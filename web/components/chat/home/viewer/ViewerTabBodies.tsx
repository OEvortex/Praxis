import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import dynamic from "@/shared/router/dynamic";
import { AlertCircle, ArrowLeft, Download, ExternalLink, Globe, Loader2 } from "lucide-react";

import {
  previewKindFor,
  resolveSourceUrl,
  type FilePreviewSource,
} from "@/components/chat/preview/previewerFor";
import {
  ActivityBody,
  type SessionActivity,
} from "@/components/chat/home/SessionActivityPanel";
import type { MessageAttachment } from "@/features/chat/ChatStateAdapter";
import { apiUrl } from "@/shared/api/client";
import Tooltip from "@/shared/ui/Tooltip";
import { hostnameFor } from "./helpers";
import { HEADER_ICON } from "./ViewerTabBar";

const PdfPreview = dynamic(
  () => import("@/components/chat/preview/previewers/PdfPreview"),
);
const ImagePreview = dynamic(
  () => import("@/components/chat/preview/previewers/ImagePreview"),
);
const VideoPreview = dynamic(
  () => import("@/components/chat/preview/previewers/VideoPreview"),
);
const SvgPreview = dynamic(
  () => import("@/components/chat/preview/previewers/SvgPreview"),
);
const MarkdownPreview = dynamic(
  () => import("@/components/chat/preview/previewers/MarkdownPreview"),
);
const TextPreview = dynamic(
  () => import("@/components/chat/preview/previewers/TextPreview"),
);
const DocxPreview = dynamic(
  () => import("@/components/chat/preview/previewers/DocxPreview"),
);
const XlsxPreview = dynamic(
  () => import("@/components/chat/preview/previewers/XlsxPreview"),
);
const OfficePdfPreview = dynamic(
  () => import("@/components/chat/preview/previewers/OfficePdfPreview"),
);
const OfficeTextPreview = dynamic(
  () => import("@/components/chat/preview/previewers/OfficeTextPreview"),
);
const FallbackPreview = dynamic(
  () => import("@/components/chat/preview/previewers/FallbackPreview"),
);
const Geogebra = dynamic(() => import("@/components/Geogebra"), {
  ssr: false,
});

export function ActivityHome({
  activity,
  open,
  configSection,
  onOpenAttachment,
  onClose,
}: {
  sessionId: string | null;
  taskDraftIds?: string[];
  onTaskDraftChange?: (ids: string[]) => void;
  activity: SessionActivity;
  open: boolean;
  configSection?: ReactNode;
  onOpenAttachment: (a: MessageAttachment) => void;
  onClose: () => void;
}) {
  
  return (
    <div className="h-full space-y-5 overflow-y-auto px-3 pb-8 pt-1 sm:px-3.5">
      <div className="sticky top-0 z-10 -mx-3 flex justify-start border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--card)_94%,transparent)] px-3 py-2 backdrop-blur-sm sm:-mx-3.5 sm:px-3.5">
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm font-medium text-[var(--muted-foreground)] transition-colors hover:bg-[var(--muted)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
          aria-label={"Back to conversation"}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
          <span>{"Back to conversation"}</span>
        </button>
      </div>
      <ActivityBody
        activity={activity}
        open={open}
        onOpenAttachment={onOpenAttachment}
        configSection={configSection}
      />
    </div>
  );
}

function fileUrlFor(source: FilePreviewSource): string | null {
  const previewUrl = resolveSourceUrl(source, apiUrl);
  if (previewUrl) return previewUrl;
  if (source.base64) {
    const mime = source.mimeType || "application/octet-stream";
    return `data:${mime};base64,${source.base64}`;
  }
  return null;
}

export function FileTabActions({ source }: { source: FilePreviewSource }) {
  
  const fileUrl = useMemo(() => fileUrlFor(source), [source]);
  const filename = source.filename || "Attachment";
  return (
    <>
      {fileUrl ? (
        <Tooltip label={"Download"} side="bottom">
          <a
            href={fileUrl}
            download={filename}
            className={HEADER_ICON}
            aria-label={"Download"}
          >
            <Download size={15} strokeWidth={1.8} />
          </a>
        </Tooltip>
      ) : null}
      <Tooltip label={"Open in browser"} side="bottom">
        <button
          type="button"
          onClick={() => {
            if (fileUrl) window.open(fileUrl, "_blank", "noopener,noreferrer");
          }}
          disabled={!fileUrl}
          className={HEADER_ICON}
          aria-label={"Open in browser"}
        >
          <ExternalLink size={14} strokeWidth={1.8} />
        </button>
      </Tooltip>
    </>
  );
}

export function FileTabBody({ source }: { source: FilePreviewSource }) {
  const previewUrl = useMemo(() => resolveSourceUrl(source, apiUrl), [source]);
  const kind = previewKindFor(source);
  return (
    <div className="relative h-full overflow-hidden">
      <PreviewBody source={source} previewUrl={previewUrl} kind={kind} />
    </div>
  );
}

const PreviewBody = memo(function PreviewBody({
  source,
  previewUrl,
  kind,
}: {
  source: FilePreviewSource;
  previewUrl: string | null;
  kind: ReturnType<typeof previewKindFor> | null;
}) {
  const filename = source.filename;

  if (kind === "office-text") {
    const fallback = (
      <OfficeTextPreview
        filename={filename}
        extractedText={source.extractedText}
        url={previewUrl}
      />
    );
    if (previewUrl) {
      return (
        <OfficePdfPreview url={previewUrl} filename={filename} fallback={fallback} />
      );
    }
    return fallback;
  }

  if (!previewUrl) {
    return <FallbackPreview filename={filename} url={null} reason="legacy" />;
  }

  switch (kind) {
    case "pdf":
      return <PdfPreview url={previewUrl} filename={filename} />;
    case "docx":
      return (
        <OfficePdfPreview
          url={previewUrl}
          filename={filename}
          fallback={<DocxPreview url={previewUrl} />}
        />
      );
    case "xlsx":
      return (
        <OfficePdfPreview
          url={previewUrl}
          filename={filename}
          fallback={<XlsxPreview url={previewUrl} />}
        />
      );
    case "image":
      return <ImagePreview url={previewUrl} filename={filename} />;
    case "video":
      return <VideoPreview url={previewUrl} filename={filename} />;
    case "svg":
      return <SvgPreview url={previewUrl} filename={filename} />;
    case "markdown":
      return (
        <div className="h-full overflow-y-auto">
          <MarkdownPreview url={previewUrl} />
        </div>
      );
    case "code":
    case "text":
      return (
        <div className="h-full overflow-y-auto">
          <TextPreview url={previewUrl} filename={filename} />
        </div>
      );
    case "fallback":
    default:
      return <FallbackPreview filename={filename} url={previewUrl} />;
  }
});

export function WebTabBody({ url }: { url: string }) {
  
  const [loaded, setLoaded] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const host = hostnameFor(url);

  const openInBrowser = useCallback(() => {
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  useEffect(() => {
    const timer = window.setTimeout(() => setTimedOut(true), 4500);
    return () => window.clearTimeout(timer);
  }, []);

  const blocked = timedOut && !loaded;

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-[color-mix(in_srgb,var(--border)_40%,transparent)] bg-[var(--card)] px-4 py-2.5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--muted)_55%,transparent)]">
          <Globe
            size={14}
            strokeWidth={1.7}
            className="text-[var(--muted-foreground)]"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-semibold text-[var(--foreground)]">
            {host}
          </div>
          <div className="truncate text-[10px] text-[var(--muted-foreground)]">
            {url}
          </div>
        </div>
        <button
          type="button"
          onClick={openInBrowser}
          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            blocked
              ? "bg-[var(--primary)] text-[var(--primary-foreground)] hover:bg-[color-mix(in_srgb,var(--primary)_90%,transparent)]"
              : "border border-[color-mix(in_srgb,var(--border)_55%,transparent)] text-[var(--muted-foreground)] hover:border-[color-mix(in_srgb,var(--primary)_35%,transparent)] hover:text-[var(--primary)]"
          }`}
        >
          <ExternalLink size={11} strokeWidth={1.9} />
          {"Open in browser"}
        </button>
      </div>

      <div
        className={`flex shrink-0 items-start gap-2 border-b border-[color-mix(in_srgb,var(--border)_30%,transparent)] px-4 py-2 text-[11px] leading-snug ${
          blocked
            ? "bg-[color-mix(in_srgb,var(--primary)_8%,var(--card))] text-[var(--foreground)]"
            : "bg-[color-mix(in_srgb,var(--muted)_45%,var(--card))] text-[var(--muted-foreground)]"
        }`}
      >
        <AlertCircle
          size={12}
          strokeWidth={1.9}
          className={`mt-[1px] shrink-0 ${
            blocked ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]"
          }`}
        />
        <span>
          {blocked
            ? "This site looks like it refused to embed (its security headers block iframes). Use “Open in browser” to view it in a real tab."
            : "Many sites refuse to embed for security reasons. If the page below stays blank, use “Open in browser”."}
        </span>
      </div>

      <div className="relative flex-1 overflow-hidden bg-[var(--background)]">
        <iframe
          key={url}
          src={url}
          title={host}
          onLoad={() => setLoaded(true)}
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
        {!loaded && !timedOut ? (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[color-mix(in_srgb,var(--card)_70%,transparent)] text-[12px] text-[var(--muted-foreground)] backdrop-blur-sm">
            <Loader2
              size={18}
              strokeWidth={1.7}
              className="animate-spin text-[color-mix(in_srgb,var(--primary)_80%,transparent)]"
            />
            <span>{`Loading ${host}…`}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function GeogebraTabBody({
  script,
  editable = false,
}: {
  script: string;
  editable?: boolean;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    setSize({
      width: Math.max(320, Math.floor(frame.clientWidth) - 24),
      height: Math.max(360, Math.floor(frame.clientHeight) - 24),
    });
  }, []);
  return (
    <div ref={frameRef} className="h-full w-full overflow-auto bg-[var(--card)] p-3">
      {size ? (
        <Geogebra
          script={script}
          editable={editable}
          width={size.width}
          height={size.height}
          className="m-0 border-0 bg-transparent"
        />
      ) : null}
    </div>
  );
}
