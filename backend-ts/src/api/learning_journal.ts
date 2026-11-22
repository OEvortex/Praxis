// read-only view of the
// workspace's conversational learning journal.
import { Hono } from "hono";
import { get_learning_journal_store } from "../services/learning_journal/store.js";

export const learningJournalRouter = new Hono();

// GET /api/learning-journal
learningJournalRouter.get("/api/learning-journal", (c) => {
  try {
    return c.json(get_learning_journal_store().overview());
  } catch {
    // Upstream maps (OSError, ValueError) to 409 — the original file is preserved.
    return c.json(
      {
        detail:
          "Learning journal could not be read. Its original file has been preserved.",
      },
      409,
    );
  }
});
