// Port of deeptutor/capabilities/notes/ — the notes capability surface.
export * from "./capability.js";
export * from "./generation.js";
export * from "./threads.js";
export * from "./tools.js";
// capability.ts and tools.ts both declare NOTE_TOOL_NAMES (same value);
// re-export explicitly to resolve the export-* ambiguity.
export { NOTE_TOOL_NAMES } from "./capability.js";
