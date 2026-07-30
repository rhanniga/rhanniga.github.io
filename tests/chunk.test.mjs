// @ts-check
/**
 * Tests for the chunk primitives.
 *
 * Runs under Node's built-in test runner with zero dependencies:
 *   node --test tests/
 * The root package.json exists only so `.js` modules are treated as ESM.
 *
 * These modules import nothing from the DOM, which is exactly why the
 * pure-formatter boundary in render/chunk.js is worth having.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { c, sp, link, blank, len, text, join } from "../site/js/render/chunk.js";
import { width, graphemes, clamp } from "../site/js/util.js";

test("c() omits the class key when no class is given", () => {
  assert.deepEqual(c("hi"), { t: "hi" });
  assert.deepEqual(c("hi", "dim"), { t: "hi", c: "dim" });
});

test("sp() never produces negative padding", () => {
  assert.equal(sp(3).t, "   ");
  assert.equal(sp(0).t, "");
  assert.equal(sp(-5).t, "");
});

test("link() marks http(s) as external but not mailto/tel", () => {
  assert.equal(link("gh", "https://github.com/x").ext, true);
  assert.equal(link("mail", "mailto:a@b.c").ext, undefined);
  assert.equal(link("call", "tel:+15551234").ext, undefined);
});

test("len() sums printed width across styled runs", () => {
  assert.equal(len([]), 0);
  assert.equal(len(blank), 0);
  assert.equal(len([c("abc"), c("de", "dim")]), 5);
  assert.equal(len([sp(4), c("x")]), 5);
});

test("text() strips styling and does not wrap", () => {
  assert.equal(text([c("Principal "), c("Engineer", "bright")]), "Principal Engineer");
  assert.equal(text(blank), "");
});

test("join() concatenates lines", () => {
  assert.deepEqual(join([c("a")], [c("b", "dim")]), [{ t: "a" }, { t: "b", c: "dim" }]);
});

test("blank is frozen so a shared reference cannot be mutated", () => {
  assert.throws(() => {
    // @ts-expect-error deliberately violating the readonly contract
    blank.push(c("oops"));
  });
});

test("width() counts graphemes, not code units", () => {
  assert.equal(width("abc"), 3);
  assert.equal(width(""), 0);
  // A single emoji is one user-perceived character but two UTF-16 code units.
  assert.equal("🎉".length, 2);
  assert.equal(width("🎉"), 1);
  // Family emoji: many code points, one grapheme.
  assert.equal(width("👨‍👩‍👧"), 1);
  // Combining mark must not be split from its base.
  assert.equal(width("é"), 1);
});

test("graphemes() keeps combining sequences intact", () => {
  assert.deepEqual(graphemes("aéb"), ["a", "é", "b"]);
  assert.deepEqual(graphemes(""), []);
});

test("clamp() bounds inclusively", () => {
  assert.equal(clamp(20, 5, 120), 20);
  assert.equal(clamp(20, 80, 120), 80);
  assert.equal(clamp(20, 999, 120), 120);
});
