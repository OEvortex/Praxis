import { get_settings } from "./src/config.js";
import { builtin_tools } from "./src/agent/tools.js";
import { co_writer_tools } from "./src/agent/co_writer.js";
import { writer_tools, shared_tools } from "./src/agent/notebook_agent/tools.js";
import type { BaseTool } from "./src/shared/vtx.js";

function dump(label: string, tools: readonly BaseTool[]) {
  console.log(`\n===== ${label} (${tools.length}) =====`);
  for (const t of tools) {
    const p = t.params as { properties?: Record<string, any>; required?: string[] } | undefined;
    const props = p?.properties ?? {};
    const actionProp = props.action;
    console.log(`\n-- ${t.name}${t.mutating ? " [mutating]" : " [read-only]"}  icon=${t.toolIcon ?? "-"}`);
    console.log(`DESC: ${String(t.description ?? "").replace(/\n/g, " ").slice(0, 700)}`);
    if (Array.isArray(actionProp?.enum)) {
      console.log(`ACTIONS: ${actionProp.enum.join(", ")}`);
      for (const a of actionProp.enum) {
        const m = new RegExp(`- ${a}: ([^\\n]+)`).exec(String(t.description ?? ""));
        if (m) console.log(`   ${a}: ${m[1]}`);
      }
    }
    console.log(`PARAMS: ${Object.keys(props).filter(k=>k!=="action").join(", ") || "(none)"}`);
    console.log(`REQUIRED: ${(p?.required ?? []).join(", ") || "(none)"}`);
  }
}
dump("MAIN CHAT", builtin_tools(get_settings()));
dump("CO-WRITER", co_writer_tools());
dump("WRITER (nb sub-agent)", writer_tools());
dump("SHARED", shared_tools());
