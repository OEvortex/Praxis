/**
 * Action-dispatched tool factory.
 *
 * One tool with an `action` discriminator replaces a family of narrow tools.
 * The original tool objects remain the implementation — only the model-facing
 * surface is consolidated. Server-owned params injected by capability hooks
 * are forwarded verbatim to the selected tool.
 */

import {
  BaseTool,
  ToolResult,
  type ToolParamField,
  type ToolParamsSchema,
  type ToolResultLike,
} from "../shared/vtx.js";

export interface MergedAction {
  tool: BaseTool;
  description: string;
}

export interface MergedToolOptions {
  name: string;
  description: string;
  actions: Record<string, MergedAction>;
  actionParam?: string;
  toolIcon?: string;
}

export function actionTool(options: MergedToolOptions): BaseTool {
  const actionParam = options.actionParam ?? "action";
  const actionNames = Object.keys(options.actions);
  const properties: Record<string, ToolParamField> = {
    [actionParam]: { type: "string", enum: actionNames },
  };
  for (const action of Object.values(options.actions)) {
    const schema = action.tool.params as ToolParamsSchema | undefined;
    for (const [key, value] of Object.entries(schema?.properties ?? {})) {
      if (key.startsWith("_")) continue;
      if (key in properties) continue;
      const field = { ...(value as Record<string, unknown>) };
      if (typeof field.required === "boolean") delete field.required;
      properties[key] = field as ToolParamField;
    }
  }
  const params: ToolParamsSchema = {
    type: "object",
    properties,
    required: [actionParam],
  };
  const mutating = Object.values(options.actions).some((a) => a.tool.mutating);
  const description = `${options.description} Actions: ${actionNames
    .map((name) => `${name}=${options.actions[name].description}`)
    .join(", ")}`;

  class MergedTool extends BaseTool {
    name = options.name;
    description = description;
    params = params;
    mutating = mutating;
    toolIcon = options.toolIcon ?? "🧰";

    async execute(raw: unknown): Promise<ToolResultLike> {
      const args = (raw && typeof raw === "object" ? { ...raw } : {}) as Record<string, unknown>;
      const action = String(args[actionParam] ?? "").trim();
      delete args[actionParam];
      const selected = options.actions[action];
      if (!selected) {
        return new ToolResult(false, `${options.name}: unknown action '${action}'. Use one of ${actionNames.join(", ")}.`);
      }
      const result = await selected.tool.execute(args);
      if (result instanceof ToolResult) return result;
      const text = (result as ToolResultLike | null)?.result ?? String(result ?? "");
      return new ToolResult(true, String(text));
    }
  }

  return new MergedTool();
}
