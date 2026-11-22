// Port of consolidator/__init__.py — public surface.
export { filter_banned, has_banned } from "./guards.js";
export {
  consolidate_l2,
  consolidate_l3,
  run_audit,
  run_dedup,
  run_merge,
  run_update,
} from "./modes/index.js";
export type {
  AuditResult,
  ConsolidateResult,
  DedupResult,
  MergeResult,
  UpdateResult,
} from "./modes/index.js";
export { parse_action, parse_ops_response } from "./parse.js";
export type { ParsedAction } from "./parse.js";
export { parse_edits_payload, apply_edits, render_view } from "./line_doc.js";
export type { Edit, EditReport, Line, LineView } from "./line_doc.js";
export { chunk_with_boundary } from "./chunker.js";
export type { ChunkSpan } from "./chunker.js";
export { get_run_manager, RunBusyError } from "./runs.js";
export type { Run, RunEvent, RunMode, RunStatus } from "./runs.js";
