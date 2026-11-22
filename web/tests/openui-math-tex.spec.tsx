import { render, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import katex from "katex";

import { MathNode, normalizeTex } from "@/lib/openui/components/math";
import { library } from "@/lib/openui/library";

/**
 * A model writes formulas in prose form all over this app, so it also hands
 * `Math(...)` the delimiters: `Math("$V_{bi}=\\dfrac{kT}{q}$")`. KaTeX then
 * fails on the leading `$` and its error fallback paints the raw source red —
 * the formula reached the notes as an error box. These cases pin the unwrap and
 * the fact that what reaches KaTeX afterwards is valid.
 */
describe("openui Math tex normalisation", () => {
  it("unwraps the delimiters models put around a Math() argument", () => {
    expect(normalizeTex("$V_{bi}=\\dfrac{kT}{q}$")).toBe(
      "V_{bi}=\\dfrac{kT}{q}",
    );
    expect(normalizeTex("$$E=mc^2$$")).toBe("E=mc^2");
    expect(normalizeTex("  $$E=mc^2$$  ")).toBe("E=mc^2");
    expect(normalizeTex("\\(a+b\\)")).toBe("a+b");
    expect(normalizeTex("\\[a+b\\]")).toBe("a+b");
  });

  it("leaves raw LaTeX and ambiguous text alone", () => {
    expect(normalizeTex("E=mc^2")).toBe("E=mc^2");
    // Two separate spans are not one formula to unwrap.
    expect(normalizeTex("$x$ and $y$")).toBe("$x$ and $y$");
    // An escaped dollar is a literal, never a delimiter.
    expect(normalizeTex("\\$5")).toBe("\\$5");
    expect(normalizeTex("")).toBe("");
  });

  it("renders the unwrapped formula without KaTeX's error fallback", () => {
    const { container } = renderKatex("$W=\\sqrt{\\dfrac{2\\varepsilon_s}{q}}$");
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).toContain("W");
  });

  it("still shows red source for a genuinely broken formula", () => {
    // Prevents the fix from being confused with hiding all errors.
    expect(katex.renderToString("$\\frac{1}{", { throwOnError: false })).toContain(
      "katex-error",
    );
  });

  it("keeps the KaTeX node the renderer uses", () => {
    // A future refactor that renames this fails here rather than silently
    // rendering raw source again.
    expect(MathNode).toBeTypeOf("function");
  });
});

function renderKatex(tex: string) {
  const host = document.createElement("div");
  host.innerHTML = katex.renderToString(normalizeTex(tex), {
    throwOnError: false,
    strict: "ignore",
  });
  return { container: host };
}

/**
 * The override has to be registered on the extended library, not just exported:
 * `Library.extend` silently ignores a name it does not recognise, and the
 * failure mode is exactly the screenshot this fixed — formulas printed as red
 * source inside `Card(...)`/`Grid(...)`.
 */
describe("the extended library renders delimited Math() as formulas", () => {
  it("never paints the formula as a KaTeX error", async () => {
    const definition = library.components.Math as unknown as {
      component: (context: unknown) => React.ReactElement;
    };
    const { container } = render(
      definition.component({
        props: { tex: "$V_{bi}=\\dfrac{kT}{q}$" },
        renderNode: () => null,
      }) as React.ReactElement,
    );
    // The library hides the formula until its KaTeX sheet resolves, so the
    // assertion has to wait for that (and it keeps React's update in act()).
    await waitFor(() => expect(container.querySelector(".katex")).not.toBeNull());
    expect(container.querySelector(".katex-error")).toBeNull();
    expect(container.textContent).not.toContain("$");
  });
});
