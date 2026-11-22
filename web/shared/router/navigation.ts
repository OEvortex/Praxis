"use client";

import { useMemo } from "react";
import {
  notFound,
  redirect as tanStackRedirect,
  useLocation,
  useParams as useTanStackParams,
  useRouter as useTanStackRouter,
} from "@tanstack/react-router";
import { isExternalHref, parseInternalHref } from "./href";

export interface AppRouterInstance {
  push: (href: string, options?: { scroll?: boolean }) => void;
  replace: (href: string, options?: { scroll?: boolean }) => void;
  back: () => void;
  forward: () => void;
  refresh: () => void;
  prefetch: (href: string) => void;
}

export function useRouter(): AppRouterInstance {
  const router = useTanStackRouter();

  return useMemo<AppRouterInstance>(
    () => ({
      push(href: string, options?: { scroll?: boolean }) {
        if (isExternalHref(href)) {
          window.location.assign(href);
          return;
        }
        const { to, search, hash } = parseInternalHref(href);
        void router.navigate({
          to: to as never,
          search: search as never,
          hash,
          resetScroll: options?.scroll,
        });
      },
      replace(href: string, options?: { scroll?: boolean }) {
        if (isExternalHref(href)) {
          window.location.replace(href);
          return;
        }
        const { to, search, hash } = parseInternalHref(href);
        void router.navigate({
          to: to as never,
          search: search as never,
          hash,
          replace: true,
          resetScroll: options?.scroll,
        });
      },
      back() {
        router.history.back();
      },
      forward() {
        router.history.forward();
      },
      refresh() {
        void router.invalidate();
      },
      prefetch(href: string) {
        if (isExternalHref(href)) return;
        const { to, search, hash } = parseInternalHref(href);
        void router
          .preloadRoute({
            to: to as never,
            search: search as never,
            hash,
          })
          .catch(() => {});
      },
    }),
    [router],
  );
}

export function usePathname(): string {
  return useLocation({ select: (location) => location.pathname });
}

export function useSearchParams(): URLSearchParams {
  const searchStr = useLocation({ select: (location) => location.searchStr });
  return useMemo(() => new URLSearchParams(searchStr), [searchStr]);
}

export function useParams<
  T extends Record<string, string | string[] | undefined> = Record<
    string,
    string
  >,
>(): T {
  return useTanStackParams({ strict: false } as never) as T;
}

export function redirect(url: string): never {
  throw tanStackRedirect({ href: url });
}

export function permanentRedirect(url: string): never {
  throw tanStackRedirect({ href: url, statusCode: 308 });
}

export { notFound };
