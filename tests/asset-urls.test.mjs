// @ts-check
/**
 * Asset URL resolution.
 *
 * These exist because of a bug that made the real engine unreachable while every
 * existing test passed.
 *
 * config.js is imported by both the main thread and ask.worker.js, and it used to
 * spell its asset paths relative: `"./ask/engine.simd.wasm"`, `"./model/"`. A relative
 * `fetch()` resolves against the *document* on the main thread and against the *worker
 * script* inside a worker, so one string meant two different URLs -- and the worker's,
 * `/js/llm/ask/engine.simd.wasm`, does not exist. Worse, the two halves disagreed
 * silently: the HEAD probe in engine.js ran on the main thread, found the manifest, and
 * reported the model deployed; the worker then 404'd on the same path and `ask` fell
 * back to searching the resume.
 *
 * Nothing caught it. weights.js is tested with an injected `fetchImpl`, which resolves
 * nothing, and no test loads config.js from a worker-like base. So what is pinned here
 * is the property that makes the context irrelevant: every asset URL is absolute and
 * anchored to the site root, so there is no base left to get wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  WASM_SIMD_URL,
  WASM_SCALAR_URL,
  TOKENIZER_URL,
  modelBaseUrl,
  setModelBaseUrl,
  shardUrl,
  HF_REPO,
  MODEL_REVISION,
} from "../site/js/llm/config.js";

/** Where this checkout's `site/` directory is, as a URL. */
const SITE_ROOT = new URL("../site/", import.meta.url).href;

test("every asset URL is absolute", () => {
  // A relative URL is the bug. Absolute means the worker and the document resolve it
  // to the same bytes, which is the entire point.
  for (const url of [WASM_SIMD_URL, WASM_SCALAR_URL, TOKENIZER_URL, shardUrl("manifest.json")]) {
    assert.doesNotThrow(() => new URL(url), `${url} should be absolute`);
    assert.ok(!url.startsWith("./"), `${url} should not be document-relative`);
  }
});

test("asset URLs are anchored to the site root, not to js/llm/", () => {
  assert.equal(WASM_SIMD_URL, `${SITE_ROOT}ask/engine.simd.wasm`);
  assert.equal(WASM_SCALAR_URL, `${SITE_ROOT}ask/engine.wasm`);
  assert.equal(TOKENIZER_URL, `${SITE_ROOT}data/tokenizer.bin`);
  assert.equal(shardUrl("manifest.json"), `${SITE_ROOT}model/manifest.json`);

  // The exact shape of the original failure: config.js lives in js/llm/, so a
  // relative path resolved from here rather than from the site root.
  for (const url of [WASM_SIMD_URL, TOKENIZER_URL, shardUrl("manifest.json")]) {
    assert.ok(!url.includes("/js/llm/"), `${url} resolved against the module, not the site`);
  }
});

test("the resolved URLs really are fetchable paths in this checkout", async () => {
  // Belt and braces: the assertions above compare strings, and a string can be
  // beautifully consistent and still point at nothing. `site/ask/` is a build output,
  // so a bare checkout legitimately has no wasm -- the tokenizer is committed and is
  // enough to prove the resolution lands inside site/.
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  assert.ok(
    existsSync(fileURLToPath(TOKENIZER_URL)),
    `${TOKENIZER_URL} should exist -- site/data/tokenizer.bin is committed`,
  );
});

test("the model base can be replaced, which is how the worker inherits ?model=", () => {
  // `location.search` is empty in a worker, so the main thread resolves the override
  // and posts it across. Without this the two would silently load different models.
  const original = modelBaseUrl();
  try {
    setModelBaseUrl("https://example.test/weights/");
    assert.equal(shardUrl("shard-000.bin"), "https://example.test/weights/shard-000.bin");

    // A base with no trailing slash still produces one separator, not two or none.
    setModelBaseUrl("https://example.test/weights");
    assert.equal(shardUrl("shard-000.bin"), "https://example.test/weights/shard-000.bin");

    // An empty string is ignored rather than blanking the base -- a dropped message
    // field should not silently repoint the fetch at the document root.
    setModelBaseUrl("");
    assert.equal(shardUrl("shard-000.bin"), "https://example.test/weights/shard-000.bin");
  } finally {
    setModelBaseUrl(original);
  }
  assert.equal(modelBaseUrl(), original);
});

test("an hf: base expands to a revision-pinned HuggingFace URL", () => {
  const original = modelBaseUrl();
  try {
    setModelBaseUrl("hf:");
    assert.equal(
      shardUrl("shard-000.bin"),
      `https://huggingface.co/${HF_REPO}/resolve/${MODEL_REVISION}/shard-000.bin`,
    );
    setModelBaseUrl("hf:someone/else");
    assert.equal(
      shardUrl("shard-000.bin"),
      `https://huggingface.co/someone/else/resolve/${MODEL_REVISION}/shard-000.bin`,
    );
  } finally {
    setModelBaseUrl(original);
  }
});
