// @ts-check
/**
 * LineBuffer is the source of truth for the input line, so it gets the most
 * thorough tests in the terminal layer. It touches no DOM, which is the whole
 * reason it can be tested like this.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { LineBuffer } from "../site/js/terminal/line-buffer.js";

/**
 * Build a buffer with the cursor at a marked position. `|` marks the cursor.
 * @param {string} spec
 */
function at(spec) {
  const i = spec.indexOf("|");
  assert.notEqual(i, -1, "spec must contain a | cursor marker");
  const b = new LineBuffer();
  b.set(spec.replace("|", ""), i);
  return b;
}

/** Render a buffer back to the `|`-marked form, for readable assertions. */
function show(/** @type {LineBuffer} */ b) {
  const { pre, at: cur, post } = b.split();
  return pre + "|" + cur + post;
}

test("starts empty", () => {
  const b = new LineBuffer();
  assert.equal(b.value, "");
  assert.equal(b.cursor, 0);
  assert.equal(b.length, 0);
  assert.equal(b.isEmpty, true);
});

test("insert appends at the cursor and advances it", () => {
  const b = new LineBuffer();
  b.insert("echo");
  assert.equal(show(b), "echo|");
  b.moveHome();
  b.insert("# ");
  assert.equal(show(b), "# |echo");
});

test("insert of empty string is a no-op", () => {
  const b = at("ab|c");
  b.insert("");
  assert.equal(show(b), "ab|c");
});

test("set clamps the cursor into range", () => {
  const b = new LineBuffer();
  b.set("abc", 99);
  assert.equal(b.cursor, 3);
  b.set("abc", -5);
  assert.equal(b.cursor, 0);
  b.set("abc", 1.7);
  assert.equal(b.cursor, 1);
  b.set("abc");
  assert.equal(b.cursor, 3, "no cursor argument means end of line");
});

test("deleteBackward reports whether it did anything", () => {
  const b = at("ab|c");
  assert.equal(b.deleteBackward(), true);
  assert.equal(show(b), "a|c");
  b.moveHome();
  assert.equal(b.deleteBackward(), false, "at column 0 there is nothing to delete");
  assert.equal(show(b), "|ac");
});

test("deleteForward reports whether it did anything", () => {
  const b = at("a|bc");
  assert.equal(b.deleteForward(), true);
  assert.equal(show(b), "a|c");
  b.moveEnd();
  assert.equal(b.deleteForward(), false);
  assert.equal(show(b), "ac|");
});

test("Ctrl+U kills to start and fills the kill ring", () => {
  const b = at("foo bar|baz");
  b.killToStart();
  assert.equal(show(b), "|baz");
  assert.equal(b.killRing, "foo bar");
});

test("Ctrl+K kills to end and fills the kill ring", () => {
  const b = at("foo |bar baz");
  b.killToEnd();
  assert.equal(show(b), "foo |");
  assert.equal(b.killRing, "bar baz");
});

test("Ctrl+Y yanks the kill ring at the cursor", () => {
  const b = at("hello world|");
  b.killWordBackward();
  assert.equal(show(b), "hello |");
  b.moveHome();
  b.yank();
  assert.equal(show(b), "world|hello ");
});

test("yank with an empty kill ring does nothing", () => {
  const b = at("ab|");
  b.yank();
  assert.equal(show(b), "ab|");
});

test("kill-word is whitespace-delimited, matching bash unix-word-rubout", () => {
  // This is the behaviour that differs from word *motion*: at the end of
  // "foo/bar baz", one kill takes "baz" and the next takes all of "foo/bar" --
  // it does not stop at the slash.
  const b = at("foo/bar baz|");
  b.killWordBackward();
  assert.equal(show(b), "foo/bar |");
  b.killWordBackward();
  assert.equal(show(b), "|");
});

test("kill-word skips trailing whitespace before killing", () => {
  const b = at("alpha beta   |");
  b.killWordBackward();
  assert.equal(show(b), "alpha |");
});

test("kill-word at column 0 is a no-op", () => {
  const b = at("|abc");
  b.killWordBackward();
  assert.equal(show(b), "|abc");
});

test("word motion stops at non-word characters", () => {
  // Unlike kill-word, motion treats "/" as a boundary.
  const b = at("foo/bar baz|");
  b.moveWordLeft();
  assert.equal(show(b), "foo/bar |baz");
  b.moveWordLeft();
  assert.equal(show(b), "foo/|bar baz");
  b.moveWordLeft();
  assert.equal(show(b), "|foo/bar baz");
  b.moveWordLeft();
  assert.equal(show(b), "|foo/bar baz", "clamps at start");
});

test("moveWordRight mirrors moveWordLeft", () => {
  const b = at("|foo/bar baz");
  b.moveWordRight();
  assert.equal(show(b), "foo|/bar baz");
  b.moveWordRight();
  assert.equal(show(b), "foo/bar| baz");
  b.moveWordRight();
  assert.equal(show(b), "foo/bar baz|");
  b.moveWordRight();
  assert.equal(show(b), "foo/bar baz|", "clamps at end");
});

test("horizontal motion clamps at both ends", () => {
  const b = new LineBuffer();
  b.set("ab");
  b.moveRight();
  assert.equal(b.cursor, 2);
  b.moveHome();
  b.moveLeft();
  assert.equal(b.cursor, 0);
});

test("split exposes the grapheme under the cursor", () => {
  const b = at("ab|cd");
  assert.deepEqual(b.split(), { pre: "ab", at: "c", post: "d" });
});

test("split at end-of-line has no character under the cursor", () => {
  const b = at("ab|");
  assert.deepEqual(b.split(), { pre: "ab", at: "", post: "" });
});

test("the cursor never bisects a multi-code-unit grapheme", () => {
  const b = new LineBuffer();
  b.insert("a🎉b");
  assert.equal(b.length, 3, "three graphemes, not four UTF-16 code units");
  b.moveHome();
  b.moveRight();
  // The cursor sits ON the emoji, covering it entirely.
  assert.deepEqual(b.split(), { pre: "a", at: "🎉", post: "b" });
  assert.equal(b.deleteForward(), true);
  assert.equal(b.value, "ab", "the whole emoji went, not half of it");
});

test("combining marks stay attached to their base character", () => {
  const b = new LineBuffer();
  b.insert("café");
  b.moveEnd();
  b.deleteBackward();
  assert.equal(b.value, "caf");
});

test("clear resets both the text and the cursor", () => {
  const b = at("ab|c");
  b.clear();
  assert.equal(b.value, "");
  assert.equal(b.cursor, 0);
  assert.equal(b.isEmpty, true);
});
