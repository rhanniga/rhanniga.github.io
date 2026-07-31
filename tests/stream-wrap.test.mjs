// @ts-check
/**
 * Incremental wrapping for streamed tokens.
 *
 * The property that matters: a break, once made, is never revisited. Re-wrapping
 * the whole buffer per token would make already-visible text reflow as the answer
 * grows, which looks broken.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { streamWrapper } from "../site/js/render/stream-wrap.js";

/**
 * Feed pieces through a wrapper and return the emitted lines.
 * @param {string[]} pieces
 * @param {{width: number, indent?: number}} opts
 */
function run(pieces, opts) {
  let out = "";
  const w = streamWrapper((s) => {
    out += s;
  }, opts);
  for (const p of pieces) w.push(p);
  w.end();
  return out.replace(/\n$/, "").split("\n");
}

test("short text stays on one line", () => {
  assert.deepEqual(run(["hello ", "world"], { width: 40 }), ["hello world"]);
});

test("wraps at the width", () => {
  assert.deepEqual(run(["aaa ", "bbb ", "ccc ", "ddd"], { width: 7 }), ["aaa bbb", "ccc ddd"]);
});

test("applies an indent to every line, including continuations", () => {
  // Asserted as a property rather than against hand-computed break points, which
  // is what the first version of this test got wrong.
  const lines = run("aaaa bbbb cccc dddd eeee".split(" ").map((w) => w + " "), {
    width: 14,
    indent: 2,
  });
  assert.ok(lines.length > 1, `expected wrapping, got ${JSON.stringify(lines)}`);
  for (const line of lines) {
    assert.match(line, /^ {2}\S/, `line should start with exactly the indent: ${JSON.stringify(line)}`);
  }
});

test("no emitted line exceeds the width", () => {
  const words = "the quick brown fox jumps over the lazy dog and keeps going".split(" ");
  for (const width of [20, 24, 30, 40, 76]) {
    for (const line of run(words.map((w) => w + " "), { width, indent: 2 })) {
      assert.ok(line.length <= width, `width ${width}: got ${line.length} (${line})`);
    }
  }
});

test("a word split across deltas is not broken", () => {
  // A token can end mid-word. Wrapping on a partial word would split it, so words
  // are held until whitespace confirms them.
  assert.deepEqual(run(["infra", "struct", "ure ", "here"], { width: 40 }), [
    "infrastructure here",
  ]);
});

test("a word arriving one character at a time still wraps as a unit", () => {
  const pieces = [..."aaa bbbbbbb ccc"].map((ch) => ch);
  const lines = run(pieces, { width: 8 });
  for (const l of lines) assert.ok(l.length <= 8, l);
  assert.equal(lines.join(" ").replace(/\s+/g, " "), "aaa bbbbbbb ccc");
});

test("output is identical however the text is chunked", () => {
  // The invariant that makes streaming safe: chunk boundaries must not affect
  // layout, only timing.
  const text = "Ryan earned a doctorate in Particle Physics from the University of Texas at Austin.";
  const whole = run([text], { width: 28, indent: 2 });
  const words = run(text.match(/\S+\s*/g) ?? [], { width: 28, indent: 2 });
  const chars = run([...text], { width: 28, indent: 2 });
  assert.deepEqual(words, whole);
  assert.deepEqual(chars, whole);
});

test("end() flushes a trailing partial word", () => {
  assert.deepEqual(run(["abc ", "de"], { width: 40 }), ["abc de"]);
});

test("nothing is emitted for empty input", () => {
  let out = "";
  const w = streamWrapper((s) => { out += s; }, { width: 40 });
  w.end();
  assert.equal(out, "");
});

test("whitespace-only input emits nothing", () => {
  let out = "";
  const w = streamWrapper((s) => { out += s; }, { width: 40 });
  w.push("   \n  ");
  w.end();
  assert.equal(out, "");
});

test("isEmpty reports whether anything has been committed", () => {
  let out = "";
  const w = streamWrapper((s) => { out += s; }, { width: 40 });
  assert.equal(w.isEmpty(), true);
  w.push("x");
  assert.equal(w.isEmpty(), false, "a pending partial word counts");
});

test("a word longer than the width is not silently dropped", () => {
  const lines = run(["short ", "a".repeat(30), " end"], { width: 10 });
  assert.ok(lines.join("").includes("a".repeat(30)), "the long word must survive");
});

test("an absurdly narrow width still produces usable output", () => {
  // The floor keeps the wrapper from thrashing at width 1.
  const lines = run(["aa ", "bb ", "cc"], { width: 1 });
  assert.ok(lines.length >= 1);
  assert.ok(lines.join(" ").includes("aa"));
});
