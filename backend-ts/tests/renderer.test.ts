// False-trigger eval fixtures for the "should this answer be a UI at all?"
// decision. ChatGPT trains this judgment and tests a counterexample set; we
// keep the same idea here so prompt edits that push the model back toward
// "UI for everything" fail a test instead of shipping.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { classifyRenderer } from "../src/agent/renderer.js";

const here = dirname(fileURLToPath(import.meta.url));
type Fixture = {
  id: string;
  category: string;
  prompt: string;
  expected: "markdown" | "ui";
  sample_output: string;
};
const fixtures: Fixture[] = JSON.parse(
  readFileSync(join(here, "fixtures/visual-triggers.json"), "utf8"),
);

describe("renderer classification", () => {
  it("classifies every fixture the way the web app will render it", () => {
    for (const fixture of fixtures) {
      expect(classifyRenderer(fixture.sample_output), fixture.id).toBe(fixture.expected);
    }
  });

  it("has both a false-trigger and a true-trigger set", () => {
    expect(fixtures.filter((f) => f.expected === "markdown").length).toBeGreaterThanOrEqual(5);
    expect(fixtures.filter((f) => f.expected === "ui").length).toBeGreaterThanOrEqual(4);
  });

  it("treats an empty or whitespace reply as Markdown", () => {
    expect(classifyRenderer("")).toBe("markdown");
    expect(classifyRenderer("   \n")).toBe("markdown");
  });
});

describe("response-format prompt policy", () => {
  const systemPrompt = readFileSync(join(here, "../src/agent/prompt.ts"), "utf8");
  const spec = readFileSync(join(here, "../src/agent/openui_prompt.txt"), "utf8");

  it("does not force a UI on every answer", () => {
    for (const source of [systemPrompt, spec]) {
      expect(source).not.toContain("Do not reply with plain Markdown prose");
      expect(source).not.toContain("Your ENTIRE response must be valid openui-lang code");
      expect(source).not.toContain("no markdown, no explanations");
    }
  });

  it("states when plain Markdown is the right answer", () => {
    expect(systemPrompt).toContain("ordinary Markdown with no program at all");
    expect(spec).toContain("plain Markdown answer is a complete, valid reply");
    expect(spec).toContain("One-or-two-sentence answers go out as plain Markdown");
    expect(spec).toContain("needs no interface");
  });
});
