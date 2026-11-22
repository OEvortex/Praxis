"use client";

import React, { Suspense, lazy } from "react";
import type { ComponentType, ReactNode } from "react";

export interface DynamicOptionsLoadingProps {
  error?: Error | null;
  isLoading?: boolean;
  pastDelay?: boolean;
  retry?: () => void;
}

export interface DynamicOptions<P = Record<string, unknown>> {
  loading?: (loadingProps: DynamicOptionsLoadingProps) => ReactNode;
  ssr?: boolean;
  _type?: P;
}

export type LoaderComponent<P = Record<string, unknown>> = Promise<
  ComponentType<P> | { default: ComponentType<P> }
>;

export type Loader<P = Record<string, unknown>> =
  | (() => LoaderComponent<P>)
  | LoaderComponent<P>;

function normalizeModule<P>(
  mod: ComponentType<P> | { default: ComponentType<P> },
): { default: ComponentType<P> } {
  if (typeof mod === "object" && mod !== null && "default" in mod) {
    return mod;
  }
  return { default: mod };
}

export function dynamic<P extends object = Record<string, unknown>>(
  loader: Loader<P>,
  options?: DynamicOptions<P>,
): ComponentType<P> {
  const loadFn = typeof loader === "function" ? loader : () => loader;
  const LazyComponent = lazy(() => loadFn().then(normalizeModule));
  const Loading = options?.loading;

  function DynamicComponent(props: P) {
    const fallback = Loading ? Loading({ isLoading: true }) : null;
    return (
      <Suspense fallback={fallback}>
        <LazyComponent {...props} />
      </Suspense>
    );
  }

  DynamicComponent.displayName = "DynamicComponent";
  return DynamicComponent;
}

export default dynamic;
