// @ts-check
/**
 * A generic sub-REPL.
 *
 * Parameterised rather than specific to `ask -i`, and it composes the same
 * LineBuffer and History the shell uses -- so the sub-REPL gets full readline
 * editing and its own independent history for free, which is most of the argument
 * for the mode stack existing at all.
 */

import { c } from "../render/chunk.js";
import { LineBuffer } from "./line-buffer.js";
import { applyEdit, applyScroll } from "./editing.js";

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */
/** @typedef {import('../render/chunk.js').Line} Line */
/** @typedef {import('./history.js').History} History */

/** @implements {TerminalMode} */
export class ReplMode {
  editable = true;
  buffer = new LineBuffer();

  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.label
   * @param {() => Line} opts.promptChunks
   * @param {History} opts.history
   * @param {(line: string, ctx: ModeContext) => void} opts.onSubmit
   * @param {(ctx: ModeContext) => void} opts.onEof   Ctrl+D or `exit`
   * @param {(cmd: string, ctx: ModeContext) => boolean} [opts.onDirective]
   *   handles dot-commands like `.reset`; return true if consumed
   */
  constructor({ id, label, promptChunks, history, onSubmit, onEof, onDirective }) {
    this.id = id;
    this.label = label;
    this.promptChunks = promptChunks;
    this.history = history;
    this.onSubmit = onSubmit;
    this.onEof = onEof;
    this.onDirective = onDirective;
  }

  prompt() {
    return this.promptChunks();
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
        ctx.out.row([...this.promptChunks(), c(line)]);
        this.history.push(line);

        const trimmed = line.trim();
        if (trimmed === "") {
          ctx.term.renderInput();
          return;
        }
        if (trimmed === "exit" || trimmed === "quit") {
          this.onEof(ctx);
          return;
        }
        if (trimmed.startsWith(".") && this.onDirective?.(trimmed, ctx) === true) {
          ctx.term.renderInput();
          return;
        }
        this.onSubmit(line, ctx);
        return;
      }

      case "up": {
        const recalled = this.history.prev(b.value);
        if (recalled !== null) b.set(recalled);
        break;
      }
      case "down": {
        const recalled = this.history.next();
        if (recalled !== null) b.set(recalled);
        break;
      }

      case "interrupt":
        // Abandons the line but stays in the repl -- Ctrl+C is not how you leave.
        ctx.out.row([...this.promptChunks(), c(b.value), c("^C", "dim")]);
        b.clear();
        this.history.reset();
        break;

      case "eof":
        if (b.isEmpty) {
          this.onEof(ctx);
          return;
        }
        b.deleteForward();
        break;

      case "clear":
        ctx.term.clear();
        return;

      // No tab completion here: there is nothing to complete but free text.
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
