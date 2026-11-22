// commit one setting after
// validating it against its spec row. Writes go to the runtime-override file
// (config.ts write_override), so they take effect on the next get_settings()
// call — effect "instant".

import type { Settings } from "../../config.js";
import { OVERRIDABLE_SETTINGS, read_overrides, write_override } from "../../config.js";
import { findSpec } from "./spec.js";

export interface ApplyOutcome {
  ok: boolean;
  key: string;
  value: string;
  previous: string;
  effect: "instant" | "restart";
  message: string;
}

function previousValue(settings: Settings, specKey: string): string {
  const field = OVERRIDABLE_SETTINGS[specKey];
  if (!field) return "";
  const v = settings[field];
  return v === null || v === undefined ? "" : String(v);
}

export function applySetting(
  settings: Settings,
  key: string,
  value: string,
): ApplyOutcome {
  const specKey = String(key ?? "").trim();
  const specValue = String(value ?? "").trim();
  const spec = findSpec(specKey);
  const fail = (message: string): ApplyOutcome => ({
    ok: false,
    key: specKey,
    value: specValue,
    previous: "",
    effect: "instant",
    message,
  });

  if (!spec) {
    return fail(
      `Unknown setting '${specKey}'. Call inspect_setup for the list of changeable settings.`,
    );
  }
  if (!spec.writable) {
    return fail(
      `'${specKey}' cannot be changed from chat: ${spec.notWritableBecause ?? "not writable"}.`,
    );
  }
  if (!specValue) {
    return fail(`apply_setting needs a non-empty 'value' for '${specKey}'.`);
  }
  if (!(specKey in OVERRIDABLE_SETTINGS)) {
    return fail(`'${specKey}' has no runtime override path.`);
  }

  // Validate against declared choices when the spec provides them.
  const choices = spec.choices?.(settings) ?? [];
  const allowed = new Set(choices.map((c) => c.value));
  // Choices lists show the *current* value plus named options; a custom value
  // is acceptable for free-text rows (titles.api_url) but not for enums.
  const isEnumRow = specKey !== "titles.api_url";
  if (isEnumRow && allowed.size && !allowed.has(specValue)) {
    return fail(
      `Invalid value '${specValue}' for '${specKey}'. Options: ${[...allowed].join(", ")}.`,
    );
  }
  if (specKey === "runtime.max_turns") {
    const n = Number(specValue);
    if (!Number.isFinite(n) || n < 1 || n > 200) {
      return fail("runtime.max_turns must be an integer between 1 and 200.");
    }
  }
  if (specKey === "titles.api_url" && specValue !== "off" && !/^https?:\/\//.test(specValue)) {
    return fail("titles.api_url must be an http(s) URL or 'off'.");
  }
  if (specKey === "workspace.dir" && specValue !== "off") {
    // Accept the value; existence is checked but not required (the dir may be
    // created on first use, same as upstream's effect reporting).
  }

  const previous = previousValue(settings, specKey);
  const overrides = read_overrides(settings.data_dir);
  const storedPrevious = overrides[specKey];
  write_override(specKey, specValue === "off" && specKey === "titles.api_url" ? "off" : specValue);

  return {
    ok: true,
    key: specKey,
    value: specValue,
    previous: storedPrevious !== undefined ? String(storedPrevious) : previous,
    effect: "instant",
    message: `'${spec.label}' set to '${specValue}'. Takes effect immediately.`,
  };
}
