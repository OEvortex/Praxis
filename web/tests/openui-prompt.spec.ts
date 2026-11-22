import { describe, expect, it } from "vitest";
import { library } from "@/lib/openui/library";
import { promptOptions } from "@/lib/openui/prompt-options";

/**
 * The generated prompt no longer carries the one-line-per-function reference:
 * `scripts/compact-openui-prompt.mjs` drops it, and `promptOptions.preamble`
 * carries the condensed copy instead. That keeps the per-request spec ~4k
 * tokens smaller, but it means a new library function is only documented if
 * the preamble mentions it — this catches the omission.
 */
describe("OpenUI prompt", () => {
  it("documents every library function in the compact reference", () => {
    const functions = Object.keys(library.toJSONSchema().functions ?? {});
    const preamble = promptOptions.preamble ?? "";
    const undocumented = functions.filter((name) => !preamble.includes(`@${name}(`));
    expect(functions.length).toBeGreaterThan(0);
    expect(undocumented).toEqual([]);
  });

  it("keeps the compact reference in the prompt preamble", () => {
    expect(promptOptions.preamble).toContain("## Function Reference");
  });
});
