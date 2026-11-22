"use client";

import React from "react";

export interface StaticImageData {
  src: string;
  height?: number;
  width?: number;
  blurDataURL?: string;
}

export interface ImageProps
  extends Omit<
    React.ImgHTMLAttributes<HTMLImageElement>,
    "src" | "width" | "height"
  > {
  src: string | StaticImageData;
  alt: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  priority?: boolean;
  quality?: number | `${number}`;
  placeholder?: "blur" | "empty" | `data:image/${string}`;
  blurDataURL?: string;
  unoptimized?: boolean;
  loader?: unknown;
  onLoadingComplete?: (img: HTMLImageElement) => void;
}

export const Image = React.forwardRef<HTMLImageElement, ImageProps>(
  function Image(
    {
      src,
      alt,
      width,
      height,
      fill,
      priority,
      quality: _quality,
      placeholder: _placeholder,
      blurDataURL: _blurDataURL,
      unoptimized: _unoptimized,
      loader: _loader,
      onLoadingComplete: _onLoadingComplete,
      style,
      loading,
      decoding = "async",
      ...rest
    },
    ref,
  ) {
    const resolvedSrc = typeof src === "string" ? src : src.src;
    const resolvedWidth =
      width ?? (typeof src === "object" ? src.width : undefined);
    const resolvedHeight =
      height ?? (typeof src === "object" ? src.height : undefined);

    const fillStyle: React.CSSProperties | undefined = fill
      ? {
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          ...style,
        }
      : style;

    return (
      <img
        ref={ref}
        src={resolvedSrc}
        alt={alt}
        width={fill ? undefined : resolvedWidth}
        height={fill ? undefined : resolvedHeight}
        loading={priority ? "eager" : (loading ?? "lazy")}
        decoding={decoding}
        style={fillStyle}
        {...rest}
      />
    );
  },
);

export default Image;
