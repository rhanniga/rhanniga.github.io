// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { highlight, formatGrepAnswer } from "../site/js/render/format.js";
import { text } from "../site/js/render/chunk.js";
import { grepAnswer } from "../site/js/llm/fallback.js";

/** Flatten rendered lines back to plain text. */
const render = (/** @type {import('../site/js/render/chunk.js').Line[]} */ lines) =>
  lines.map((l) => text(l)).join("\n");

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

/* ── Grep-mode rendering ──────────────────────────────────────────────────
   The output has to read like the rest of the resume, because it IS the rest of
   the resume. These tests pin the properties that make it look that way. */

test("a grep answer renders the card's title and text", () => {
  const answer = grepAnswer("what did you do at CERN?");
  const rendered = render(formatGrepAnswer(answer, 76));
  assert.match(rendered, /CERN/);
  for (const m of answer.shown) {
    assert.ok(
      rendered.includes(m.card.title),
      `title missing from output: ${m.card.title}`,
    );
  }
});

test("a card whose text repeats its title prints it once", () => {
  // Job and education cards derive their text from their own title. Printing both
  // said the same thing twice, which read like a rendering bug -- and was one.
  const rendered = render(formatGrepAnswer(grepAnswer("tell me about VenHub"), 76));
  const occurrences = rendered.split("Principal Software Engineer").length - 1;
  assert.equal(occurrences, 1, `title appeared ${occurrences} times:\n${rendered}`);
});

test("a bullet card prints its title AND its text", () => {
  // The other side of the previous test: a bullet is not its title, and suppressing
  // it would lose the actual answer.
  const answer = grepAnswer("has he led a team?");
  const rendered = render(formatGrepAnswer(answer, 76));
  assert.match(rendered, /Principal Software Engineer/);
  assert.match(rendered, /team of 8\+/);
});

test("grep output never exceeds the width it was given", () => {
  // The same invariant the resume formatters hold. Checked at an awkward width
  // because that is where wrapping bugs live.
  for (const cols of [40, 60, 76, 100]) {
    for (const q of ["python", "what did you do at CERN?", "what languages does he know"]) {
      for (const line of formatGrepAnswer(grepAnswer(q), cols)) {
        const w = text(line).length;
        assert.ok(w <= cols, `"${q}" at ${cols} cols produced a ${w}-wide line`);
      }
    }
  }
});

test("grep output highlights with the card's keywords, not the query", () => {
  // So the same bullet looks identical however it was found. Searching for "python"
  // must not make Python the only highlighted word in a bullet that also names C++.
  const answer = grepAnswer("does he know react");
  const lines = formatGrepAnswer(answer, 76);
  const keywords = new Set(
    answer.shown.flatMap((m) => m.card.keywords.map((k) => k.toLowerCase())),
  );
  const highlighted = lines
    .flatMap((l) => l.filter((ch) => ch.c === "keyword").map((ch) => ch.t.toLowerCase()))
    .filter((t) => t.trim() !== "");
  assert.ok(highlighted.length > 0, "nothing was highlighted at all");
  for (const h of highlighted) {
    // Matched as a part rather than whole: a two-word keyword like "React Native"
    // is one highlighted run that wrapping may split across two lines, so the
    // pieces arrive separately.
    const belongs = [...keywords].some((k) => k.includes(h) || h.includes(k));
    assert.ok(belongs, `highlighted "${h}", which is not part of any card keyword`);
  }
});

test("no match renders a helpful line rather than nothing", () => {
  // An empty response would look like a hang.
  const rendered = render(formatGrepAnswer(grepAnswer("kubernetes"), 76));
  assert.match(rendered, /nothing in the resume matches/);
  assert.match(rendered, /help/);
});

test("the remaining-matches line is grammatical", () => {
  // "1 more matches" is the kind of thing that survives forever once shipped.
  const many = render(formatGrepAnswer(grepAnswer("python"), 76));
  assert.ok(!/\b1 more matches\b/.test(many), "singular/plural disagreement");
  assert.match(many, /\(\d+ more match(es)? — try /);
});

test("grep output ends with a blank line, like every other section", () => {
  for (const q of ["python", "kubernetes", "what did you do at CERN?"]) {
    const lines = formatGrepAnswer(grepAnswer(q), 76);
    assert.equal(text(lines[lines.length - 1]), "", `"${q}" did not end blank`);
  }
});
