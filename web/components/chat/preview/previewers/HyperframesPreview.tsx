"use client";

import HyperframesPlayer from "@/components/chat/preview/HyperframesPlayer";

/** Preview for agent-generated HyperFrames compositions (interactive HTML). */
export default function HyperframesPreview({
  url,
  filename,
}: {
  url: string;
  filename: string;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-black/95 p-3">
      <HyperframesPlayer
        src={url}
        className="block h-full w-full rounded-md"
        style={{ aspectRatio: "16 / 9", maxHeight: "100%" }}
      />
      <span className="sr-only">{filename}</span>
    </div>
  );
}
