// @ts-check
/**
 * Structured output primitives.
 *
 * The load-bearing decision of the render layer: every formatter is a pure
 * function `(data, cols) => Line[]` that never touches the DOM. That buys three
 * things at once --
 *
 *   1. layout is unit-testable under `node --test` with no DOM at all;
 *   2. the screen-reader path can render the *unwrapped* chunk text, which is
 *      strictly better for it than the hard-wrapped visual output;
 *   3. a `?plain=1` semantic-HTML view is a different renderer over the same
 *      data, not a second implementation.
 *
 * It also means we never need an ANSI/CSI escape-sequence parser: output is
 * structured on the way in, so there is nothing to parse on the way out.
 */

import { width } from "../util.js";

/**
 * @typedef {'text'|'dim'|'bright'|'heading'|'subheading'|'accent'|'keyword'
 *          |'error'|'warn'|'success'|'link'|'rule'
 *          |'json-key'|'json-string'|'json-number'|'json-punct'
 *          |'prompt-user'|'prompt-path'|'prompt-sigil'|'prompt-repl'} TokenClass
 */

/**
 * One styled run of text. `href` makes it a link; `ext` opens it in a new tab.
 * @typedef {{ t: string, c?: TokenClass, href?: string, ext?: boolean }} Chunk
 */

/**
 * One terminal line, already hard-wrapped to the column count if it came from
 * a formatter.
 * @typedef {Chunk[]} Line
 */

/**
 * Make a chunk.
 * @param {string} t
 * @param {TokenClass} [cls]
 * @returns {Chunk}
 */
export function c(t, cls) {
  return cls === undefined ? { t } : { t, c: cls };
}

/**
 * `n` spaces.
 * @param {number} n
 * @returns {Chunk}
 */
export function sp(n) {
  return { t: " ".repeat(Math.max(0, n)) };
}

/**
 * A link chunk. External links get `ext` so the renderer can add
 * target/rel; mailto: and tel: deliberately do not.
 * @param {string} t
 * @param {string} href
 * @returns {Chunk}
 */
export function link(t, href) {
  const ext = /^https?:/i.test(href);
  return ext ? { t, c: "link", href, ext: true } : { t, c: "link", href };
}

/** An empty line. Frozen so a shared reference can't be mutated by a caller. */
export const blank = /** @type {Line} */ (Object.freeze([]));

/**
 * Printed width of a line, in terminal cells.
 * @param {Line} line
 * @returns {number}
 */
export function len(line) {
  let n = 0;
  for (const ch of line) n += width(ch.t);
  return n;
}

/**
 * Plain text of a line, with no styling and no wrapping.
 *
 * This is the screen-reader and `?plain=1` path. Hard-wrapped text is actively
 * hostile to screen readers -- it injects phantom line breaks mid-sentence --
 * so the SR path getting unwrapped text is a genuine improvement, not a
 * compromise.
 * @param {Line} line
 * @returns {string}
 */
export function text(line) {
  let s = "";
  for (const ch of line) s += ch.t;
  return s;
}

/**
 * Concatenate lines into one.
 * @param {...Line} lines
 * @returns {Line}
 */
export function join(...lines) {
  /** @type {Line} */
  const out = [];
  for (const l of lines) out.push(...l);
  return out;
}
