// SQLite-backed session
// persistence, legacy transcript repair, JSON import, and FTS search.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import { SessionStore, type SessionDict } from "../src/store/session_store.js";

let dataDir: string;

function makeSettings(dir: string): Settings {
  return {
    data_dir: dir,
    default_model: "",
    max_turns: 25,
    workspace_dir: join(dir, "workspace"),
    title_api_url: "",
    cors_origins: [],
    sessions_dir: join(dir, "sessions"),
    sessions_db: join(dir, "praxis.sqlite3"),
    files_dir: join(dir, "files"),
  };
}

function store(): SessionStore {
  return new SessionStore(makeSettings(dataDir));
}

function message(
  id: number,
  role: string,
  parent: number | null = null,
  extra: Record<string, unknown> = {},
): SessionDict {
  return {
    id,
    session_id: "sess_test",
    role,
    content: `${role} ${id}`,
    capability: null,
    events: [],
    attachments: [],
    metadata: {},
    created_at: 1.0,
    parent_message_id: parent,
    ...extra,
  };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "praxis-sessions-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("message parent chaining", () => {
  it("chains parents across appended messages", () => {
    const s = store();
    const session = s.create();

    const user1 = s.append_user_message(session, "first");
    const assistant1 = s.append_assistant_message(session, "answer", {
      events: [],
      turn_id: "turn_1",
    });
    const user2 = s.append_user_message(session, "second");
    const assistant2 = s.append_assistant_message(session, "answer 2", {
      events: [],
      turn_id: "turn_2",
    });

    expect(user1.parent_message_id).toBeNull();
    expect(assistant1.parent_message_id).toBe(user1.id);
    expect(user2.parent_message_id).toBe(assistant1.id);
    expect(assistant2.parent_message_id).toBe(user2.id);
  });

  it("supports explicit parent and root edit", () => {
    const s = store();
    const session = s.create();
    const user1 = s.append_user_message(session, "first");
    const assistant1 = s.append_assistant_message(session, "answer", {
      events: [],
      turn_id: "turn_1",
    });

    const edited = s.append_user_message(session, "edited", {
      parent_message_id: user1.parent_message_id,
    });
    const reply = s.append_assistant_message(session, "edited answer", {
      events: [],
      turn_id: "turn_2",
    });

    expect(edited.parent_message_id).toBeNull();
    expect(reply.parent_message_id).toBe(edited.id);
    expect(assistant1.parent_message_id).toBe(user1.id);
  });
});

describe("legacy transcript repair on read", () => {
  it("repairs a flat legacy transcript", () => {
    const s = store();
    const session = s.create();
    session.messages = [
      message(1, "user"),
      message(2, "assistant"),
      message(3, "user"),
      message(4, "assistant"),
    ];
    session.next_message_id = 5;
    s.save(session);

    const loaded = s.get(session.id)!;
    expect(loaded.messages.map((m: SessionDict) => m.parent_message_id)).toEqual([
      null,
      1,
      2,
      3,
    ]);
  });

  it("repairs duplicate legacy ids", () => {
    const s = store();
    const session = s.create();
    session.messages = [
      message(1, "user"),
      message(2, "assistant"),
      message(1, "user"),
      message(2, "assistant"),
      message(1, "user"),
      message(2, "assistant"),
    ];
    session.next_message_id = 3;
    s.save(session);

    const loaded = s.get(session.id)!;
    expect(loaded.messages.map((m: SessionDict) => m.id)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    expect(
      loaded.messages.map((m: SessionDict) => m.parent_message_id),
    ).toEqual([null, 1, 2, 3, 4, 5]);
    expect(loaded.next_message_id).toBe(7);
  });

  it("preserves an existing branch tree", () => {
    const s = store();
    const session = s.create();
    session.messages = [
      message(1, "user"),
      message(2, "assistant", 1),
      message(3, "user"), // legitimate root-edit sibling
      message(4, "assistant", 3),
      message(5, "user", 4),
      message(6, "assistant", 5),
    ];
    session.next_message_id = 7;
    s.save(session);

    const loaded = s.get(session.id)!;
    expect(
      loaded.messages.map((m: SessionDict) => m.parent_message_id),
    ).toEqual([null, 1, null, 3, 4, 5]);
  });
});

describe("legacy JSON import", () => {
  it("imports legacy JSON sessions and archives them", () => {
    const data = dataDir;
    const legacy = join(data, "sessions");
    mkdirSync(legacy, { recursive: true });
    const record = {
      id: "sess_legacy",
      title: "Legacy notes",
      created_at: 10.0,
      updated_at: 20.0,
      status: "idle",
      preferences: { note_document_id: "page_1" },
      messages: [message(1, "user"), message(2, "assistant", 1)],
      turns: {},
      vtx_items: [],
      next_message_id: 3,
    };
    writeFileSync(
      join(legacy, "sess_legacy.json"),
      JSON.stringify(record),
      "utf-8",
    );

    const s = new SessionStore(makeSettings(data));

    const loaded = s.get("sess_legacy")!;
    expect(loaded).not.toBeNull();
    expect(loaded.title).toBe("Legacy notes");
    expect(loaded.updated_at).toBe(20.0);
    expect(
      loaded.messages.map((m: SessionDict) => m.session_id),
    ).toEqual(["sess_legacy", "sess_legacy"]);
    expect(existsSync(join(legacy, "sess_legacy.json"))).toBe(false);
    expect(existsSync(join(data, "sessions-legacy", "sess_legacy.json"))).toBe(
      true,
    );
    expect(existsSync(join(data, "praxis.sqlite3"))).toBe(true);
  });
});

describe("search", () => {
  it("uses the message index and page filter", () => {
    const s = store();
    const first = s.create({ preferences: { note_document_id: "page_a" } });
    s.append_user_message(
      first,
      "Why does the depletion region narrow under bias?",
    );
    s.append_assistant_message(
      first,
      "It widens with reverse bias and narrows with forward bias.",
      { events: [], turn_id: "t1" },
    );
    s.save(first);

    const second = s.create({ preferences: { note_document_id: "page_b" } });
    s.append_user_message(second, "Explain threshold voltage.");
    s.append_assistant_message(second, "The gate voltage that inverts the channel.", {
      events: [],
      turn_id: "t2",
    });
    s.save(second);

    const hits = s.search_hits("depletion OR bias", { limit: 5 });
    expect(hits.map((h: SessionDict) => h.session_id)).toEqual([first.id]);
    expect(hits[0].question.toLowerCase()).toContain("depletion");
    expect(hits[0].answer.toLowerCase()).toContain("reverse bias");

    const scoped = s.search_hits("voltage", { limit: 5, page_id: "page_a" });
    expect(scoped).toEqual([]);

    const [found, total] = s.search("threshold", 10);
    expect(total).toBe(1);
    expect(found[0].id).toBe(second.id);
    expect(found[0]._match_excerpt.toLowerCase()).toContain("threshold");
  });

  it("removes index rows on delete", () => {
    const s = store();
    const session = s.create();
    s.append_user_message(session, "unique-zebra-term");
    s.save(session);
    expect(s.search_hits("zebra").length).toBeGreaterThan(0);

    expect(s.delete(session.id)).toBe(true);
    expect(s.get(session.id)).toBeNull();
    expect(s.search_hits("zebra")).toEqual([]);
    expect(s.delete(session.id)).toBe(false);
  });
});
