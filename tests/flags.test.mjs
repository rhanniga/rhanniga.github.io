// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { parseFlags, invalidOptionMessage } from "../site/js/shell/flags.js";

/** The spec `ask` uses. */
const ASK = { bools: { interactive: ["i", "interactive"], offline: ["offline"] } };

/** @param {string[]} argv */
function parse(argv) {
  const r = parseFlags(argv, ASK);
  assert.equal(r.ok, true, `expected ${argv.join(" ")} to parse`);
  return r.ok ? r : { flags: {}, operands: [] };
}

test("recognises long and short forms", () => {
  assert.equal(parse(["ask", "-i"]).flags["interactive"], true);
  assert.equal(parse(["ask", "--interactive"]).flags["interactive"], true);
  assert.equal(parse(["ask", "--offline"]).flags["offline"], true);
});

test("unset flags are false, not undefined", () => {
  const r = parse(["ask", "hello"]);
  assert.equal(r.flags["interactive"], false);
  assert.equal(r.flags["offline"], false);
});

test("collects operands in order", () => {
  const r = parse(["ask", "what", "is", "this"]);
  assert.deepEqual(r.operands, ["what", "is", "this"]);
});

test("flags and operands can interleave", () => {
  const r = parse(["ask", "question", "-i"]);
  assert.equal(r.flags["interactive"], true);
  assert.deepEqual(r.operands, ["question"]);
});

test("clustered short flags", () => {
  const r = parse(["ask", "-i"]);
  assert.equal(r.flags["interactive"], true);
  const spec = { bools: { a: ["a"], b: ["b"], c: ["c"] } };
  const clustered = parseFlags(["x", "-abc"], spec);
  assert.equal(clustered.ok, true);
  if (clustered.ok) {
    assert.equal(clustered.flags["a"], true);
    assert.equal(clustered.flags["b"], true);
    assert.equal(clustered.flags["c"], true);
  }
});

test("-- ends flag parsing", () => {
  // So `ask -- -i` asks about the literal text "-i".
  const r = parse(["ask", "--", "-i", "--offline"]);
  assert.equal(r.flags["interactive"], false);
  assert.equal(r.flags["offline"], false);
  assert.deepEqual(r.operands, ["-i", "--offline"]);
});

test("a lone dash is an operand, not a flag", () => {
  const r = parse(["ask", "-"]);
  assert.deepEqual(r.operands, ["-"]);
});

test("an empty argument survives as an operand", () => {
  // Paired with the tokenizer's handling of `ask ""`, so the command can report a
  // usage error rather than the argument vanishing.
  const r = parse(["ask", ""]);
  assert.deepEqual(r.operands, [""]);
});

test("unknown flags are rejected, naming the offender", () => {
  const short = parseFlags(["ask", "-z"], ASK);
  assert.equal(short.ok, false);
  if (!short.ok) assert.equal(short.badFlag, "z");

  const long = parseFlags(["ask", "--nope"], ASK);
  assert.equal(long.ok, false);
  if (!long.ok) assert.equal(long.badFlag, "--nope");
});

test("an unknown flag inside a cluster is rejected", () => {
  const r = parseFlags(["ask", "-iz"], ASK);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.badFlag, "z");
});

test("the error message matches getopt_long's shape", () => {
  assert.equal(invalidOptionMessage("ask", "z"), "ask: invalid option -- 'z'");
  assert.equal(invalidOptionMessage("ask", "--nope"), "ask: invalid option -- --nope");
});
