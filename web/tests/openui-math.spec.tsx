import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OpenUIMessage from "@/features/chat/messages/OpenUIMessage";

/**
 * A tutor reply is written in OpenUI Lang, whose text components run their
 * strings through the library's own tiny inline-markdown helper. That helper
 * knows bold, italic, code and links but not LaTeX, so `$z = f(x,y)$` inside a
 * `Text(...)` printed as source while `Math("...")` formulas rendered. These
 * are the props and the prose of a real reply from `sess_7b922f8c8f7b`.
 */
describe("inline LaTeX in OpenUI Lang prose", () => {
  it("renders single-dollar maths in Text as KaTeX", () => {
    const { container } = render(
      <OpenUIMessage
        content={
          'root = Text("A surface $z=f(x,y)$ can slope differently when you move parallel to the $x$-axis.")'
        }
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(screen.queryByText(/\$z=f\(x,y\)\$/)).toBeNull();
    expect(screen.queryByText(/\$x\$/)).toBeNull();
  });

  it("renders maths in a Card body, its question and its caption", () => {
    const { container } = render(
      <OpenUIMessage
        content={[
          'root = Card([Title("Geometric meaning"), Text("The partial derivative $\\frac{\\partial f}{\\partial x}$ gives the slope."), Caption("Remember: treat $y$ as a constant.")], "soft")',
        ].join("\n")}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    // KaTeX keeps the TeX source in its MathML <annotation>, so check what the
    // reader sees rather than the element's whole textContent.
    expect(container.querySelector(".katex-html")?.textContent).not.toContain("\\frac");
  });

  it("keeps bold and italic markdown working around the formula", () => {
    const { container } = render(
      <OpenUIMessage
        content={'root = Text("The term $y^2$ becomes **zero** when **y stays fixed**.")'}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(1);
    expect(container.querySelector("strong")?.textContent).toBe("zero");
  });

  it("accepts \\(...\\), \\[...\\] and $$...$$ delimiters", () => {
    const { container } = render(
      <OpenUIMessage
        content={
          'root = Text("Slope \\(m = \\frac{dy}{dx}\\) and the block $$\\nabla f$$ both render.")'
        }
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-html")?.textContent).not.toContain("\\frac");
  });

  it("does not treat prices or escaped dollars as maths", () => {
    const { container } = render(
      <OpenUIMessage
        content={'root = Text("It costs $5 and the upgrade is $7, or \\$9 with tax.")'}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(container.textContent).toContain("It costs $5 and the upgrade is $7");
  });

  it("leaves a formula inside a code span as code", () => {
    const { container } = render(
      <OpenUIMessage content={'root = Text("Write `$x$` for an inline variable.")'} />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(container.querySelector("code")?.textContent).toBe("$x$");
  });
});
