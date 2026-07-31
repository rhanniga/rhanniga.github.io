// @ts-check
/**
 * A single-keystroke yes/no prompt.
 *
 * Exists so `ask` can get consent before spending 72 MB of someone's bandwidth.
 * That confirmation is not ceremony: it is a large download triggered by a command
 * whose cost is not obvious from its name.
 *
 * Reads one key rather than a line, which is what `[Y/n]` implies and what makes
 * it feel like a shell prompt rather than a form.
 */

import { c } from "../render/chunk.js";
import { LineBuffer } from "./line-buffer.js";
import { applyScroll } from "./editing.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../render/chunk.js').Line} Line */

/** @implements {TerminalMode} */
export class ConfirmMode {
  id = "confirm";
  label = "confirm — hannigan.sh";
  /**
   * Editable, and carrying a buffer it never modifies, purely so the block cursor
   * renders. A `[Y/n]` prompt with no cursor does not look like it is waiting for
   * you. Keystrokes are intercepted in onInsertText and answer the question
   * instead of being inserted, and no editing action is ever applied.
   */
  editable = true;
  buffer = new LineBuffer();

  /**
   * @param {object} opts
   * @param {Line} opts.question   rendered as the prompt, already including [Y/n]
   * @param {boolean} opts.defaultYes  what Enter means
   * @param {(answer: boolean) => void} opts.resolve
   */
  constructor({ question, defaultYes, resolve }) {
    this.question = question;
    this.defaultYes = defaultYes;
    this.resolve = resolve;
    this.#settled = false;
  }

  /** @type {boolean} */ #settled;

  prompt() {
    return this.question;
  }

  onInsertText(text, ctx) {
    // Printable keys arrive here rather than through onKey, since the host routes
    // characters via the textarea's input event.
    const ch = text.trim().toLowerCase()[0];
    if (ch === "y") this.#answer(true, "y", ctx);
    else if (ch === "n") this.#answer(false, "n", ctx);
    // Anything else is ignored, as a shell prompt would.
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    if (applyScroll(ev.action, ctx.term)) return;
    switch (ev.action) {
      case "enter":
        this.#answer(this.defaultYes, this.defaultYes ? "y" : "n", ctx);
        return;
      // Ctrl+C and Ctrl+D both decline. Declining is always the safe reading of
      // "the user wants out" when the alternative is a 72 MB download.
      case "interrupt":
        this.#answer(false, "^C", ctx);
        return;
      case "eof":
        this.#answer(false, "^D", ctx);
        return;
      default:
        return;
    }
  }

  /**
   * @param {boolean} answer
   * @param {string} echo
   * @param {ModeContext} ctx
   */
  #answer(answer, echo, ctx) {
    if (this.#settled) return;
    this.#settled = true;
    ctx.out.row([...this.question, c(echo, "bright")]);
    ctx.term.removeMode(this);
    this.resolve(answer);
  }
}

/**
 * Ask a yes/no question, resolving to the answer.
 *
 * @param {import('./terminal.js').TerminalApi} term
 * @param {Line} question
 * @param {{ defaultYes?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
export function confirm(term, question, opts = {}) {
  return new Promise((resolve) => {
    term.pushMode(
      new ConfirmMode({
        question,
        defaultYes: opts.defaultYes ?? true,
        resolve,
      }),
    );
  });
}
