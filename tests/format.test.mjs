// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { highlight } from "../site/js/render/format.js";
import { text } from "../site/js/render/chunk.js";

/** The substrings that came back marked as keywords. */
const marked = (/** @type {import('../site/js/render/chunk.js').Line} */ line) =>
  line.filter((ch) => ch.c === "keyword").map((ch) => ch.t);

test("highlighting never alters the text", () => {
  const s = "Developed a C++ suite in Python for the LHC";
  assert.equal(text(highlight(s, ["C++", "Python", "LHC"])), s);
});

test("marks each keyword occurrence", () => {
  const line = highlight("Built with Python and C++", ["Python", "C++"]);
  assert.deepEqual(marked(line), ["Python", "C++"]);
});

test("C++ wins over C — longest match first", () => {
  // Both are real keywords in this resume. Without longest-first sorting the
  // alternation matches "C" and leaves a bare "++" unstyled.
  const line = highlight("Wrote C++ and C for the detector", ["C", "C++"]);
  assert.deepEqual(marked(line), ["C++", "C"]);
  assert.equal(text(line), "Wrote C++ and C for the detector");
});

test("a keyword glued to more letters is not marked", () => {
  // "\bC\+\+\b" can never match, because + is not a word character and so there
  // is no word boundary after it. The boundary check therefore inspects the
  // adjacent characters directly, treating + and # as word-ish.
  assert.deepEqual(marked(highlight("Cargo and Clang", ["C"])), []);
  assert.deepEqual(marked(highlight("Pythonic", ["Python"])), []);
  assert.deepEqual(marked(highlight("C++11 is old", ["C++"])), [], "C++11 is not C++");
});

test("keywords are marked at string boundaries and next to punctuation", () => {
  assert.deepEqual(marked(highlight("C", ["C"])), ["C"]);
  assert.deepEqual(marked(highlight("Python.", ["Python"])), ["Python"]);
  assert.deepEqual(marked(highlight("(Python)", ["Python"])), ["Python"]);
  assert.deepEqual(marked(highlight("Python/FastAPI", ["Python", "FastAPI"])), [
    "Python",
    "FastAPI",
  ]);
});

test("matching is case-insensitive but preserves the original casing", () => {
  const line = highlight("built with python", ["Python"]);
  assert.deepEqual(marked(line), ["python"]);
  assert.equal(text(line), "built with python");
});

test("regex metacharacters in keywords are escaped", () => {
  // "C++" as a raw pattern would mean "one or more C+".
  assert.deepEqual(marked(highlight("C++ code", ["C++"])), ["C++"]);
  assert.deepEqual(marked(highlight("a.b here", ["a.b"])), ["a.b"]);
  assert.deepEqual(marked(highlight("axb here", ["a.b"])), [], ". must be literal");
  assert.deepEqual(marked(highlight("cost is $5", ["$5"])), ["$5"]);
});

test("no keywords means one plain chunk", () => {
  const line = highlight("plain text", []);
  assert.deepEqual(line.map((ch) => ch.c), [undefined]);
  assert.equal(text(line), "plain text");
  assert.equal(text(highlight("plain text", undefined)), "plain text");
});

test("empty and duplicate keywords are ignored", () => {
  assert.deepEqual(marked(highlight("Python here", ["", "Python", "Python"])), ["Python"]);
  assert.equal(text(highlight("Python here", [""])), "Python here");
});

test("empty text yields no chunks", () => {
  assert.deepEqual(highlight("", ["Python"]), []);
});

test("a keyword occurring several times is marked every time", () => {
  assert.deepEqual(marked(highlight("Python, then Python again", ["Python"])), [
    "Python",
    "Python",
  ]);
});

test("real bullet text from resume.json", () => {
  const s =
    "Developed early software infrastructure, including microcrontroller firmware (C++), " +
    "hub control servers and application backends (Python/FastAPI)";
  const keys = ["C++", "Python", "FastAPI", "PyTorch", "TypeScript", "React"];
  const line = highlight(s, keys);
  assert.equal(text(line), s, "text must round-trip exactly");
  assert.deepEqual(marked(line), ["C++", "Python", "FastAPI"]);
});
