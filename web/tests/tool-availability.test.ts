import test from "node:test";
import assert from "node:assert/strict";

import {
  toolAvailabilityCopy,
  toolEffectiveEnabled,
} from "../lib/tool-availability";

test("configured runtime and saved preference are both required", () => {
  assert.equal(toolEffectiveEnabled(true, true, false), true);
  assert.equal(toolEffectiveEnabled(true, false, false), false);
  assert.equal(toolEffectiveEnabled(false, true, false), false);
  assert.equal(toolEffectiveEnabled(true, true, true), false);
});

test("search unavailability has no dead settings link", () => {
  const expected = {
    badge: "Unavailable",
    detail: "Web search is not available in this build.",
  };
  assert.deepEqual(
    toolAvailabilityCopy("search_provider_not_configured", "en"),
    expected,
  );
  assert.deepEqual(
    toolAvailabilityCopy("search_credentials_missing", "en"),
    expected,
  );
});
