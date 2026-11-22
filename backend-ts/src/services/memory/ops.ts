// atomic add/edit/delete batches.
// Pure functions; no I/O.
import { is_entry_id, is_valid_ref, new_entry_id } from "./ids.js";
import {
  all_entries,
  find_entry,
  newDocument,
  remove_entry,
  section_entries,
  type Document,
  type Entry,
} from "./document.js";

const MAX_TEXT_LEN = 240;
const MAX_SECTION_LEN = 80;
const DELETE_REASONS = new Set(["contradicted", "superseded", "stale", "low-signal"]);

export interface AddOp {
  op: "add";
  section: string;
  text: string;
  refs: string[];
}
export interface EditOp {
  op: "edit";
  target_id: string;
  new_text: string;
  new_refs: string[];
}
export interface DeleteOp {
  op: "delete";
  target_id: string;
  reason: string;
}
export type Op = AddOp | EditOp | DeleteOp;

export interface OpResult {
  op: Op;
  status: "applied";
  entry_id?: string | null;
  detail?: string;
}

export interface ApplyReport {
  accepted: boolean;
  results: OpResult[];
  reason?: string;
}

export class OpValidationError extends Error {}

function validateSingleLine(value: string, fieldName: string): void {
  if (value.split("\n").length !== 1 || value.includes("\r")) {
    throw new OpValidationError(`${fieldName} must be a single line`);
  }
}

function validate(doc: Document, ops: Op[]): void {
  const edits = new Set<string>();
  const deletes = new Set<string>();

  for (const op of ops) {
    if (op.op === "add") {
      if (!op.text || op.text.length > MAX_TEXT_LEN) {
        throw new OpValidationError(
          `add: text length must be 1..${MAX_TEXT_LEN} (got ${op.text.length})`,
        );
      }
      validateSingleLine(op.text, "add: text");
      if (!op.section || op.section.length > MAX_SECTION_LEN) {
        throw new OpValidationError(`add: invalid section ${JSON.stringify(op.section)}`);
      }
      validateSingleLine(op.section, "add: section");
      if (!op.refs.length) {
        throw new OpValidationError("add: refs must be non-empty");
      }
      for (const ref of op.refs) {
        if (!is_valid_ref(ref)) {
          throw new OpValidationError(`add: malformed ref ${JSON.stringify(ref)}`);
        }
        validateSingleLine(ref, "add: ref");
      }
    } else if (op.op === "edit") {
      if (!is_entry_id(op.target_id)) {
        throw new OpValidationError(`edit: malformed target_id ${op.target_id}`);
      }
      if (find_entry(doc, op.target_id) === null) {
        throw new OpValidationError(`edit: target_id ${op.target_id} not found`);
      }
      if (!op.new_text || op.new_text.length > MAX_TEXT_LEN) {
        throw new OpValidationError(
          `edit: text length must be 1..${MAX_TEXT_LEN} (got ${op.new_text.length})`,
        );
      }
      validateSingleLine(op.new_text, "edit: text");
      if (!op.new_refs.length) {
        throw new OpValidationError("edit: refs must be non-empty");
      }
      for (const ref of op.new_refs) {
        if (!is_valid_ref(ref)) {
          throw new OpValidationError(`edit: malformed ref ${JSON.stringify(ref)}`);
        }
        validateSingleLine(ref, "edit: ref");
      }
      if (deletes.has(op.target_id)) {
        throw new OpValidationError(
          `batch conflict: edit and delete on same id ${op.target_id}`,
        );
      }
      edits.add(op.target_id);
    } else if (op.op === "delete") {
      if (!is_entry_id(op.target_id)) {
        throw new OpValidationError(`delete: malformed target_id ${op.target_id}`);
      }
      if (find_entry(doc, op.target_id) === null) {
        throw new OpValidationError(`delete: target_id ${op.target_id} not found`);
      }
      if (!DELETE_REASONS.has(op.reason)) {
        throw new OpValidationError(
          `delete: reason must be one of ${[...DELETE_REASONS].sort().join(", ")}`,
        );
      }
      if (edits.has(op.target_id)) {
        throw new OpValidationError(
          `batch conflict: edit and delete on same id ${op.target_id}`,
        );
      }
      deletes.add(op.target_id);
    } else {
      throw new OpValidationError(`unknown op ${(op as Op).op}`);
    }
  }
}

export function apply(doc: Document, ops: Op[]): ApplyReport {
  try {
    validate(doc, ops);
  } catch (exc) {
    if (exc instanceof OpValidationError) {
      return { accepted: false, results: [], reason: exc.message };
    }
    throw exc;
  }

  const results: OpResult[] = [];
  for (const op of ops) {
    if (op.op === "add") {
      const newId = new_entry_id();
      section_entries(doc, op.section).push({
        id: newId,
        section: op.section,
        text: op.text,
        refs: [...op.refs],
      });
      results.push({ op, status: "applied", entry_id: newId });
    } else if (op.op === "edit") {
      const entry = find_entry(doc, op.target_id);
      if (entry) {
        entry.text = op.new_text;
        entry.refs = [...op.new_refs];
      }
      results.push({ op, status: "applied" });
    } else {
      remove_entry(doc, op.target_id);
      results.push({ op, status: "applied", detail: op.reason });
    }
  }
  return { accepted: true, results };
}

export { all_entries, find_entry, newDocument };
export type { Entry };
