// Common ported types — mirrors the wire models.
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Dict = Record<string, unknown>;

export interface BlockNoteInline { type: string; text?: string; styles?: Record<string, unknown>; [k: string]: unknown }
export interface BlockNoteBlock {
  id: string;
  type: string;
  props?: Record<string, unknown>;
  content?: BlockNoteInline[] | { rows?: { cells?: unknown[] }[] } | string;
  children?: BlockNoteBlock[];
  [k: string]: unknown;
}

export interface CoWriterDocument {
  id: string;
  title: string | null;
  content: string;
  blocks: BlockNoteBlock[] | null;
  parent_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

export interface CoWriterDocumentSummary {
  id: string;
  title: string | null;
  parent_id: string | null;
  updated_at: number;
  [k: string]: unknown;
}

export interface ToolResult { success: boolean; result: string; [k: string]: unknown }

export function ok(text: string): ToolResult { return { success: true, result: text }; }
export function fail(text: string): ToolResult { return { success: false, result: text }; }
