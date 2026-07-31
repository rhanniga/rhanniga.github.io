// @ts-check
/**
 * PS2: the prompt you get when a quote is left open.
 *
 * Real bash behaviour, and about twenty lines because the mode stack already
 * provides the machinery. It accumulates lines, re-tokenizes after each Enter, and
 * pops as soon as the quote closes.
 */

import { c } from "../render/chunk.js";
import { LineBuffer } from "./line-buffer.js";
import { continuationPrompt } from "./prompt.js";
import { tokenize } from "../shell/tokenize.js";
import { applyEdit, applyScroll } from "./editing.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */

/** @implements {TerminalMode} */
export class ContinuationMode {
  id = "continuation";
  label = "continuation — hannigan.sh";
  editable = true;
  buffer = new LineBuffer();

  /**
   * @param {object} opts
   * @param {string} opts.pending the text typed so far, with its open quote
   * @param {{status: number}} opts.env
   * @param {(argv: string[]) => void} opts.onComplete
   * @param {() => void} opts.onAbort
   */
  constructor({ pending, env, onComplete, onAbort }) {
    this.pending = pending;
    this.env = env;
    this.onComplete = onComplete;
    this.onAbort = onAbort;
  }

  prompt() {
    return continuationPrompt();
  }

  /**
   * @param {string} text
   * @param {ModeContext} ctx
   */
  onInsertText(text, ctx) {
    this.buffer.insert(text);
    ctx.term.renderInput();
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    const b = this.buffer;

    if (applyEdit(b, ev.action)) {
      ctx.term.renderInput();
      return;
    }
    if (applyScroll(ev.action, ctx.term)) return;

    switch (ev.action) {
      case "enter": {
        const line = b.value;
        b.clear();
        ctx.out.row([...continuationPrompt(), c(line)]);
        // A newline is what the user actually typed, so join with one -- the
        // tokenizer treats it as ordinary whitespace when unquoted and preserves
        // it inside quotes, which is exactly right.
        this.pending = `${this.pending}\n${line}`;

        const result = tokenize(this.pending, this.env);
        if (result.ok) {
          ctx.term.popMode();
          this.onComplete(result.argv);
        }
        // Still unterminated: stay here and keep collecting.
        break;
      }

      case "interrupt":
        // Abandons the whole accumulated command, not just this line.
        ctx.out.row([...continuationPrompt(), c(b.value), c("^C", "dim")]);
        b.clear();
        ctx.term.popMode();
        this.onAbort();
        return;

      case "eof":
        if (b.isEmpty) {
          ctx.out.row([...continuationPrompt(), c("^D", "dim")]);
          ctx.term.popMode();
          this.onAbort();
          return;
        }
        b.deleteForward();
        break;

      case "clear":
        ctx.term.clear();
        return;

      // No history or completion inside a continuation -- bash has none either.
      case "up":
      case "down":
      case "tab":
      case "tab-back":
      case "none":
        break;

      default:
        break;
    }

    ctx.term.renderInput();
  }
}
