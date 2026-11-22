import React, { Suspense } from "react";
import type { ComponentType, ReactNode } from "react";

export function LazyRoute({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function lazyPage(
  loader: () => Promise<{ default: ComponentType }>,
): () => React.JSX.Element {
  const Lazy = React.lazy(loader);
  return function LazyPageRoute() {
    return (
      <LazyRoute>
        <Lazy />
      </LazyRoute>
    );
  };
}
