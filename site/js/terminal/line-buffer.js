// @ts-check
/**
 * The editable input line.
 *
 * Pure: no DOM, no events. It is the single source of truth for what the user
 * has typed -- the hidden <textarea> in terminal.js is only a keystroke
 * acquisition device, and its value is cleared after every input event. Never
 * render from the textarea.
 *
 * State is an array of *graphemes*, not code units or code points, because the
 * cursor renders as a block over one user-perceived character. Indexing by code
 * unit would let the cursor bisect an emoji or separate a combining mark from
 * its base.
 */

import { graphemes } from "../util.js";

/** Word characters for readline-style word motion (Alt+B/F, Ctrl+arrows). */
const WORD = /[\p{L}\p{N}_]/u;
/** Whitespace, for bash's unix-word-rubout (Ctrl+W). */
const SPACE = /\s/u;

/**
 * @param {string} g
 * @returns {boolean}
 */
function isWord(g) {
  return WORD.test(g);
}

/**
 * @param {string} g
 * @returns {boolean}
 */
function isSpace(g) {
  return SPACE.test(g);
}

export class LineBuffer {
  /** @type {string[]} */ #g = [];
  /** @type {number} */ #cursor = 0;
  /** Single-slot kill ring, as in readline's default. */
  /** @type {string} */ #kill = "";

  /** The line as a string. */
  get value() {
    return this.#g.join("");
  }

  /** Cursor position, as a grapheme index in [0, length]. */
  get cursor() {
    return this.#cursor;
  }

  /** Length in graphemes. */
  get length() {
    return this.#g.length;
  }

  get killRing() {
    return this.#kill;
  }

  get isEmpty() {
    return this.#g.length === 0;
  }

  /**
   * Replace the whole line. Used by history recall and tab completion.
   * @param {string} value
   * @param {number} [cursor] defaults to end of line
   */
  set(value, cursor) {
    this.#g = graphemes(value);
    this.#cursor = cursor === undefined ? this.#g.length : this.#clampIndex(cursor);
  }

  clear() {
    this.#g = [];
    this.#cursor = 0;
  }

  /**
   * Split for rendering: the text before the cursor, the single grapheme *under*
   * it, and the text after. `at` is empty at end-of-line, where the renderer
   * substitutes a non-breaking space so the block cursor still has a cell.
   * @returns {{ pre: string, at: string, post: string }}
   */
  split() {
    return {
      pre: this.#g.slice(0, this.#cursor).join(""),
      at: this.#g[this.#cursor] ?? "",
      post: this.#g.slice(this.#cursor + 1).join(""),
    };
  }

  /* ── Insertion ─────────────────────────────────────────────────────── */

  /**
   * Insert text at the cursor.
   * @param {string} text
   */
  insert(text) {
    if (text === "") return;
    const gs = graphemes(text);
    this.#g.splice(this.#cursor, 0, ...gs);
    this.#cursor += gs.length;
  }

  /* ── Deletion ──────────────────────────────────────────────────────── */

  /** Backspace. @returns {boolean} whether anything was deleted */
  deleteBackward() {
    if (this.#cursor === 0) return false;
    this.#g.splice(this.#cursor - 1, 1);
    this.#cursor--;
    return true;
  }

  /** Delete / Ctrl+D on a non-empty line. @returns {boolean} */
  deleteForward() {
    if (this.#cursor >= this.#g.length) return false;
    this.#g.splice(this.#cursor, 1);
    return true;
  }

  /** Ctrl+U -- kill from the cursor to the start of the line. */
  killToStart() {
    if (this.#cursor === 0) return;
    this.#kill = this.#g.splice(0, this.#cursor).join("");
    this.#cursor = 0;
  }

  /** Ctrl+K -- kill from the cursor to the end of the line. */
  killToEnd() {
    if (this.#cursor >= this.#g.length) return;
    this.#kill = this.#g.splice(this.#cursor).join("");
  }

  /**
   * Ctrl+W -- bash's unix-word-rubout. Deliberately *whitespace*-delimited, not
   * word-character-delimited: at the end of `foo/bar baz` it kills `baz`, and
   * again it kills all of `foo/bar`. That differs from Alt+Backspace, and
   * matching it is the difference between muscle memory working and not.
   */
  killWordBackward() {
    if (this.#cursor === 0) return;
    let i = this.#cursor;
    while (i > 0 && isSpace(this.#g[i - 1] ?? "")) i--;
    while (i > 0 && !isSpace(this.#g[i - 1] ?? "")) i--;
    this.#kill = this.#g.splice(i, this.#cursor - i).join("");
    this.#cursor = i;
  }

  /** Ctrl+Y -- yank the kill ring at the cursor. */
  yank() {
    if (this.#kill !== "") this.insert(this.#kill);
  }

  /* ── Motion ────────────────────────────────────────────────────────── */

  moveLeft() {
    if (this.#cursor > 0) this.#cursor--;
  }

  moveRight() {
    if (this.#cursor < this.#g.length) this.#cursor++;
  }

  moveHome() {
    this.#cursor = 0;
  }

  moveEnd() {
    this.#cursor = this.#g.length;
  }

  /** Alt+B / Ctrl+Left -- readline backward-word, over word characters. */
  moveWordLeft() {
    let i = this.#cursor;
    while (i > 0 && !isWord(this.#g[i - 1] ?? "")) i--;
    while (i > 0 && isWord(this.#g[i - 1] ?? "")) i--;
    this.#cursor = i;
  }

  /** Alt+F / Ctrl+Right -- readline forward-word. */
  moveWordRight() {
    const n = this.#g.length;
    let i = this.#cursor;
    while (i < n && !isWord(this.#g[i] ?? "")) i++;
    while (i < n && isWord(this.#g[i] ?? "")) i++;
    this.#cursor = i;
  }

  /**
   * @param {number} i
   * @returns {number}
   */
  #clampIndex(i) {
    if (!Number.isFinite(i) || i < 0) return 0;
    return i > this.#g.length ? this.#g.length : Math.floor(i);
  }
}
