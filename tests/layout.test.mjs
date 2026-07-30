// @ts-check
/**
 * wrapChunks is the highest-risk function in the codebase: a logical word can
 * span several chunks with different styling, and a wrap point can fall inside a
 * styled run. Both must come out intact.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  wrapChunks,
  indent,
  bullet,
  twoCol,
  rule,
  heading,
  columns,
  kv,
  GLYPH,
} from "../site/js/render/layout.js";
import { c, sp, len, text, link } from "../site/js/render/chunk.js";

/** Render lines to plain strings for readable assertions. */
const plain = (/** @type {import('../site/js/render/chunk.js').Line[]} */ lines) =>
  lines.map(text);

test("wrapChunks always returns at least one line", () => {
  assert.deepEqual(plain(wrapChunks([], 10)), [""]);
  assert.deepEqual(plain(wrapChunks([c("")], 10)), [""]);
});

test("short input is not wrapped", () => {
  assert.deepEqual(plain(wrapChunks([c("hello world")], 40)), ["hello world"]);
});

test("greedy word wrap", () => {
  assert.deepEqual(plain(wrapChunks([c("aaa bbb ccc ddd")], 7)), ["aaa bbb", "ccc ddd"]);
});

test("no output line ever exceeds the requested width", () => {
  const line = [
    c("Developed early software "),
    c("infrastructure", "keyword"),
    c(" including microcontroller firmware and hub control servers"),
  ];
  for (const width of [1, 2, 4, 8, 20, 30, 42, 80, 120]) {
    for (const l of wrapChunks(line, width)) {
      assert.ok(
        len(l) <= width,
        `width ${width}: line of ${len(l)} columns: ${JSON.stringify(text(l))}`,
      );
    }
  }
});

test("styling survives a wrap that lands mid-run", () => {
  const line = [c("aaa "), c("bbb ccc", "keyword"), c(" ddd")];
  const out = wrapChunks(line, 7);
  // Every chunk that came from the keyword run must still be a keyword.
  const keywords = out.flat().filter((ch) => ch.c === "keyword").map((ch) => ch.t);
  assert.deepEqual(keywords.join(" ").split(/\s+/).filter(Boolean), ["bbb", "ccc"]);
});

test("a link split across lines keeps its href on both halves", () => {
  const line = [link("github.com/rhanniga/a/very/long/path", "https://example.test")];
  const out = wrapChunks(line, 15);
  assert.ok(out.length > 1, "expected the link to wrap");
  for (const l of out) {
    for (const ch of l) {
      assert.equal(ch.href, "https://example.test");
      assert.equal(ch.c, "link");
    }
  }
});

test("a word longer than the width is hard-split rather than overflowing", () => {
  assert.deepEqual(plain(wrapChunks([c("supercalifragilistic")], 8)), [
    "supercal",
    "ifragili",
    "stic",
  ]);
});

test("an over-long word after existing content starts on its own line", () => {
  const out = plain(wrapChunks([c("hi supercalifragilistic")], 8));
  assert.equal(out[0], "hi");
  assert.deepEqual(out.slice(1), ["supercal", "ifragili", "stic"]);
});

test("wrapping exactly at the boundary does not emit an empty line", () => {
  assert.deepEqual(plain(wrapChunks([c("abcd efgh")], 4)), ["abcd", "efgh"]);
  assert.deepEqual(plain(wrapChunks([c("abcd")], 4)), ["abcd"]);
});

test("no line is left with trailing whitespace", () => {
  for (const width of [5, 9, 13, 20]) {
    for (const l of wrapChunks([c("aaa bbb ccc ddd eee")], width)) {
      assert.doesNotMatch(text(l), /\s$/, `trailing space at width ${width}`);
    }
  }
});

test("embedded newlines are hard breaks", () => {
  assert.deepEqual(plain(wrapChunks([c("aaa\nbbb")], 40)), ["aaa", "bbb"]);
  // A blank line in the middle survives as a blank line.
  assert.deepEqual(plain(wrapChunks([c("aaa\n\nbbb")], 40)), ["aaa", "", "bbb"]);
});

test("degenerate widths do not hang or throw", () => {
  for (const width of [0, -5, 1, 0.5, NaN]) {
    const out = wrapChunks([c("aa bb cc")], width);
    assert.ok(out.length >= 1);
  }
});

test("indent shifts content but leaves blank lines blank", () => {
  const out = indent([[c("a")], [], [c("b")]], 2);
  assert.deepEqual(plain(out), ["  a", "", "  b"]);
  // No trailing whitespace introduced on the empty line.
  assert.deepEqual(out[1], []);
});

test("indent of zero or less is a no-op", () => {
  const lines = [[c("a")]];
  assert.equal(indent(lines, 0), lines);
  assert.equal(indent(lines, -3), lines);
});

test("bullet hangs continuation lines past the glyph", () => {
  const out = plain(bullet([c("aaa bbb ccc ddd eee")], 12));
  assert.equal(out[0], `${GLYPH.BULLET} aaa bbb`);
  // Continuations align under the text, not under the glyph.
  for (const l of out.slice(1)) assert.match(l, /^ {2}\S/);
});

test("bullet respects a leading indent", () => {
  const out = plain(bullet([c("aaa bbb ccc")], 14, { indent: 2 }));
  assert.equal(out[0], `  ${GLYPH.BULLET} aaa bbb`);
  assert.equal(out[1], "    ccc");
});

test("bullet output still fits the width", () => {
  for (const width of [10, 20, 42]) {
    for (const l of bullet([c("aaa bbbbb cc dddd eeeee")], width, { indent: 2 })) {
      assert.ok(len(l) <= width, `width ${width}, got ${len(l)}`);
    }
  }
});

test("twoCol right-aligns when both columns fit", () => {
  const out = twoCol([c("left")], [c("right")], 20);
  assert.equal(out.length, 1);
  assert.equal(text(out[0] ?? []), "left           right");
  assert.equal(len(out[0] ?? []), 20);
});

test("twoCol stacks instead of truncating when it cannot fit", () => {
  // The rule that makes job entries readable at 42 columns.
  const out = plain(twoCol([c("Principal Software Engineer")], [c("Oct 2023 - Jul 2025")], 30));
  assert.equal(out[0], "Principal Software Engineer");
  assert.equal(out[1], "  Oct 2023 - Jul 2025");
});

test("twoCol never drops content, at any width", () => {
  // Stated as "no characters are lost" rather than "words stay intact", because
  // at very narrow widths a word longer than the line legitimately gets
  // hard-split. What must never happen is content silently disappearing.
  const left = "Lecturer + Postdoctoral Fellow";
  const right = "Jan 2023 - Present";
  const squash = (/** @type {string} */ s) => s.replace(/\s+/g, "");

  for (const width of [10, 25, 30, 46, 60]) {
    const joined = squash(plain(twoCol([c(left)], [c(right)], width)).join(""));
    assert.ok(joined.includes(squash(left)), `lost left content at width ${width}`);
    assert.ok(joined.includes(squash(right)), `lost right content at width ${width}`);
  }
});

test("twoCol keeps words intact whenever they fit", () => {
  // 46 is wide enough for the longest word, so nothing should be hard-split.
  const out = plain(twoCol([c("Lecturer + Postdoctoral Fellow")], [c("Jan 2023 - Present")], 46));
  assert.ok(out.join(" ").includes("Postdoctoral"));
});

test("rule fills exactly the width with a single-cell glyph", () => {
  assert.equal(len(rule(10)), 10);
  assert.equal(text(rule(4)), GLYPH.RULE.repeat(4));
  assert.equal(len(rule(0)), 0);
});

test("heading is an uppercase title over a full-width rule", () => {
  const out = heading("experience", 12);
  assert.deepEqual(plain(out), ["EXPERIENCE", GLYPH.RULE.repeat(12)]);
});

test("columns fills down each column before moving right, like ls", () => {
  // Width 8 with 1-char items and gap 2 gives colWidth 3 and so 3 columns,
  // forcing 2 rows out of 6 items. Column-major then means the first row is
  // a, c, e -- not a, b, c.
  const out = plain(columns(["a", "b", "c", "d", "e", "f"], 8, { gap: 2 }));
  assert.equal(out.length, 2, `expected 2 rows, got ${JSON.stringify(out)}`);
  assert.deepEqual((out[0] ?? "").trim().split(/\s+/), ["a", "c", "e"]);
  assert.deepEqual((out[1] ?? "").trim().split(/\s+/), ["b", "d", "f"]);
});

test("columns wraps an item wider than the terminal rather than overflowing", () => {
  const out = plain(columns(["Problem Solving"], 10));
  assert.ok(out.length > 1, "a 15-column item must wrap at width 10");
  for (const l of out) assert.ok(l.length <= 10);
});

test("columns degrades to one item per line when narrow", () => {
  const out = plain(columns(["alpha", "beta", "gamma"], 6));
  assert.deepEqual(out, ["alpha", "beta", "gamma"]);
});

test("columns never exceeds the width", () => {
  const items = ["Python", "Problem Solving", "Leadership", "C++", "Data Science", "Bash"];
  for (const width of [10, 20, 42, 80]) {
    for (const l of columns(items, width)) {
      assert.ok(len(l) <= width, `width ${width}, got ${len(l)}`);
    }
  }
});

test("columns of nothing is nothing", () => {
  assert.deepEqual(columns([], 40), []);
});

test("kv pads the key into a fixed column", () => {
  assert.equal(text(kv("email", [c("a@b.c")], 9)), "email     a@b.c");
});

test("highlighting does not change where a word may break", () => {
  // The bug this guards: highlight() splits "(Python/FastAPI)" into several
  // chunks so it can mark two of them, and an unmerged wrapper then treats each
  // chunk as independently breakable, emitting "(Python/" then "FastAPI)".
  const split = [c("backends ("), c("Python", "keyword"), c("/"), c("FastAPI", "keyword"), c(")")];
  const whole = [c("backends (Python/FastAPI)")];
  for (const width of [12, 16, 20, 24, 30, 40]) {
    assert.deepEqual(
      plain(wrapChunks(split, width)),
      plain(wrapChunks(whole, width)),
      `chunked and plain text wrapped differently at width ${width}`,
    );
  }
});

test("a word split mid-way keeps each fragment's styling", () => {
  // An over-long highlighted word must still hard-split, and each fragment must
  // carry the style of the chunk it came from.
  const line = [c("aa"), c("HIGHLIGHTED", "keyword"), c("zz")];
  const out = wrapChunks(line, 5);
  assert.equal(text(out.flat()), "aaHIGHLIGHTEDzz");
  const marked = out.flat().filter((ch) => ch.c === "keyword").map((ch) => ch.t).join("");
  assert.equal(marked, "HIGHLIGHTED");
  for (const l of out) assert.ok(len(l) <= 5);
});
