import test from "node:test";
import assert from "node:assert/strict";

import {
  isSupportedKnowledgeEngine,
  knowledgeEngineGroup,
} from "../lib/knowledge-engine-group";

test("knowledge engines: built-in providers stay in their expected deployment group", () => {
  assert.equal(knowledgeEngineGroup({ id: "llamaindex" }), "local");
  assert.equal(knowledgeEngineGroup({ id: "ima" }), "cloud");
});

test("retired engine ids are not offered as supported engines", () => {
  for (const id of [
    "graphrag",
    "lightrag",
    "lightrag-server",
    "pageindex",
    "pageindex-oss",
    "weknora",
    "kiwix",
  ]) {
    assert.equal(isSupportedKnowledgeEngine(id), false, id);
  }
  assert.equal(isSupportedKnowledgeEngine("llamaindex"), true);
  assert.equal(isSupportedKnowledgeEngine("ima"), true);
});

test("knowledge engines: unknown providers fall back to their credential requirement", () => {
  assert.equal(
    knowledgeEngineGroup({ id: "future-hosted", requires_api_key: true }),
    "cloud",
  );
  assert.equal(knowledgeEngineGroup({ id: "future-local" }), "local");
});
