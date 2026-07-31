// @ts-check
/**
 * Guards a class of bug that is invisible in review and obvious on screen.
 *
 * `.inputline` is `white-space: pre-wrap` -- it has to be, so that leading spaces
 * in a typed line survive. That makes whitespace *between* its child tags
 * significant: pretty-printed markup renders as a literal newline plus spaces,
 * which pushes the prompt down a line and indents it by however many spaces the
 * file happened to be indented with.
 *
 * The markup is therefore authored on a single line. Nothing about that is
 * self-evident, and any HTML formatter run over index.html would undo it, so it
 * gets a test.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");

/**
 * Extract the `.inputline` element, including its children.
 * @returns {string}
 */
function inputlineMarkup() {
  const start = html.indexOf('<div class="inputline"');
  assert.notEqual(start, -1, "index.html must contain the .inputline element");
  const end = html.indexOf("</div>", start);
  assert.notEqual(end, -1, "the .inputline element must be closed");
  return html.slice(start, end + "</div>".length);
}

test("the input line's markup contains no whitespace between tags", () => {
  const markup = inputlineMarkup();
  const offenders = [...markup.matchAll(/>(\s+)</g)];
  assert.equal(
    offenders.length,
    0,
    `Found whitespace between tags inside .inputline. Because that element is\n` +
      `white-space: pre-wrap, this renders as literal newlines and spaces and\n` +
      `visibly indents the prompt. Keep the element on one line.\n` +
      `Offending markup:\n${markup}`,
  );
});

test("the input line still has the spans renderInput() writes into", () => {
  const markup = inputlineMarkup();
  for (const cls of ["prompt", "line", "line-pre", "cursor", "line-post"]) {
    assert.ok(
      markup.includes(`class="${cls}"`),
      `.inputline must contain .${cls} — terminal.js queries it and throws if absent`,
    );
  }
});

test("the cursor's placeholder is a non-breaking space", () => {
  // A plain trailing space is allowed to hang and be dropped at a wrap point
  // under pre-wrap, which would collapse the cursor to zero width at exactly
  // the column where the line wraps.
  const markup = inputlineMarkup();
  const cursor = /<span class="cursor"[^>]*>([^<]*)<\/span>/.exec(markup);
  assert.notEqual(cursor, null, "cursor span should have inline content");
  const filler = cursor?.[1] ?? "";
  assert.ok(
    filler === "&nbsp;" || filler === " ",
    `cursor placeholder should be a non-breaking space, got ${JSON.stringify(filler)}`,
  );
});

test("index.html carries the warning that keeps a formatter from breaking this", () => {
  // The one-line markup is load-bearing and not self-explanatory. If someone
  // removes the explanation, the next formatter run silently breaks the prompt.
  assert.match(
    html,
    /prettier-ignore/,
    "index.html should keep the prettier-ignore directive above .inputline",
  );
  assert.match(
    html,
    /pre-wrap/,
    "index.html should keep the comment explaining why .inputline is one line",
  );
});
