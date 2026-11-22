// durable, reviewable
// edits with per-block conflict detection.

import { randomBytes } from "node:crypto";

import {
  blocks_to_markdown,
  validate_blocks,
  walk_blocks,
} from "./blocks.js";
import { RevisionConflict } from "./storage.js";
import type { CoWriterDocument, CoWriterStorage } from "./storage.js";

const _loadDocument = (s: CoWriterStorage, id: string) => s.loadDocument(id);
const _loadExtra = (s: CoWriterStorage, docId: string, kind: string, dflt: unknown) =>
  s.loadExtra(docId, kind, dflt);
const _saveExtra = (s: CoWriterStorage, docId: string, kind: string, payload: unknown) =>
  s.saveExtra(docId, kind, payload);

/** BlockNote block row as stored in document payloads (storage.Dict shape). */
type Block = Record<string, unknown> & {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown;
  children?: Block[];
};

export interface Proposal {
  id: string;
  operation: string;
  block_id: string;
  markdown: string;
  blocks?: Block[] | null;
  explanation: string;
  original?: Block | null;
  preserve_children?: boolean;
  anchors?: ReviewAnchor[];
  status: string;
  source_turn_id?: string;
  created_at?: number;
  [k: string]: unknown;
}

const _now = (): number => Date.now() / 1000;

// Sentinel mirroring Python's ``expected_original=_UNSET`` default argument.
const _UNSET = Symbol("unset");

/**
 * Keep resource links as written.
 *
 * The upstream build rewrites ``[[resource]]`` links against the workspace
 * file store before a proposal is stored; this deployment has no such store,
 * so the text passes through unchanged.
 */
function _normalize_resources(
  markdown: string,
  blocks: Block[] | null,
): [string, Block[] | null] {
  return [markdown, blocks];
}

function _as_proposals(raw: unknown): Proposal[] {
  return Array.isArray(raw) ? (raw as Proposal[]) : [];
}

export function list_proposals(
  storage: CoWriterStorage,
  doc_id: string,
): Proposal[] {
  return _as_proposals(_loadExtra(storage, doc_id, "suggestions", []));
}

export interface ReviewAnchor {
  id: string;
  side: "before" | "after";
}

/**
 * Keep nearby, stable anchors if the reviewed block is later removed.
 * Returns null when ``block_id`` is not present in ``blocks``.
 */
export function review_anchors(
  blocks: Block[],
  block_id: string,
): ReviewAnchor[] | null {
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    let nested: ReviewAnchor[] | null = null;
    if (block.id !== block_id) {
      nested = review_anchors(block.children ?? [], block_id);
      if (nested === null) {
        continue;
      }
    }
    const neighbors: ReviewAnchor[] = [
      ...blocks.slice(index + 1).map((b) => ({
        id: String(b.id),
        side: "before" as const,
      })),
      ...blocks
        .slice(0, index)
        .reverse()
        .map((b) => ({ id: String(b.id), side: "after" as const })),
    ];
    if (block.id === block_id) {
      return neighbors;
    }
    if (nested !== null) {
      return [
        ...nested,
        { id: String(block.id), side: "after" },
        ...neighbors,
      ];
    }
  }
  return null;
}

export function refresh_review_anchors(
  storage: CoWriterStorage,
  doc_id: string,
  blocks: Block[],
  previous_blocks: Block[],
): void {
  const proposals = list_proposals(storage, doc_id);
  let changed = false;
  for (const proposal of proposals) {
    if (proposal.status !== "pending" || !proposal.block_id) {
      continue;
    }
    let anchors = review_anchors(blocks, proposal.block_id);
    if (anchors === null) {
      anchors = review_anchors(previous_blocks, proposal.block_id);
    }
    if (anchors !== null && !deep_equal(anchors, proposal.anchors)) {
      proposal.anchors = anchors;
      changed = true;
    }
  }
  if (changed) {
    _saveExtra(storage, doc_id, "suggestions", proposals);
  }
}

/** A text-only parent edit must not implicitly delete its subtree. */
export function preserves_children(
  operation: string,
  original: Block | null | undefined,
  blocks: Block[] | null | undefined,
): boolean {
  return Boolean(
    operation === "replace" &&
      original &&
      (original.children?.length ?? 0) > 0 &&
      (blocks === null ||
        blocks === undefined ||
        (blocks.length > 0 &&
          (blocks[0].children === undefined ||
            blocks[0].children.length === 0))),
  );
}

export function propose(
  storage: CoWriterStorage,
  doc_id: string,
  opts: {
    operation: string;
    block_id?: string;
    markdown?: string;
    explanation?: string;
    blocks?: Block[] | null;
    expected_original?: unknown;
    workspace_id?: string;
    source_turn_id?: string;
  },
): Proposal {
  const operation = opts.operation;
  const block_id = opts.block_id ?? "";
  let markdown = opts.markdown ?? "";
  const explanation = opts.explanation ?? "";
  let blocks: Block[] | null = opts.blocks ?? null;
  const expected_original: unknown =
    "expected_original" in opts ? opts.expected_original : _UNSET;
  const source_turn_id = opts.source_turn_id ?? "";
  // workspace_id is accepted for parity with the Python signature but unused.
  void opts.workspace_id;

  if (!["insert", "replace", "delete", "comment"].includes(operation)) {
    throw new Error("Unknown note operation");
  }
  if (markdown.length > 200000 || explanation.length > 10000) {
    throw new Error("Suggestion is too long");
  }
  return storage.locked(() => {
    const doc = _loadDocument(storage, doc_id);
    if (doc === null) {
      throw new Error("Page not found");
    }
    if (doc.blocks === null || doc.blocks === undefined) {
      throw new Error(
        "Open this page in the block editor before suggesting changes",
      );
    }
    const proposals = list_proposals(storage, doc_id);
    if (source_turn_id) {
      const existing = proposals.find(
        (p) => p.source_turn_id === source_turn_id && p.block_id === block_id,
      );
      if (existing !== undefined) {
        return existing;
      }
    }
    const target = _find_block(doc.blocks as Block[], block_id);
    if (
      (block_id || operation === "replace" || operation === "delete") &&
      target === null
    ) {
      throw new Error("Block no longer exists; read the page again");
    }
    if (
      expected_original !== _UNSET &&
      !same_block(
        target as Block | null,
        expected_original as Block | null,
      )
    ) {
      throw new RevisionConflict(
        "The block changed after it was read. Read it again before suggesting an edit.",
      );
    }
    if (operation === "comment" && !(explanation.trim() || markdown.trim())) {
      throw new Error("A comment needs feedback text");
    }
    [markdown, blocks] = _normalize_resources(markdown, blocks);
    if (blocks !== null) {
      validate_blocks(blocks);
    }
    const proposal: Proposal = {
      id: randomBytes(16).toString("hex"),
      operation,
      block_id,
      markdown,
      blocks: blocks ?? null,
      explanation,
      original: target === null ? null : deep_copy(target),
      preserve_children: preserves_children(operation, target, blocks),
      anchors: review_anchors(doc.blocks as Block[], block_id) ?? [],
      status: "pending",
      source_turn_id,
      created_at: _now(),
    };
    if (proposals.filter((p) => p.status === "pending").length >= 100) {
      throw new Error("Review pending suggestions before creating more");
    }
    proposals.push(proposal);
    _saveExtra(storage, doc_id, "suggestions", proposals.slice(-500));
    return proposal;
  });
}

export function review(
  storage: CoWriterStorage,
  doc_id: string,
  proposal_id: string,
  opts: { accept: boolean; blocks?: Block[] | null },
): CoWriterDocument {
  const accept = opts.accept;
  const blocks_arg = opts.blocks;
  return storage.locked(() => {
    const doc = _loadDocument(storage, doc_id);
    if (doc === null) {
      throw new Error("Page not found");
    }
    const proposals = list_proposals(storage, doc_id);
    const proposal = proposals.find((p) => p.id === proposal_id);
    if (proposal === undefined) {
      throw new Error("Suggestion not found");
    }
    if (proposal.status !== "pending") {
      return doc;
    }
    const appliedIds = doc.applied_suggestion_ids ?? [];
    if (
      accept &&
      proposal.operation !== "comment" &&
      !appliedIds.includes(proposal_id)
    ) {
      const current = _find_block(
        (doc.blocks ?? []) as Block[],
        proposal.block_id,
      );
      const keep_children = preserves_children(
        proposal.operation,
        proposal.original ?? null,
        proposal.blocks ?? null,
      );
      let before: Block | null = proposal.original ?? null;
      let after: Block | null = current;
      if (keep_children) {
        before = before ? { ...before, children: [] } : null;
        after = after ? { ...after, children: [] } : null;
      }
      if (!same_block(after, before)) {
        throw new RevisionConflict(
          "The suggested block changed. Ask Dito to revise the suggestion.",
        );
      }
      // Python: `blocks if blocks is not None else proposal.get("blocks")` —
      // null/undefined fall back to the stored proposal blocks.
      let replacement: Block[] | null | undefined =
        blocks_arg ?? proposal.blocks;
      if (proposal.operation !== "delete" && replacement == null) {
        throw new Error("Convert the suggestion to blocks before accepting");
      }
      replacement = deep_copy(replacement ?? []);
      if (keep_children) {
        if (replacement.length === 0) {
          throw new Error("A replacement must contain at least one block");
        }
        // Compose independent parent/child edits in either review order.
        replacement[0].children = deep_copy(
          (current as Block | null)?.children ?? [],
        );
      }
      if (proposal.operation === "replace" && replacement.length > 0) {
        // Keep the anchor stable for links and other reviews at this position.
        replacement[0].id = proposal.block_id;
      }

      const apply = (items: Block[]): boolean => {
        for (let index = 0; index < items.length; index++) {
          const block = items[index];
          if (block.id === proposal.block_id) {
            if (proposal.operation === "insert") {
              items.splice(index + 1, 0, ...replacement!);
            } else {
              items.splice(index, 1, ...replacement!);
            }
            return true;
          }
          if (apply(block.children ?? [])) {
            return true;
          }
        }
        return false;
      };

      if (proposal.block_id) {
        apply((doc.blocks ?? []) as Block[]);
      } else {
        ((doc.blocks ??= []) as Block[]).push(...replacement);
      }
      validate_blocks((doc.blocks ?? []) as Block[]);
      doc.content = blocks_to_markdown((doc.blocks ?? []) as Block[]);
      doc.revision = (doc.revision ?? 0) + 1;
      doc.updated_at = _now();
      doc.applied_suggestion_ids = [...appliedIds, proposal_id].slice(-1000);
      // TODO(verify): Python storage._write(doc, source="suggestion"); _write is
      // private in the TS port — reached through a cast, positional source.
      (storage as unknown as Record<string, any>)._write?.(doc, "suggestion");
    }
    proposal.status = accept ? "accepted" : "dismissed";
    _saveExtra(storage, doc_id, "suggestions", proposals);
    return doc;
  });
}

/** Ignore editor-added defaults while still rejecting real content/format edits. */
export function same_block(
  left: Block | null | undefined,
  right: unknown,
): boolean {
  return deep_equal(canonical(left ?? null), canonical(right ?? null));
}

function canonical(block: unknown): unknown {
  if (block === null || block === undefined) {
    return null;
  }
  const result = deep_copy(block) as Block;
  const props = (result.props ??= {}) as Record<string, unknown>;
  for (const [key, dflt] of [
    ["backgroundColor", "default"],
    ["textColor", "default"],
    ["textAlignment", "left"],
  ] as const) {
    if (props[key] === dflt) {
      delete props[key];
    }
  }
  const children = (result.children ?? []) as Block[];
  result.children = children.map((child) => canonical(child) as Block);
  if (Array.isArray(result.content) && result.content.length === 0) {
    delete result.content;
  }
  return result;
}

/** First block with ``id`` in document order, or null (walk_blocks may be a
 * generator in the TS port, so avoid relying on Array methods). */
function _find_block(blocks: Block[], block_id: string): Block | null {
  for (const block of walk_blocks(blocks)) {
    if (block.id === block_id) return block;
  }
  return null;
}

function deep_copy<T>(value: T): T {
  return value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

/** Order-insensitive deep equality mirroring Python ``==`` on dicts/lists. */
function deep_equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    return (a as unknown[]).every((v, i) => deep_equal(v, (b as unknown[])[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(bo, k) &&
      deep_equal(ao[k], bo[k]),
  );
}
