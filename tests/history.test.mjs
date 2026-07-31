// @ts-check
/**
 * History runs unmodified under Node: util.js guards every localStorage access in
 * a try/catch (Safari private mode throws), so with no `localStorage` global it
 * simply does not persist. That is exactly the degraded path real visitors hit.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { History } from "../site/js/terminal/history.js";

/** @param {string} ns */
const fresh = (ns) => new History(ns);

test("starts empty", () => {
  const h = fresh("t1");
  assert.equal(h.length, 0);
  assert.deepEqual([...h.entries()], []);
  assert.equal(h.prev(""), null, "nothing to recall");
  assert.equal(h.next(), null);
});

test("records submitted lines oldest first", () => {
  const h = fresh("t2");
  h.push("summary");
  h.push("experience");
  assert.deepEqual([...h.entries()], ["summary", "experience"]);
});

test("ignores blank lines and consecutive duplicates", () => {
  // bash's HISTCONTROL=ignoredups. Without it, holding Enter or re-running the
  // same command fills history with noise.
  const h = fresh("t3");
  h.push("");
  h.push("   ");
  h.push("summary");
  h.push("summary");
  h.push("skills");
  h.push("summary");
  assert.deepEqual([...h.entries()], ["summary", "skills", "summary"]);
});

test("Up walks backwards through history", () => {
  const h = fresh("t4");
  h.push("one");
  h.push("two");
  h.push("three");
  assert.equal(h.prev(""), "three");
  assert.equal(h.prev(""), "two");
  assert.equal(h.prev(""), "one");
  assert.equal(h.prev(""), null, "clamps at the oldest entry");
});

test("Down walks forwards and restores the stashed draft", () => {
  // The behaviour that is immediately noticeable when wrong.
  const h = fresh("t5");
  h.push("one");
  h.push("two");

  assert.equal(h.prev("half-typed"), "two", "Up stashes the draft");
  assert.equal(h.prev("ignored"), "one");
  assert.equal(h.next(), "two");
  assert.equal(h.next(), "half-typed", "walking past the newest entry restores it");
  assert.equal(h.next(), null, "already on the draft line");
});

test("the draft is stashed once, not overwritten while walking back", () => {
  const h = fresh("t6");
  h.push("one");
  h.push("two");
  h.prev("original");
  h.prev("SHOULD NOT REPLACE");
  h.next();
  assert.equal(h.next(), "original");
});

test("Enter resets the cursor and clears the stash", () => {
  const h = fresh("t7");
  h.push("one");
  h.prev("draft");
  h.push("two"); // push() calls reset()
  assert.equal(h.next(), null, "back on a fresh draft line");
  assert.equal(h.prev(""), "two", "Up starts from the newest again");
});

test("reset alone returns to the draft line", () => {
  const h = fresh("t8");
  h.push("one");
  h.prev("draft");
  h.reset();
  assert.equal(h.next(), null);
  assert.equal(h.prev(""), "one");
});

test("clear empties history", () => {
  const h = fresh("t9");
  h.push("one");
  h.push("two");
  h.clear();
  assert.equal(h.length, 0);
  assert.equal(h.prev(""), null);
});

test("history is capped so it cannot grow without bound", () => {
  const h = fresh("t10");
  for (let i = 0; i < 600; i++) h.push(`cmd${i}`);
  assert.equal(h.length, 500);
  // The oldest entries are the ones dropped.
  assert.equal(h.entries()[0], "cmd100");
  assert.equal(h.entries()[499], "cmd599");
});

test("separate namespaces do not share entries", () => {
  // This is what gives `ask -i` its own history for free.
  const shell = fresh("t11-shell");
  const ask = fresh("t11-ask");
  shell.push("summary");
  assert.equal(ask.length, 0);
  assert.equal(shell.length, 1);
});
