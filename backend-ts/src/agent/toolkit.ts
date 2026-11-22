/**
 * Local ``@tool`` decorator — builds vtx ``BaseTool`` instances directly,
 * no ``vtx.agent.sdk`` involvement. Same call shape the SDK decorator had:
 * ``@tool(mutating=..., tool_icon=...)`` over a plain function.
 *
 *
 * TS port notes:
 *  - Python introspected the function signature + type hints to build a pydantic
 *    params model. TypeScript cannot; tool functions declare their schema via an
 *    optional static ``paramsSchema`` (a JSON-schema object) which is used
 *    verbatim. Functions without one get an empty object schema — TODO(verify)
 *    that sibling tool ports attach ``paramsSchema`` where the model needs args.
 *  - Python splatted ``params.model_dump()`` as ``**kwargs``; TS tool functions
 *    take a single params object, so ``execute`` passes it through directly.
 */

import { BaseTool, type Ctx, type ToolParamsSchema, type ToolResultLike } from "../shared/vtx.js";
import { ToolResult } from "../shared/vtx.js";

/** JSON-schema-ish params declaration a tool function may carry. */
export interface ToolParamsSchemaSource {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolFunction {
  (params: Record<string, unknown>, ctx?: Ctx): unknown;
  /** Optional JSON schema for the model-facing params (replaces pydantic introspection). */
  paramsSchema?: ToolParamsSchemaSource;
  name?: string;
  description?: string;
}

/** Shape of the params object ``execute`` receives (model_dump equivalent). */
type ParamsLike = Record<string, unknown> & {
  model_dump?: (opts?: { exclude_none?: boolean }) => Record<string, unknown>;
};

function paramsModel(fn: ToolFunction): ToolParamsSchema {
  const schema = fn.paramsSchema;
  if (schema && typeof schema === "object") {
    return {
      ...schema,
      type: "object",
      properties: (schema.properties ?? {}) as ToolParamsSchema["properties"],
      required: schema.required,
    } as ToolParamsSchema;
  }
  return { type: "object", properties: {} };
}

export class FunctionTool extends BaseTool<Record<string, unknown>> {
  declare name: string;
  declare description: string;
  params: ToolParamsSchema;
  mutating: boolean;
  toolIcon?: string;
  promptGuidelines: unknown[] = [];
  private readonly _fn: ToolFunction;

  constructor(
    fn: ToolFunction,
    opts: { mutating?: boolean; toolIcon?: string; tool_icon?: string } = {},
  ) {
    super();
    this._fn = fn;
    // fn.__name__ equivalent: JS functions carry their declared name on
    // Function.name (read-only), surfaced here via the ToolFunction interface.
    this.name = fn.name || "tool";
    this.description = (fn.description ?? "").trim();
    this.params = paramsModel(fn);
    this.mutating = opts.mutating ?? true;
    this.toolIcon = opts.toolIcon ?? opts.tool_icon ?? "🛠️";
  }

  formatCall(params: unknown): string {
    try {
      const dump =
        typeof (params as ParamsLike)?.model_dump === "function"
          ? (params as ParamsLike).model_dump!()
          : (params as Record<string, unknown>);
      return Object.entries(dump ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
        .slice(0, 120);
    } catch {
      return this.name;
    }
  }

  formatPreview(_params: unknown): string | null {
    return null;
  }

  async execute(params: unknown, _cancelEvent?: unknown): Promise<ToolResultLike> {
    try {
      const p = params as ParamsLike;
      const kwargs =
        typeof p?.model_dump === "function"
          ? p.model_dump({ exclude_none: true })
          : { ...(p ?? {}) };
      const out = await this._fn(kwargs);
      return new ToolResult(true, String(out ?? ""));
    } catch (exc) {
      return new ToolResult(false, `${this.name} error: ${String(exc)}`);
    }
  }
}

export interface ToolDecoratorOptions {
  mutating?: boolean;
  toolIcon?: string;
  /** Python-style alias for toolIcon. */
  tool_icon?: string;
}

export function tool(opts: ToolDecoratorOptions = {}) {
  return function deco(fn: ToolFunction): FunctionTool {
    return new FunctionTool(fn, opts);
  };
}
