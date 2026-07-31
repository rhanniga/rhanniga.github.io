// @ts-check
/**
 * The mode that is active while a command runs.
 *
 * Renders no prompt at all -- which is what a real shell looks like mid-command,
 * and is why `prompt()` returning null is part of the mode contract rather than
 * something bolted on.
 *
 * It swallows input, with two exceptions that matter: Ctrl+C aborts, and the
 * scrolling keys keep working, because being unable to read scrollback during a
 * 15-second model prefill would be miserable.
 */

/** @typedef {import('./modes.js').TerminalMode} TerminalMode */
/** @typedef {import('./modes.js').ModeContext} ModeContext */
/** @typedef {import('./keys.js').KeyEvent} KeyEvent */

import { applyScroll } from "./editing.js";

/** @implements {TerminalMode} */
export class RunningMode {
  id = "running";
  editable = false;
  buffer = null;

  /**
   * @param {object} opts
   * @param {AbortController} opts.abort
   * @param {string} [opts.label] shown in document.title, e.g. the command name
   */
  constructor({ abort, label }) {
    this.abort = abort;
    this.label = label === undefined ? "hannigan.sh" : `${label} — hannigan.sh`;
  }

  prompt() {
    return null;
  }

  onInsertText() {
    /* Typing while a command runs is discarded, as in a real shell without a
     * line discipline buffering it. */
  }

  /**
   * @param {KeyEvent} ev
   * @param {ModeContext} ctx
   */
  onKey(ev, ctx) {
    if (ev.action === "interrupt") {
      this.abort.abort();
      return;
    }
    applyScroll(ev.action, ctx.term);
  }
}
