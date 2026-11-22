import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import OpenUIMessage from "@/features/chat/messages/OpenUIMessage";

describe("OpenUIMessage", () => {
  it("renders a streamed OpenUI Lang program", () => {
    render(<OpenUIMessage content={'root = Text("Hello OpenUI")'} />);
    expect(screen.getByText("Hello OpenUI")).toBeTruthy();
  });

  it("renders a program that starts after a sentence of prose", () => {
    // The shape that reached the UI as raw source: prose and `root =` on one
    // line, so the reply was neither detected as a program nor parseable.
    const { container } = render(
      <OpenUIMessage
        content={
          'Let us derive it. root = Col([head])\nhead = Title("Maxwell", "xl")'
        }
      />,
    );

    expect(screen.getByText("Maxwell")).toBeTruthy();
    expect(screen.getByText("Let us derive it.")).toBeTruthy();
    expect(container.textContent).not.toContain("root = Col");
  });

  it("renders a reply with no program as prose instead of blank", async () => {
    const { container } = render(
      <OpenUIMessage content={"The gradient points uphill, at $|\\nabla f|$."} />,
    );

    // Plain prose uses the app's Markdown renderer, which is dynamically
    // imported so KaTeX is only loaded for answers that need it.
    expect(await screen.findByText(/The gradient points uphill/)).toBeTruthy();
    expect(container.querySelector("p")).toBeTruthy();
  });
  it("renders a program written entirely on one line", () => {
    // The reply that reached the Dito side panel as source: three statements
    // share a line, which the parser read as one and rendered as nothing.
    const { container } = render(
      <OpenUIMessage
        content={
          'root = Col([head, note]) head = Title("Can\'t open that", "xl") note = Text("No content to read.", "md")'
        }
      />,
    );

    expect(screen.getByText("Can't open that")).toBeTruthy();
    expect(screen.getByText("No content to read.")).toBeTruthy();
    expect(container.textContent).not.toContain("root = Col");
  });
});
