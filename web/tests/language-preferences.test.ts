import test from "node:test";
import assert from "node:assert/strict";

import { formatDate, formatTime, getLocale } from "../lib/datetime";

test("dates and times use the English locale", () => {
  const date = new Date("2026-03-05T14:05:00Z");
  assert.equal(getLocale("en"), "en-US");
  assert.equal(formatDate(date, "en", {
    year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
  }), "March 5, 2026");
  assert.equal(formatTime(date, "en", {
    hour: "2-digit", minute: "2-digit", timeZone: "UTC",
  }), "02:05 PM");
});
