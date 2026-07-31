// @ts-check
/**
 * The output sink.
 *
 * `#output` is append-only: one <div class="row"> per emitted line, never
 * re-rendered. That keeps writes O(1), keeps native cross-line text selection
 * working, and keeps scroll position stable. The only mutable row is the
 * transient row (added in M6) used for the `ask` download progress bar.
 *
 * Every DOM mutation is coalesced into one append per animation frame. Without
 * that, a fast token stream from the LLM triggers hundreds of layout passes per
 * second.
 */

/** @typedef {import('../render/chunk.js').Chunk} Chunk */
/** @typedef {import('../render/chunk.js').Line} Line */

/**
 * A row that can be rewritten in place, for progress bars and spinners.
 * @typedef {object} TransientRow
 * @property {(line: Line) => void} set      replace its contents
 * @property {() => void} commit             leave it on screen permanently
 * @property {() => void} discard            remove it entirely
 */

/**
 * Build the DOM for one chunk.
 * @param {Chunk} ch
 * @returns {Node}
 */
function renderChunk(ch) {
  if (ch.href !== undefined) {
    const a = document.createElement("a");
    a.textContent = ch.t;
    a.href = ch.href;
    // Printed links get tabindex -1 so Tab doesn't walk through hundreds of
    // them; the `open` command is the keyboard path instead.
    a.tabIndex = -1;
    if (ch.ext) {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    return a;
  }
  if (ch.c !== undefined && ch.c !== "text") {
    const span = document.createElement("span");
    span.className = "tk-" + ch.c;
    span.textContent = ch.t;
    return span;
  }
  return document.createTextNode(ch.t);
}

/**
 * @param {Line} line
 * @returns {HTMLDivElement}
 */
function renderRow(line) {
  const row = document.createElement("div");
  row.className = "row";
  for (const ch of line) row.appendChild(renderChunk(ch));
  return row;
}

export class Writer {
  /** @type {HTMLElement} */ #output;
  /** @type {HTMLElement} */ #viewport;
  /** @type {DocumentFragment} */ #frag = document.createDocumentFragment();
  /** @type {HTMLDivElement | null} */ #openRow = null;
  /** @type {number} */ #raf = 0;
  /** @type {() => number} */ #getCols;
  /** @type {((line: Line) => void) | null} */ #onLine;

  /**
   * @param {object} opts
   * @param {HTMLElement} opts.output
   * @param {HTMLElement} opts.viewport
   * @param {() => number} opts.getCols
   * @param {(line: Line) => void} [opts.onLine] mirror for the aria-live sink
   */
  constructor({ output, viewport, getCols, onLine }) {
    this.#output = output;
    this.#viewport = viewport;
    this.#getCols = getCols;
    this.#onLine = onLine ?? null;
  }

  /** Current terminal width in columns. */
  get cols() {
    return this.#getCols();
  }

  /**
   * Emit one line.
   * @param {Line} line
   */
  row(line) {
    this.#closeOpenRow();
    this.#frag.appendChild(renderRow(line));
    this.#onLine?.(line);
    this.#schedule();
  }

  /**
   * Emit many lines.
   * @param {Line[]} lines
   */
  rows(lines) {
    for (const l of lines) this.row(l);
  }

  /**
   * Append raw text, honouring embedded newlines. Text accumulates in an open
   * row until a newline closes it, which is what makes token streaming append
   * into the current line rather than starting a new one per token.
   * @param {string} s
   * @param {import('../render/chunk.js').TokenClass} [cls]
   */
  write(s, cls) {
    if (s === "") return;
    const parts = s.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) this.#closeOpenRow(true);
      const part = parts[i];
      if (part === undefined || part === "") continue;
      if (this.#openRow === null) {
        this.#openRow = document.createElement("div");
        this.#openRow.className = "row";
        this.#frag.appendChild(this.#openRow);
      }
      // Merge into the preceding text node when there is no styling to apply.
      // Token streaming calls this once per token, and without coalescing a long
      // answer becomes hundreds of sibling text nodes in one row.
      const last = this.#openRow.lastChild;
      if (cls === undefined && last instanceof Text) {
        last.appendData(part);
      } else {
        this.#openRow.appendChild(renderChunk(cls ? { t: part, c: cls } : { t: part }));
      }
    }
    this.#schedule();
  }

  /**
   * @param {string} [s]
   * @param {import('../render/chunk.js').TokenClass} [cls]
   */
  writeln(s = "", cls) {
    this.write(s + "\n", cls);
  }

  /** Wipe the screen (Ctrl+L, `clear`). */
  clear() {
    if (this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    this.#frag = document.createDocumentFragment();
    this.#openRow = null;
    this.#output.replaceChildren();
  }

  /**
   * Force a synchronous flush. Needed before measuring layout, and after the
   * last write of a command so the next prompt lands in the same frame.
   */
  flush() {
    if (this.#raf) {
      cancelAnimationFrame(this.#raf);
      this.#raf = 0;
    }
    this.#commit();
  }

  /**
   * Close the current open row so the next write starts a fresh line.
   * @param {boolean} [emptyIfNone] emit a blank row if there is no open row,
   *   so a bare "\n" produces a visible empty line
   */
  #closeOpenRow(emptyIfNone = false) {
    if (this.#openRow === null) {
      if (emptyIfNone) {
        this.#frag.appendChild(renderRow([]));
        this.#schedule();
      }
      return;
    }
    this.#openRow = null;
  }

  #schedule() {
    if (this.#raf) return;
    this.#raf = requestAnimationFrame(() => {
      this.#raf = 0;
      this.#commit();
    });
  }

  #commit() {
    if (!this.#frag.hasChildNodes()) return;
    // Read the pin state BEFORE mutating. If the user has scrolled up to read
    // scrollback, do not yank them to the bottom.
    const v = this.#viewport;
    const wasPinned = v.scrollHeight - v.scrollTop - v.clientHeight < 4;
    this.#output.appendChild(this.#frag);
    this.#frag = document.createDocumentFragment();
    if (wasPinned) v.scrollTop = v.scrollHeight;
  }

  /**
   * Open the one mutable row.
   *
   * Everything else here is append-only, which is what keeps writes O(1) and
   * selection stable. Progress bars and spinners genuinely need to overwrite
   * themselves, so they get this single carve-out -- and it is a carve-out rather
   * than a general "update any row" API precisely so the append-only invariant
   * stays true everywhere else.
   *
   * @returns {TransientRow}
   */
  beginTransientRow() {
    // Commit anything pending first, so the transient row lands after it.
    this.flush();
    const row = document.createElement("div");
    row.className = "row";
    this.#output.appendChild(row);
    this.#viewport.scrollTop = this.#viewport.scrollHeight;

    let live = true;
    return {
      set: (line) => {
        if (!live) return;
        row.replaceChildren(...line.map(renderChunk));
      },
      commit: () => {
        live = false;
      },
      discard: () => {
        if (!live) return;
        row.remove();
        live = false;
      },
    };
  }

  /** Scroll to the bottom regardless of pin state. */
  scrollToBottom() {
    this.#viewport.scrollTop = this.#viewport.scrollHeight;
  }
}
