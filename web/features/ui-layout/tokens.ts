"use client";

import { useCallback } from "react";

import { useUiLayout } from "@/hooks/useUiLayout";
import type { UiLayout } from "@/lib/ui-layout";
import { classicTokens } from "./classic/tokens";
import { modernTokens } from "./modern/tokens";
import type { UiLayoutTokens } from "./types";

const UI_LAYOUT_TOKENS: Record<UiLayout, UiLayoutTokens> = {
  classic: classicTokens,
  modern: modernTokens,
};

/** Translated copy for a label the two UIs name differently. */
export function useUiLayoutLabel(key: keyof UiLayoutTokens["labels"]): string {
  
  const label = UI_LAYOUT_TOKENS[useUiLayout()].labels[key];
  // An empty token means "this layout shows nothing here".
  return label ? (label) : "";
}

/** The mode picker's name for a capability; the default one is layout copy. */
export function useCapabilityLabel(): (capability: { value: string; label: string }) => string {
  
  const defaultLabel = useUiLayoutLabel("defaultCapability");
  return useCallback(
    // The layout names the default action; a surface that relabelled it
    // (the note companion's "Write together") keeps its own name.
    (capability) =>
      capability.value === "" && capability.label === "Chat"
        ? defaultLabel
        : (capability.label),
    [defaultLabel],
  );
}
