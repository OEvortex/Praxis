// model resolution for turns that carry no explicit llm_selection.
//
// Co-Writer threads (and any other client that doesn't send a selection)
// used to fail at agent init with "no model configured" whenever the learner
// had configured a model but never explicitly picked one. The composer's
// settings endpoint already falls back to the first configured option; turn
// resolution must agree with it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Settings } from "../src/config.js";
import {
  active_selection,
  default_catalog,
  get_selection,
  resolve_runtime_model,
  save_catalog,
  set_selection,
} from "../src/provider-config.js";

const CONNECTION_ID = "conn-test";
const PROFILE_ID = "profile-test";
const MODEL_ID = "model-test";

function testSettings(dir: string): Settings {
  return {
    data_dir: dir,
    sessions_dir: join(dir, "sessions"),
    sessions_db: join(dir, "praxis.sqlite3"),
    files_dir: join(dir, "files"),
    default_model: "",
    max_turns: 25,
    workspace_dir: join(dir, "workspace"),
    title_api_url: "off",
    cors_origins: [],
  };
}

function catalogWithOneModel() {
  const catalog = default_catalog();
  catalog.connections = [
    {
      id: CONNECTION_ID,
      provider: "kilo",
      name: "Kilo Gateway",
      base_url: "https://api.kilo.ai/api/gateway",
      api_key: "key-from-connection",
      api_format: "auto",
    },
  ];
  catalog.services.llm.profiles = [
    {
      id: PROFILE_ID,
      name: "Kilo Gateway",
      binding: "kilo",
      base_url: "",
      api_key: "",
      provider_ref: { connection_id: CONNECTION_ID, binding: "kilo" },
      models: [
        {
          id: MODEL_ID,
          model: "reflection/beam-free",
          name: "reflection/beam-free",
          provider_ref: { connection_id: CONNECTION_ID, binding: "kilo" },
        },
      ],
    },
  ];
  return catalog;
}

describe("turn model resolution without an explicit selection", () => {
  let dir: string;
  let settings: Settings;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "praxis-provider-"));
    settings = testSettings(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the first configured model when none was picked", () => {
    save_catalog(settings, catalogWithOneModel());
    expect(get_selection(settings)).toBeNull();

    expect(active_selection(settings)).toMatchObject({
      profile_id: PROFILE_ID,
      model_id: MODEL_ID,
    });

    const resolved = resolve_runtime_model(settings, {});
    expect(resolved.model).toBe("reflection/beam-free");
    expect(resolved.provider).toBe("kilo");
    expect(resolved.base_url).toBe("https://api.kilo.ai/api/gateway");
    expect(resolved.api_key).toBe("key-from-connection");
    expect(resolved.source).toBe(`profile:${PROFILE_ID}`);
  });

  it("treats an explicit null selection from a client the same as no selection", () => {
    save_catalog(settings, catalogWithOneModel());
    const resolved = resolve_runtime_model(settings, { llm_selection: null });
    expect(resolved.model).toBe("reflection/beam-free");
  });

  it("prefers a saved selection over the first configured model", () => {
    const catalog = catalogWithOneModel();
    catalog.services.llm.profiles[0].models.push({
      id: "model-second",
      model: "openai/gpt-6.2",
      provider_ref: { connection_id: CONNECTION_ID, binding: "kilo" },
    });
    save_catalog(settings, catalog);
    set_selection(settings, { profile_id: PROFILE_ID, model_id: "model-second" });

    const resolved = resolve_runtime_model(settings, {});
    expect(resolved.model).toBe("openai/gpt-6.2");
  });

  it("keeps an explicit command selection ahead of the fallback", () => {
    save_catalog(settings, catalogWithOneModel());
    const resolved = resolve_runtime_model(settings, {
      llm_selection: { profile_id: "kilo", model_id: "kilo-auto/free" },
    });
    expect(resolved.model).toBe("kilo-auto/free");
    expect(resolved.source).toBe("preset:kilo");
  });

  it("still reports no model when nothing is configured", () => {
    save_catalog(settings, default_catalog());
    expect(active_selection(settings)).toBeNull();
    expect(resolve_runtime_model(settings, {}).model).toBe("");
  });
});
