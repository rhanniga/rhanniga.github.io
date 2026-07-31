// @ts-check
/**
 * The contract for `cat resume.json`: the coloured output must be structurally
 * identical to the file on disk, not a prettier reinterpretation of it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { formatJson } from "../site/js/render/json.js";
import { text } from "../site/js/render/chunk.js";

/** @param {unknown} v */
const render = (v) => formatJson(v).map(text).join("\n");

/** @param {unknown} v */
function assertMatchesStringify(v) {
  assert.equal(render(v), JSON.stringify(v, null, 2));
}

test("scalars", () => {
  assertMatchesStringify(1);
  assertMatchesStringify(-2.5);
  assertMatchesStringify("hi");
  assertMatchesStringify(true);
  assertMatchesStringify(false);
  assertMatchesStringify(null);
});

test("empty containers stay on one line", () => {
  assertMatchesStringify({});
  assertMatchesStringify([]);
  assertMatchesStringify({ a: [], b: {} });
});

test("nested objects and arrays indent by two", () => {
  assertMatchesStringify({ a: { b: 1 } });
  assertMatchesStringify({ a: [1, 2, 3] });
  assertMatchesStringify([{ a: 1 }, { b: 2 }]);
  assertMatchesStringify({ a: [{ b: [1, { c: 2 }] }] });
});

test("commas appear on every element but the last", () => {
  const out = formatJson({ a: 1, b: 2 }).map(text);
  assert.equal(out[1]?.endsWith(","), true);
  assert.equal(out[2]?.endsWith(","), false);
});

test("strings are escaped the way JSON.stringify escapes them", () => {
  assertMatchesStringify({ quote: 'say "hi"' });
  assertMatchesStringify({ backslash: "a\\b" });
  assertMatchesStringify({ newline: "a\nb" });
  assertMatchesStringify({ tab: "a\tb" });
  assertMatchesStringify({ unicode: "café 🎉" });
  // A key needing escapes must be escaped too.
  assertMatchesStringify({ 'we"ird': 1 });
});

test("the real resume.json renders identically to JSON.stringify", () => {
  // The load-bearing assertion: `cat resume.json` is telling the truth.
  const resume = JSON.parse(
    readFileSync(new URL("../site/resume.json", import.meta.url), "utf8"),
  );
  assertMatchesStringify(resume);
});

test("keys, strings, numbers and punctuation get distinct classes", () => {
  const line = formatJson({ n: 1 })[1] ?? [];
  const classes = line.map((ch) => ch.c);
  assert.ok(classes.includes("json-key"));
  assert.ok(classes.includes("json-number"));
  assert.ok(classes.includes("json-punct"));

  const strLine = formatJson({ s: "x" })[1] ?? [];
  assert.ok(strLine.some((ch) => ch.c === "json-string"));
});

test("long strings are not wrapped", () => {
  // A real terminal soft-wraps a long cat line at the screen edge; inserting hard
  // breaks would put line endings in the output that are not in the file.
  const long = "x".repeat(500);
  const out = formatJson({ long });
  assert.equal(out.length, 3, "open brace, the pair, close brace");
  assert.ok(text(out[1] ?? []).length > 500);
});
