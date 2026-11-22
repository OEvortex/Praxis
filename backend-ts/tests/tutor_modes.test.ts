import { describe, expect, it } from "vitest";

import { prepare_turn_capabilities } from "../src/agent/capability_hooks.js";
import {
  augment_kwargs,
  is_tutor_mode,
  load_system_prompt,
  system_block,
  toolFilterForMode,
  TUTOR_MODES,
} from "../src/capabilities/tutor_modes/capability.js";
import { TUTOR_MODE_TOOLS } from "../src/capabilities/tutor_modes/tools.js";

describe("composer tutor modes", () => {
  it("recognises exactly the five composer actions as turn modes", () => {
    for (const mode of TUTOR_MODES) expect(is_tutor_mode(mode)).toBe(true);
    for (const other of ["", "chat", "deep_solve", "deep_research", "visualize"]) {
      expect(is_tutor_mode(other)).toBe(false);
    }
  });

  it("loads a distinct playbook for each mode", () => {
    const prompts = TUTOR_MODES.map((mode) => load_system_prompt(mode));
    for (const prompt of prompts) expect(prompt.length).toBeGreaterThan(80);
    expect(new Set(prompts).size).toBe(TUTOR_MODES.length);
    expect(load_system_prompt("solve")).toContain("must not call `solve_plan`");
  });

  it("returns a system block only for a selected tutor mode", () => {
    expect(system_block({ tutor_mode: "practice" }, { language: "en" })).toEqual({
      name: "tutor_practice",
      content: load_system_prompt("practice"),
    });
    expect(system_block({ tutor_mode: "deep_solve" })).toBeNull();
    expect(system_block({})).toBeNull();
  });

  it("frames the turn and does not enter Deep Solve for composer Solve", async () => {
    for (const mode of TUTOR_MODES) {
      const hooks = await prepare_turn_capabilities({
        command: { capability: mode, language: "en" },
        session: { id: "session-1", preferences: {} },
        turn_id: `turn-${mode}`,
        prompt: "test",
      });
      expect(hooks.metadata["tutor_mode"]).toBe(mode);
      expect(hooks.metadata["capability"]).toBe(mode);
      expect(hooks.metadata["solve_mode"]).toBeUndefined();
      expect(hooks.systemBlocks.some((block) => block.name === `tutor_${mode}`)).toBe(true);
    }
  });

  it("enforces a per-mode tool gate and mounts the mode's own tool", async () => {
    const solveGate = toolFilterForMode("solve");
    expect(solveGate("web")).toBe(true);
    expect(solveGate("paper_search")).toBe(false);
    expect(solveGate("solve_hint")).toBe(true);
    // Locked-on built-ins are never taken away by a mode.
    expect(solveGate("sources")).toBe(true);
    expect(toolFilterForMode("research")("paper_search")).toBe(true);

    const hooks = await prepare_turn_capabilities({
      command: { capability: "solve", language: "en" },
      session: { id: "session-3", preferences: {} },
      turn_id: "turn-gated",
      prompt: "test",
    });
    expect(hooks.toolFilter?.("paper_search")).toBe(false);
    expect(hooks.ownedTools?.map((tool) => tool.name)).toEqual(["solve_hint"]);
  });

  it("injects the private turn-state handle only into its own tool", () => {
    const metadata = { tutor_mode: "practice", tutor_state_id: "tutor:turn-9" };
    expect(augment_kwargs("practice_item", { question: "2+2?" }, metadata)).toEqual({
      question: "2+2?",
      _tutor_state_id: "tutor:turn-9",
      _tutor_mode: "practice",
    });
    expect(augment_kwargs("web", { query: "x" }, metadata)).toEqual({ query: "x" });
  });

  it("records structured state through the mode-owned tool", async () => {
    const hooks = await prepare_turn_capabilities({
      command: { capability: "research", language: "en" },
      session: { id: "session-4", preferences: {} },
      turn_id: "turn-source",
      prompt: "test",
    });
    const tool = TUTOR_MODE_TOOLS.research;
    const args = hooks.augment(tool.name, {
      title: "Paper",
      url: "https://example.com",
      claim: "A finding",
    });
    const result = await tool.execute(args as never, {} as never);
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.result) as { index: number; note: string };
    expect(payload.index).toBe(1);
    expect(payload.note).toContain("[CIT-1]");
  });

  it("keeps Deep Solve on its own committed-step protocol", async () => {
    const hooks = await prepare_turn_capabilities({
      command: { capability: "deep_solve", language: "en" },
      session: { id: "session-2", preferences: {} },
      turn_id: "turn-deep",
      prompt: "test",
    });
    expect(hooks.metadata["tutor_mode"]).toBeUndefined();
    expect(hooks.metadata["solve_mode"]).toBe(true);
    expect(hooks.systemBlocks.some((block) => block.name === "deep_solve")).toBe(true);
  });
});
