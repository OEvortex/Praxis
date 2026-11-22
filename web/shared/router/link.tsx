"use client";

import React from "react";
import { Link as TanStackLink } from "@tanstack/react-router";
import { isExternalHref, parseInternalHref } from "./href";

export interface UrlObject {
  pathname?: string | null;
  query?: Record<string, string | number | boolean | null | undefined>;
  hash?: string | null;
}

export type LinkHref = string | UrlObject;

export interface LinkProps
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> {
  href: LinkHref;
  replace?: boolean;
  prefetch?: boolean | null;
  scroll?: boolean;
  shallow?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
}

function resolveHref(href: LinkHref): string {
  if (typeof href === "string") return href;
  const pathname = href.pathname ?? "";
  const params = new URLSearchParams();
  if (href.query) {
    for (const [key, value] of Object.entries(href.query)) {
      if (value !== undefined && value !== null) {
        params.set(key, String(value));
      }
    }
  }
  const search = params.toString();
  const hash = href.hash
    ? href.hash.startsWith("#")
      ? href.hash
      : `#${href.hash}`
    : "";
  return `${pathname}${search ? `?${search}` : ""}${hash}`;
}

export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  function Link(
    {
      href,
      replace,
      prefetch,
      scroll,
      shallow: _shallow,
      passHref: _passHref,
      legacyBehavior: _legacyBehavior,
      target,
      download,
      children,
      ...rest
    },
    ref,
  ) {
    const resolved = resolveHref(href);

    if (
      isExternalHref(resolved) ||
      target === "_blank" ||
      download !== undefined
    ) {
      return (
        <a
          ref={ref}
          href={resolved}
          target={target}
          download={download}
          {...rest}
        >
          {children}
        </a>
      );
    }

    const { to, search, hash } = parseInternalHref(resolved);

    return (
      <TanStackLink
        ref={ref}
        to={to as never}
        search={search as never}
        hash={hash}
        replace={replace}
        resetScroll={scroll}
        preload={prefetch === false ? false : "intent"}
        target={target}
        {...rest}
      >
        {children}
      </TanStackLink>
    );
  },
);

export default Link;
