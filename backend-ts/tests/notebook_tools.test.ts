import { describe, expect, it } from "vitest";

import {
  listNotebooksOrRecords,
  readFavoriteRecord,
  writeNote,
  notebook_tools,
} from "../src/agent/notebook_agent/notebook_tools.js";
import type { NotebookManager } from "../src/services/notebook/service.js";

function stubManager() {
  const notebooks: Record<string, Record<string, unknown>> = {
    nb1: {
      id: "nb1",
      name: "Learning",
      updated_at: 1700000000,
      records: [
        {
          id: "r1",
          type: "chat",
          title: "Water cycle",
          summary: "How water moves",
          user_query: "Explain the water cycle",
          output: "A".repeat(9000),
          created_at: 1700000001,
        },
      ],
    },
  };
  const manager = {
    list_notebooks: () =>
      Object.values(notebooks).map((nb) => ({
        id: nb["id"],
        name: nb["name"],
        record_count: (nb["records"] as unknown[]).length,
        updated_at: nb["updated_at"],
      })),
    get_records: (id: string) =>
      (notebooks[id]?.["records"] as Record<string, unknown>[]) ?? [],
    get_record: (id: string, recordId: string) =>
      ((notebooks[id]?.["records"] as Record<string, unknown>[]) ?? []).find(
        (r) => r["id"] === recordId,
      ) ?? null,
    add_record: (opts: Record<string, unknown>) => {
      const id = "r2";
      notebooks["nb1"]!["records"] = [
        ...((notebooks["nb1"]!["records"] as unknown[]) ?? []),
        {
          id,
          type: opts["record_type"],
          title: opts["title"],
          user_query: opts["user_query"],
          output: opts["output"],
          summary: opts["summary"],
          metadata: opts["metadata"] ?? {},
          created_at: 1700000002,
        },
      ];
      return { record: { id }, added_to_notebooks: opts["notebook_ids"] };
    },
    update_record: (
      id: string,
      recordId: string,
      changes: Record<string, unknown>,
    ) => {
      const record = manager.get_record(id, recordId) as Record<
        string,
        unknown
      > | null;
      if (!record) return null;
      Object.assign(record, changes);
      return record;
    },
  };
  return manager as unknown as NotebookManager;
}

describe("DeepTutor notebook toolset", () => {
  it("exposes exactly the three favorites tools", () => {
    expect(notebook_tools().map((tool) => tool.name)).toEqual([
      "list_notebook",
      "list_favorites",
      "save_favorite",
    ]);
  });

  it("lists the index and drills into a collection", () => {
    const manager = stubManager();
    const index = listNotebooksOrRecords("", manager);
    expect(index.ok).toBe(true);
    expect(index.text).toContain("`nb1` — **Learning**");
    expect(index.summary?.mode).toBe("index");

    const records = listNotebooksOrRecords("nb1", manager);
    expect(records.ok).toBe(true);
    expect(records.text).toContain("`r1` — **Water cycle**");
    expect(records.summary?.mode).toBe("records");

    const unknown = listNotebooksOrRecords("nope", manager);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Valid ids: `nb1`");
  });

  it("pages through a favorite record body", () => {
    const manager = stubManager();
    const first = readFavoriteRecord("nb1", "r1", 0, manager);
    expect(first.ok).toBe(true);
    expect(first.summary?.next_offset).toBe(8000);
    const second = readFavoriteRecord("nb1", "r1", 8000, manager);
    expect(second.ok).toBe(true);
    expect(second.summary?.next_offset).toBeNull();
    expect(readFavoriteRecord("nb1", "r1", -1, manager).ok).toBe(false);
  });

  it("saves the real transcript by default and preserves favorite bodies on edit", () => {
    const manager = stubManager();
    const saved = writeNote(
      {
        mode: "append",
        notebook_id: "nb1",
        title: "New favorite",
        conversation_history: [
          { role: "user", content: "What is photosynthesis?" },
          { role: "assistant", content: "Plants make sugar from light." },
        ],
        current_user_message: "What is photosynthesis?",
      },
      manager,
    );
    expect(saved.ok).toBe(true);
    const record = manager.get_record("nb1", saved.record_id) as Record<
      string,
      unknown
    >;
    expect(record["output"]).toContain("### User");
    expect(record["output"]).toContain("Plants make sugar from light.");

    const renamed = writeNote(
      {
        mode: "edit",
        notebook_id: "nb1",
        record_id: saved.record_id,
        title: "Renamed",
        note: "A note",
      },
      manager,
    );
    expect(renamed.ok).toBe(true);
    const updated = manager.get_record("nb1", saved.record_id) as Record<
      string,
      unknown
    >;
    expect(updated["title"]).toBe("Renamed");
    expect(updated["summary"]).toBe("A note");
    expect(updated["output"]).toBe(record["output"]);

    const rejected = writeNote(
      {
        mode: "edit",
        notebook_id: "nb1",
        record_id: saved.record_id,
        content: "overwrite",
      },
      manager,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toContain("preserve original content");
  });
});
