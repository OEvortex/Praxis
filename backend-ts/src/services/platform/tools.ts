// Tool catalog for GET /api/tools — serialises the real builtin tools the
// agent registers (agent/dt_tools.ts) into the upstream BuiltinToolPayload
// shape: name, description, parameters (JSON-schema → parameter list), hints,
// aliases, toggleable/enabled/available flags.

import {
  question_bank, memory, learning, workspace, mastery, video, notebook,
  web, paper_search, cron, review,
} from "../../agent/dt_tools.js";
import type { BaseTool } from "../../shared/vtx.js";

export interface ToolParameter {
  name: string;
  type: string;
  description: string;
  required: boolean;
  default?: unknown;
  enum?: string[];
}

export interface ToolListing {
  name: string;
  description: string;
  parameters: ToolParameter[];
  hints: Record<string, unknown>;
  aliases: string[];
  capability?: string | null;
  available?: boolean;
  unavailable_reason?: string | null;
  coming_soon?: boolean;
}

// Name → upstream definition name (web merges into web_search).
const NAME_MAP: Record<string, string> = { web: "web_search" };

function schemaToParams(schema: unknown): ToolParameter[] {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return [];
  const s = schema as Record<string, unknown>;
  const properties = s["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return [];
  const required = new Set(Array.isArray(s["required"]) ? (s["required"] as unknown[]).map(String) : []);
  const out: ToolParameter[] = [];
  for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
    const prop = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    const enumValues = Array.isArray(prop["enum"]) ? (prop["enum"] as unknown[]).map(String) : undefined;
    out.push({
      name,
      type: String(prop["type"] ?? "object"),
      description: String(prop["description"] ?? ""),
      required: required.has(name),
      default: prop["default"],
      enum: enumValues,
    });
  }
  return out;
}

const BUILTIN: Array<{ tool: BaseTool; capability?: string | null; comingSoon?: boolean }> = [
  { tool: question_bank as unknown as BaseTool, capability: "question_bank" },
  { tool: memory as unknown as BaseTool },
  { tool: learning as unknown as BaseTool, capability: "learning" },
  { tool: workspace as unknown as BaseTool },
  { tool: mastery as unknown as BaseTool, capability: "mastery" },
  { tool: video as unknown as BaseTool, capability: "video_learning" },
  { tool: notebook as unknown as BaseTool, capability: "notebook" },
  { tool: web as unknown as BaseTool },
  { tool: paper_search as unknown as BaseTool },
  { tool: cron as unknown as BaseTool },
  { tool: review as unknown as BaseTool },
];

const TOOL_HINTS: Record<string, Record<string, unknown>> = {
  web_search: {
    short_description: "Search the web and fetch pages",
    when_to_use: "When the answer needs current or external information.",
    input_format: '{"query": "...", "mode": "search|fetch"}',
    guideline: "Prefer search for discovery, fetch for a known URL.",
    note: "",
    phase: "research",
    aliases: [],
  },
  paper_search: {
    short_description: "Search arXiv papers",
    when_to_use: "For academic or scientific literature questions.",
    input_format: '{"query": "...", "max_results": 5}',
    guideline: "Use for papers, preprints, scientific claims.",
    note: "",
    phase: "research",
    aliases: [],
  },
};

export function builtinTools(): ToolListing[] {
  const seen = new Set<string>();
  const out: ToolListing[] = [];
  for (const { tool, capability, comingSoon } of BUILTIN) {
    const rawName = String((tool as { name?: string }).name ?? "");
    const name = NAME_MAP[rawName] ?? rawName;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const schema = (tool as { params?: unknown }).params;
    const available = name === "web_search" ? webSearchAvailable() : true;
    out.push({
      name,
      description: String((tool as { description?: string }).description ?? ""),
      parameters: schemaToParams(schema),
      hints: TOOL_HINTS[name] ?? {},
      aliases: [],
      capability: capability ?? null,
      available,
      unavailable_reason: available ? null : "search_provider_not_configured",
      coming_soon: comingSoon ?? false,
    });
  }
  return out;
}

function webSearchAvailable(): boolean {
  // web_search is available when an Exa/Tavily-style key or endpoint is
  // configured; the TS runtime resolves keys from env at call time.
  return Boolean(
    process.env.EXA_API_KEY ||
    process.env.TAVILY_API_KEY ||
    process.env.SEARCH_API_KEY ||
    process.env.PRAXIS_SEARCH_API_URL,
  );
}
