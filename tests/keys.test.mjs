// @ts-check
/**
 * keys.js reads only `key`, `ctrlKey`, `altKey`, `metaKey` and `shiftKey`, so a
 * plain object stands in for a KeyboardEvent and no DOM is needed.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normalize, isPrintable, sanitizePaste } from "../site/js/terminal/keys.js";

/**
 * @param {string} key
 * @param {{ctrl?: boolean, alt?: boolean, shift?: boolean, meta?: boolean}} [mods]
 */
function ev(key, mods = {}) {
  return /** @type {KeyboardEvent} */ (
    /** @type {unknown} */ ({
      key,
      ctrlKey: mods.ctrl ?? false,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
      metaKey: mods.meta ?? false,
    })
  );
}

/**
 * @param {string} key
 * @param {{ctrl?: boolean, alt?: boolean, shift?: boolean}} [mods]
 */
const act = (key, mods) => normalize(ev(key, mods)).action;

/** Control characters, built from code points so this file stays ASCII text. */
const ctl = (/** @type {number} */ cp) => String.fromCharCode(cp);

test("plain navigation keys map to motion", () => {
  assert.equal(act("ArrowLeft"), "left");
  assert.equal(act("ArrowRight"), "right");
  assert.equal(act("ArrowUp"), "up");
  assert.equal(act("ArrowDown"), "down");
  assert.equal(act("Home"), "home");
  assert.equal(act("End"), "end");
  assert.equal(act("Enter"), "enter");
  assert.equal(act("Backspace"), "backspace");
  assert.equal(act("Delete"), "delete");
});

test("the readline control keymap", () => {
  assert.equal(act("a", { ctrl: true }), "home");
  assert.equal(act("e", { ctrl: true }), "end");
  assert.equal(act("b", { ctrl: true }), "left");
  assert.equal(act("f", { ctrl: true }), "right");
  assert.equal(act("p", { ctrl: true }), "up");
  assert.equal(act("n", { ctrl: true }), "down");
  assert.equal(act("u", { ctrl: true }), "kill-to-start");
  assert.equal(act("k", { ctrl: true }), "kill-to-end");
  assert.equal(act("w", { ctrl: true }), "kill-word");
  assert.equal(act("y", { ctrl: true }), "yank");
  assert.equal(act("l", { ctrl: true }), "clear");
  assert.equal(act("c", { ctrl: true }), "interrupt");
  assert.equal(act("d", { ctrl: true }), "eof");
  assert.equal(act("h", { ctrl: true }), "backspace");
});

test("control keys are case-insensitive, so Caps Lock does not break them", () => {
  assert.equal(act("A", { ctrl: true }), "home");
  assert.equal(act("K", { ctrl: true }), "kill-to-end");
});

test("Ctrl+Arrow moves by word", () => {
  assert.equal(act("ArrowLeft", { ctrl: true }), "word-left");
  assert.equal(act("ArrowRight", { ctrl: true }), "word-right");
});

test("Alt+B/F move by word and Alt+Backspace kills one", () => {
  assert.equal(act("b", { alt: true }), "word-left");
  assert.equal(act("f", { alt: true }), "word-right");
  // The reliable kill-word binding: Chrome and Firefox both swallow Ctrl+W to
  // close the tab and do not honour preventDefault.
  assert.equal(act("Backspace", { alt: true }), "kill-word");
});

test("Shift+Home/End scroll the viewport instead of moving the cursor", () => {
  assert.equal(act("Home", { shift: true }), "scroll-top");
  assert.equal(act("End", { shift: true }), "scroll-bottom");
  assert.equal(act("PageUp"), "page-up");
  assert.equal(act("PageDown"), "page-down");
});

test("Tab and Shift+Tab are distinct completion directions", () => {
  assert.equal(act("Tab"), "tab");
  assert.equal(act("Tab", { shift: true }), "tab-back");
});

test("unhandled keys report none so the host can let them through", () => {
  assert.equal(act("F5"), "none");
  assert.equal(act("q"), "none");
  assert.equal(act("z", { ctrl: true }), "none");
});

test("isPrintable distinguishes characters from named keys", () => {
  assert.equal(isPrintable(ev("a")), true);
  assert.equal(isPrintable(ev(" ")), true);
  assert.equal(isPrintable(ev("é")), true);
  // Astral-plane character: two UTF-16 code units, one printable key.
  assert.equal(isPrintable(ev("\u{1f389}")), true);
  assert.equal(isPrintable(ev("ArrowLeft")), false);
  assert.equal(isPrintable(ev("Enter")), false);
  // Modifier combinations are commands, not text.
  assert.equal(isPrintable(ev("a", { ctrl: true })), false);
  assert.equal(isPrintable(ev("a", { alt: true })), false);
  assert.equal(isPrintable(ev("a", { meta: true })), false);
  // Shift+letter is still text.
  assert.equal(isPrintable(ev("A", { shift: true })), true);
});

test("paste collapses newlines to spaces rather than executing lines", () => {
  // The important property: pasting a block of shell history must not run it.
  assert.equal(sanitizePaste("summary\nexperience\n"), "summary experience ");
  assert.equal(sanitizePaste("a\r\nb"), "a b");
  assert.equal(sanitizePaste("a\rb"), "a b");
  assert.equal(
    sanitizePaste("a\n\n\nb"),
    "a b",
    "runs of newlines collapse to a single space",
  );
});

test("paste strips control characters that would desync the cursor", () => {
  const NUL = ctl(0x00);
  const BEL = ctl(0x07);
  const ESC = ctl(0x1b);
  const DEL = ctl(0x7f);

  assert.equal(sanitizePaste(`a${NUL}b`), "ab");
  assert.equal(sanitizePaste(`a${BEL}b`), "ab");
  // There is no ANSI/CSI escape parser anywhere in this project, by design:
  // output is structured on the way in. So an ESC reaching the buffer is junk
  // and the surrounding bytes are just text.
  assert.equal(sanitizePaste(`a${ESC}[31mb`), "a[31mb");
  assert.equal(sanitizePaste(`a${DEL}b`), "ab");
  assert.equal(sanitizePaste("a\tb"), "ab", "tabs would break column alignment");
});

test("paste preserves surrogate pairs and leaves surrounding space alone", () => {
  assert.equal(sanitizePaste("hi \u{1f389}"), "hi \u{1f389}");
  // Deliberately not trimmed: trimming would silently alter an exact paste.
  assert.equal(sanitizePaste("  padded  "), "  padded  ");
});

test("normalize passes the modifier state through for the host to inspect", () => {
  const k = normalize(ev("c", { ctrl: true, shift: true }));
  assert.equal(k.action, "interrupt");
  assert.equal(k.ctrl, true);
  assert.equal(k.shift, true);
  assert.equal(k.key, "c");
});
