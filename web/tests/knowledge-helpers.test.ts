import test from "node:test";
import assert from "node:assert/strict";

import {
  getFileExtension,
  isMarginNoteKb,
  kbCanReindex,
  kbDetailSections,
  kbProvider,
  resolveKnowledgeIndexFailure,
  taskFailureMessage,
  validateFiles,
  providerConnectionStatus,
  type KnowledgeBase,
} from "../lib/knowledge-helpers";

test("knowledge upload extension matching supports compound Docling suffixes", () => {
  const allowed = [".gz", ".tar.gz", ".xml", ".dclg.xml"];
  assert.equal(getFileExtension("BOOK.TAR.GZ", allowed), ".tar.gz");
  assert.equal(getFileExtension("document.DCLG.XML", allowed), ".dclg.xml");
  assert.equal(getFileExtension("plain.XML", allowed), ".xml");
});

test("unbounded parser policy delegates unknown extensions", () => {
  const custom = new File(["payload"], "document.vendor-format");
  const result = validateFiles(
    [custom],
    {
      extensions: [],
      accept: "",
      max_file_size_bytes: 100,
      allow_any_extension: true,
    },
  );

  assert.deepEqual(result.validFiles, [custom]);
  assert.equal(result.invalidFiles.length, 0);
});

function kb(overrides: Partial<KnowledgeBase>): KnowledgeBase {
  return {
    name: "kb",
    status: "ready",
    statistics: { raw_documents: 1 },
    ...overrides,
  };
}

test("kbCanReindex allows failed knowledge bases with source files", () => {
  assert.equal(
    kbCanReindex(
      kb({
        status: "error",
        statistics: { raw_documents: 1, active_match: true },
      }),
    ),
    true,
  );
});

test("kbCanReindex keeps empty failed knowledge bases disabled", () => {
  assert.equal(
    kbCanReindex(
      kb({
        status: "error",
        statistics: { raw_documents: 0, active_match: false },
      }),
    ),
    false,
  );
});

test("kbCanReindex supports recovery and changing a healthy KB's model", () => {
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, needs_reindex: true } })),
    true,
  );
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, active_match: false } })),
    true,
  );
  assert.equal(
    kbCanReindex(kb({ statistics: { raw_documents: 1, active_match: true } })),
    true,
  );
});

test("resolveKnowledgeIndexFailure preserves actionable backend metadata", () => {
  assert.deepEqual(
    resolveKnowledgeIndexFailure(
      kb({
        status: "error",
        progress: {
          stage: "error",
          error: "Choose a chat model that supports structured output.",
          error_code: "indexing_model_unavailable",
          retryable: false,
        },
      }),
    ),
    {
      code: "indexing_model_unavailable",
      message: "Choose a chat model that supports structured output.",
      retryable: false,
      requiresModelChange: true,
      settingsHref: "/settings#models",
    },
  );
});

test("resolveKnowledgeIndexFailure distinguishes configuration from transient failures", () => {
  const authentication = resolveKnowledgeIndexFailure(
    kb({
      status: "error",
      progress: {
        stage: "error",
        error_code: "reindex_required",
        retryable: false,
      },
    }),
  );
  const rateLimit = resolveKnowledgeIndexFailure(
    kb({
      status: "error",
      progress: {
        stage: "error",
        error_code: "rate_limit_exceeded",
        retryable: true,
      },
    }),
  );

  assert.equal(authentication?.requiresModelChange, true);
  assert.equal(authentication?.settingsHref, "/settings#models");
  assert.equal(rateLimit?.requiresModelChange, false);
  assert.equal(rateLimit?.settingsHref, undefined);
  assert.equal(rateLimit?.retryable, true);
});

test("taskFailureMessage keeps trace details out of the primary error", () => {
  assert.equal(
    taskFailureMessage({
      detail: "Index preflight failed.",
      details: "Traceback: sensitive internal diagnostics",
    }),
    "Index preflight failed.",
  );
});

test("engine status follows the credential and install state", () => {
  // IMA holds one account credential pair for all of its knowledge bases.
  assert.equal(
    providerConnectionStatus({
      id: "ima",
      configured: false,
      requires_api_key: true,
    }),
    "needs_key",
  );
  assert.equal(
    providerConnectionStatus({
      id: "ima",
      configured: true,
      requires_api_key: true,
    }),
    "ready",
  );
  assert.equal(
    providerConnectionStatus({ id: "llamaindex", configured: true }),
    "ready",
  );
  assert.equal(
    providerConnectionStatus({
      id: "future-engine",
      configured: false,
      requires_api_key: true,
    }),
    "needs_key",
  );
  assert.equal(
    providerConnectionStatus({ id: "future-engine", configured: false }),
    "unavailable",
  );
  assert.equal(
    providerConnectionStatus({
      id: "future-engine",
      configured: true,
      setup_required: true,
    }),
    "needs_setup",
  );
});

test("a MarginNote library shows devices instead of files and index versions", () => {
  // It owns no raw documents and builds no index, so those three sections
  // would render empty against it; what it does have is the devices that
  // push objects into it.
  const marginNote: KnowledgeBase = {
    name: "MN4",
    metadata: { type: "marginnote4", db_path: "/data/mn4/MN4.db" },
  };
  assert.deepEqual(kbDetailSections(marginNote), ["devices", "settings"]);
  assert.equal(isMarginNoteKb(marginNote), true);
  assert.equal(kbProvider(marginNote), "marginnote4");
});

test("an ordinary knowledge base has no devices section", () => {
  const indexed: KnowledgeBase = {
    name: "Papers",
    statistics: { rag_provider: "llamaindex" },
  };
  assert.deepEqual(kbDetailSections(indexed), [
    "files",
    "add",
    "folders",
    "github",
    "web",
    "versions",
    "settings",
  ]);
  assert.equal(isMarginNoteKb(indexed), false);
});

test("connected knowledge bases do not expose local source-folder controls", () => {
  assert.deepEqual(
    kbDetailSections({
      name: "Obsidian",
      metadata: { type: "obsidian", vault_path: "/notes" },
    }),
    ["files", "add", "github", "web", "versions", "settings"],
  );
});
