"use client";

import "@hyperframes/player";
import type { CSSProperties, DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "hyperframes-player": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        controls?: boolean;
        poster?: string;
        muted?: boolean;
        width?: number | string;
        height?: number | string;
        "disable-fullscreen"?: boolean;
      };
    }
  }
}

/**
 * Wrapper around the `@hyperframes/player` web component — loads a
 * HyperFrames composition HTML in a sandboxed iframe and plays its
 * seekable GSAP timeline with transport controls.
 */
export default function HyperframesPlayer({
  src,
  className,
  style,
  controls = true,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
  controls?: boolean;
}) {
  return (
    <hyperframes-player
      src={src}
      controls={controls}
      className={className}
      style={style}
    />
  );
}
