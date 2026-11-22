import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = (relative: string) =>
  fs.readFileSync(path.resolve(process.cwd(), relative), "utf8");

describe("retired co-writer workspace", () => {
  it("redirects old document URLs to the favorites notebooks", () => {
    const route = source("app/(workspace)/co-writer/[docId]/page.tsx");
    expect(route).toMatch(/router\.replace\("\/notebooks"/);
    expect(route).not.toMatch(/NoteWorkspace|BlockNote|apiFetch|localStorage/);
    expect(route.split("\n").length).toBeLessThan(20);
  });

  it("uses revisioned blocks and scoped recovery", () => {
    const workspace = source("features/notes/components/NoteWorkspace.tsx");
    expect(workspace).toMatch(/reviewSuggestion/);
    expect(workspace).toMatch(/expected_revision/);
    expect(workspace).toMatch(/persistDraft/);
    expect(workspace).not.toMatch(/\.localStorage\.(?:getItem|setItem|removeItem)/);
  });
});
