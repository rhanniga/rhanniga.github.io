// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { tokenize, describeError } from "../site/js/shell/tokenize.js";

/** @param {string} s @param {number} [status] */
function argv(s, status = 0) {
  const r = tokenize(s, { status });
  assert.equal(r.ok, true, `expected ${JSON.stringify(s)} to tokenize`);
  return r.ok ? r.argv : [];
}

/** @param {string} s */
function err(s) {
  const r = tokenize(s, { status: 0 });
  assert.equal(r.ok, false, `expected ${JSON.stringify(s)} to fail`);
  return r.ok ? "" : r.error;
}

test("splits on whitespace and collapses runs", () => {
  assert.deepEqual(argv("summary"), ["summary"]);
  assert.deepEqual(argv("echo a b"), ["echo", "a", "b"]);
  assert.deepEqual(argv("  echo   a\tb  "), ["echo", "a", "b"]);
  assert.deepEqual(argv(""), []);
  assert.deepEqual(argv("   "), []);
});

test("double quotes group words", () => {
  // The case the whole tokenizer exists for.
  assert.deepEqual(argv('ask "How did you get into physics?"'), [
    "ask",
    "How did you get into physics?",
  ]);
  assert.deepEqual(argv('echo "a b"  c'), ["echo", "a b", "c"]);
});

test("single quotes are fully literal", () => {
  assert.deepEqual(argv("echo 'a b'"), ["echo", "a b"]);
  // No escape processing at all inside single quotes, per POSIX.
  assert.deepEqual(argv("echo 'a\\nb'"), ["echo", "a\\nb"]);
  assert.deepEqual(argv("echo 'it\"s'"), ["echo", 'it"s']);
});

test("double quotes honour only the POSIX escape set", () => {
  assert.deepEqual(argv('echo "say \\"hi\\""'), ["echo", 'say "hi"']);
  assert.deepEqual(argv('echo "a\\\\b"'), ["echo", "a\\b"]);
  assert.deepEqual(argv('echo "\\$5"'), ["echo", "$5"]);
  // A backslash before anything else stays literal inside double quotes.
  assert.deepEqual(argv('echo "a\\nb"'), ["echo", "a\\nb"]);
});

test("unquoted backslash escapes the next character", () => {
  assert.deepEqual(argv("echo a\\ b"), ["echo", "a b"]);
  assert.deepEqual(argv('echo \\"'), ["echo", '"']);
});

test("quotes can abut and join within one word", () => {
  assert.deepEqual(argv(`echo "a"'b'c`), ["echo", "abc"]);
  assert.deepEqual(argv('echo x"y z"'), ["echo", "xy z"]);
});

test("an empty quoted string produces an empty argument", () => {
  // This matters: the empty arg must reach the command so it can report a usage
  // error, rather than silently vanishing and looking like `ask` with no args.
  assert.deepEqual(argv('ask ""'), ["ask", ""]);
  assert.deepEqual(argv("ask ''"), ["ask", ""]);
  assert.deepEqual(argv('echo "" a'), ["echo", "", "a"]);
});

test("$? is the only expansion", () => {
  assert.deepEqual(argv("echo $?", 127), ["echo", "127"]);
  assert.deepEqual(argv('echo "status $?"', 2), ["echo", "status 2"]);
  assert.deepEqual(argv("echo $?", 0), ["echo", "0"]);
  // Single quotes suppress it, as in bash.
  assert.deepEqual(argv("echo '$?'", 127), ["echo", "$?"]);
  // Nothing else expands.
  assert.deepEqual(argv("echo $HOME"), ["echo", "$HOME"]);
  assert.deepEqual(argv("echo ~"), ["echo", "~"]);
  assert.deepEqual(argv("echo *.js"), ["echo", "*.js"]);
  assert.deepEqual(argv("echo $"), ["echo", "$"]);
});

test("unterminated quotes are reported, not guessed at", () => {
  assert.equal(err('ask "unfinished'), "unterminated-double");
  assert.equal(err("ask 'unfinished"), "unterminated-single");
  assert.equal(err("echo a\\"), "trailing-backslash");
  assert.equal(err('echo "a\\'), "trailing-backslash");
});

test("errors have bash-shaped descriptions", () => {
  assert.match(describeError("unterminated-double"), /unexpected EOF/);
  assert.match(describeError("unterminated-single"), /unexpected EOF/);
  assert.match(describeError("trailing-backslash"), /escape character/);
});

test("newlines inside quotes survive, which is how continuation works", () => {
  // ContinuationMode joins accumulated lines with \n and re-tokenizes.
  assert.deepEqual(argv('ask "line one\nline two"'), ["ask", "line one\nline two"]);
  // Unquoted, a newline is just whitespace.
  assert.deepEqual(argv("echo a\nb"), ["echo", "a", "b"]);
});

test("non-ASCII text passes through intact", () => {
  assert.deepEqual(argv('echo "café 🎉"'), ["echo", "café 🎉"]);
});
