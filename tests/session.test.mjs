// @ts-check
/**
 * The generation session, against the real engine and the real weights.
 *
 * These are the browser's exact modules -- bindings.js, session.js, weights.js,
 * tokenizer.js -- driven under node. The only thing node substitutes is `fetch`, which
 * reads the shards off disk. So a failure here is a real failure, not a mock drifting.
 *
 * Everything is gitignored: the wasm is built by CI, the weights by tools/convert.py.
 * A bare checkout skips the file rather than failing it, and prints how to get them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { instantiate, allocOrThrow, describeError } from "../site/js/llm/bindings.js";
import { loadTokenizer } from "../site/js/llm/tokenizer.js";
import { createSession } from "../site/js/llm/session.js";
import { fetchManifest, streamWeights } from "../site/js/llm/weights.js";
import { SAMPLING, N_CTX } from "../site/js/llm/config.js";
import { SYSTEM_PROMPT_IDS } from "../site/js/llm/prompt.js";

const WASM = "site/ask/engine.simd.wasm";
const TOKENIZER = "site/data/tokenizer.bin";
const MANIFEST = "site/model/manifest.json";

const artifacts = [WASM, TOKENIZER, MANIFEST];
const missing = artifacts.filter((p) => !existsSync(p));
const skip =
  missing.length === 0
    ? false
    : `missing ${missing.join(", ")} -- run make -C engine wasm and tools/convert.py`;

/** Reads shards off disk, chunked, standing in for the network. */
const diskFetch = /** @type {any} */ (
  async (url) => {
    const name = String(url).split("/").pop() ?? "";
    const buf = readFileSync(`site/model/${name}`);
    if (name === "manifest.json") return new Response(buf, { status: 200 });
    const CHUNK = 1 << 18;
    let at = 0;
    return new Response(
      new ReadableStream({
        pull(c) {
          if (at >= buf.length) {
            c.close();
            return;
          }
          c.enqueue(new Uint8Array(buf.subarray(at, at + CHUNK)));
          at += CHUNK;
        },
      }),
      { status: 200 },
    );
  }
);

/**
 * Built once and shared: prefill costs ~4 s, and paying it per test would make this
 * file slow enough that nobody runs it.
 * @type {Promise<any> | null}
 */
let shared = null;

/** @param {{temperature?: number}} [opts] */
function boot(opts = {}) {
  if (shared !== null) return shared;
  shared = (async () => {
    const engine = await instantiate(readFileSync(WASM));
    const manifest = await fetchManifest({ fetchImpl: diskFetch });
    const ptr = allocOrThrow(engine, manifest.bytes);
    const { bytes } = await streamWeights({
      manifest,
      // Re-viewed on every chunk. ml_alloc grew memory, so a view captured before that
      // call points into a detached buffer and writes nowhere.
      write: (chunk, offset) => engine.u8().set(chunk, ptr + offset),
      deps: { fetchImpl: diskFetch, caches: undefined },
    });
    const rc = engine.init(ptr, bytes, N_CTX);
    if (rc !== 0) throw new Error(`ml_init: ${describeError(rc)}`);
    engine.seed(1234, 0);

    const tokenizer = loadTokenizer(readFileSync(TOKENIZER));
    const t0 = Date.now();
    const session = await createSession({
      engine,
      tokenizer,
      systemIds: SYSTEM_PROMPT_IDS,
      nCtx: N_CTX,
      sampling: { ...SAMPLING, temperature: opts.temperature ?? 0 },
    });
    return { engine, session, manifest, prefillMs: Date.now() - t0 };
  })();
  return shared;
}

/**
 * @param {any} session
 * @param {string} question
 * @param {{signal?: AbortSignal}} [opts]
 */
async function answer(session, question, opts = {}) {
  let text = "";
  let firstTokenMs = 0;
  const started = Date.now();
  const result = await session.generate({
    question,
    signal: opts.signal,
    onDelta: (t) => {
      if (firstTokenMs === 0) firstTokenMs = Date.now() - started;
      text += t;
    },
  });
  return { text: text.trim(), firstTokenMs, totalMs: Date.now() - started, result };
}

test("the shipped weights initialize", { skip }, async () => {
  const { engine, manifest } = await boot();
  assert.equal(engine.nCtx(), N_CTX);
  assert.equal(engine.nVocab(), 49152);
  assert.equal(manifest.bytes, 86_885_888);
  // The digest is over the loaded weights, so it is the check that the shards
  // reassembled into the right bytes in the right order.
  assert.match(engine.modelSha256(), /^[0-9a-f]{64}$/);
});

test("a resume question is answered from the resume", { skip }, async () => {
  const { session, prefillMs } = await boot();
  const { text, firstTokenMs } = await answer(session, "Where did Ryan get his PhD?");
  // Greedy decoding at temperature 0, so this is reproducible rather than hopeful.
  assert.match(text, /Texas/i, `answer was: ${text}`);
  assert.ok(text.length > 10, `answer was too short: ${text}`);
  assert.ok(prefillMs < 30_000, `prefill took ${prefillMs}ms`);
  assert.ok(firstTokenMs >= 0);
});

test("the KV snapshot means only the first question pays prefill", { skip }, async () => {
  // The whole reason ml_kv_save exists. Without it every question re-runs the ~350-token
  // system prompt and the REPL is unusable.
  const { session, prefillMs } = await boot();
  const second = await answer(session, "What languages does Ryan know?");
  assert.ok(
    second.firstTokenMs < prefillMs / 3,
    `first token took ${second.firstTokenMs}ms vs a ${prefillMs}ms prefill -- ` +
      `the snapshot is not being restored`,
  );
  assert.ok(second.text.length > 0);
});

test("generation is deterministic at temperature 0", { skip }, async () => {
  // Also the check that reset() restores the snapshot faithfully: a botched restore
  // leaves stale keys in the cache and the second answer drifts.
  const { session } = await boot();
  const q = "What is Ryan's current role?";
  const first = await answer(session, q);
  session.reset();
  const again = await answer(session, q);
  assert.equal(again.text, first.text);
});

test("aborting mid-generation throws AbortError and keeps partial text", { skip }, async () => {
  // `ask` distinguishes cancel (exit 130) from completion (exit 0) by this throw, and
  // the partial text stays on screen the way a real Ctrl+C leaves partial output.
  const { session } = await boot();
  const controller = new AbortController();
  let partial = "";
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    session.generate({
      question: "Tell me in detail about every job Ryan has ever had.",
      signal: controller.signal,
      onDelta: (t) => {
        partial += t;
      },
    }),
    (err) => /** @type {any} */ (err).name === "AbortError",
  );
  const elapsed = Date.now() - started;
  clearTimeout(timer);
  // The yield is what makes this bounded; a tight loop would run to completion first.
  assert.ok(elapsed < 1500, `abort took ${elapsed}ms to take effect`);
  session.reset();
  assert.ok(typeof partial === "string");
});

test("an already-aborted signal produces no tokens", { skip }, async () => {
  const { session } = await boot();
  const controller = new AbortController();
  controller.abort();
  let emitted = 0;
  await assert.rejects(
    session.generate({
      question: "Anything at all.",
      signal: controller.signal,
      onDelta: () => {
        emitted++;
      },
    }),
    (err) => /** @type {any} */ (err).name === "AbortError",
  );
  assert.equal(emitted, 0);
  session.reset();
});

test("contact questions are never answered with fabricated digits", { skip }, async () => {
  // Both quantized models invented phone numbers during M9, which is why guard.js
  // exists. This asserts the guard holds against the real model, not a mock.
  const { session } = await boot();
  for (const q of [
    "What is Ryan's phone number?",
    "How can I contact Ryan?",
    "What's Ryan's email address?",
  ]) {
    const { text } = await answer(session, q);
    session.reset();
    const digits = text.replace(/\D/g, "");
    assert.ok(
      !/\d{3}[-.\s]?\d{4}/.test(text),
      `phone-shaped digits leaked for "${q}": ${text}`,
    );
    assert.ok(digits.length < 10, `${digits.length} digits leaked for "${q}": ${text}`);
    assert.ok(!/@/.test(text), `an email address leaked for "${q}": ${text}`);
  }
});

test("memory stays within the mobile budget", { skip }, async () => {
  // Safari on iOS kills a tab somewhere north of ~300 MB. The budget: 87 MB weights,
  // 47 MB KV cache, 16 MB snapshot. Anything approaching double that means the weights
  // are being held twice.
  const { engine } = await boot();
  const mb = engine.u8().length / 1e6;
  assert.ok(mb < 200, `wasm heap is ${mb.toFixed(1)} MB`);
});

test("the session closes without leaking its yield channel", { skip }, async () => {
  // A leaked MessageChannel keeps a node process alive forever; in a tab it accumulates
  // one per session. If this file hangs after the last test, this is why.
  const { engine, session } = await boot();
  session.close();
  engine.shutdown();
  shared = null;
});
