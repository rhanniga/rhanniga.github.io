// @ts-check
/**
 * The tokenizer must agree with HuggingFace EXACTLY.
 *
 * There is no tolerance to trade against here, unlike everywhere else in the engine
 * where fp32 rounding buys some slack. One wrong merge rule shifts every subsequent
 * token, the model reads a different prompt from the one intended, and the symptom
 * is "answers seem a bit worse" -- which is close to undiagnosable from the outside.
 *
 * Fixtures come from tools/make_fixtures.py, which runs HuggingFace's own tokenizer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadTokenizer,
  encode,
  decode,
  streamDecoder,
} from "../site/js/llm/tokenizer.js";

const tok = loadTokenizer(
  readFileSync(new URL("../site/data/tokenizer.bin", import.meta.url)),
);
const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/tokenizer-cases.json", import.meta.url), "utf8"),
);

/** @param {string} s */
const show = (s) => (s.length > 48 ? JSON.stringify(s.slice(0, 48)) + "..." : JSON.stringify(s));

/**
 * Does this text contain a byte with no vocabulary entry?
 *
 * Such bytes are dropped -- by HuggingFace as well as here -- so those cases cannot
 * round-trip and must be excluded explicitly. Computed from the byte table rather
 * than pattern-matched out of a failure message, so a genuine new failure cannot
 * hide behind the exclusion.
 * @param {string} text
 */
function hasUnrepresentableByte(text) {
  for (const b of new TextEncoder().encode(text)) {
    if (tok.byteIds[b] === 0xffff) return true;
  }
  return false;
}

test("the binary parses into a complete vocabulary", () => {
  assert.equal(tok.nVocab, 49152);
  assert.equal(tok.merges.size, 48900);
  assert.equal(tok.specials.length, 17);
  // Every id must have been reconstructed. A gap here means the derive-from-merges
  // scheme is broken, and decode would silently emit nothing for those tokens.
  let missing = 0;
  for (let i = 0; i < tok.nVocab; i++) {
    if (tok.vocab[i] === undefined) missing++;
  }
  assert.equal(missing, 0, `${missing} vocabulary entries were not reconstructed`);
});

test("the special tokens are ids 0..16 with the expected text", () => {
  assert.equal(tok.specials[0]?.text, "<|endoftext|>");
  assert.equal(tok.specials[1]?.text, "<|im_start|>");
  assert.equal(tok.specials[2]?.text, "<|im_end|>");
  tok.specials.forEach((s, i) => assert.equal(s.id, i));
});

test("21 byte values have no token, matching the vocabulary", () => {
  // Vanilla GPT-2 has all 256. This one does not, and HuggingFace silently drops
  // the missing ones rather than substituting anything.
  const absent = [];
  for (let b = 0; b < 256; b++) {
    if (tok.byteIds[b] === 0xffff) absent.push(b);
  }
  assert.deepEqual(absent, [4, 6, 19, 20, 22, 29, 192, 193, 241, 242, 245, 246,
                            247, 248, 249, 250, 251, 252, 253, 254, 255]);
});

test(`encodes all ${fixtures.count} fixtures identically to HuggingFace`, () => {
  /** @type {string[]} */
  const failures = [];
  for (const { text, ids } of fixtures.cases) {
    const got = encode(tok, text);
    if (got.length !== ids.length || got.some((v, i) => v !== ids[i])) {
      failures.push(
        `  ${show(text)}\n    want ${JSON.stringify(ids)}\n    got  ${JSON.stringify(got)}`,
      );
    }
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length}/${fixtures.count} mismatches:\n${failures.slice(0, 12).join("\n")}`,
  );
});

test("decode(encode(s)) round-trips every fixture", () => {
  /** @type {string[]} */
  const failures = [];
  let skipped = 0;
  for (const { text } of fixtures.cases) {
    if (hasUnrepresentableByte(text)) {
      skipped++;
      continue;
    }
    const round = decode(tok, encode(tok, text));
    if (round !== text) failures.push(`  ${show(text)} -> ${show(round)}`);
  }
  assert.ok(skipped > 0, "the dropped-byte cases should be present and excluded");
  assert.equal(
    failures.length,
    0,
    `${failures.length} round-trip failures (${skipped} excluded as undecodable ` +
      `by design):\n${failures.slice(0, 10).join("\n")}`,
  );
});

test("decoding HuggingFace's ids gives back the original text", () => {
  // The other direction: not just self-consistent, but consistent with the
  // reference's own token ids.
  for (const { text, ids } of fixtures.cases) {
    if (hasUnrepresentableByte(text)) continue;
    assert.equal(decode(tok, ids), text, `decode mismatch for ${show(text)}`);
  }
});

test("a leading byte-order mark survives decoding", () => {
  // TextDecoder strips a leading U+FEFF unless ignoreBOM is set, so this decoded to
  // the empty string while encoding perfectly correctly -- bytes right, character
  // silently gone. A tokenizer decoder wants the exact bytes back, not BOM-aware
  // text loading.
  const bom = "\ufeff";
  assert.deepEqual(encode(tok, bom), [186, 136, 140]);
  assert.equal(decode(tok, encode(tok, bom)), bom);
  assert.equal(decode(tok, encode(tok, bom + "hi")), bom + "hi");

  const stream = streamDecoder(tok);
  let out = "";
  for (const id of encode(tok, bom + "hi")) out += stream.push(id);
  out += stream.flush();
  assert.equal(out, bom + "hi", "the streaming decoder must not eat it either");
});

test("digits are split individually, not merged", () => {
  // The single most damaging thing to get wrong: without the Digits pre-tokenizer,
  // "2023" is one token and every date in the prompt shifts.
  const ids = encode(tok, "2023");
  assert.equal(ids.length, 4, `expected 4 ids for "2023", got ${JSON.stringify(ids)}`);
  assert.equal(encode(tok, "1234567890").length, 10);
  // And they are the same ids regardless of surrounding context.
  const a = encode(tok, "2023");
  const b = encode(tok, "x2023").slice(1);
  assert.deepEqual(a, b);
});

test("special tokens encode to their single id, never to their characters", () => {
  assert.deepEqual(encode(tok, "<|im_start|>"), [1]);
  assert.deepEqual(encode(tok, "<|im_end|>"), [2]);
  assert.deepEqual(encode(tok, "<|endoftext|>"), [0]);
  // Embedded, with real text either side.
  const ids = encode(tok, "a<|im_end|>b");
  assert.ok(ids.includes(2));
  assert.ok(ids.length < 8, `should not have expanded the special: ${JSON.stringify(ids)}`);
});

test("something that merely looks like a special token does not become one", () => {
  const ids = encode(tok, "<|not_real|>");
  assert.ok(ids.length > 3, "should tokenize as ordinary characters");
  for (const id of ids) assert.ok(id > 16, `id ${id} is a special token`);
});

test("the real system prompt encodes exactly", () => {
  // The case that actually matters on every question.
  const promptCase = fixtures.cases.find(
    (/** @type {{text: string}} */ c) => c.text.includes("FACTS:") && c.text.length > 1000,
  );
  assert.notEqual(promptCase, undefined, "the system prompt should be a fixture");
  assert.deepEqual(encode(tok, promptCase.text), promptCase.ids);
});

test("the streaming decoder never splits a multi-byte character", () => {
  // A token's bytes can end partway through a UTF-8 sequence. Decoding tokens one
  // at a time without a streaming decoder emits replacement characters exactly
  // where a multi-byte character straddles a token boundary -- and the AskEngine
  // contract requires deltas never to do that.
  for (const text of ["café", "日本語", "🎉🎉", "a🎉b", "Zürich", "👨‍👩‍👧", "мир"]) {
    const ids = encode(tok, text);
    const stream = streamDecoder(tok);
    let out = "";
    for (const id of ids) out += stream.push(id);
    out += stream.flush();
    assert.equal(out, text, `streamed ${show(text)} came back as ${show(out)}`);
    assert.ok(!out.includes("�"), `replacement character in ${show(out)}`);
  }
});

test("streaming and bulk decoding agree on every fixture", () => {
  for (const { ids } of fixtures.cases) {
    const stream = streamDecoder(tok);
    let streamed = "";
    for (const id of ids) streamed += stream.push(id);
    streamed += stream.flush();
    assert.equal(streamed, decode(tok, ids));
  }
});

test("a lone token that is half a character still decodes correctly in sequence", () => {
  // Constructed directly: find a case where the first token's bytes are an
  // incomplete UTF-8 sequence, and confirm the stream holds them.
  const ids = encode(tok, "🎉");
  assert.ok(ids.length >= 1);
  const stream = streamDecoder(tok);
  const first = stream.push(/** @type {number} */ (ids[0]));
  // Either the first token completed a character or the decoder held the bytes --
  // what it must NOT do is emit a replacement character.
  assert.ok(!first.includes("�"), `emitted U+FFFD early: ${JSON.stringify(first)}`);
});

test("empty input yields no tokens", () => {
  assert.deepEqual(encode(tok, ""), []);
  assert.equal(decode(tok, []), "");
});

test("encoding is deterministic", () => {
  const text = "Ryan got his PhD at the University of Texas at Austin in 2023.";
  assert.deepEqual(encode(tok, text), encode(tok, text));
});
