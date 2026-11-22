// Port of consolidator/modes/__init__.py
export { consolidate_l2, consolidate_l3 } from "./shims.js";
export type { ConsolidateResult } from "./shims.js";
export { run_audit } from "./audit.js";
export type { AuditResult } from "./audit.js";
export { run_dedup } from "./dedup.js";
export type { DedupResult } from "./dedup.js";
export { run_merge } from "./merge.js";
export type { MergeResult } from "./merge.js";
export { run_update } from "./update.js";
export type { UpdateResult } from "./update.js";
