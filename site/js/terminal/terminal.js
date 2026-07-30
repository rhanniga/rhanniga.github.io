// @ts-check
/**
 * The terminal host: DOM ownership, event routing, and the mode stack.
 *
 * Input architecture, which is the part worth understanding:
 *
 *   - `keydown` is bound to **document**, not to the textarea. Editing keys and
 *     control sequences are handled there regardless of what has focus, so
 *     Ctrl+C still aborts after the user has clicked around.
 *   - Printable text is NOT read from keydown. It arrives via the textarea's
 *     `input` event, which is the only way IME composition, mobile autocorrect,
 *     and paste all behave uniformly. For a printable key we therefore do *not*
 *     preventDefault -- we just make sure the textarea has focus so the character
 *     lands in it and `input` fires.
 *   - The textarea's value is cleared after every read. It is a keystroke
 *     acquisition device; LineBuffer is the source of truth.
 */

import { c } from "../render/chunk.js";
import { Writer } from "./writer.js";
import { Metrics } from "./metrics.js";
import { ModeStack } from "./modes.js";
import { normalize, isPrintable, sanitizePaste } from "./keys.js";

/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('./modes.js').TerminalMode} TerminalMode */

/** How long after the last keystroke the cursor resumes blinking. */
const BLINK_RESUME_MS = 500;

/**
 * The surface commands and modes are allowed to touch.
 * @typedef {object} TerminalApi
 * @property {(line: Line) => void} row
 * @property {(lines: Line[]) => void} rows
 * @property {(s?: string, cls?: import('../render/chunk.js').TokenClass) => void} writeln
 * @property {() => void} clear
 * @property {() => number} cols
 * @property {(mode: TerminalMode) => void} pushMode
 * @property {() => void} popMode
 * @property {() => void} renderInput
 * @property {() => void} scrollToBottom
 * @property {() => void} scrollToTop
 * @property {(n: number) => void} scrollPages
 * @property {() => void} shutdown
 */

export class Terminal {
  /** @type {HTMLElement} */ #root;
  /** @type {HTMLElement} */ #viewport;
  /** @type {HTMLElement} */ #output;
  /** @type {HTMLElement} */ #inputline;
  /** @type {HTMLElement} */ #promptEl;
  /** @type {HTMLElement} */ #lineEl;
  /** @type {HTMLElement} */ #preEl;
  /** @type {HTMLElement} */ #curEl;
  /** @type {HTMLElement} */ #postEl;
  /** @type {HTMLTextAreaElement} */ #kbd;

  /** @type {Metrics} */ #metrics;
  /** @type {Writer} */ #writer;
  /** @type {ModeStack} */ #modes;

  /** @type {boolean} */ #composing = false;
  /** @type {number} */ #blinkTimer = 0;
  /** Set by shutdown(); all input is ignored afterwards. */
  /** @type {boolean} */ #dead = false;

  /**
   * @param {object} els
   * @param {HTMLElement} els.root
   * @param {HTMLElement} els.viewport
   * @param {HTMLElement} els.output
   * @param {HTMLElement} els.inputline
   * @param {HTMLTextAreaElement} els.kbd
   * @param {HTMLElement} els.probe
   */
  constructor({ root, viewport, output, inputline, kbd, probe }) {
    this.#root = root;
    this.#viewport = viewport;
    this.#output = output;
    this.#inputline = inputline;
    this.#kbd = kbd;

    const q = (/** @type {string} */ sel) => {
      const el = inputline.querySelector(sel);
      if (!(el instanceof HTMLElement)) {
        throw new Error(`missing ${sel} inside #inputline`);
      }
      return el;
    };
    this.#promptEl = q(".prompt");
    this.#lineEl = q(".line");
    this.#preEl = q(".line-pre");
    this.#curEl = q(".cursor");
    this.#postEl = q(".line-post");
    this.#stripLayoutWhitespace();

    this.#metrics = new Metrics({ probe, content: output });
    this.#writer = new Writer({
      output,
      viewport,
      getCols: () => this.#metrics.cols,
    });

    this.#modes = new ModeStack(
      { term: this.api, out: this.#writer },
      () => this.renderInput(),
    );

    this.#wire();
  }

  get metrics() {
    return this.#metrics;
  }
  get writer() {
    return this.#writer;
  }
  get modes() {
    return this.#modes;
  }

  /** @type {TerminalApi} */
  get api() {
    return {
      row: (line) => this.#writer.row(line),
      rows: (lines) => this.#writer.rows(lines),
      writeln: (s, cls) => this.#writer.writeln(s, cls),
      clear: () => {
        this.#writer.clear();
        this.renderInput();
      },
      cols: () => this.#metrics.cols,
      pushMode: (mode) => this.#modes.push(mode),
      popMode: () => {
        this.#modes.pop();
      },
      renderInput: () => this.renderInput(),
      scrollToBottom: () => this.#writer.scrollToBottom(),
      scrollToTop: () => {
        this.#viewport.scrollTop = 0;
      },
      scrollPages: (n) => this.#scrollPages(n),
      shutdown: () => this.shutdown(),
    };
  }

  /**
   * End the session: hide the prompt and stop accepting input.
   *
   * Deliberately does not clear the screen -- closing a real terminal leaves the
   * transcript visible, and wiping it would destroy whatever the visitor was
   * reading. A reload brings it back, which the caller says so.
   */
  shutdown() {
    this.#dead = true;
    this.#inputline.hidden = true;
    this.#kbd.blur();
    this.#kbd.disabled = true;
    this.#root.dataset.focused = "false";
  }

  /**
   * Install the initial mode and reveal the input line.
   * @param {TerminalMode} mode
   */
  start(mode) {
    this.#modes.push(mode);
    this.#metrics.observe(this.#viewport);
    // A width change moves the caret, so the keyboard sink has to be re-parked
    // or the browser will scroll the wrong place into view on mobile.
    this.#metrics.onChange(() => this.renderInput());
    this.#inputline.hidden = false;
    this.#root.dataset.booting = "false";
    this.renderInput();
    this.focus();
  }

  /* ── Rendering the input line ────────────────────────────────────────── */

  renderInput() {
    if (this.#dead) {
      this.#inputline.hidden = true;
      return;
    }
    const mode = this.#modes.top();
    const prompt = mode.prompt();

    document.title = mode.label;

    // A null prompt means render nothing at all -- which is what a real shell
    // looks like while a command is running.
    if (prompt === null) {
      this.#inputline.hidden = true;
      return;
    }
    this.#inputline.hidden = false;

    this.#promptEl.replaceChildren();
    for (const ch of prompt) {
      const span = document.createElement("span");
      if (ch.c !== undefined) span.className = "tk-" + ch.c;
      span.textContent = ch.t;
      this.#promptEl.appendChild(span);
    }

    const buf = mode.buffer;
    if (buf === null || !mode.editable) {
      this.#preEl.textContent = "";
      this.#curEl.textContent = " ";
      this.#postEl.textContent = "";
      this.#curEl.hidden = true;
      return;
    }
    this.#curEl.hidden = false;

    const { pre, at, post } = buf.split();
    this.#preEl.textContent = pre;
    // At end-of-line there is no character under the cursor, so substitute a
    // non-breaking space to give the block cursor a cell to occupy. It must be
    // U+00A0 and not a plain space: under pre-wrap a trailing plain space may
    // hang and be dropped at a wrap point, which would collapse the cursor to
    // nothing at exactly the width where the line wraps.
    this.#curEl.textContent = at === "" ? " " : at;
    this.#postEl.textContent = post;

    this.#positionSink();
  }

  /**
   * Delete whitespace-only text nodes sitting *between* the input line's spans.
   *
   * `.inputline` is `white-space: pre-wrap`, which it must be so that leading
   * spaces in a typed line survive. That also makes the indentation between tags
   * in index.html significant: pretty-printed markup renders as a literal newline
   * plus spaces, pushing the prompt down and to the right.
   *
   * The markup is authored on one line to avoid this, but any HTML formatter
   * reflowing index.html would silently reintroduce it, so it is also stripped
   * here. Only the two container elements are swept -- the content spans are
   * managed by renderInput(), and the cursor's placeholder is a non-breaking
   * space that `trim()` would consider whitespace and eat.
   */
  #stripLayoutWhitespace() {
    for (const parent of [this.#inputline, this.#lineEl]) {
      for (const node of [...parent.childNodes]) {
        if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === "") {
          node.remove();
        }
      }
    }
  }

  /**
   * Park the invisible textarea at the caret. It is focused, so the browser will
   * scroll it into view on its own -- and if it were parked off-screen, iOS would
   * scroll the page sideways every time the keyboard opened.
   */
  #positionSink() {
    const box = this.#curEl.getBoundingClientRect();
    const ref = this.#viewport.getBoundingClientRect();
    this.#kbd.style.left = `${box.left - ref.left + this.#viewport.scrollLeft}px`;
    this.#kbd.style.top = `${box.top - ref.top + this.#viewport.scrollTop}px`;
  }

  /* ── Focus ───────────────────────────────────────────────────────────── */

  focus() {
    this.#kbd.focus({ preventScroll: true });
  }

  /**
   * Focus the keyboard sink, but never at the cost of an active selection --
   * without this guard, releasing a drag-select refocuses and wipes it, which
   * breaks copy entirely.
   */
  #focusUnlessSelecting() {
    const sel = window.getSelection();
    if (sel !== null && !sel.isCollapsed) return;
    this.focus();
  }

  /* ── Cursor blink ────────────────────────────────────────────────────── */

  /** Suppress blinking while actively typing, as real terminals do. */
  #pokeCursor() {
    this.#curEl.dataset.blink = "false";
    if (this.#blinkTimer) clearTimeout(this.#blinkTimer);
    this.#blinkTimer = setTimeout(() => {
      this.#curEl.dataset.blink = "true";
      this.#blinkTimer = 0;
    }, BLINK_RESUME_MS);
  }

  /* ── Scrolling ───────────────────────────────────────────────────────── */

  /** @param {number} pages positive scrolls down */
  #scrollPages(pages) {
    this.#viewport.scrollTop += pages * this.#viewport.clientHeight * 0.9;
  }

  /* ── Event wiring ────────────────────────────────────────────────────── */

  #wire() {
    const kbd = this.#kbd;

    kbd.addEventListener("focus", () => {
      this.#root.dataset.focused = "true";
    });
    kbd.addEventListener("blur", () => {
      this.#root.dataset.focused = "false";
    });

    this.#root.addEventListener("click", () => this.#focusUnlessSelecting());

    /* Printable text, autocorrect, and mobile input. */
    kbd.addEventListener("input", () => {
      if (this.#composing) return; // mid-composition; wait for compositionend
      const text = kbd.value;
      kbd.value = "";
      if (text !== "") this.#insert(text);
    });

    /* IME. compositionend fires before the final input event in every engine we
     * care about, and clearing the value there makes that input event a no-op. */
    kbd.addEventListener("compositionstart", () => {
      this.#composing = true;
    });
    kbd.addEventListener("compositionend", (ev) => {
      this.#composing = false;
      const text = ev.data ?? "";
      kbd.value = "";
      if (text !== "") this.#insert(text);
    });

    kbd.addEventListener("paste", (ev) => {
      ev.preventDefault();
      const raw = ev.clipboardData?.getData("text/plain") ?? "";
      const clean = sanitizePaste(raw);
      if (clean !== "") this.#insert(clean);
    });

    document.addEventListener("keydown", (ev) => this.#onKeyDown(ev));
  }

  /**
   * @param {string} text
   */
  #insert(text) {
    this.#pokeCursor();
    void this.#modes.top().onInsertText(text, {
      term: this.api,
      out: this.#writer,
    });
  }

  /**
   * @param {KeyboardEvent} ev
   */
  #onKeyDown(ev) {
    // Never steal OS/browser shortcuts (Cmd+C, Cmd+A, Cmd+R, ...).
    if (ev.metaKey) return;
    // After `exit`, selection and copy still work but nothing is interactive.
    if (this.#dead) return;

    const k = normalize(ev);

    // Ctrl+C is overloaded. With a live selection it must copy -- a real terminal
    // would demand Ctrl+Shift+C for that, but on the web that would surprise
    // everyone. We copy explicitly rather than relying on the default, because
    // the focused (and empty) textarea would otherwise be the copy source.
    if (k.action === "interrupt") {
      const sel = window.getSelection();
      const picked = sel !== null && !sel.isCollapsed ? sel.toString() : "";
      if (picked !== "") {
        if (navigator.clipboard !== undefined) {
          ev.preventDefault();
          void navigator.clipboard.writeText(picked).catch(() => {});
          sel?.removeAllRanges();
        }
        // Without the Clipboard API, fall through to the browser's own copy.
        return;
      }
      // No selection: this is a genuine interrupt. Handled below.
    }

    if (k.action !== "none") {
      // Several of these are browser shortcuts. Ctrl+L (address bar), Ctrl+K
      // (search), Ctrl+U (view source), Ctrl+D (bookmark) and Ctrl+P (print) all
      // honour preventDefault. Ctrl+W and Ctrl+N do NOT in Chrome or Firefox --
      // they close the tab and open a window respectively, and there is nothing
      // a page can do about it. Alt+Backspace is the working kill-word binding;
      // `help` documents the gap.
      ev.preventDefault();
      this.#pokeCursor();
      this.#focusUnlessSelecting();
      void this.#modes.top().onKey(k, { term: this.api, out: this.#writer });
      return;
    }

    // Not an action we handle. If it will produce a character, make sure the
    // sink has focus so the `input` event fires -- and deliberately do NOT
    // preventDefault, so the character actually reaches it.
    //
    // This collapses any selection first, unlike every other focus path here.
    // Typing with text selected means the user is done with that selection: a
    // real terminal inserts the character. Refusing to focus would instead make
    // the keyboard appear dead until they clicked, which reads as broken.
    if (isPrintable(ev)) {
      window.getSelection()?.removeAllRanges();
      this.focus();
    }
  }
}
