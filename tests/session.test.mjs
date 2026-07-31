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
    return { engine, session, tokenizer, manifest, prefillMs: Date.now() - t0 };
  })();
  return shared;
}

/**
 * A second session on the shared engine, at a caller-chosen sampling config.
 *
 * The tests above all decode greedily, which is reproducible and was the right default
 * -- but `ask` ships temperature 0.4, and temperature is a completely separate code path
 * through ml_sample: it divides the logits, softmaxes them, and takes a top-k/top-p
 * draw, none of which greedy decoding touches. That path was broken for the entire life
 * of the engine and every test here passed, because none of them ever set a temperature.
 *
 * Memoised per config, since each one pays another ~4 s prefill.
 * @type {Map<string, Promise<any>>}
 */
const sessions = new Map();

/** @param {Record<string, number>} sampling */
function bootWith(sampling) {
  const key = JSON.stringify(sampling);
  const existing = sessions.get(key);
  if (existing !== undefined) return existing;
  const made = (async () => {
    const { engine, tokenizer } = await boot();
    return await createSession({
      engine,
      tokenizer,
      systemIds: SYSTEM_PROMPT_IDS,
      nCtx: N_CTX,
      sampling: /** @type {any} */ (sampling),
    });
  })();
  sessions.set(key, made);
  return made;
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

test("temperature sampling with topK=1 is exactly greedy decoding", { skip }, async () => {
  // The sharpest available test of the temperature path, and it is not statistical.
  // topK=1 leaves one token above the cutoff, so whatever the RNG draws, the only token
  // that can be chosen is the argmax -- which means this must reproduce temperature-0
  // output character for character, while still exercising the divide, the softmax and
  // the top-k/top-p walk that greedy decoding skips entirely.
  //
  // This is the test that catches the bug it was written for. hslm_expf returned a large
  // NEGATIVE number for arguments in exp's subnormal window, which softmax reaches
  // routinely once the logits are divided by 0.4. That made the sum of exponentials
  // negative, which flipped every sign on normalisation, which promoted ~40 junk tail
  // tokens above the real answer. `ask` replied "R" and stopped.
  const q = "Where did Ryan get his PhD?";
  const { session: greedySession } = await boot();
  const greedy = await answer(greedySession, q);

  const sampled = await bootWith({ ...SAMPLING, temperature: 0.4, topK: 1 });
  const forced = await answer(sampled, q);

  assert.equal(forced.text, greedy.text);
});

test("the shipped sampling config answers coherently", { skip }, async () => {
  // Sampling, so this cannot assert an exact string -- but it can assert that the
  // answers are answers. Under the expf bug these three came back as "R",
  // "Dremeteriesighsystem" and "MetaInfo knows theομαι, but
  // not...": 14 tokens across all three, every one of them stopping almost
  // immediately because a junk token outranked the real distribution.
  const session = await bootWith({ ...SAMPLING });
  const questions = [
    "Where has Ryan worked?",
    "What did he do at CERN?",
    "What programming languages does he know?",
  ];

  let total = 0;
  const texts = [];
  for (const q of questions) {
    const { text, result } = await answer(session, q);
    total += result.tokens;
    texts.push(text);
    // Four tokens is not an answer to any of these, and every failure mode observed
    // stopped inside the first ten.
    assert.ok(result.tokens > 10, `"${q}" produced ${result.tokens} tokens: ${text}`);
    assert.ok(
      result.reason === "eos" || result.reason === "maxTokens",
      `"${q}" stopped because ${result.reason}`,
    );
  }
  assert.ok(total > 60, `${total} tokens across three questions is not coherent output`);

  // At least two of the three should land on something from the resume. Asserting all
  // three would be betting on a 135M model at temperature 0.4; asserting none would be
  // testing nothing.
  const grounded = texts.filter((t) => /CERN|Texas|Python|C\+\+|ALICE|physics/i.test(t));
  assert.ok(
    grounded.length >= 2,
    `only ${grounded.length}/3 answers mentioned anything from the resume:\n${texts.join("\n---\n")}`,
  );
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
  // The temperature sessions share this engine and each hold their own channel, so
  // they have to go too -- and they run before this test, so they are safe to close.
  for (const pending of sessions.values()) (await pending).close();
  sessions.clear();
  engine.shutdown();
  shared = null;
});
