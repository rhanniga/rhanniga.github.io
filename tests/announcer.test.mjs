// @ts-check
/**
 * The screen-reader sink.
 *
 * `unwrap` is the interesting half and it is pure, so it tests without a DOM. What it
 * has to get right: reverse the visual wrapping without corrupting the text. A screen
 * reader treats a line break as a pause or a list boundary, so a 42-column wrap turns
 * one sentence into eight fragments -- which is why this path exists at all rather than
 * pointing aria-live at #output.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { unwrap } from "../site/js/render/announcer.js";
import { c, sp, blank } from "../site/js/render/chunk.js";
import { wrapChunks, indent } from "../site/js/render/layout.js";
import { formatExperience, formatSummary } from "../site/js/render/format.js";
import { readFileSync } from "node:fs";

const resume = JSON.parse(
  readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
);

test("consecutive lines rejoin into one paragraph", () => {
  const lines = [[c("the quick brown")], [c("fox jumps over")], [c("the lazy dog")]];
  assert.equal(unwrap(lines), "the quick brown fox jumps over the lazy dog");
});

test("a blank line stays a paragraph break", () => {
  const lines = [[c("first para")], blank, [c("second para")]];
  assert.equal(unwrap(lines), "first para\nsecond para");
});

test("runs of blank lines collapse to one break", () => {
  // Sections pad themselves with blank lines. Announcing three consecutive breaks
  // just makes a screen reader pause three times.
  const lines = [[c("a")], blank, blank, blank, [c("b")]];
  assert.equal(unwrap(lines), "a\nb");
});

test("indentation is dropped, not announced", () => {
  // A screen reader reading leading spaces conveys nothing; some announce them.
  const lines = [[sp(4), c("indented text")]];
  assert.equal(unwrap(lines), "indented text");
});

test("column alignment padding is collapsed", () => {
  // twoCol pads with a long run of spaces to right-align dates. Unannounced, that
  // is one sentence; announced literally it is a long silence mid-line.
  const lines = [[c("Software Engineer"), sp(23), c("2018-2022")]];
  assert.equal(unwrap(lines), "Software Engineer 2018-2022");
});

test("styling does not affect the announced text", () => {
  // Chunks split for highlighting must not introduce word boundaries.
  const styled = [[c("Built with "), c("Python", "keyword"), c(" and "), c("C++", "keyword")]];
  assert.equal(unwrap(styled), "Built with Python and C++");
});

test("empty input announces nothing", () => {
  assert.equal(unwrap([]), "");
  assert.equal(unwrap([blank]), "");
  assert.equal(unwrap([blank, blank]), "");
});

test("a real wrapped paragraph round-trips to its original sentence", () => {
  // The property that matters, checked against the wrapper that actually produced
  // the lines: wrap a long sentence hard, unwrap it, get the sentence back.
  const sentence =
    "Developed early software infrastructure, including microcontroller firmware " +
    "and hub control servers, plus the customer application frontend.";
  for (const cols of [20, 32, 42, 60, 80]) {
    const wrapped = wrapChunks([c(sentence)], cols);
    assert.equal(unwrap(wrapped), sentence, `failed at ${cols} columns`);
  }
});

test("an indented wrapped paragraph also round-trips", () => {
  const sentence =
    "Mentored and guided a team of 8+ engineers in developing the company's core technology.";
  const wrapped = indent(wrapChunks([c(sentence)], 40), 4);
  assert.equal(unwrap(wrapped), sentence);
});

test("the announced text contains no line breaks inside a paragraph", () => {
  // The whole point. Every paragraph the announcer emits must be a single line, or
  // a screen reader will fragment it.
  const lines = formatSummary(resume, 42);
  for (const paragraph of unwrap(lines).split("\n")) {
    assert.ok(!paragraph.includes("\n"));
    // And no double spaces, which some screen readers pause on.
    assert.ok(!paragraph.includes("  "), `collapsed badly: ${paragraph}`);
  }
});

test("real section output announces fewer paragraphs than it renders lines", () => {
  // A sanity check that unwrapping is actually happening: `experience` at 42 columns
  // is many wrapped lines but far fewer paragraphs.
  const lines = formatExperience(resume, 42);
  const paragraphs = unwrap(lines).split("\n").filter((s) => s !== "");
  assert.ok(
    paragraphs.length < lines.length / 2,
    `${paragraphs.length} paragraphs from ${lines.length} lines -- not unwrapping`,
  );
  assert.ok(paragraphs.length > 0);
});

test("no resume content is lost in unwrapping", () => {
  // Rejoining must not drop words. Compared as a word multiset, since the whole
  // point is that the line structure changes.
  const lines = formatExperience(resume, 42);
  const rendered = lines
    .map((l) => l.map((ch) => ch.t).join(""))
    .join(" ")
    .split(/\s+/)
    .filter((w) => w !== "")
    .sort();
  const announced = unwrap(lines)
    .split(/\s+/)
    .filter((w) => w !== "")
    .sort();
  assert.deepEqual(announced, rendered);
});

/* ── Wiring ───────────────────────────────────────────────────────────────
   The announcer is invisible by construction, so nothing about the page looks
   wrong if it never fires. These drive a real ShellMode and assert that command
   output actually reaches it -- and reaches it as one block per command, not one
   per line. */

test("a command's output reaches the announcer as a single block", async () => {
  const { ShellMode } = await import("../site/js/terminal/shell-mode.js");
  const { buildRegistry } = await import("../site/js/commands/index.js");
  const { Env } = await import("../site/js/shell/env.js");
  const { History } = await import("../site/js/terminal/history.js");

  /** @type {string[]} */
  const announced = [];
  const announcer = {
    rows: (lines) => announced.push(unwrap(lines)),
    say: (t) => announced.push(t),
    clear: () => {},
  };

  const mode = new ShellMode({
    registry: buildRegistry(),
    env: new Env(),
    resume,
    history: new History("announcer-test"),
    motd: () => {},
    announcer: /** @type {any} */ (announcer),
  });

  /** @type {any} */
  const ctx = {
    term: {
      cols: () => 42,
      renderInput: () => {},
      pushMode: () => {},
      removeMode: () => {},
      clear: () => {},
      transientRow: () => ({ set: () => {}, discard: () => {} }),
      scrollToBottom: () => {},
    },
    out: { row: () => {}, rows: () => {} },
  };

  mode.onInsertText("summary", ctx);
  mode.onKey({ action: "enter", key: "Enter", ctrl: false, alt: false, shift: false, raw: /** @type {any} */ ({}) }, ctx);

  // #runArgv is async and not awaited by onKey -- the same reason the real terminal
  // stays responsive while a command runs.
  for (let i = 0; i < 20 && announced.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }

  assert.equal(announced.length, 1, "one block per command, not one per line");
  assert.match(announced[0], /Software engineer/);
  // The point of the whole path: no wrap-induced breaks inside a paragraph.
  const longest = announced[0].split("\n").reduce((a, b) => (a.length > b.length ? a : b), "");
  assert.ok(longest.length > 42, `longest paragraph is ${longest.length} chars -- still wrapped`);
});

test("a command that fails still announces its error", async () => {
  // A screen-reader user must hear "command not found", not silence.
  const { ShellMode } = await import("../site/js/terminal/shell-mode.js");
  const { buildRegistry } = await import("../site/js/commands/index.js");
  const { Env } = await import("../site/js/shell/env.js");
  const { History } = await import("../site/js/terminal/history.js");

  /** @type {string[]} */
  const announced = [];
  const mode = new ShellMode({
    registry: buildRegistry(),
    env: new Env(),
    resume,
    history: new History("announcer-test-2"),
    motd: () => {},
    announcer: /** @type {any} */ ({
      rows: (lines) => announced.push(unwrap(lines)),
      say: () => {},
      clear: () => {},
    }),
  });

  /** @type {any} */
  const ctx = {
    term: {
      cols: () => 42,
      renderInput: () => {},
      pushMode: () => {},
      removeMode: () => {},
      clear: () => {},
      transientRow: () => ({ set: () => {}, discard: () => {} }),
      scrollToBottom: () => {},
    },
    out: { row: () => {}, rows: () => {} },
  };

  mode.onInsertText("nonexistentcmd", ctx);
  mode.onKey({ action: "enter", key: "Enter", ctrl: false, alt: false, shift: false, raw: /** @type {any} */ ({}) }, ctx);
  for (let i = 0; i < 20 && announced.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(announced.length, 1);
  assert.match(announced[0], /command not found/);
});
