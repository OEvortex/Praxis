// The consolidated tool surface: one action-dispatched tool per family.
import { describe, expect, it } from "vitest";

import { get_settings } from "../src/config.js";
import { builtin_tools } from "../src/agent/tools.js";
import { actionTool } from "../src/agent/merged_tools_factory.js";
import { BaseTool, ToolResult, type ToolResultLike } from "../src/shared/vtx.js";

const names = () => builtin_tools(get_settings()).map((tool) => tool.name);

describe("consolidated tool registry", () => {
  it("exposes a small tool surface and no legacy per-action names", () => {
    const all = names();
    expect(all.length).toBeLessThanOrEqual(25);
    for (const merged of [
      "obsidian", "ima", "marginnote", "setup", "subagent", "propose",
      "generate", "solve", "reading", "mastery", "notes", "notebooks", "sources",
    ]) {
      expect(all).toContain(merged);
    }
    for (const legacy of [
      "obsidian_search", "ima_read", "marginnote_tags", "apply_setting",
      "consult_subagent", "propose_partner", "video", "solve_plan",
      "material_outline", "reader_annotate", "mastery_quiz", "note_suggest",
      "nb_patch", "knowledge_base_search",
    ]) {
      expect(all).not.toContain(legacy);
    }
  });

  it("lists every action in the model-facing schema", () => {
    const byName = new Map(builtin_tools(get_settings()).map((t) => [t.name, t]));
    const mastery = byName.get("mastery")!;
    const props = (mastery.params as { properties: Record<string, { enum: string[] }> }).properties;
    expect(props.action.enum).toContain("status");
    expect(props.action.enum).toContain("quiz");
    expect(props.action.enum).toContain("grade");
  });
});

describe("actionTool", () => {
  class SpyTool extends BaseTool {
    name = "spy";
    description = "spy";
    params = { type: "object" as const, properties: { query: { type: "string" }, _hidden: { type: "string" } } };
    mutating = false;
    seen: Record<string, unknown> = {};
    async execute(raw: unknown): Promise<ToolResultLike> {
      this.seen = { ...(raw as Record<string, unknown>) };
      return new ToolResult(true, "done");
    }
  }

  it("forwards hidden params and strips the discriminator", async () => {
    const spy = new SpyTool();
    const merged = actionTool({
      name: "combined",
      description: "combined",
      actions: { go: { tool: spy, description: "go" } },
    });
    const result = await merged.execute({ action: "go", query: "x", _hidden: "server" });
    expect(spy.seen).toEqual({ query: "x", _hidden: "server" });
    expect((result as ToolResultLike).result).toBe("done");
  });

  it("reports an unknown action instead of throwing", async () => {
    const merged = actionTool({
      name: "combined",
      description: "combined",
      actions: { go: { tool: new SpyTool(), description: "go" } },
    });
    const result = (await merged.execute({ action: "nope" })) as ToolResultLike;
    expect(result.success).toBe(false);
    expect(String(result.result)).toContain("unknown action");
  });
});
