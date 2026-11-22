// The usage page must reflect provider usage reported by live turns. The local
// agent loop keeps that usage on AgentEndEvent, not in session entries, so the
// vtx_entries scraper finds nothing — record_call_usage is the live path.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../src/config.js";
import {
  add_usage,
  record_call_usage,
  usage_for_year,
} from "../src/services/usage_stats.js";

let dataDir: string;
let settings: Settings;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "praxis-usage-"));
  settings = {
    data_dir: dataDir,
    default_model: "",
    max_turns: 25,
    workspace_dir: join(dataDir, "workspace"),
    title_api_url: "",
    cors_origins: [],
    sessions_dir: join(dataDir, "sessions"),
    sessions_db: join(dataDir, "praxis.sqlite3"),
    files_dir: join(dataDir, "files"),
  };
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("record_call_usage", () => {
  it("feeds native usage into the year report", () => {
    record_call_usage(settings, {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "reflection/beam-free",
      provider: "kilo",
      usage: {
        total_tokens: 18500,
        input_tokens: 15000,
        output_tokens: 3500,
        cache_read_tokens: 0,
      },
    });

    const year = new Date().getUTCFullYear();
    const report = usage_for_year(settings, year, "UTC");
    expect(report.totals.total_tokens).toBe(18500);
    expect(report.totals.prompt_tokens).toBe(15000);
    expect(report.totals.completion_tokens).toBe(3500);
    expect(report.totals.total_calls).toBe(1);
    expect(report.models.length).toBe(1);
    expect(report.models[0].model).toBe("reflection/beam-free");
    expect(report.models[0].provider).toBe("kilo");
  });

  it("does not double count when the same turn is recorded twice", () => {
    const args = {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "model-x",
      provider: "p",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    record_call_usage(settings, args);
    record_call_usage(settings, args);
    const report = usage_for_year(settings, new Date().getUTCFullYear(), "UTC");
    expect(report.totals.total_tokens).toBe(15);
    expect(report.totals.total_calls).toBe(1);
  });

  it("computes cache hit rate from provider-reported cache reads", () => {
    record_call_usage(settings, {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "reflection/beam-free",
      provider: "kilo",
      usage: {
        total_tokens: 145,
        input_tokens: 100,
        output_tokens: 45,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
        cache_reported: true,
      },
    });
    const report = usage_for_year(settings, new Date().getUTCFullYear(), "UTC");
    const t = report.totals;
    expect(t.cache_reported_calls).toBe(1);
    expect(t.cache_read_input_tokens).toBe(40);
    expect(t.cache_creation_input_tokens).toBe(10);
    expect(t.cache_input_tokens).toBe(100);
    expect(t.cache_hit_rate).toBe(0.4);
    expect(report.models[0].cache_hit_rate).toBe(0.4);
  });

  it("leaves cache hit rate null when the provider reports no cache counters", () => {
    record_call_usage(settings, {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "m",
      provider: "p",
      usage: { total_tokens: 20, input_tokens: 15, output_tokens: 5 },
    });
    const report = usage_for_year(settings, new Date().getUTCFullYear(), "UTC");
    expect(report.totals.cache_reported_calls).toBe(0);
    expect(report.totals.cache_hit_rate).toBeNull();
  });

  it("sums every model call in a tool-using turn", () => {
    let total = add_usage(null, { input_tokens: 100, output_tokens: 10 });
    total = add_usage(total, { input_tokens: 200, output_tokens: 20 });
    expect(total).toMatchObject({
      input_tokens: 300,
      output_tokens: 30,
      calls: 2,
    });
    record_call_usage(settings, {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "m",
      provider: "p",
      usage: total,
    });
    const report = usage_for_year(settings, new Date().getUTCFullYear(), "UTC");
    expect(report.totals.total_tokens).toBe(330);
    expect(report.totals.total_calls).toBe(2);
  });

  it("ignores turns with no reported usage", () => {
    record_call_usage(settings, {
      session_id: "sess_1",
      turn_id: "turn_1",
      model: "m",
      provider: "p",
      usage: null,
    });
    const report = usage_for_year(settings, new Date().getUTCFullYear(), "UTC");
    expect(report.totals.total_tokens).toBe(0);
  });
});
